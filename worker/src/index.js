/* Portfolio backend. Two jobs, one Worker.

   POST /        ask-about-Ryan chat, proxied to OpenRouter
   POST /react   visitor reaction, stored in KV and mailed to Ryan

   The portfolio is a static page on GitHub Pages, so any key placed in it would be readable by
   anyone. This Worker holds the keys instead: the browser calls the Worker, the Worker calls the
   upstream, and no credential leaves Cloudflare.

   Set the secrets once:
     npx wrangler secret put OPENROUTER_KEY    (required, chat)
     npx wrangler secret put RESEND_KEY        (optional, mail; without it reactions still store)
     npx wrangler secret put ADMIN_KEY         (optional, lets you read reactions back over HTTP)

   Deliberately small. The only guards are the ones that pay for themselves. */

const ALLOWED = [
  'https://ryandev1st.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

// Ordered by MEASURED time to first token and availability, not by reputation. hy3 answered in
// ~1.7s while gpt-oss was returning 429s, and a 429 on the first model makes the visitor pay a
// whole failed round trip before anything streams. gpt-oss stays as the backup because its
// answers are good when it is up. The client cannot choose, so nobody can point this at a paid
// model. Re-measure before reordering; the free tier moves.
const MODELS = ['tencent/hy3:free', 'openai/gpt-oss-20b:free', 'nvidia/nemotron-3-super-120b-a12b:free'];

const MAIL_TO = 'ryandev1st@gmail.com';
const MAIL_FROM = 'Portfolio Signal <onboarding@resend.dev>';

// Two reactions per week per visitor, counted three different ways so that clearing one of them
// does not reset the limit (see rateCheck). Plus a hard ceiling on the whole day, which is the
// only thing that actually protects the inbox against many machines at once.
const PER_WEEK = 2;
const WEEK = 60 * 60 * 24 * 7;
const DAY_CAP = 120;
const KEEP = 60 * 60 * 24 * 365;   // how long a stored reaction lives

const REACTIONS = ['hire', 'solid', 'meh'];

const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin'
});

const json = (obj, status, origin) => new Response(JSON.stringify(obj), {
  status,
  headers: { ...(origin ? cors(origin) : {}), 'Content-Type': 'application/json' }
});

/* Identifiers are HASHED before they are stored. The rate limiter needs to recognise a repeat
   visitor, which does not require knowing who they are: a salted digest compares equal for the
   same input and is useless for anything else. The salt is the OpenRouter key, which is already
   a secret on this account, so there is no second thing to rotate. */
async function tag(value, salt) {
  const data = new TextEncoder().encode(salt + '|' + value);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* Three independent counters, all of which must be under the limit. One alone is easy to shed:
   a device id is just localStorage, a fingerprint changes with a browser update or a resized
   window, and an IP changes on a phone that walks between wifi and cellular. Requiring all three
   to be clear means shedding any single one does not buy another submission. */
async function rateCheck(env, ids) {
  const keys = ids.map(k => 'q:' + k);
  const counts = await Promise.all(keys.map(k => env.REACTIONS.get(k)));
  const over = counts.some(c => (parseInt(c || '0', 10) || 0) >= PER_WEEK);
  return { over, keys, counts: counts.map(c => parseInt(c || '0', 10) || 0) };
}

async function sendMail(env, body) {
  if (!env.RESEND_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [MAIL_TO],
        subject: `Portfolio: ${body.r}${body.note ? ' + note' : ''}`,
        text: [
          `Reaction: ${body.r}`,
          `Note: ${body.note || '(none)'}`,
          `Page: ${body.host || 'unknown'}`,
          `Device: ${body.mobile ? 'mobile' : 'desktop'}`,
          `When: ${body.at}`,
          `Ref: ${body.ref || '(direct)'}`
        ].join('\n')
      })
    });
    return r.ok;
  } catch { return false; }
}

