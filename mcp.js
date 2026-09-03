'use strict';
// A small, dependency-free MCP endpoint (JSON-RPC over HTTP POST).
// Hand-rolled rather than pulled from the SDK so the service keeps exactly two
// runtime dependencies and cannot break on an SDK module-format change.
const express = require('express');
const { db } = require('./db');
const ops = require('./ops');
const { renderBrief, renderQueue, renderExport, renderCitations } = require('./render');

const PROTOCOL = '2025-06-18';
const S = (props, required) => ({ type: 'object', properties: props, required: required || [] });
const str = description => ({ type: 'string', description });

const TOOLS = [
  { name: 'casefile_brief',
    description: 'Read the working brief for a case: the newest consolidation, every entry since, the live queue, and the do-not-repeat list. Call this FIRST, before any research.',
    inputSchema: S({ case: str('case slug, e.g. susz') }, ['case']) },
  { name: 'casefile_queue',
    description: 'Read just the queue for a case: open items, who holds a claimed one, and what is closed or retired.',
    inputSchema: S({ case: str('case slug') }, ['case']) },
  { name: 'casefile_claim',
    description: 'Atomically claim the first open queue item and mark it held by you. Do this BEFORE working, so a concurrent run cannot take the same item. Returns null if nothing is open in those lanes.',
    inputSchema: S({
      case: str('case slug'),
      agent: str('who is claiming, e.g. Claude or ChatGPT'),
      lanes: { type: 'array', items: { type: 'string' }, description: "restrict to lanes you can actually execute, e.g. ['agent']" },
      letter: str('claim one specific item by its letter instead of the first open one')
    }, ['case', 'agent']) },
  { name: 'casefile_entry',
    description: 'Append an entry to the log. The number is assigned server-side and entries are immutable - a correction is a new entry, never an edit. End every run with this, even a run that found nothing.',
    inputSchema: S({
      case: str('case slug'),
      agent: str('Claude, ChatGPT or Ted'),
      body: str('the entry: Checked (with coverage) / Found (with confidence labels) / Sources / Do Not Repeat / Next'),
      kind: str("'run' (default) or 'consolidation'"),
      claimed: str('the queue item text or letter this run worked'),
      headline: str('one line summarising the run, shown in the read view')
    }, ['case', 'agent', 'body']) },
  { name: 'casefile_queue_upsert',
    description: 'Add a queue item, re-rank one, or close/retire one. Use status done or retired with a resolution rather than deleting.',
    inputSchema: S({
      case: str('case slug'), letter: str('item letter, e.g. A2c'),
      title: str('short imperative title'), detail: str('what to do and why'),
      lane: str('agent | browser | archival | waiting | low'),
      rank: { type: 'number', description: 'lower sorts first' },
      status: str('open | claimed | done | retired'),
      resolution: str('why it closed')
    }, ['case', 'letter']) },
  { name: 'casefile_exhausted',
    description: 'Record an avenue as exhausted so no future run repeats it. Add only what YOU closed this run.',
    inputSchema: S({ case: str('case slug'), note: str('what is closed, and the coverage that closed it'), entry_id: { type: 'number' } }, ['case', 'note']) },
  { name: 'casefile_person',
    description: 'Register or update a person - family or an excluded same-name individual. Evidence attaches to people.',
    inputSchema: S({
      case: str('case slug'), person: str('person slug, e.g. wahrmann-sarolta'),
      display_name: str('name as usually written'), aka: str('spelling variants seen in records'),
      born: str('e.g. c.1875'), died: str('e.g. 1967'), relation: str('e.g. mother of subject'),
      status: str('family | excluded | unknown'), tree_id: str('FamilySearch or other tree id'),
      notes: str('')
    }, ['case', 'person', 'display_name']) },
  { name: 'casefile_evidence',
    description: 'Attach a citable piece of evidence to a person. Include the verbatim quote and the locator - this is what gets exported onto a tree profile later.',
    inputSchema: S({
      case: str('case slug'), person: str('person slug'),
      asserts: str('what this record says about the person'),
      source_title: str('the record set, e.g. Kozma Street Jewish Cemetery burial index'),
      repository: str('who holds it'), locator: str('page, image, grave or entry reference'),
      record_date: str('date of the record'), url: str(''), quote: str('verbatim transcription'),
      kind: str('burial | directory | newspaper | civil | school | register | other'),
      confidence: str('VERIFIED | STRONG LEAD | CANDIDATE | DISPROVEN'),
      accessed_at: str('YYYY-MM-DD'), entry_id: { type: 'number' }
    }, ['case', 'person', 'asserts', 'source_title']) },
  { name: 'casefile_citations',
    description: 'Get every source found for one person, formatted for pasting onto a genealogy profile.',
    inputSchema: S({ case: str('case slug'), person: str('person slug') }, ['case', 'person']) },
  { name: 'casefile_export',
    description: 'Full text of every entry in the case, for archiving outside this service.',
    inputSchema: S({ case: str('case slug') }, ['case']) },
  { name: 'casefile_case',
    description: 'Create a case, or update its title, subject or open question.',
    inputSchema: S({ slug: str(''), title: str(''), subject: str(''), question: str('the question the case exists to answer') }, ['slug', 'title']) }
];

