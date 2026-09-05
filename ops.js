'use strict';
// Shared operations. The MCP layer and the HTTP layer both go through here so
// the two cannot drift apart on the things that matter — entry numbering and
// the atomicity of a claim.
const crypto = require('crypto');
const { db } = require('./db');

const getCase = slug => db.prepare('SELECT * FROM cases WHERE slug = ?').get(slug);

function upsertCase({ slug, title, subject, question }) {
  if (!slug || !title) throw new Error('slug and title are required');
  const existing = getCase(slug);
  if (existing) {
    db.prepare(`UPDATE cases SET title=?, subject=COALESCE(?,subject),
      question=COALESCE(?,question) WHERE slug=?`)
      .run(title, subject ?? null, question ?? null, slug);
    return getCase(slug);
  }
  db.prepare('INSERT INTO cases (slug,title,subject,question,read_key) VALUES (?,?,?,?,?)')
    .run(slug, title, subject ?? null, question ?? null, crypto.randomBytes(16).toString('base64url'));
  return getCase(slug);
}

function addEntry({ case: slug, agent, body, kind, claimed, headline, stamp }) {
  if (!slug || !agent || !body) throw new Error('case, agent and body are required');
  if (!getCase(slug)) throw new Error('no such case: ' + slug);
  const tx = db.transaction(() => {
    const { n } = db.prepare('SELECT COALESCE(MAX(part_no),0) AS n FROM entries WHERE case_slug=?').get(slug);
    const part_no = n + 1;
    const info = db.prepare(
      `INSERT INTO entries (case_slug,part_no,agent,kind,claimed,headline,body,stamp)
       VALUES (?,?,?,?,?,?,?,COALESCE(?, datetime('now')))`
    ).run(slug, part_no, agent, kind || 'run', claimed ?? null, headline ?? null, body, stamp ?? null);
    return { part_no, id: info.lastInsertRowid };
  });
  const out = tx();
  if (claimed) {
    const letter = String(claimed).trim().split(/[\s.:—-]/)[0];
    db.prepare(`UPDATE queue_items SET claim_entry=? WHERE case_slug=? AND letter=? AND claim_entry IS NULL`)
      .run(out.id, slug, letter);
  }
  return out;
}

function getEntry({ case: slug, entry }) {
  if (!slug || entry == null) throw new Error('case and entry are required');
  const e = db.prepare('SELECT * FROM entries WHERE case_slug=? AND part_no=?').get(slug, Number(entry));
  if (!e) throw new Error('no entry ' + entry + ' in case ' + slug);
  return e;
}

function claim({ case: slug, agent, lanes, letter }) {
  if (!slug || !agent) throw new Error('case and agent are required');
  const laneList = Array.isArray(lanes) && lanes.length ? lanes : null;
  const tx = db.transaction(() => {
    let item;
    if (letter) {
      item = db.prepare(`SELECT * FROM queue_items WHERE case_slug=? AND letter=? AND status='open'`).get(slug, letter);
    } else if (laneList) {
      const qs = laneList.map(() => '?').join(',');
      item = db.prepare(`SELECT * FROM queue_items WHERE case_slug=? AND status='open'
        AND lane IN (${qs}) ORDER BY rank ASC, id ASC LIMIT 1`).get(slug, ...laneList);
    } else {
      item = db.prepare(`SELECT * FROM queue_items WHERE case_slug=? AND status='open'
        ORDER BY rank ASC, id ASC LIMIT 1`).get(slug);
    }
    if (!item) return null;
    db.prepare(`UPDATE queue_items SET status='claimed', claimed_by=?, claimed_at=datetime('now') WHERE id=?`)
      .run(agent, item.id);
    return db.prepare('SELECT * FROM queue_items WHERE id=?').get(item.id);
  });
  const item = tx();
  return item ? { ...item, steps: listSteps(slug, item.letter) } : null;
}

