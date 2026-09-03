'use strict';
const express = require('express');
const crypto = require('crypto');
const { db, DB_PATH } = require('./db');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.set('trust proxy', true);

const WRITE_TOKEN = process.env.WRITE_TOKEN || '';
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function requireToken(req, res, next) {
  const h = req.get('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (req.body && req.body.token) || req.query.token || '';
  if (!WRITE_TOKEN || tok !== WRITE_TOKEN) return res.status(401).json({ error: 'bad or missing token' });
  next();
}

function getCase(slug) {
  return db.prepare('SELECT * FROM cases WHERE slug = ?').get(slug);
}
function requireReadKey(req, res) {
  const c = getCase(req.params.case);
  if (!c) { res.status(404).type('text/plain').send('no such case'); return null; }
  const k = req.query.k || (req.get('authorization') || '').replace(/^Bearer /, '');
  if (k !== c.read_key && k !== WRITE_TOKEN) {
    res.status(403).type('text/plain').send('bad or missing key');
    return null;
  }
  return c;
}

/* ---------------------------------------------------------------- health */
app.get(['/health', '/healthz'], (_q, s) => s.json({ status: 'ok', db: DB_PATH }));

/* ------------------------------------------------------------------ API */

// Create or update a case (title/subject/question only; never destructive).
app.post('/api/case', requireToken, (req, res) => {
  const { slug, title, subject, question } = req.body || {};
  if (!slug || !title) return res.status(400).json({ error: 'slug and title required' });
  const existing = getCase(slug);
  if (existing) {
    db.prepare('UPDATE cases SET title=?, subject=COALESCE(?,subject), question=COALESCE(?,question) WHERE slug=?')
      .run(title, subject ?? null, question ?? null, slug);
    return res.json({ ok: true, case: getCase(slug) });
  }
  const read_key = crypto.randomBytes(16).toString('base64url');
  db.prepare('INSERT INTO cases (slug,title,subject,question,read_key) VALUES (?,?,?,?,?)')
    .run(slug, title, subject ?? null, question ?? null, read_key);
  res.json({ ok: true, case: getCase(slug) });
});

// Append an entry. Server assigns the number; entries are never mutated.
app.post('/api/entry', requireToken, (req, res) => {
  const { case: slug, agent, body, kind, claimed, headline, stamp } = req.body || {};
  if (!slug || !agent || !body) return res.status(400).json({ error: 'case, agent, body required' });
  if (!getCase(slug)) return res.status(404).json({ error: 'no such case' });
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT COALESCE(MAX(part_no),0) AS n FROM entries WHERE case_slug=?').get(slug);
    const part_no = row.n + 1;
    const info = db.prepare(
      `INSERT INTO entries (case_slug,part_no,agent,kind,claimed,headline,body,stamp)
       VALUES (?,?,?,?,?,?,?,COALESCE(?, datetime('now')))`
    ).run(slug, part_no, agent, kind || 'run', claimed ?? null, headline ?? null, body, stamp ?? null);
    return { part_no, id: info.lastInsertRowid };
  });
  const out = tx();
  // Mark a claimed item as answered by this entry, if it matches a letter.
  if (claimed) {
    const letter = String(claimed).trim().split(/[\s.:—-]/)[0];
    db.prepare(`UPDATE queue_items SET claim_entry=? WHERE case_slug=? AND letter=? AND claim_entry IS NULL`)
      .run(out.id, slug, letter);
  }
  res.json({ ok: true, ...out });
});

// Atomically claim the first open item this agent can execute.
app.post('/api/claim', requireToken, (req, res) => {
  const { case: slug, agent, lanes, letter } = req.body || {};
  if (!slug || !agent) return res.status(400).json({ error: 'case and agent required' });
  const laneList = Array.isArray(lanes) && lanes.length ? lanes : null;
  const tx = db.transaction(() => {
    let item;
    if (letter) {
      item = db.prepare(`SELECT * FROM queue_items WHERE case_slug=? AND letter=? AND status='open'`).get(slug, letter);
    } else if (laneList) {
      const qs = laneList.map(() => '?').join(',');
      item = db.prepare(
        `SELECT * FROM queue_items WHERE case_slug=? AND status='open' AND lane IN (${qs})
         ORDER BY rank ASC, id ASC LIMIT 1`).get(slug, ...laneList);
    } else {
      item = db.prepare(
        `SELECT * FROM queue_items WHERE case_slug=? AND status='open'
         ORDER BY rank ASC, id ASC LIMIT 1`).get(slug);
    }
    if (!item) return null;
    db.prepare(`UPDATE queue_items SET status='claimed', claimed_by=?, claimed_at=datetime('now') WHERE id=?`)
      .run(agent, item.id);
    return db.prepare('SELECT * FROM queue_items WHERE id=?').get(item.id);
  });
  const item = tx();
  if (!item) return res.json({ ok: true, item: null, note: 'nothing open in those lanes' });
  res.json({ ok: true, item });
});