const text = t => ({ content: [{ type: 'text', text: t }] });
const json = o => text(JSON.stringify(o, null, 2));

function mustCase(slug) {
  const c = ops.getCase(slug);
  if (!c) throw new Error('no such case: ' + slug);
  return c;
}

function callTool(name, a) {
  a = a || {};
  switch (name) {
    case 'casefile_brief':   return text(renderBrief(mustCase(a.case)));
    case 'casefile_queue':   return text(renderQueue(mustCase(a.case)));
    case 'casefile_export':  return text(renderExport(mustCase(a.case)));
    case 'casefile_case':    return json(ops.upsertCase(a));
    case 'casefile_entry': {
      const r = ops.addEntry(a);
      return text(`Filed as entry ${r.part_no}. Immutable - a correction is a new entry.`);
    }
    case 'casefile_claim': {
      const item = ops.claim(a);
      if (!item) return text('Nothing open in those lanes. Say so plainly in your entry and keep the run short.');
      return json(item);
    }
    case 'casefile_queue_upsert': return json(ops.upsertQueueItem(a));
    case 'casefile_exhausted':    return json(ops.addExhausted(a));
    case 'casefile_person':       return json(ops.upsertPerson(a));
    case 'casefile_evidence':     return json(ops.addEvidence(a));
    case 'casefile_citations': {
      const c = mustCase(a.case);
      const p = db.prepare('SELECT * FROM persons WHERE case_slug=? AND slug=?').get(c.slug, a.person);
      if (!p) throw new Error('no such person: ' + a.person);
      return text(renderCitations(c, p));
    }
    default: throw new Error('unknown tool: ' + name);
  }
}

function handle(msg) {
  const id = msg && msg.id;
  const m = msg && msg.method;
  if (m === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: (msg.params && msg.params.protocolVersion) || PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'casefile', version: '1.0.0' }
    } };
  }
  if (m === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (m === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (m === 'tools/call') {
    const p = msg.params || {};
    try {
      return { jsonrpc: '2.0', id, result: callTool(p.name, p.arguments) };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } };
    }
  }
  if (m === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (m === 'prompts/list')   return { jsonrpc: '2.0', id, result: { prompts: [] } };
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + m } };
}

function router(WRITE_TOKEN) {
  const r = express.Router({ mergeParams: true });
  const auth = (req, res, next) => {
    const h = req.get('authorization') || '';
    const tok = (h.startsWith('Bearer ') ? h.slice(7) : '') || req.query.token || req.params.token || '';
    if (!WRITE_TOKEN || tok !== WRITE_TOKEN) {
      return res.status(401).json({ jsonrpc: '2.0', id: null,
        error: { code: -32001, message: 'unauthorized: supply the write token' } });
    }
    next();
  };
  const post = (req, res) => {
    const body = req.body;
    const msgs = Array.isArray(body) ? body : [body];
    const out = [];
    for (const msg of msgs) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.id === undefined || msg.id === null) continue;   // notification: no reply
      out.push(handle(msg));
    }
    if (!out.length) return res.status(202).end();
    res.json(Array.isArray(body) ? out : out[0]);
  };
  r.post('/', auth, post);
  r.post('/:token', auth, post);
  r.get(['/', '/:token'], auth, (_q, res) =>
    res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'POST only' } }));
  r.delete(['/', '/:token'], auth, (_q, res) => res.status(200).end());
  return r;
}

module.exports = { router, TOOLS };