function upsertQueueItem({ case: slug, letter, title, detail, lane, rank, status, resolution }) {
  if (!slug || !letter) throw new Error('case and letter are required');
  const existing = db.prepare('SELECT * FROM queue_items WHERE case_slug=? AND letter=?').get(slug, letter);
  if (existing) {
    db.prepare(`UPDATE queue_items SET title=COALESCE(?,title), detail=COALESCE(?,detail),
      lane=COALESCE(?,lane), rank=COALESCE(?,rank), status=COALESCE(?,status),
      resolution=COALESCE(?,resolution) WHERE id=?`)
      .run(title ?? null, detail ?? null, lane ?? null, rank ?? null, status ?? null,
           resolution ?? null, existing.id);
    // Releasing an item back to open releases the claim with it, so a stale
    // "claimed_by" cannot outlive the claim.
    if (status && status !== 'claimed') {
      db.prepare('UPDATE queue_items SET claimed_by=NULL, claimed_at=NULL WHERE id=?').run(existing.id);
    }
    return getQueueItem({ case: slug, letter });
  }
  if (!title) throw new Error('title is required for a new queue item');
  db.prepare(`INSERT INTO queue_items (case_slug,letter,title,detail,lane,rank,status)
    VALUES (?,?,?,?,?,?,?)`)
    .run(slug, letter, title, detail ?? null, lane || 'agent', rank ?? 100, status || 'open');
  return getQueueItem({ case: slug, letter });
}

const listSteps = (slug, letter) => db.prepare(
  `SELECT step,title,status,note,updated_by,updated_at FROM queue_steps
   WHERE case_slug=? AND letter=? ORDER BY rank ASC, step ASC`).all(slug, letter);

function getQueueItem({ case: slug, letter }) {
  if (!slug || !letter) throw new Error('case and letter are required');
  const it = db.prepare('SELECT * FROM queue_items WHERE case_slug=? AND letter=?').get(slug, letter);
  if (!it) throw new Error('no such queue item: ' + letter);
  return { ...it, steps: listSteps(slug, letter) };
}