// Add, re-rank, or retire a queue item.
app.post('/api/queue', requireToken, (req, res) => {
  const { case: slug, letter, title, detail, lane, rank, status, resolution } = req.body || {};
  if (!slug || !letter) return res.status(400).json({ error: 'case and letter required' });
  const existing = db.prepare('SELECT * FROM queue_items WHERE case_slug=? AND letter=?').get(slug, letter);
  if (existing) {
    db.prepare(`UPDATE queue_items SET title=COALESCE(?,title), detail=COALESCE(?,detail),
      lane=COALESCE(?,lane), rank=COALESCE(?,rank), status=COALESCE(?,status),
      resolution=COALESCE(?,resolution) WHERE id=?`)
      .run(title ?? null, detail ?? null, lane ?? null, rank ?? null, status ?? null, resolution ?? null, existing.id);
    return res.json({ ok: true, item: db.prepare('SELECT * FROM queue_items WHERE id=?').get(existing.id) });
  }
  if (!title) return res.status(400).json({ error: 'title required for a new item' });
  const info = db.prepare(
    `INSERT INTO queue_items (case_slug,letter,title,detail,lane,rank,status)
     VALUES (?,?,?,?,?,?,?)`
  ).run(slug, letter, title, detail ?? null, lane || 'agent', rank ?? 100, status || 'open');
  res.json({ ok: true, item: db.prepare('SELECT * FROM queue_items WHERE id=?').get(info.lastInsertRowid) });
});