async function handleReact(request, env, origin) {
  if (!env.REACTIONS) return json({ ok: false, error: 'no store' }, 500, origin);

  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400, origin); }

  const r = String(b.r || '');
  if (!REACTIONS.includes(r)) return json({ ok: false, error: 'bad reaction' }, 400, origin);
  const note = String(b.note || '').slice(0, 200);

  /* ONE VISITOR, ONE RECORD. The panel sends the chip the instant it is tapped, because most
     people tap and leave and that signal must not depend on them staying. The optional note
     arrives seconds later, and it used to be a SECOND post: two rows in the store and two of
     the visitor's two weekly attempts spent on one opinion (Ryan saw the duplicate).
     So the first post returns its record id and the note comes back with it, which ATTACHES
     the note to the row that already exists. It does not count again, because nothing new was
     said, only finished.
     Guards, since the id travels through the browser: the row must exist, must be recent, and
     must not already carry a note, so this cannot be used to rewrite history or to spam. */
  const id = String(b.id || '');
  if (id) {
    if (!/^r:\d{13}:[a-z0-9]{6}$/.test(id)) return json({ ok: false, error: 'bad id' }, 400, origin);
    const prev = await env.REACTIONS.get(id, 'json');
    if (!prev) return json({ ok: false, error: 'unknown id' }, 404, origin);
    if (prev.note) return json({ ok: true, counted: false, note: 'already set' }, 200, origin);
    if (Date.now() - Date.parse(prev.at) > 30 * 60 * 1000) {
      return json({ ok: false, error: 'too late' }, 409, origin);
    }
    if (!note) return json({ ok: true, counted: false }, 200, origin);
    prev.note = note;
    await env.REACTIONS.put(id, JSON.stringify(prev), { expirationTtl: KEEP });
    const sent = await sendMail(env, prev);
    return json({ ok: true, counted: false, updated: true, mailed: sent }, 200, origin);
  }
  // Fingerprint and device id are opaque to us, so they only have to LOOK like ids. Anything
  // longer is either a mistake or someone trying to write a large value into the store.
  const clean = (v) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const fp = clean(b.fp), dev = clean(b.dev);

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const salt = env.OPENROUTER_KEY || 'salt';
  const ids = ['ip:' + await tag(ip, salt)];
  if (fp) ids.push('fp:' + await tag(fp, salt));
  if (dev) ids.push('dev:' + await tag(dev, salt));

  const day = new Date().toISOString().slice(0, 10);
  const dayKey = 'q:day:' + day;
  const dayCount = parseInt(await env.REACTIONS.get(dayKey) || '0', 10) || 0;
  if (dayCount >= DAY_CAP) return json({ ok: false, error: 'closed for today' }, 429, origin);

  const gate = await rateCheck(env, ids);
  // Answers 200 with counted:false rather than an error. The visitor gave a real reaction and
  // does not need to be told about a quota; the panel just thanks them either way. Only the
  // storing and the mailing are skipped.
  if (gate.over) return json({ ok: true, counted: false }, 200, origin);

  const rec = {
    r, note,
    host: String(b.host || '').slice(0, 80),
    ref: String(b.ref || '').slice(0, 120),
    mobile: !!b.mobile,
    at: new Date().toISOString(),
    country: request.headers.get('CF-IPCountry') || ''
  };

  // Newest first when listed: KV sorts keys lexicographically, so an inverted timestamp puts the
  // most recent reaction at the top of the list without reading every record to sort it.
  const key = 'r:' + (1e13 - Date.now()) + ':' + Math.random().toString(36).slice(2, 8);
  await env.REACTIONS.put(key, JSON.stringify(rec), { expirationTtl: KEEP });

  const mailed = await sendMail(env, rec);

  /* The quota is spent only on a reaction that actually GOT THROUGH (Ryan). If mail is
     configured and the provider fails, the visitor keeps their attempt: burning it would mean
     the one submission they had was consumed by our outage, and a retry would be refused for a
     week. The record is already in KV either way, so nothing is lost by not counting.
     When no mail provider is configured at all, KV IS the delivery, so a successful write
     counts. Otherwise the limiter would be permanently disabled by a missing secret, which is
     the failure mode that leaves the endpoint wide open. */
  const delivered = env.RESEND_KEY ? mailed : true;
  if (delivered) {
    await Promise.all([
      ...gate.keys.map((k, i) => env.REACTIONS.put(k, String(gate.counts[i] + 1), { expirationTtl: WEEK })),
      env.REACTIONS.put(dayKey, String(dayCount + 1), { expirationTtl: 60 * 60 * 36 })
    ]);
  }

  // the id goes back so an optional note can be attached to THIS row instead of opening a new one
  return json({ ok: true, counted: delivered, mailed, id: key }, 200, origin);
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// "3h ago" beats a timestamp when the question is almost always "is this recent".
function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return Math.floor(m) + 'm ago';
  const h = m / 60; if (h < 24) return Math.floor(h) + 'h ago';
  const d = h / 24; if (d < 7) return Math.floor(d) + 'd ago';
  return new Date(iso).toISOString().slice(0, 10);
}

const LABEL = { hire: 'hire-worthy', solid: 'solid', meh: 'not for me' };

