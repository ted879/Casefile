'use strict';
const { db } = require('./db');

// The brief is BOUNDED. It used to render every entry since the consolidation
// in full, plus every queue item's full detail, plus every do-not-repeat note —
// which on the susz case reached 1.2 million characters and could no longer be
// read in one pass by the very agents instructed to read it first. Nothing is
// deleted here; the detail moved one call away.
const BRIEF_CAP = Number(process.env.BRIEF_MAX_CHARS || 60000);

const oneLine = (s, n) => {
  if (s == null) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
};
const rule = n => '='.repeat(n);

function stepSummary(slug, letter) {
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM queue_steps
    WHERE case_slug=? AND letter=? GROUP BY status`).all(slug, letter);
  const total = rows.reduce((a, r) => a + r.n, 0);
  if (!total) return '';
  const pick = s => (rows.find(r => r.status === s) || { n: 0 }).n;
  const blocked = pick('blocked');
  return `  [steps ${pick('done')}/${total} done${blocked ? `, ${blocked} blocked` : ''}]`;
}

// detail defaults to OFF. A queue item's detail runs to thousands of words in a
// live case; casefile_queue_get returns one item's detail when it is needed.
function renderQueue(c, opts = {}) {
  const detail = !!opts.detail;
  const titleLen = Number(opts.titleLen) || 220;
  const rows = db.prepare(`SELECT * FROM queue_items WHERE case_slug=?
    AND status IN ('open','claimed') ORDER BY rank ASC, id ASC`).all(c.slug);
  const L = [];
  if (!rows.length) {
    L.push('(queue empty)');
  } else {
    for (const r of rows) {
      const mark = r.status === 'claimed' ? `[CLAIMED by ${r.claimed_by} at ${r.claimed_at}]` : '[open]';
      L.push(`${r.letter}. (${r.lane}) ${mark} ${oneLine(r.title, detail ? 100000 : titleLen)}${stepSummary(c.slug, r.letter)}`);
      if (detail) {
        const steps = db.prepare(`SELECT step,title,status,note FROM queue_steps
          WHERE case_slug=? AND letter=? ORDER BY rank ASC, step ASC`).all(c.slug, r.letter);
        for (const s of steps) {
          L.push(`      (${s.status}) ${s.step}${s.title ? ' — ' + s.title : ''}${s.note ? ' — ' + s.note : ''}`);
        }
        if (r.detail) for (const ln of String(r.detail).split('\n')) L.push(`      ${ln}`);
      }
    }
    if (!detail) L.push('', 'Titles only. Full text and steps of one item: casefile_queue_get { case, letter }.');
  }
  const done = db.prepare(`SELECT letter,title,resolution FROM queue_items WHERE case_slug=?
    AND status IN ('done','retired') ORDER BY rank ASC`).all(c.slug);
  if (done.length) {
    L.push('', `CLOSED OR RETIRED (${done.length}) — do not re-queue:`);
    for (const d of done) {
      L.push(`  ${d.letter}. ${oneLine(d.title, 160)}${d.resolution ? ' — ' + oneLine(d.resolution, 160) : ''}`);
    }
  }
  return L.join('\n');
}

function renderDoctrine(c) {
  const rows = db.prepare('SELECT * FROM doctrine WHERE case_slug=? ORDER BY rank ASC, section ASC').all(c.slug);
  const L = [];
  if (!rows.length) {
    L.push('(no doctrine sections yet — this case\'s standing state still lives inside the');
    L.push(' consolidation below, where a later consolidation can hide it. Move it out with');
    L.push(' casefile_doctrine_set { case, section, body }: identity anchors, method rules,');
    L.push(' the access map, spelling and folding rules, instrument behaviour.)');
    return L.join('\n');
  }
  for (const d of rows) {
    L.push('', `--- ${d.section.toUpperCase()} ---  (updated ${d.updated_at}${d.updated_by ? ' by ' + d.updated_by : ''})`);
    L.push(d.body);
  }
  return L.join('\n').replace(/^\n/, '');
}

function renderBrief(c, opts = {}) {
  const full = !!opts.full;
  const since = opts.since == null ? null : Number(opts.since);
  const wantEntries = opts.full_entries == null ? 1 : Math.max(0, Number(opts.full_entries) || 0);

  // When the brief will not fit, degrade in a fixed order of least to most
  // damaging. The do-not-repeat list and the queue are the two things a run
  // cannot work safely without, so they are shortened per row but never cut
  // off, and the assembled text is never blind-sliced at the tail.
  const st = { fullEntries: wantEntries, exLen: 300, idxLimit: Infinity, qTitle: 220, consMax: Infinity };
  const DEGRADE = [
    ['fullEntries', 0,    'the most recent entry bodies were dropped — read them with casefile_entry_read'],
    ['exLen',       150,  'do-not-repeat notes were trimmed to 150 characters'],
    ['idxLimit',    40,   'the entry index was cut to the 40 most recent — use casefile_search for older ones'],
    ['qTitle',      120,  'queue titles were shortened to 120 characters'],
    ['exLen',       90,   'do-not-repeat notes were trimmed to 90 characters'],
    ['idxLimit',    15,   'the entry index was cut to the 15 most recent'],
    ['consMax',     8000, 'the consolidation body was truncated — read it whole with casefile_entry_read'],
    ['consMax',     3000, 'the consolidation body was truncated hard — read it whole with casefile_entry_read']
  ];

  const build = notes => {
    const L = [];
    L.push(`CASE: ${c.title}`);
    if (c.subject) L.push(`SUBJECT: ${c.subject}`);
    if (c.question) L.push(`OPEN QUESTION: ${c.question}`);
    L.push(`GENERATED: ${new Date().toISOString()}`, '');

    L.push('HOW TO USE THIS BRIEF');
    if (full) {
      L.push('  UNBOUNDED MODE (full:true) — every entry since the consolidation in full,');
      L.push('  every queue item\'s detail, every do-not-repeat note. This can be very large.');
    } else {
      L.push('  This brief is BOUNDED so it always fits in one read. It carries the case');
      L.push('  doctrine, the newest consolidation, an index of the entries since, the newest');
      L.push('  entry in full, the whole queue as titles, and the whole do-not-repeat list.');
      L.push('  NOTHING HAS BEEN DELETED — the full text of anything named here is one call');
      L.push('  away:');
      L.push('    casefile_entry_read     { case, entry }      one entry, complete');
      L.push('    casefile_queue_get      { case, letter }     one queue item, with its steps');
      L.push('    casefile_exhausted_read { case, id }         one do-not-repeat note in full');
      L.push('    casefile_search         { case, q }          which entry or note said this');
      L.push('    casefile_brief          { case, full: true } the unbounded brief');
      if (notes && notes.length) {
        L.push('');
        L.push(`  THIS BRIEF WAS COMPRESSED TO FIT ${BRIEF_CAP} CHARACTERS:`);
        for (const n of notes) L.push(`    - ${n}`);
      }
    }
    L.push('  Do not reconstruct state from anywhere else. Claim an item before working.');
    L.push('  End your run by appending an entry. Entries are immutable — a correction is');
    L.push('  a new entry, never an edit.');

    L.push('', rule(70), 'DOCTRINE — the standing state of this case.', rule(70));
    L.push('Mutable, versioned, and never hidden by a consolidation. If it contradicts an');
    L.push('older entry, doctrine wins.');
    L.push(renderDoctrine(c));

    const cons = db.prepare(`SELECT * FROM entries WHERE case_slug=? AND kind='consolidation'
      ORDER BY part_no DESC LIMIT 1`).get(c.slug);
    L.push('', rule(70));
    if (cons) {
      L.push(`CONSOLIDATION — entry ${cons.part_no}, ${cons.agent}, ${cons.stamp}`);
      L.push(rule(70));
      if (!full && cons.body.length > st.consMax) {
        L.push(cons.body.slice(0, st.consMax));
        L.push(`\n[… consolidation truncated at ${st.consMax} of ${cons.body.length} characters —`);
        L.push(`   read it whole with casefile_entry_read { case, entry: ${cons.part_no} } …]`);
      } else {
        L.push(cons.body);
      }
      const older = db.prepare(`SELECT part_no, agent, stamp, headline FROM entries
        WHERE case_slug=? AND kind='consolidation' AND part_no<? ORDER BY part_no DESC`)
        .all(c.slug, cons.part_no);
      if (older.length) {
        L.push('', '-'.repeat(70));
        L.push(`SUPERSEDED CONSOLIDATIONS (${older.length}) — NOT shown above.`);
        L.push('If the consolidation above does not carry something you expected to find, it');
        L.push('may be in one of these. Read one with casefile_entry_read.');
        for (const o of older) {
          L.push(`  entry ${o.part_no} — ${o.agent} — ${o.stamp}${o.headline ? ' — ' + oneLine(o.headline, 150) : ''}`);
        }
        L.push('-'.repeat(70));
      }
    } else {
      L.push('NO CONSOLIDATION YET.', rule(70));
    }

    const floor = since != null ? since : (cons ? cons.part_no : 0);
    const list = db.prepare('SELECT * FROM entries WHERE case_slug=? AND part_no>? ORDER BY part_no ASC')
      .all(c.slug, floor);
    L.push('', rule(70));
    L.push(`ENTRIES SINCE ${since != null ? 'ENTRY ' + since : 'THE CONSOLIDATION'} (${list.length})`);
    L.push(rule(70));
    if (!list.length) {
      L.push('(none — the consolidation is current)');
    } else if (full) {
      for (const e of list) {
        L.push('', '-'.repeat(70), `ENTRY ${e.part_no} — ${e.agent} — ${e.stamp}`);
        if (e.claimed) L.push(`CLAIMED: ${e.claimed}`);
        if (e.headline) L.push(`HEADLINE: ${e.headline}`);
        L.push('-'.repeat(70), e.body);
      }
    } else {
      const shown = Number.isFinite(st.idxLimit) ? list.slice(-st.idxLimit) : list;
      if (shown.length < list.length) {
        L.push(`Showing the ${shown.length} most recent of ${list.length}. The other ${list.length - shown.length}`);
        L.push('are still there — find them with casefile_search or casefile_export.');
      } else {
        L.push('Headline index, oldest first. Read any one in full with casefile_entry_read.');
      }
      L.push('');
      for (const e of shown) {
        L.push(`  ${String(e.part_no).padStart(4)}  ${e.stamp}  ${e.agent.padEnd(8)}  ${oneLine(e.headline || e.claimed || '(no headline)', 180)}`);
      }
      const tail = st.fullEntries > 0 ? list.slice(-st.fullEntries) : [];
      for (const e of tail) {
        L.push('', '-'.repeat(70), `ENTRY ${e.part_no} — ${e.agent} — ${e.stamp}  (most recent, in full)`);
        if (e.claimed) L.push(`CLAIMED: ${e.claimed}`);
        if (e.headline) L.push(`HEADLINE: ${e.headline}`);
        L.push('-'.repeat(70), e.body);
      }
    }

    L.push('', rule(70), 'THE QUEUE — live. Claim before you work.', rule(70));
    L.push(renderQueue(c, { detail: full, titleLen: st.qTitle }));

    const ex = db.prepare('SELECT * FROM exhausted WHERE case_slug=? ORDER BY id ASC').all(c.slug);
    if (ex.length) {
      L.push('', rule(70), `DO NOT REPEAT — ${ex.length} closed avenues`, rule(70));
      if (!full) L.push(`Every one is listed. Trimmed to ${st.exLen} characters each — full text:`,
                        'casefile_exhausted_read { case, id }.', '');
      for (const x of ex) {
        L.push(full ? `- ${x.note}` : `- [id ${x.id}] ${oneLine(x.note, st.exLen)}`);
      }
    }
    return L.join('\n');
  };

  if (full) return build([]);

  const notes = [];
  let out = build(notes);
  for (const [key, val, msg] of DEGRADE) {
    if (out.length <= BRIEF_CAP) break;
    if (st[key] === val) continue;
    st[key] = val;
    notes.push(msg);
    out = build(notes);
  }
  out += `\n\nBRIEF SIZE: ${out.length} characters` +
         (out.length > BRIEF_CAP ? ' — over the soft cap even fully compressed; nothing was cut off the end.' : '.');
  return out;
}

// A life, rendered from the fact schedule plus the citations. This is the
// deliverable the schedule exists to produce: what is known, what was looked
// for and not found (with the coverage), and what nobody has looked for yet.
function renderLife(c, life, progress, opts = {}) {
  const p = life.person;
  const L = [];
  const dates = [p.born, p.died].filter(Boolean).join(' – ');
  L.push(`LIFE — ${p.display_name}`);
  if (dates) L.push(dates);
  if (p.relation) L.push(p.relation);
  if (p.aka) L.push(`Also recorded as: ${p.aka}`);
  if (life.group.length > 1)
    L.push(`One person across ${life.group.length} cases: ${life.group.map(g => g.case_slug + '/' + g.slug).join(', ')}`);
  if (p.notes) L.push('', p.notes);

  const byFact = new Map();
  for (const f of life.facts) {
    if (!byFact.has(f.fact)) byFact.set(f.fact, []);
    byFact.get(f.fact).push(f);
  }

  L.push('', rule(70));
  L.push(`FACT SCHEDULE — ${progress.answered} found, ${progress.searched_null} searched and null, ` +
         `${progress.not_applicable} n/a, ${progress.conflicted} conflicted, ${progress.open} never looked for`);
  L.push(rule(70));
  for (const fact of opts.order) {
    const rows = (byFact.get(fact) || []).slice().sort((a, b) => a.seq - b.seq);
    const head = rows.find(r => r.seq === 0);
    const st = head ? head.status : 'UNSEARCHED';
    const bits = [];
    if (head) {
      if (head.value) bits.push(head.value);
      else if (head.date || head.place) bits.push([head.date, head.place].filter(Boolean).join(', '));
      if (head.confidence) bits.push('[' + head.confidence + ']');
    }
    L.push(`  ${fact.padEnd(15)} ${st.padEnd(14)} ${bits.join('  ') || '—'}`);
    if (head && head.status === 'SEARCHED_NULL' && head.coverage)
      L.push(`  ${' '.repeat(15)} ${' '.repeat(14)} coverage: ${oneLine(head.coverage, 400)}`);
    for (const r of rows.filter(r => r.seq > 0)) {
      const sub = [r.value, [r.date, r.place].filter(Boolean).join(', '), r.confidence ? '[' + r.confidence + ']' : '']
        .filter(Boolean).join('  ');
      L.push(`  ${' '.repeat(15)} ${String(r.seq).padStart(2)}. ${sub || '—'}`);
    }
  }

  L.push('', rule(70));
  if (progress.exhausted) {
    L.push('THIS PERSON IS EXHAUSTED. Every fact in the vocabulary is FOUND, searched');
    L.push('and null with its coverage stated, or explicitly not applicable.');
  } else {
    L.push(`NOT EXHAUSTED. ${progress.still_open.length} facts have never been searched or are in conflict:`);
    L.push('  ' + progress.still_open.join(', '));
    L.push('');
    L.push('That list IS the remaining work on this person. Record each one with');
    L.push('casefile_fact_upsert — a null needs status SEARCHED_NULL and its coverage,');
    L.push('and a fact that cannot apply needs status NA, not silence.');
  }

  L.push('', rule(70), `SOURCES (${life.evidence.length})`, rule(70));
  if (!life.evidence.length) {
    L.push('(none attached yet — casefile_evidence)');
  } else {
    life.evidence.forEach((e, i) => {
      L.push(`${i + 1}. ${e.source_title}${e.repository ? ' (' + e.repository + ')' : ''}${e.locator ? ', ' + e.locator : ''}${e.record_date ? ', ' + e.record_date : ''}.`);
      L.push(`   Asserts: ${e.asserts}`);
      if (e.quote) L.push(`   Transcription: "${e.quote}"`);
      if (e.url) L.push(`   ${e.url}`);
      L.push(`   Confidence: ${e.confidence}${e.accessed_at ? ' · accessed ' + e.accessed_at : ''}` +
             (life.group.length > 1 ? ' · from case ' + e.from_case : ''), '');
    });
  }
  return L.join('\n');
}

// Which person to work next, and how far each one has got.
function renderRoster(c, rows) {
  const L = [`PEOPLE IN ${c.title.toUpperCase()} — fact-schedule completeness`, ''];
  L.push('  ' + 'PERSON'.padEnd(24) + 'FOUND  NULL   N/A  CONFL   OPEN   ');
  for (const r of rows) {
    L.push('  ' + r.person.padEnd(24) +
      String(r.answered).padStart(5) + String(r.searched_null).padStart(6) +
      String(r.not_applicable).padStart(6) + String(r.conflicted).padStart(7) +
      String(r.open).padStart(7) + '   ' +
      (r.exhausted ? 'EXHAUSTED' : r.display_name));
  }
  L.push('', 'A person is EXHAUSTED when nothing is open and nothing is conflicted.',
         'casefile_life { case, person } for one life in full.');
  return L.join('\n');
}

function renderExport(c) {
  const all = db.prepare('SELECT * FROM entries WHERE case_slug=? ORDER BY part_no ASC').all(c.slug);
  const L = [`FULL EXPORT — ${c.title} — ${new Date().toISOString()}`, ''];
  for (const e of all) {
    L.push(rule(70), `ENTRY ${e.part_no} — ${e.agent} — ${e.kind} — ${e.stamp}`);
    if (e.claimed) L.push(`CLAIMED: ${e.claimed}`);
    L.push(rule(70), e.body, '');
  }
  return L.join('\n');
}

function renderEntry(c, e) {
  const L = [rule(70), `ENTRY ${e.part_no} — ${e.agent} — ${e.kind} — ${e.stamp}`];
  if (e.claimed) L.push(`CLAIMED: ${e.claimed}`);
  if (e.headline) L.push(`HEADLINE: ${e.headline}`);
  L.push(rule(70), e.body);
  return L.join('\n');
}

function renderQueueItem(it) {
  const L = [`${it.letter}. (${it.lane}) [${it.status}] ${it.title}`];
  if (it.claimed_by) L.push(`CLAIMED BY: ${it.claimed_by} at ${it.claimed_at}`);
  if (it.resolution) L.push(`RESOLUTION: ${it.resolution}`);
  if (it.steps && it.steps.length) {
    L.push('', 'STEPS');
    for (const s of it.steps) {
      L.push(`  (${s.status}) ${s.step}${s.title ? ' — ' + s.title : ''}`);
      if (s.note) L.push(`        ${s.note}`);
    }
  }
  if (it.detail) L.push('', 'DETAIL', it.detail);
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

module.exports = { renderBrief, renderQueue, renderQueueItem, renderDoctrine,
                   renderEntry, renderExport, renderCitations, renderLife, renderRoster };
