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
  return tx();
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
    return db.prepare('SELECT * FROM queue_items WHERE id=?').get(existing.id);
  }
  if (!title) throw new Error('title is required for a new queue item');
  const info = db.prepare(`INSERT INTO queue_items (case_slug,letter,title,detail,lane,rank,status)
    VALUES (?,?,?,?,?,?,?)`)
    .run(slug, letter, title, detail ?? null, lane || 'agent', rank ?? 100, status || 'open');
  return db.prepare('SELECT * FROM queue_items WHERE id=?').get(info.lastInsertRowid);
}

function addExhausted({ case: slug, note, entry_id }) {
  if (!slug || !note) throw new Error('case and note are required');
  const info = db.prepare('INSERT INTO exhausted (case_slug,note,entry_id) VALUES (?,?,?)')
    .run(slug, note, entry_id ?? null);
  return { id: info.lastInsertRowid };
}

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
    (case_slug,slug,display_name,aka,born,died,relation,status,tree_id,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(slug, pslug, a.display_name, a.aka ?? null, a.born ?? null, a.died ?? null,
         a.relation ?? null, a.status || 'family', a.tree_id ?? null, a.notes ?? null);
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

module.exports = { getCase, upsertCase, addEntry, claim, upsertQueueItem,
                   addExhausted, upsertPerson, addEvidence };