/* Reading this on a phone, at a glance, is the actual use: Ryan checks it when a notification
   would have gone off. So it renders as a page rather than raw JSON. The counts answer the only
   question that matters first, the notes are the part worth reading, and everything else is
   metadata that stays quiet. `?format=json` still returns the raw records. */
function adminPage(rows) {
  const n = rows.length;
  const by = { hire: 0, solid: 0, meh: 0 };
  rows.forEach(r => { if (by[r.r] != null) by[r.r]++; });
  const pct = (k) => n ? Math.round(by[k] / n * 100) : 0;

  const cards = rows.map(r => `
    <li class="row row--${esc(r.r)}">
      <div class="head">
        <span class="tag">${esc(LABEL[r.r] || r.r)}</span>
        <span class="when">${esc(ago(r.at))}</span>
      </div>
      ${r.note ? `<p class="note">${esc(r.note)}</p>` : `<p class="note note--none">no note</p>`}
      <div class="meta">
        <span>${esc(r.country || '??')}</span><i></i>
        <span>${r.mobile ? 'mobile' : 'desktop'}</span><i></i>
        <span>${esc(r.host || '')}</span>
        ${r.ref ? `<i></i><span class="ref">from ${esc(r.ref)}</span>` : ''}
      </div>
    </li>`).join('');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>signal.log</title>
<style>
  :root{--bg:#0b0c0e;--fg:#ecE7db;--mut:rgba(236,231,219,.45);--sig:#ff2a12;
    --line:rgba(255,255,255,.09);--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--mono);
    font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased;
    padding:24px 18px 64px}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:var(--mut);
    font-weight:400;margin:0 0 20px}
  h1 b{color:var(--sig);font-weight:400}
  /* the summary answers "how is it going" before any reading happens */
  .sum{border:1px solid var(--line);border-radius:14px;padding:16px;margin:0 0 22px;
    background:linear-gradient(160deg,rgba(255,255,255,.045),rgba(255,255,255,.015))}
  .total{font-size:30px;line-height:1;letter-spacing:-.02em}
  .total span{font-size:12px;color:var(--mut);letter-spacing:.14em;text-transform:uppercase;
    margin-left:9px}
  .bars{margin-top:16px;display:grid;gap:9px}
  .bar{display:grid;grid-template-columns:88px 1fr 42px;align-items:center;gap:10px;font-size:12px}
  .bar em{font-style:normal;color:var(--mut)}
  /* display:block on both, or an inline span ignores the height and every bar renders as an
     empty full-width track (the same trap as the signal panel on the site itself) */
  .track{display:block;height:6px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden}
  .fill{display:block;height:6px;border-radius:99px;background:var(--sig);min-width:0}
  .bar--solid .fill{background:rgba(236,231,219,.55)}
  .bar--meh .fill{background:rgba(236,231,219,.25)}
  .bar b{font-weight:400;text-align:right;color:var(--mut)}
  ul{list-style:none;margin:0;padding:0;display:grid;gap:10px}
  .row{border:1px solid var(--line);border-left:2px solid rgba(236,231,219,.22);
    border-radius:12px;padding:13px 15px;background:rgba(255,255,255,.022)}
  .row--hire{border-left-color:var(--sig)}
  .head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
  .tag{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mut)}
  .row--hire .tag{color:var(--sig)}
  .when{font-size:11px;color:var(--mut);white-space:nowrap}
  /* the note is the only thing here written by a human, so it gets the readable treatment */
  .note{margin:8px 0 0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
    font-size:15px;line-height:1.55;overflow-wrap:anywhere}
  .note--none{color:rgba(236,231,219,.28);font-family:var(--mono);font-size:12px}
  .meta{margin-top:10px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;
    font-size:11px;color:rgba(236,231,219,.34)}
  .meta i{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.5}
  .ref{overflow-wrap:anywhere}
  .empty{border:1px dashed var(--line);border-radius:14px;padding:34px 18px;text-align:center;
    color:var(--mut);font-size:13px}
  .foot{margin-top:26px;font-size:11px;color:rgba(236,231,219,.28)}
  @media (max-width:520px){
    body{padding:18px 13px 48px}
    .total{font-size:26px}
    .bar{grid-template-columns:76px 1fr 36px;gap:8px}
    .note{font-size:16px}          /* comfortable to read on a phone, which is where this gets opened */
  }
  @media (prefers-color-scheme:light){
    :root{--bg:#faf9f6;--fg:#16171a;--mut:rgba(22,23,26,.5);--line:rgba(0,0,0,.11)}
    .row{background:rgba(0,0,0,.02)}
    .track{background:rgba(0,0,0,.08)}
    .bar--solid .fill{background:rgba(22,23,26,.5)}
    .bar--meh .fill{background:rgba(22,23,26,.22)}
    .note--none{color:rgba(22,23,26,.3)}
    .meta{color:rgba(22,23,26,.4)}
  }
</style></head><body><div class="wrap">
<h1><b>&gt;_</b> signal.log</h1>
<div class="sum">
  <div class="total">${n}<span>${n === 1 ? 'reaction' : 'reactions'}</span></div>
  <div class="bars">
    ${['hire', 'solid', 'meh'].map(k => `
    <div class="bar bar--${k}"><em>${LABEL[k]}</em>
      <span class="track"><span class="fill" style="width:${pct(k)}%"></span></span>
      <b>${by[k]}</b></div>`).join('')}
  </div>
</div>
${n ? `<ul>${cards}</ul>` : `<div class="empty">Nothing yet. Reactions land here as visitors leave them.</div>`}
<p class="foot">Newest first. Add <code>&amp;format=json</code> for the raw records.</p>
</div></body></html>`;
}

/* Read the reactions back without opening the Cloudflare dashboard. Guarded by its own secret
   and never CORS-exposed, so it is a thing Ryan opens, not a thing the page can call. */
async function handleAdmin(request, env, url) {
  if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
    return new Response('nope', { status: 404 });
  }
  const list = await env.REACTIONS.list({ prefix: 'r:', limit: 200 });
  const out = (await Promise.all(list.keys.map(k => env.REACTIONS.get(k.name, 'json')))).filter(Boolean);

  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify(out, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
  return new Response(adminPage(out), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function handleChat(request, env, origin) {
  if (!env.OPENROUTER_KEY) return new Response('Not configured', { status: 500, headers: cors(origin) });

  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: cors(origin) }); }

  // Trim the CONVERSATION, never the system prompt. A plain slice(-10) silently drops the
  // first message once a chat runs long, which is exactly the message that tells the model
  // who Ryan is: the bot would keep answering while quietly knowing nothing.
  const all = Array.isArray(body.messages) ? body.messages : null;
  if (!all || !all.length) return new Response('No messages', { status: 400, headers: cors(origin) });
  const sys = all[0] && all[0].role === 'system' ? [all[0]] : [];
  const msgs = sys.concat(all.slice(sys.length).slice(-12));
  // Cap the payload so a caller cannot push a huge context through this key. The system
  // message is ours and carries the whole briefing, so it gets room; everything a visitor
  // can actually type is held short, which is the part that needs limiting.
  for (const m of msgs) {
    const limit = m.role === 'system' ? 24000 : 2000;
    if (typeof m.content !== 'string' || m.content.length > limit) {
      return new Response('Message too long', { status: 400, headers: cors(origin) });
    }
  }

  // Model fallback lives HERE, not in the page. Free models 429 intermittently (measured on
  // both gemma variants while these two answered fine), and doing the retry server-side
  // means one browser request instead of a failed round trip plus a second one. Only the
  // headers are awaited before falling through, so a model that is busy costs milliseconds
  // and nothing has been streamed to the visitor yet.
  let upstream = null;
  for (const model of MODELS) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ryandev1st.github.io/portfolio/',
        'X-Title': 'Ryan Portfolio'
      },
      // 400 truncated real answers mid sentence: a reply that explains something AND hands
      // off with contact details runs past it, and the visitor saw "He is at ryandev..., Gi".
      // 700 leaves room for the handoff to complete. Brevity is enforced by the prompt, not
      // by cutting the model off in the middle of a word.
      body: JSON.stringify({ model, stream: true, max_tokens: 700, temperature: 0.3, messages: msgs })
    });
    if (r.ok) { upstream = r; break; }
    // 4xx that is not a rate limit is our bug (bad payload, bad key): surface it rather
    // than burning the rest of the chain on a request that will fail the same way.
    if (r.status !== 429 && r.status < 500) {
      return new Response(await r.text(), { status: r.status, headers: cors(origin) });
    }
  }
  if (!upstream) return new Response('All models busy', { status: 503, headers: cors(origin) });

  // Pass the stream straight through so the page can render tokens as they arrive.
  return new Response(upstream.body, {
    status: 200,
    headers: { ...cors(origin), 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const ok = ALLOWED.includes(origin);

    if (request.method === 'GET' && url.pathname === '/admin') return handleAdmin(request, env, url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: ok ? 204 : 403, headers: ok ? cors(origin) : {} });
    }
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    if (!ok) return new Response('Origin not allowed', { status: 403 });

    if (url.pathname === '/react') return handleReact(request, env, origin);
    return handleChat(request, env, origin);
  }
};
