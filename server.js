'use strict';
const express = require('express');
const { db, DB_PATH } = require('./db');
const ops = require('./ops');
const mcp = require('./mcp');
const { renderBrief, renderQueue, renderExport, renderCitations } = require('./render');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.set('trust proxy', true);

const WRITE_TOKEN = process.env.WRITE_TOKEN || '';
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// MCP endpoint - how agents that cannot make plain HTTP calls reach this service.
app.use('/mcp', mcp.router(WRITE_TOKEN));

app.get(['/health', '/healthz'], (_q, s) => s.json({ status: 'ok', db: DB_PATH, tools: mcp.TOOLS.length }));

/* ------------------------------------------------------------------ API */
function requireToken(req, res, next) {
  const h = req.get('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (req.body && req.body.token) || req.query.token || '';
  if (!WRITE_TOKEN || tok !== WRITE_TOKEN) return res.status(401).json({ error: 'bad or missing token' });
  next();
}
const wrap = fn => (req, res) => {
  try { res.json({ ok: true, result: fn(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
};

app.post('/api/case',      requireToken, wrap(ops.upsertCase));
app.post('/api/entry',     requireToken, wrap(ops.addEntry));
app.post('/api/claim',     requireToken, wrap(ops.claim));
app.post('/api/queue',     requireToken, wrap(ops.upsertQueueItem));
app.post('/api/exhausted', requireToken, wrap(ops.addExhausted));
app.post('/api/person',    requireToken, wrap(ops.upsertPerson));
app.post('/api/evidence',  requireToken, wrap(ops.addEvidence));

/* ------------------------------------------------------------- read URLs */
function requireReadKey(req, res) {
  const c = ops.getCase(req.params.case);
  if (!c) { res.status(404).type('text/plain').send('no such case'); return null; }
  const k = req.query.k || (req.get('authorization') || '').replace(/^Bearer /, '');
  if (k !== c.read_key && k !== WRITE_TOKEN) {
    res.status(403).type('text/plain').send('bad or missing key');
    return null;
  }
  return c;
}
const asText = (res, body) => res.type('text/plain; charset=utf-8').send(body);

app.get('/c/:case/brief',  (q, s) => { const c = requireReadKey(q, s); if (c) asText(s, renderBrief(c)); });
app.get('/c/:case/queue',  (q, s) => { const c = requireReadKey(q, s); if (c) asText(s, renderQueue(c)); });
app.get('/c/:case/export', (q, s) => { const c = requireReadKey(q, s); if (c) asText(s, renderExport(c)); });

/* ------------------------------------------------------------- human UI */
const page = (title, inner) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#faf9f7;--mut:#6b6b6b;--line:#e0ddd8;--acc:#7a4b2a}
@media(prefers-color-scheme:dark){:root{--fg:#e8e6e3;--bg:#17181a;--mut:#9a9a9a;--line:#2e3033;--acc:#c98a5e}}
*{box-sizing:border-box}body{margin:0;padding:2rem 1.25rem 4rem;background:var(--bg);color:var(--fg);
font:15px/1.6 ui-serif,Georgia,serif;max-width:56rem;margin-inline:auto}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:2rem 0 .5rem;color:var(--acc)}
.mut{color:var(--mut);font-size:.85rem}a{color:var(--acc)}
.item{border-left:3px solid var(--line);padding:.35rem 0 .35rem .75rem;margin:.5rem 0}
.tag{font:11px ui-sans-serif,system-ui;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
pre{white-space:pre-wrap;word-wrap:break-word;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
background:color-mix(in srgb,var(--fg) 4%,transparent);padding:1rem;border-radius:6px;overflow-x:auto}
textarea,input,select{width:100%;font:13px ui-monospace,monospace;padding:.6rem;border:1px solid var(--line);
border-radius:6px;background:var(--bg);color:var(--fg)}
button{font:15px ui-serif,Georgia,serif;padding:.55rem 1.1rem;border:0;border-radius:6px;
background:var(--acc);color:#fff;cursor:pointer;margin-top:.75rem}
table{width:100%;border-collapse:collapse;font-size:.9rem}td,th{text-align:left;padding:.4rem .5rem;
border-bottom:1px solid var(--line);vertical-align:top}
</style>${inner}`;

app.get('/', (_q, res) => {
  const cases = db.prepare('SELECT * FROM cases ORDER BY created_at').all();
  res.type('html').send(page('Casefile', `<h1>Casefile</h1>
<p class="mut">Append-only research logs with a claim queue and a citable evidence archive.</p>
${cases.map(c => `<div class="item"><a href="/c/${esc(c.slug)}">${esc(c.title)}</a>
<div class="mut">${esc(c.subject || '')}</div></div>`).join('') || '<p class="mut">No cases yet.</p>'}`));
});

app.get('/c/:case', (req, res) => {
  const c = ops.getCase(req.params.case);
  if (!c) return res.status(404).type('html').send(page('Not found', '<h1>No such case</h1>'));
  const entries = db.prepare('SELECT * FROM entries WHERE case_slug=? ORDER BY part_no DESC LIMIT 25').all(c.slug);
  const persons = db.prepare('SELECT * FROM persons WHERE case_slug=? ORDER BY status, display_name').all(c.slug);
  const nEv = db.prepare('SELECT COUNT(*) n FROM evidence WHERE case_slug=?').get(c.slug).n;
  const nEnt = db.prepare('SELECT COUNT(*) n FROM entries WHERE case_slug=?').get(c.slug).n;
  res.type('html').send(page(c.title, `
<h1>${esc(c.title)}</h1>
<p class="mut">${esc(c.subject || '')}</p>
${c.question ? `<p><strong>Still open:</strong> ${esc(c.question)}</p>` : ''}
<p class="mut">${nEnt} entries &middot; ${nEv} pieces of evidence &middot; <a href="/c/${esc(c.slug)}/paste">paste an entry</a></p>
<h2>Queue</h2><pre>${esc(renderQueue(c))}</pre>
<h2>People</h2>
<table><tr><th>Name</th><th>Dates</th><th>Relation</th><th>Status</th></tr>
${persons.map(p => `<tr><td><a href="/c/${esc(c.slug)}/p/${esc(p.slug)}">${esc(p.display_name)}</a></td>
<td>${esc([p.born, p.died].filter(Boolean).join(' - '))}</td><td>${esc(p.relation || '')}</td>
<td class="tag">${esc(p.status)}</td></tr>`).join('') || '<tr><td colspan="4" class="mut">none yet</td></tr>'}</table>
<h2>Recent entries</h2>
${entries.map(e => `<div class="item"><span class="tag">${e.part_no} &middot; ${esc(e.agent)} &middot; ${esc(e.stamp)}</span><br>
${esc(e.headline || (e.claimed ? 'claimed: ' + e.claimed : '') || '(entry)')}</div>`).join('')}`));
});

app.get('/c/:case/p/:person', (req, res) => {
  const c = ops.getCase(req.params.case);
  if (!c) return res.status(404).type('html').send(page('Not found', '<h1>No such case</h1>'));
  const p = db.prepare('SELECT * FROM persons WHERE case_slug=? AND slug=?').get(c.slug, req.params.person);
  if (!p) return res.status(404).type('html').send(page('Not found', '<h1>No such person</h1>'));
  const ev = db.prepare('SELECT * FROM evidence WHERE person_id=? ORDER BY record_date, id').all(p.id);
  res.type('html').send(page(p.display_name, `
<p class="mut"><a href="/c/${esc(c.slug)}">&larr; ${esc(c.title)}</a></p>
<h1>${esc(p.display_name)}</h1>
<p class="mut">${esc([p.born, p.died].filter(Boolean).join(' - '))}${p.relation ? ' &middot; ' + esc(p.relation) : ''} &middot; <span class="tag">${esc(p.status)}</span></p>
${p.aka ? `<p class="mut">Also recorded as: ${esc(p.aka)}</p>` : ''}
${p.notes ? `<p>${esc(p.notes)}</p>` : ''}
<p><a href="/c/${esc(c.slug)}/p/${esc(p.slug)}/citations.txt">citations.txt</a> &mdash; ready to paste onto a tree profile</p>
<h2>Evidence (${ev.length})</h2>
${ev.map(e => `<div class="item"><span class="tag">${esc(e.confidence)}${e.record_date ? ' &middot; ' + esc(e.record_date) : ''}${e.kind ? ' &middot; ' + esc(e.kind) : ''}</span>
<div><strong>${esc(e.asserts)}</strong></div>
<div class="mut">${esc(e.source_title)}${e.repository ? ' &mdash; ' + esc(e.repository) : ''}${e.locator ? ', ' + esc(e.locator) : ''}</div>
${e.quote ? `<div style="margin:.35rem 0;padding-left:.75rem;border-left:2px solid var(--line)">&ldquo;${esc(e.quote)}&rdquo;</div>` : ''}
${e.url ? `<div class="mut"><a href="${esc(e.url)}">${esc(e.url)}</a></div>` : ''}</div>`).join('') || '<p class="mut">none yet</p>'}`));
});

app.get('/c/:case/p/:person/citations.txt', (req, res) => {
  const c = ops.getCase(req.params.case);
  if (!c) return res.status(404).type('text/plain').send('no such case');
  const p = db.prepare('SELECT * FROM persons WHERE case_slug=? AND slug=?').get(c.slug, req.params.person);
  if (!p) return res.status(404).type('text/plain').send('no such person');
  asText(res, renderCitations(c, p));
});

app.get('/c/:case/paste', (req, res) => {
  const c = ops.getCase(req.params.case);
  if (!c) return res.status(404).type('html').send(page('Not found', '<h1>No such case</h1>'));
  res.type('html').send(page('Paste an entry', `
<p class="mut"><a href="/c/${esc(c.slug)}">&larr; ${esc(c.title)}</a></p>
<h1>Paste an entry</h1>
<p class="mut">Drop the block an agent produced. The number is assigned here, so it cannot fork.</p>
<form method="post" action="/c/${esc(c.slug)}/paste">
<p><input name="token" type="password" placeholder="write token" autocomplete="off"></p>
<p><select name="agent"><option>ChatGPT</option><option>Claude</option><option>Ted</option></select></p>
<p><input name="claimed" placeholder="CLAIMED: (optional - the queue item worked)"></p>
<p><textarea name="body" rows="22" placeholder="Checked: / Found: / Sources: / Do Not Repeat: / Next:"></textarea></p>
<button>Append entry</button></form>`));
});

app.post('/c/:case/paste', (req, res) => {
  const c = ops.getCase(req.params.case);
  if (!c) return res.status(404).type('html').send(page('Not found', '<h1>No such case</h1>'));
  if (!WRITE_TOKEN || req.body.token !== WRITE_TOKEN)
    return res.status(401).type('html').send(page('Nope',
      '<h1>Bad token</h1><p><a href="javascript:history.back()">back</a></p>'));
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).type('html').send(page('Empty', '<h1>Nothing to append</h1>'));
  let claimed = String(req.body.claimed || '').trim() || null;
  const m = body.match(/^\s*CLAIMED:\s*(.+)$/im);
  if (!claimed && m) claimed = m[1].trim();
  try {
    const r = ops.addEntry({ case: c.slug, agent: req.body.agent || 'ChatGPT', body, claimed });
    res.type('html').send(page('Filed', `<h1>Filed as entry ${r.part_no}</h1>
<p class="mut">Immutable. A correction is a new entry, never an edit.</p>
<p><a href="/c/${esc(c.slug)}">back to the case</a> &middot; <a href="/c/${esc(c.slug)}/paste">paste another</a></p>`));
  } catch (e) {
    res.status(400).type('html').send(page('Error', `<h1>${esc(e.message)}</h1>`));
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`casefile up on ${PORT}, db ${DB_PATH}, ${mcp.TOOLS.length} mcp tools`));