function upsertStep({ case: slug, letter, step, title, status, note, rank, agent }) {
  if (!slug || !letter || !step) throw new Error('case, letter and step are required');
  const ok = ['open', 'done', 'blocked'];
  if (status && !ok.includes(status)) throw new Error('status must be one of: ' + ok.join(', '));
  const item = db.prepare('SELECT * FROM queue_items WHERE case_slug=? AND letter=?').get(slug, letter);
  if (!item) throw new Error('no such queue item: ' + letter + ' — create it before adding steps');
  const existing = db.prepare('SELECT * FROM queue_steps WHERE case_slug=? AND letter=? AND step=?')
    .get(slug, letter, step);
  if (existing) {
    db.prepare(`UPDATE queue_steps SET title=COALESCE(?,title), status=COALESCE(?,status),
      note=COALESCE(?,note), rank=COALESCE(?,rank), updated_by=COALESCE(?,updated_by),
      updated_at=datetime('now') WHERE id=?`)
      .run(title ?? null, status ?? null, note ?? null, rank ?? null, agent ?? null, existing.id);
  } else {
    db.prepare(`INSERT INTO queue_steps (case_slug,letter,step,title,status,note,rank,updated_by)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(slug, letter, step, title ?? null, status || 'open', note ?? null, rank ?? 100, agent ?? null);
  }
  return { letter, steps: listSteps(slug, letter) };
}

function setDoctrine({ case: slug, section, body, rank, agent }) {
  if (!slug || !section || !body) throw new Error('case, section and body are required');
  if (!getCase(slug)) throw new Error('no such case: ' + slug);
  const tx = db.transaction(() => {
    const prev = db.prepare('SELECT * FROM doctrine WHERE case_slug=? AND section=?').get(slug, section);
    if (prev) {
      db.prepare('INSERT INTO doctrine_history (case_slug,section,body,updated_by) VALUES (?,?,?,?)')
        .run(slug, section, prev.body, prev.updated_by ?? null);
      db.prepare(`UPDATE doctrine SET body=?, rank=COALESCE(?,rank), updated_by=COALESCE(?,updated_by),
        updated_at=datetime('now') WHERE id=?`).run(body, rank ?? null, agent ?? null, prev.id);
      return { section, replaced: true, previous_version_kept: true,
               note: 'The previous text of this section is preserved in doctrine_history and is readable with casefile_doctrine { history: true }.' };
    }
    db.prepare('INSERT INTO doctrine (case_slug,section,body,rank,updated_by) VALUES (?,?,?,?,?)')
      .run(slug, section, body, rank ?? 100, agent ?? null);
    return { section, replaced: false, created: true };
  });
  return tx();
}

function getDoctrine({ case: slug, section, history }) {
  if (!slug) throw new Error('case is required');
  if (history) {
    return section
      ? db.prepare(`SELECT * FROM doctrine_history WHERE case_slug=? AND section=?
                    ORDER BY id DESC`).all(slug, section)
      : db.prepare('SELECT * FROM doctrine_history WHERE case_slug=? ORDER BY id DESC').all(slug);
  }
  return section
    ? db.prepare('SELECT * FROM doctrine WHERE case_slug=? AND section=?').all(slug, section)
    : db.prepare('SELECT * FROM doctrine WHERE case_slug=? ORDER BY rank ASC, section ASC').all(slug);
}

function addExhausted({ case: slug, note, entry_id }) {
  if (!slug || !note) throw new Error('case and note are required');
  const info = db.prepare('INSERT INTO exhausted (case_slug,note,entry_id) VALUES (?,?,?)')
    .run(slug, note, entry_id ?? null);
  return { id: info.lastInsertRowid };
}

function getExhausted({ case: slug, id }) {
  if (!slug || id == null) throw new Error('case and id are required');
  const x = db.prepare('SELECT * FROM exhausted WHERE case_slug=? AND id=?').get(slug, Number(id));
  if (!x) throw new Error('no exhausted note ' + id + ' in case ' + slug);
  return x;
}

// Find which entry, note or queue item already said something. The point of a
// bounded brief is that the detail is one call away — this is how a run finds
// which call to make, and it is also the cheapest guard against redoing work.
function search({ case: slug, q, limit }) {
  if (!slug || !q) throw new Error('case and q are required');
  const like = '%' + String(q).replace(/[%_\\]/g, m => '\\' + m) + '%';
  const lim = Math.min(Number(limit) || 25, 100);
  const entries = db.prepare(`SELECT part_no, agent, stamp, headline FROM entries
    WHERE case_slug=? AND (body LIKE ? ESCAPE '\\' OR headline LIKE ? ESCAPE '\\')
    ORDER BY part_no DESC LIMIT ?`).all(slug, like, like, lim);
  const exhausted = db.prepare(`SELECT id, entry_id, substr(note,1,300) AS note FROM exhausted
    WHERE case_slug=? AND note LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`).all(slug, like, lim);
  const queue = db.prepare(`SELECT letter, lane, status, substr(title,1,200) AS title FROM queue_items
    WHERE case_slug=? AND (title LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')
    ORDER BY rank ASC LIMIT ?`).all(slug, like, like, lim);
  return {
    query: q,
    found: { entries: entries.length, exhausted: exhausted.length, queue: queue.length },
    entries, exhausted, queue,
    read: 'casefile_entry_read { case, entry } · casefile_exhausted_read { case, id } · casefile_queue_get { case, letter }'
  };
}

/* ------------------------------------------------------------ fact schedule */
// The vocabulary is fixed and ordered, because that is what makes a life
// summary comparable between people and what makes "exhausted" a countable
// condition rather than a feeling.
const FACT_ORDER = ['birth', 'name-change', 'religion', 'adoption', 'education',
  'occupation', 'military', 'residence', 'emigration', 'arrival', 'naturalisation',
  'marriage', 'child', 'divorce', 'death', 'burial', 'probate', 'other'];
// Facts that can legitimately have several instances. For these, seq 0 is the
// verdict on the category ("two children, both enumerated") and seq 1..n are the
// instances themselves.
const FACT_REPEATABLE = new Set(['name-change', 'education', 'occupation', 'military',
  'residence', 'marriage', 'child', 'divorce', 'other', 'adoption']);
const FACT_STATUS = ['UNSEARCHED', 'SEARCHED_NULL', 'FOUND', 'CONFLICTED', 'NA'];

const getPerson = (slug, pslug) => {
  const p = db.prepare('SELECT * FROM persons WHERE case_slug=? AND slug=?').get(slug, pslug);
  if (!p) throw new Error('no such person: ' + pslug + ' in case ' + slug + ' — register them with casefile_person first');
  return p;
};

function upsertFact(a) {
  const slug = a.case, pslug = a.person;
  if (!slug || !pslug || !a.fact) throw new Error('case, person and fact are required');
  const fact = String(a.fact).toLowerCase().trim();
  if (!FACT_ORDER.includes(fact))
    throw new Error('fact must be one of: ' + FACT_ORDER.join(', '));
  if (a.status && !FACT_STATUS.includes(a.status))
    throw new Error('status must be one of: ' + FACT_STATUS.join(', '));
  const seq = Number(a.seq) || 0;
  if (seq > 0 && !FACT_REPEATABLE.has(fact))
    throw new Error(fact + ' is a single fact — use seq 0. Repeatable facts: ' +
      [...FACT_REPEATABLE].join(', '));
  const p = getPerson(slug, pslug);
  const ev = Array.isArray(a.evidence_ids) ? a.evidence_ids.join(',') : (a.evidence_ids ?? null);
  const existing = db.prepare('SELECT * FROM facts WHERE case_slug=? AND person_id=? AND fact=? AND seq=?')
    .get(slug, p.id, fact, seq);
  if (existing) {
    db.prepare(`UPDATE facts SET status=COALESCE(?,status), value=COALESCE(?,value),
      date=COALESCE(?,date), place=COALESCE(?,place), confidence=COALESCE(?,confidence),
      coverage=COALESCE(?,coverage), evidence_ids=COALESCE(?,evidence_ids),
      entry_id=COALESCE(?,entry_id), updated_by=COALESCE(?,updated_by),
      updated_at=datetime('now') WHERE id=?`)
      .run(a.status ?? null, a.value ?? null, a.date ?? null, a.place ?? null,
           a.confidence ?? null, a.coverage ?? null, ev, a.entry_id ?? null,
           a.agent ?? null, existing.id);
  } else {
    db.prepare(`INSERT INTO facts (case_slug,person_id,fact,seq,status,value,date,place,
        confidence,coverage,evidence_ids,entry_id,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(slug, p.id, fact, seq, a.status || 'UNSEARCHED', a.value ?? null, a.date ?? null,
           a.place ?? null, a.confidence ?? null, a.coverage ?? null, ev,
           a.entry_id ?? null, a.agent ?? null);
  }
  return lifeProgress(slug, pslug);
}

// Every person in the same-identity group, across cases. global_id defaults to
// the person's own slug, so an unlinked person is a group of one.
function personGroup(slug, pslug, across) {
  const p = getPerson(slug, pslug);
  if (!across) return [p];
  const gid = p.global_id || p.slug;
  return db.prepare('SELECT * FROM persons WHERE COALESCE(global_id, slug)=? ORDER BY case_slug').all(gid);
}

function getLife({ case: slug, person: pslug, across_cases }) {
  if (!slug || !pslug) throw new Error('case and person are required');
  const group = personGroup(slug, pslug, across_cases);
  const ids = group.map(p => p.id);
  const qs = ids.map(() => '?').join(',');
  const facts = db.prepare(`SELECT f.*, p.case_slug AS from_case FROM facts f
    JOIN persons p ON p.id=f.person_id WHERE f.person_id IN (${qs})
    ORDER BY f.fact, f.seq`).all(...ids);
  const evidence = db.prepare(`SELECT e.*, p.case_slug AS from_case FROM evidence e
    JOIN persons p ON p.id=e.person_id WHERE e.person_id IN (${qs})
    ORDER BY e.record_date, e.id`).all(...ids);
  return { person: group[0], group, facts, evidence };
}

// The stopping rule, as a number. A person is exhausted when open === 0.
function lifeProgress(slug, pslug, across) {
  const group = personGroup(slug, pslug, across);
  const ids = group.map(p => p.id);
  const qs = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT fact, status FROM facts WHERE person_id IN (${qs}) AND seq=0`).all(...ids);
  const byFact = new Map(rows.map(r => [r.fact, r.status]));
  let answered = 0, nulls = 0, na = 0, conflicted = 0, open = 0;
  const openList = [];
  for (const f of FACT_ORDER) {
    const st = byFact.get(f) || 'UNSEARCHED';
    if (st === 'FOUND') answered++;
    else if (st === 'SEARCHED_NULL') nulls++;
    else if (st === 'NA') na++;
    else if (st === 'CONFLICTED') { conflicted++; openList.push(f); }
    else { open++; openList.push(f); }
  }
  return { person: group[0].slug, display_name: group[0].display_name,
           cases: group.map(p => p.case_slug),
           total: FACT_ORDER.length, answered, searched_null: nulls, not_applicable: na,
           conflicted, open, still_open: openList,
           exhausted: open === 0 && conflicted === 0 };
}

function lifeRoster(slug) {
  if (!slug) throw new Error('case is required');
  const people = db.prepare(`SELECT * FROM persons WHERE case_slug=? AND status!='excluded'
    ORDER BY display_name`).all(slug);
  return people.map(p => lifeProgress(slug, p.slug));
}

function linkPerson({ case: slug, person, to_case, to_person, agent }) {
  if (!slug || !person || !to_case || !to_person)
    throw new Error('case, person, to_case and to_person are all required');
  const a = getPerson(slug, person), b = getPerson(to_case, to_person);
  const gid = a.global_id || a.slug;
  db.prepare('UPDATE persons SET global_id=? WHERE id IN (?,?)').run(gid, a.id, b.id);
  const group = db.prepare('SELECT case_slug, slug, display_name FROM persons WHERE COALESCE(global_id, slug)=?').all(gid);
  return { global_id: gid, linked_by: agent ?? null, group,
    note: 'These records are now one person. casefile_life and casefile_citations with across_cases:true will gather evidence from all of them.' };
}

/* ---------------------------------------------------------- case sources */
function addSource({ case: slug, host, probe_url, note, agent }) {
  if (!slug || !host) throw new Error('case and host are required');
  if (!getCase(slug)) throw new Error('no such case: ' + slug);
  const h = String(host).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) throw new Error('host must be a bare hostname, e.g. catalog.archives.gov');
  db.prepare(`INSERT INTO case_sources (case_slug,host,probe_url,note,added_by) VALUES (?,?,?,?,?)
    ON CONFLICT(case_slug,host) DO UPDATE SET probe_url=COALESCE(excluded.probe_url,probe_url),
    note=COALESCE(excluded.note,note)`)
    .run(slug, h, probe_url ?? null, note ?? null, agent ?? null);
  return { case: slug, host: h, sources: listSources(slug),
    note: 'source_fetch will now accept this host when called with case:"' + slug + '". It is recorded with who added it, and source_reachability names it.' };
}

const listSources = slug =>
  db.prepare('SELECT host, probe_url, note, added_by, added_at FROM case_sources WHERE case_slug=? ORDER BY host').all(slug);

function upsertPerson(a) {
  const slug = a.case, pslug = a.person || a.slug;
  if (!slug || !pslug || !a.display_name) throw new Error('case, person and display_name are required');
  const existing = db.prepare('SELECT * FROM persons WHERE case_slug=? AND slug=?').get(slug, pslug);
  if (existing) {
    db.prepare(`UPDATE persons SET display_name=?, aka=COALESCE(?,aka), born=COALESCE(?,born),
      died=COALESCE(?,died), relation=COALESCE(?,relation), status=COALESCE(?,status),
      tree_id=COALESCE(?,tree_id), notes=COALESCE(?,notes) WHERE id=?`)
      .run(a.display_name, a.aka ?? null, a.born ?? null, a.died ?? null, a.relation ?? null,
           a.status ?? null, a.tree_id ?? null, a.notes ?? null, existing.id);
    return { id: existing.id, person: pslug };
  }
  const info = db.prepare(`INSERT INTO persons
    (case_slug,slug,display_name,aka,born,died,relation,status,tree_id,notes,global_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(slug, pslug, a.display_name, a.aka ?? null, a.born ?? null, a.died ?? null,
         a.relation ?? null, a.status || 'family', a.tree_id ?? null, a.notes ?? null,
         a.global_id || pslug);
  return { id: info.lastInsertRowid, person: pslug };
}

function addEvidence(b) {
  if (!b.case || !b.person || !b.asserts || !b.source_title)
    throw new Error('case, person, asserts and source_title are required');
  const p = db.prepare('SELECT * FROM persons WHERE case_slug=? AND slug=?').get(b.case, b.person);
  if (!p) throw new Error('no such person: ' + b.person + ' — register them first');
  const info = db.prepare(`INSERT INTO evidence (case_slug,person_id,kind,asserts,record_date,
      source_title,repository,locator,url,quote,confidence,entry_id,accessed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.case, p.id, b.kind ?? null, b.asserts, b.record_date ?? null, b.source_title,
         b.repository ?? null, b.locator ?? null, b.url ?? null, b.quote ?? null,
         b.confidence || 'CANDIDATE', b.entry_id ?? null, b.accessed_at ?? null);
  return { id: info.lastInsertRowid };
}

module.exports = { getCase, upsertCase, addEntry, getEntry, claim, upsertQueueItem,
                   getQueueItem, listSteps, upsertStep, setDoctrine, getDoctrine,
                   addExhausted, getExhausted, search, upsertPerson, addEvidence,
                   upsertFact, getLife, lifeProgress, lifeRoster, linkPerson,
                   addSource, listSources, getPerson,
                   FACT_ORDER, FACT_REPEATABLE, FACT_STATUS };
