'use strict';
const { db } = require('./db');

function renderQueue(c) {
  const rows = db.prepare(`SELECT * FROM queue_items WHERE case_slug=?
    AND status IN ('open','claimed') ORDER BY rank ASC, id ASC`).all(c.slug);
  if (!rows.length) return '(queue empty)';
  const L = [];
  for (const r of rows) {
    const mark = r.status === 'claimed' ? `[CLAIMED by ${r.claimed_by} at ${r.claimed_at}]` : '[open]';
    L.push(`${r.letter}. (${r.lane}) ${mark} ${r.title}`);
    if (r.detail) for (const ln of String(r.detail).split('\n')) L.push(`      ${ln}`);
  }
  const done = db.prepare(`SELECT letter,title,resolution FROM queue_items WHERE case_slug=?
    AND status IN ('done','retired') ORDER BY rank ASC`).all(c.slug);
  if (done.length) {
    L.push('', 'CLOSED OR RETIRED — do not re-queue:');
    for (const d of done) L.push(`  ${d.letter}. ${d.title}${d.resolution ? ' — ' + d.resolution : ''}`);
  }
  return L.join('\n');
}

function renderBrief(c) {
  const L = [];
  const cons = db.prepare(`SELECT * FROM entries WHERE case_slug=? AND kind='consolidation'
    ORDER BY part_no DESC LIMIT 1`).get(c.slug);
  L.push(`CASE: ${c.title}`);
  if (c.subject) L.push(`SUBJECT: ${c.subject}`);
  if (c.question) L.push(`OPEN QUESTION: ${c.question}`);
  L.push(`GENERATED: ${new Date().toISOString()}`, '');
  L.push('HOW TO USE THIS BRIEF');
  L.push('  This is the whole of what you need to read: the newest consolidation,');
  L.push('  every entry written since, and the live queue. Do not reconstruct state');
  L.push('  from anywhere else. Claim an item before working. End your run by');
  L.push('  appending an entry. Entries are immutable — a correction is a new entry.');
  L.push('', '='.repeat(70));
  if (cons) {
    L.push(`CONSOLIDATION — entry ${cons.part_no}, ${cons.agent}, ${cons.stamp}`);
    L.push('='.repeat(70), cons.body);
  } else {
    L.push('NO CONSOLIDATION YET.');
  }
  const since = cons
    ? db.prepare('SELECT * FROM entries WHERE case_slug=? AND part_no>? ORDER BY part_no ASC').all(c.slug, cons.part_no)
    : db.prepare('SELECT * FROM entries WHERE case_slug=? ORDER BY part_no ASC').all(c.slug);
  L.push('', '='.repeat(70), `ENTRIES SINCE THE CONSOLIDATION (${since.length})`, '='.repeat(70));
  if (!since.length) L.push('(none — the consolidation is current)');
  for (const e of since) {
    L.push('', '-'.repeat(70), `ENTRY ${e.part_no} — ${e.agent} — ${e.stamp}`);
    if (e.claimed) L.push(`CLAIMED: ${e.claimed}`);
    if (e.headline) L.push(`HEADLINE: ${e.headline}`);
    L.push('-'.repeat(70), e.body);
  }
  L.push('', '='.repeat(70), 'THE QUEUE — live. Claim before you work.', '='.repeat(70));
  L.push(renderQueue(c));
  const ex = db.prepare('SELECT * FROM exhausted WHERE case_slug=? ORDER BY id ASC').all(c.slug);
  if (ex.length) {
    L.push('', '='.repeat(70), `DO NOT REPEAT — ${ex.length} closed avenues`, '='.repeat(70));
    for (const x of ex) L.push(`- ${x.note}`);
  }
  return L.join('\n');
}

function renderExport(c) {
  const all = db.prepare('SELECT * FROM entries WHERE case_slug=? ORDER BY part_no ASC').all(c.slug);
  const L = [`FULL EXPORT — ${c.title} — ${new Date().toISOString()}`, ''];
  for (const e of all) {
    L.push('='.repeat(70), `ENTRY ${e.part_no} — ${e.agent} — ${e.kind} — ${e.stamp}`);
    if (e.claimed) L.push(`CLAIMED: ${e.claimed}`);
    L.push('='.repeat(70), e.body, '');
  }
  return L.join('\n');
}

function renderCitations(c, p) {
  const ev = db.prepare('SELECT * FROM evidence WHERE person_id=? ORDER BY record_date, id').all(p.id);
  const L = [`SOURCES FOR ${p.display_name.toUpperCase()}`,
             [p.born, p.died].filter(Boolean).join(' – '), p.relation || '', ''];
  ev.forEach((e, i) => {
    L.push(`${i + 1}. ${e.source_title}${e.repository ? ' (' + e.repository + ')' : ''}${e.locator ? ', ' + e.locator : ''}${e.record_date ? ', ' + e.record_date : ''}.`);
    L.push(`   Asserts: ${e.asserts}`);
    if (e.quote) L.push(`   Transcription: "${e.quote}"`);
    if (e.url) L.push(`   ${e.url}`);
    L.push(`   Confidence: ${e.confidence}${e.accessed_at ? ' · accessed ' + e.accessed_at : ''}`, '');
  });
  return L.join('\n');
}

module.exports = { renderBrief, renderQueue, renderExport, renderCitations };