// Record an exhausted avenue (the do-not-repeat list).
app.post('/api/exhausted', requireToken, (req, res) => {
  const { case: slug, note, entry_id } = req.body || {};
  if (!slug || !note) return res.status(400).json({ error: 'case and note required' });
  const info = db.prepare('INSERT INTO exhausted (case_slug,note,entry_id) VALUES (?,?,?)')
    .run(slug, note, entry_id ?? null);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// Register a person (family or excluded same-name).
app.post('/api/person', requireToken, (req, res) => {
  const { case: slug, slug: pslug, display_name, aka, born, died, relation, status, tree_id, notes } = req.body || {};
  if (!slug || !pslug || !display_name) return res.status(400).json({ error: 'case, slug, display_name required' });
  const existing = db.prepare('SELECT * FROM persons WHERE case_slug=? AND slug=?').get(slug, pslug);
  if (existing) {
    db.prepare(`UPDATE persons SET display_name=?, aka=COALESCE(?,aka), born=COALESCE(?,born),
      died=COALESCE(?,died), relation=COALESCE(?,relation), status=COALESCE(?,status),
      tree_id=COALESCE(?,tree_id), notes=COALESCE(?,notes) WHERE id=?`)
      .run(display_name, aka ?? null, born ?? null, died ?? null, relation ?? null,
           status ?? null, tree_id ?? null, notes ?? null, existing.id);
    return res.json({ ok: true, id: existing.id });
  }
  const info = db.prepare(
    `INSERT INTO persons (case_slug,slug,display_name,aka,born,died,relation,status,tree_id,notes)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(slug, pslug, display_name, aka ?? null, born ?? null, died ?? null,
        relation ?? null, status || 'family', tree_id ?? null, notes ?? null);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// Attach citable evidence to a person.
app.post('/api/evidence', requireToken, (req, res) => {
  const b = req.body || {};
  if (!b.case || !b.person || !b.asserts || !b.source_title)
    return res.status(400).json({ error: 'case, person, asserts, source_title required' });
  const p = db.prepare('SELECT * FROM persons WHERE case_slug=? AND slug=?').get(b.case, b.person);
  if (!p) return res.status(404).json({ error: 'no such person; POST /api/person first' });
  const info = db.prepare(
    `INSERT INTO evidence (case_slug,person_id,kind,asserts,record_date,source_title,repository,
       locator,url,quote,confidence,entry_id,accessed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(b.case, p.id, b.kind ?? null, b.asserts, b.record_date ?? null, b.source_title,
        b.repository ?? null, b.locator ?? null, b.url ?? null, b.quote ?? null,
        b.confidence || 'CANDIDATE', b.entry_id ?? null, b.accessed_at ?? null);
  res.json({ ok: true, id: info.lastInsertRowid });
});

/* --------------------------------------------------------------- render */

function renderBrief(c) {
  const L = [];
  const cons = db.prepare(
    `SELECT * FROM entries WHERE case_slug=? AND kind='consolidation' ORDER BY part_no DESC LIMIT 1`
  ).get(c.slug);
  L.push(`CASE: ${c.title}`);
  if (c.subject) L.push(`SUBJECT: ${c.subject}`);
  if (c.question) L.push(`OPEN QUESTION: ${c.question}`);
  L.push(`GENERATED: ${new Date().toISOString()}`);
  L.push('');
  L.push('HOW TO USE THIS BRIEF');
  L.push('  This is the whole of what you need to read. It is the newest');
  L.push('  consolidation plus every entry written since, in order, plus the');
  L.push('  live queue. Do not reconstruct state from anywhere else.');
  L.push('  Claim an item before working: POST /api/claim.');
  L.push('  End your run by appending an entry: POST /api/entry.');
  L.push('  Entries are immutable. Corrections are new entries, never edits.');
  L.push('');
  L.push('='.repeat(70));
  if (cons) {
    L.push(`CONSOLIDATION — entry ${cons.part_no}, ${cons.agent}, ${cons.stamp}`);
    L.push('='.repeat(70));
    L.push(cons.body);
  } else {
    L.push('NO CONSOLIDATION YET.');
  }
  const since = cons
    ? db.prepare('SELECT * FROM entries WHERE case_slug=? AND part_no>? ORDER BY part_no ASC').all(c.slug, cons.part_no)
    : db.prepare('SELECT * FROM entries WHERE case_slug=? ORDER BY part_no ASC').all(c.slug);
  L.push('');
  L.push('='.repeat(70));
  L.push(`ENTRIES SINCE THE CONSOLIDATION (${since.length})`);
  L.push('='.repeat(70));
  if (!since.length) L.push('(none — the consolidation is current)');
  for (const e of since) {
    L.push('');
    L.push('-'.repeat(70));
    L.push(`ENTRY ${e.part_no} — ${e.agent} — ${e.stamp}`);
    if (e.claimed) L.push(`CLAIMED: ${e.claimed}`);
    if (e.headline) L.push(`HEADLINE: ${e.headline}`);
    L.push('-'.repeat(70));
    L.push(e.body);
  }
  L.push('');
  L.push('='.repeat(70));
  L.push('THE QUEUE — live. Claim before you work.');
  L.push('='.repeat(70));
  L.push(renderQueue(c));
  const ex = db.prepare('SELECT * FROM exhausted WHERE case_slug=? ORDER BY id ASC').all(c.slug);
  if (ex.length) {
    L.push('');
    L.push('='.repeat(70));
    L.push(`DO NOT REPEAT — ${ex.length} closed avenues`);
    L.push('='.repeat(70));
    for (const x of ex) L.push(`- ${x.note}`);
  }
  return L.join('\n');
}

function renderQueue(c) {
  const rows = db.prepare(
    `SELECT * FROM queue_items WHERE case_slug=? AND status IN ('open','claimed')
     ORDER BY rank ASC, id ASC`).all(c.slug);
  if (!rows.length) return '(queue empty)';
  const L = [];
  for (const r of rows) {
    const mark = r.status === 'claimed' ? `[CLAIMED by ${r.claimed_by} at ${r.claimed_at}]` : `[open]`;
    L.push(`${r.letter}. (${r.lane}) ${mark} ${r.title}`);
    if (r.detail) for (const ln of String(r.detail).split('\n')) L.push(`      ${ln}`);
  }
  const done = db.prepare(
    `SELECT letter,title,resolution FROM queue_items WHERE case_slug=? AND status IN ('done','retired')
     ORDER BY rank ASC`).all(c.slug);
  if (done.length) {
    L.push('');
    L.push('CLOSED OR RETIRED — do not re-queue:');
    for (const d of done) L.push(`  ${d.letter}. ${d.title}${d.resolution ? ' — ' + d.resolution : ''}`);
  }
  return L.join('\n');
}

app.get('/c/:case/brief', (req, res) => {
  const c = requireReadKey(req, res); if (!c) return;
  res.type('text/plain; charset=utf-8').send(renderBrief(c));
});

app.get('/c/:case/queue', (req, res) => {
  const c = requireReadKey(req, res); if (!c) return;
  res.type('text/plain; charset=utf-8').send(renderQueue(c));
});

app.get('/c/:case/export', (req, res) => {
  const c = requireReadKey(req, res); if (!c) return;
  const all = db.prepare('SELECT * FROM entries WHERE case_slug=? ORDER BY part_no ASC').all(c.slug);
  const L = [`FULL EXPORT — ${c.title} — ${new Date().toISOString()}`, ''];
  for (const e of all) {
    L.push('='.repeat(70));
    L.push(`ENTRY ${e.part_no} — ${e.agent} — ${e.kind} — ${e.stamp}`);
    if (e.claimed) L.push(`CLAIMED: ${e.claimed}`);
    L.push('='.repeat(70));
    L.push(e.body, '');
  }
  res.type('text/plain; charset=utf-8').send(L.join('\n'));
});

/* ------------------------------------------------------------ human UI */
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
.item.claimed{border-left-color:var(--acc)}
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
  const c = getCase(req.params.case);
  if (!c) return res.status(404).type('html').send(page('Not found', '<h1>No such case</h1>'));
  const entries = db.prepare('SELECT * FROM entries WHERE case_slug=? ORDER BY part_no DESC LIMIT 25').all(c.slug);
  const persons = db.prepare('SELECT * FROM persons WHERE case_slug=? ORDER BY status, display_name').all(c.slug);
  const nEv = db.prepare('SELECT COUNT(*) n FROM evidence WHERE case_slug=?').get(c.slug).n;
  const nEnt = db.prepare('SELECT COUNT(*) n FROM entries WHERE case_slug=?').get(c.slug).n;
  res.type('html').send(page(c.title, `
<h1>${esc(c.title)}</h1>
<p class="mut">${esc(c.subject || '')}</p>
${c.question ? `<p><strong>Still open:</strong> ${esc(c.question)}</p>` : ''}
<p class="mut">${nEnt} entries · ${nEv} pieces of evidence · <a href="/c/${esc(c.slug)}/paste">paste an entry</a></p>
<h2>Queue</h2><pre>${esc(renderQueue(c))}</pre>
<h2>People</h2>
<table><tr><th>Name</th><th>Dates</th><th>Relation</th><th>Status</th></tr>
${persons.map(p => `<tr><td><a href="/c/${esc(c.slug)}/p/${esc(p.slug)}">${esc(p.display_name)}</a></td>
<td>${esc([p.born, p.died].filter(Boolean).join(' – '))}</td><td>${esc(p.relation || '')}</td>
<td class="tag">${esc(p.status)}</td></tr>`).join('') || '<tr><td colspan="4" class="mut">none yet</td></tr>'}</table>
<h2>Recent entries</h2>
${entries.map(e => `<div class="item"><span class="tag">${e.part_no} · ${esc(e.agent)} · ${esc(e.stamp)}</span><br>
${esc(e.headline || (e.claimed ? 'claimed: ' + e.claimed : '') || '(entry)')}</div>`).join('')}
`));
});

app.get('/c/:case/p/:person', (req, res) => {
  const c = getCase(req.params.case);
  if (!c) return res.status(404).type('html').send(page('Not found', '<h1>No such case</h1>'));
  const p = db.prepare('SELECT * FROM persons WHERE case_slug=? AND slug=?').get(c.slug, req.params.person);
  if (!p) return res.status(404).type('html').send(page('Not found', '<h1>No such person</h1>'));
  const ev = db.prepare('SELECT * FROM evidence WHERE person_id=? ORDER BY record_date, id').all(p.id);
  res.type('html').send(page(p.display_name, `
<p class="mut"><a href="/c/${esc(c.slug)}">&larr; ${esc(c.title)}</a></p>
<h1>${esc(p.display_name)}</h1>
<p class="mut">${esc([p.born, p.died].filter(Boolean).join(' – '))}${p.relation ? ' · ' + esc(p.relation) : ''} · <span class="tag">${esc(p.status)}</span></p>
${p.aka ? `<p class="mut">Also recorded as: ${esc(p.aka)}</p>` : ''}
${p.notes ? `<p>${esc(p.notes)}</p>` : ''}
<p><a href="/c/${esc(c.slug)}/p/${esc(p.slug)}/citations.txt">citations.txt</a> — ready to paste onto a tree profile</p>
<h2>Evidence (${ev.length})</h2>
${ev.map(e => `<div class="item"><span class="tag">${esc(e.confidence)}${e.record_date ? ' · ' + esc(e.record_date) : ''}${e.kind ? ' · ' + esc(e.kind) : ''}</span>
<div><strong>${esc(e.asserts)}</strong></div>
<div class="mut">${esc(e.source_title)}${e.repository ? ' — ' + esc(e.repository) : ''}${e.locator ? ', ' + esc(e.locator) : ''}</div>
${e.quote ? `<div style="margin:.35rem 0;padding-left:.75rem;border-left:2px solid var(--line)">“${esc(e.quote)}”</div>` : ''}
${e.url ? `<div class="mut"><a href="${esc(e.url)}">${esc(e.url)}</a></div>` : ''}</div>`).join('') || '<p class="mut">none yet</p>'}
`));
});

app.get('/c/:case/p/:person/citations.txt', (req, res) => {
  const c = getCase(req.params.case);
  if (!c) return res.status(404).type('text/plain').send('no such case');
  const p = db.prepare('SELECT * FROM persons WHERE case_slug=? AND slug=?').get(c.slug, req.params.person);
  if (!p) return res.status(404).type('text/plain').send('no such person');
  const ev = db.prepare('SELECT * FROM evidence WHERE person_id=? ORDER BY record_date, id').all(p.id);
  const L = [`SOURCES FOR ${p.display_name.toUpperCase()}`,
             [p.born, p.died].filter(Boolean).join(' – '), p.relation || '', ''];
  ev.forEach((e, i) => {
    L.push(`${i + 1}. ${e.source_title}${e.repository ? ' (' + e.repository + ')' : ''}${e.locator ? ', ' + e.locator : ''}${e.record_date ? ', ' + e.record_date : ''}.`);
    L.push(`   Asserts: ${e.asserts}`);
    if (e.quote) L.push(`   Transcription: "${e.quote}"`);
    if (e.url) L.push(`   ${e.url}`);
    L.push(`   Confidence: ${e.confidence}${e.accessed_at ? ' · accessed ' + e.accessed_at : ''}`);
    L.push('');
  });
  res.type('text/plain; charset=utf-8').send(L.join('\n'));
});

app.get('/c/:case/paste', (req, res) => {
  const c = getCase(req.params.case);
  if (!c) return res.status(404).type('html').send(page('Not found', '<h1>No such case</h1>'));
  res.type('html').send(page('Paste an entry', `
<p class="mut"><a href="/c/${esc(c.slug)}">&larr; ${esc(c.title)}</a></p>
<h1>Paste an entry</h1>
<p class="mut">Drop the block an agent produced. The number is assigned here, so it cannot fork.</p>
<form method="post" action="/c/${esc(c.slug)}/paste">
<p><input name="token" type="password" placeholder="write token" autocomplete="off"></p>
<p><select name="agent"><option>ChatGPT</option><option>Claude</option><option>Ted</option></select></p>
<p><input name="claimed" placeholder="CLAIMED: (optional — the queue item worked)"></p>
<p><textarea name="body" rows="22" placeholder="Checked: / Found: / Sources: / Do Not Repeat: / Next:"></textarea></p>
<button>Append entry</button></form>`));
});

app.post('/c/:case/paste', (req, res) => {
  const c = getCase(req.params.case);
  if (!c) return res.status(404).type('html').send(page('Not found', '<h1>No such case</h1>'));
  if (!WRITE_TOKEN || req.body.token !== WRITE_TOKEN)
    return res.status(401).type('html').send(page('Nope', '<h1>Bad token</h1><p><a href="javascript:history.back()">back</a></p>'));
  let body = String(req.body.body || '').trim();
  if (!body) return res.status(400).type('html').send(page('Empty', '<h1>Nothing to append</h1>'));
  let claimed = String(req.body.claimed || '').trim() || null;
  const m = body.match(/^\s*CLAIMED:\s*(.+)$/im);
  if (!claimed && m) claimed = m[1].trim();
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT COALESCE(MAX(part_no),0) AS n FROM entries WHERE case_slug=?').get(c.slug);
    const part_no = row.n + 1;
    db.prepare(`INSERT INTO entries (case_slug,part_no,agent,kind,claimed,body) VALUES (?,?,?,'run',?,?)`)
      .run(c.slug, part_no, req.body.agent || 'ChatGPT', claimed, body);
    return part_no;
  });
  const n = tx();
  res.type('html').send(page('Filed', `<h1>Filed as entry ${n}</h1>
<p class="mut">Immutable. A correction is a new entry, never an edit.</p>
<p><a href="/c/${esc(c.slug)}">back to the case</a> · <a href="/c/${esc(c.slug)}/paste">paste another</a></p>`));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`casefile up on ${PORT}, db ${DB_PATH}`));
