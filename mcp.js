'use strict';
// A small, dependency-free MCP endpoint (JSON-RPC over HTTP POST).
// Hand-rolled rather than pulled from the SDK so the service keeps exactly two
// runtime dependencies and cannot break on an SDK module-format change.
const express = require('express');
const { db } = require('./db');
const ops = require('./ops');
const { renderBrief, renderQueue, renderQueueItem, renderDoctrine,
        renderEntry, renderExport, renderCitations, renderLife,
        renderRoster } = require('./render');
const research = require('./research');

const PROTOCOL = '2025-06-18';
const S = (props, required) => ({ type: 'object', properties: props, required: required || [] });
const str = description => ({ type: 'string', description });
const bool = description => ({ type: 'boolean', description });
const num = description => ({ type: 'number', description });

const TOOLS = [
  { name: 'casefile_brief',
    description: 'Read the working brief for a case: the case doctrine (standing state), the newest consolidation, a headline index of every entry since, the newest entry in full, the live queue as titles, and the do-not-repeat list. Call this FIRST, before any research. The brief is BOUNDED so it always fits in one read — nothing is deleted, the detail is one call away via casefile_entry_read, casefile_queue_get, casefile_exhausted_read and casefile_search.',
    inputSchema: S({
      case: str('case slug, e.g. susz'),
      full: bool('true returns the old unbounded brief — every entry in full, every queue detail, every note. Large. Default false.'),
      since: num('only index entries after this entry number, instead of after the newest consolidation'),
      full_entries: num('how many of the most recent entries to include in full. Default 1; 0 for a pure index.')
    }, ['case']) },
  { name: 'casefile_entry_read',
    description: 'Read one entry in full by its number. The brief lists entries as headlines; this is how you open one.',
    inputSchema: S({ case: str('case slug'), entry: num('the entry number, e.g. 69') }, ['case', 'entry']) },
  { name: 'casefile_search',
    description: 'Find which entry, do-not-repeat note or queue item already mentions something. Use it before searching a source, to check the work has not been done, and to locate the entry behind a headline.',
    inputSchema: S({ case: str('case slug'), q: str('substring to look for, e.g. a name, a corpus, a URL stem'), limit: num('max rows per section, default 25') }, ['case', 'q']) },
  { name: 'casefile_queue',
    description: 'Read just the queue for a case: open items as titles with their step counts, who holds a claimed one, and what is closed or retired. Pass detail:true only if you really need every item\'s full text — in a live case that is very large.',
    inputSchema: S({ case: str('case slug'), detail: bool('include each item\'s full detail and steps. Default false.') }, ['case']) },
  { name: 'casefile_queue_get',
    description: 'Read one queue item in full — its detail, its steps and their status. This is the companion to the titles-only queue listing.',
    inputSchema: S({ case: str('case slug'), letter: str('item letter, e.g. CM') }, ['case', 'letter']) },
  { name: 'casefile_step_upsert',
    description: 'Add or update ONE step of a queue item, without resending the item\'s detail. This is how progress inside a multi-step item gets recorded: mark step (ii) done and leave the rest alone. Before this existed, runs wrote progress into the item TITLE because updating detail meant re-sending thousands of words.',
    inputSchema: S({
      case: str('case slug'), letter: str('queue item letter, e.g. CM'),
      step: str('short step id, e.g. "i", "ii", "2b"'),
      title: str('what the step is'),
      status: str('open | done | blocked'),
      note: str('what closed it, or what blocks it — carry the coverage'),
      rank: num('lower sorts first'), agent: str('who updated it')
    }, ['case', 'letter', 'step']) },
  { name: 'casefile_claim',
    description: 'Atomically claim the first open queue item and mark it held by you. Do this BEFORE working, so a concurrent run cannot take the same item. Returns the item with its steps, or null if nothing is open in those lanes.',
    inputSchema: S({
      case: str('case slug'),
      agent: str('who is claiming, e.g. Claude or ChatGPT'),
      lanes: { type: 'array', items: { type: 'string' }, description: "restrict to lanes you can actually execute, e.g. ['agent']" },
      letter: str('claim one specific item by its letter instead of the first open one')
    }, ['case', 'agent']) },
  { name: 'casefile_entry',
    description: 'Append an entry to the log. The number is assigned server-side and entries are immutable - a correction is a new entry, never an edit. End every run with this, even a run that found nothing. Use kind="run" for a run report or any bookkeeping. Standing state — anchors, method rules, the access map — belongs in casefile_doctrine_set, NOT in a consolidation.',
    inputSchema: S({
      case: str('case slug'),
      agent: str('Claude, ChatGPT or Ted'),
      body: str('the entry: Checked (with coverage) / Found (with confidence labels) / Sources / Do Not Repeat / Next'),
      kind: str("'run' (default) or 'consolidation'"),
      claimed: str('the queue item text or letter this run worked'),
      headline: str('one line summarising the run — this is what the brief\'s entry index shows, so make it carry the finding')
    }, ['case', 'agent', 'body']) },
  { name: 'casefile_doctrine',
    description: 'Read the case doctrine — the standing state that every run needs: identity anchors, method rules, the access map, spelling and folding rules, instrument behaviour. Rendered in full at the top of every brief, so you rarely need to call this directly. Pass history:true to see superseded versions of a section.',
    inputSchema: S({ case: str('case slug'), section: str('one section name, or omit for all'), history: bool('return superseded versions instead of current text') }, ['case']) },
  { name: 'casefile_doctrine_set',
    description: 'Create or replace one section of the case doctrine. This is where standing state lives now. It is mutable and always visible in the brief, so unlike a consolidation it CANNOT be hidden by a later entry — which has already happened once and cost a case its method rules. The previous text of a replaced section is kept and readable with casefile_doctrine { history: true }.',
    inputSchema: S({
      case: str('case slug'),
      section: str('section name, e.g. anchors | method-rules | access-map | spelling | instruments | same-name-roster'),
      body: str('the full text of this section — it REPLACES the section, so carry forward anything still standing'),
      rank: num('lower sorts first in the brief'), agent: str('who wrote it')
    }, ['case', 'section', 'body']) },
  { name: 'casefile_queue_upsert',
    description: 'Add a queue item, re-rank one, or close/retire one. Use status done or retired with a resolution rather than deleting. To record progress INSIDE an item use casefile_step_upsert — this tool replaces detail wholesale. Setting status back to open also clears a stale claim.',
    inputSchema: S({
      case: str('case slug'), letter: str('item letter, e.g. A2c'),
      title: str('short imperative title — keep it short, progress goes in steps'),
      detail: str('what to do and why'),
      lane: str('agent | browser | archival | waiting | low'),
      rank: num('lower sorts first'),
      status: str('open | claimed | done | retired'),
      resolution: str('why it closed')
    }, ['case', 'letter']) },
  { name: 'casefile_exhausted',
    description: 'Record an avenue as exhausted so no future run repeats it. Add only what YOU closed this run. State the coverage: exact corpus, exact string, date range, results reported, results actually read.',
    inputSchema: S({ case: str('case slug'), note: str('what is closed, and the coverage that closed it'), entry_id: num('') }, ['case', 'note']) },
  { name: 'casefile_exhausted_read',
    description: 'Read one do-not-repeat note in full. The brief trims these to keep itself bounded; this returns the whole coverage statement.',
    inputSchema: S({ case: str('case slug'), id: num('the note id shown in the brief, e.g. 122') }, ['case', 'id']) },
  { name: 'casefile_fact_upsert',
    description: 'Record ONE fact of ONE person\'s life, with the coverage that settled it. This is the schedule that makes "exhausted" a countable condition instead of a feeling: a person is exhausted when no fact in the vocabulary is still UNSEARCHED. A null is a RESULT and belongs here with status SEARCHED_NULL and its coverage — silence is not a null. A fact that cannot apply (naturalisation for someone who never emigrated) is status NA, also not silence.',
    inputSchema: S({
      case: str('case slug'), person: str('person slug'),
      fact: str('one of: ' + ops.FACT_ORDER.join(' | ')),
      seq: num('0 (default) is the fact itself, or the verdict on a repeatable category. 1..n are instances — marriage 1, marriage 2, child 1, 2, 3. Repeatable: ' + [...ops.FACT_REPEATABLE].join(', ')),
      status: str('UNSEARCHED | SEARCHED_NULL | FOUND | CONFLICTED | NA'),
      value: str('the answer in plain words, e.g. "31 March 1924, Baden, after a long illness"'),
      date: str('date of the event, as precise as the record is'),
      place: str('place of the event'),
      confidence: str('VERIFIED | STRONG LEAD | CANDIDATE | DISPROVEN'),
      coverage: str('REQUIRED for a SEARCHED_NULL: exact corpus, exact string, date range, results reported, results read, EXHAUSTED or SAMPLED'),
      evidence_ids: str('comma-separated casefile_evidence ids supporting this'),
      entry_id: num('the entry that established it'), agent: str('who recorded it')
    }, ['case', 'person', 'fact']) },
  { name: 'casefile_life',
    description: 'The life summary of one person: every fact in the schedule with its status, value, confidence and — for a null — the coverage that closed it, then every source attached to them, then what is still unsearched. That last list IS the remaining work on that person. Call with a case but no person to get the roster instead: who is registered and how far each life has got.',
    inputSchema: S({
      case: str('case slug'), person: str('person slug — omit for the roster of everyone'),
      across_cases: bool('gather facts and sources from every case this person is linked into')
    }, ['case']) },
  { name: 'casefile_person_link',
    description: 'Declare that a person registered in two cases is ONE person — the subject of their own case and a collateral in another. Evidence keeps living in the case that found it; casefile_life and casefile_citations with across_cases:true then gather it all. Without this, the same human becomes two records that drift apart.',
    inputSchema: S({
      case: str('case slug of the first record'), person: str('person slug in that case'),
      to_case: str('case slug of the second record'), to_person: str('person slug in that case'),
      agent: str('who linked them')
    }, ['case', 'person', 'to_case', 'to_person']) },
  { name: 'casefile_source_add',
    description: 'Add a repository host to THIS CASE\'s source allowlist, so source_fetch and source_reachability will use it when called with that case. The built-in allowlist is entirely Central European because that is where this investigation started — a case about someone who emigrated needs different repositories. Every addition records who made it and is named in reachability output, so a widened allowlist is visible rather than silent. Add a host because the case genuinely needs that archive, not to make the fetcher general.',
    inputSchema: S({
      case: str('case slug'), host: str('bare hostname, e.g. catalog.archives.gov'),
      probe_url: str('URL for source_reachability to probe; defaults to https://<host>/'),
      note: str('what it is, in a few words — this is what the reachability report prints'),
      agent: str('who added it')
    }, ['case', 'host']) },
  { name: 'casefile_sources',
    description: 'List the extra source hosts this case has added on top of the built-in allowlist, with who added each and why.',
    inputSchema: S({ case: str('case slug') }, ['case']) },
  { name: 'casefile_person',
    description: 'Register or update a person - family or an excluded same-name individual. Evidence attaches to people.',
    inputSchema: S({
      case: str('case slug'), person: str('person slug, e.g. wahrmann-sarolta'),
      display_name: str('name as usually written'), aka: str('spelling variants seen in records'),
      born: str('e.g. c.1875'), died: str('e.g. 1967'), relation: str('e.g. mother of subject'),
      status: str('family | excluded | unknown'), tree_id: str('FamilySearch or other tree id'),
      global_id: str('shared identity key when this person also exists in another case — usually set with casefile_person_link instead'),
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
      accessed_at: str('YYYY-MM-DD'), entry_id: num('')
    }, ['case', 'person', 'asserts', 'source_title']) },
  { name: 'casefile_citations',
    description: 'Get every source found for one person, formatted for pasting onto a genealogy profile. casefile_life gives the same sources plus the fact schedule around them.',
    inputSchema: S({ case: str('case slug'), person: str('person slug'),
      across_cases: bool('include sources filed in every case this person is linked into') }, ['case', 'person']) },
  { name: 'casefile_export',
    description: 'Full text of every entry in the case, including superseded consolidations, for archiving outside this service or for recovering something the current brief does not carry.',
    inputSchema: S({ case: str('case slug') }, ['case']) },
  { name: 'casefile_case',
    description: 'Create a case, or update its title, subject or open question.',
    inputSchema: S({ slug: str(''), title: str(''), subject: str(''), question: str('the question the case exists to answer') }, ['slug', 'title']) }
].concat(research.TOOLS);

const text = t => ({ content: [{ type: 'text', text: t }] });
const json = o => text(JSON.stringify(o, null, 2));

function mustCase(slug) {
  const c = ops.getCase(slug);
  if (!c) throw new Error('no such case: ' + slug);
  return c;
}

async function callTool(name, a) {
  a = a || {};
  switch (name) {
    case 'casefile_brief':
      return text(renderBrief(mustCase(a.case), { full: a.full, since: a.since, full_entries: a.full_entries }));
    case 'casefile_queue':   return text(renderQueue(mustCase(a.case), { detail: a.detail }));
    case 'casefile_export':  return text(renderExport(mustCase(a.case)));
    case 'casefile_case':    return json(ops.upsertCase(a));
    case 'casefile_entry_read': {
      const c = mustCase(a.case);
      return text(renderEntry(c, ops.getEntry(a)));
    }
    case 'casefile_queue_get': {
      mustCase(a.case);
      return text(renderQueueItem(ops.getQueueItem(a)));
    }
    case 'casefile_exhausted_read': {
      mustCase(a.case);
      const x = ops.getExhausted(a);
      return text(`DO NOT REPEAT — note ${x.id}${x.entry_id ? ' (filed with entry id ' + x.entry_id + ')' : ''}, ${x.created_at}\n\n${x.note}`);
    }
    case 'casefile_search': { mustCase(a.case); return json(ops.search(a)); }
    case 'casefile_step_upsert': { mustCase(a.case); return json(ops.upsertStep(a)); }
    case 'casefile_doctrine': {
      mustCase(a.case);
      const rows = ops.getDoctrine(a);
      if (a.history) return json(rows);
      if (!rows.length) return text('(no doctrine set for this case yet — casefile_doctrine_set { case, section, body })');
      return text(renderDoctrine(mustCase(a.case)));
    }
    case 'casefile_doctrine_set': {
      mustCase(a.case);
      const r = ops.setDoctrine(a);
      return text(`Doctrine section "${r.section}" ${r.replaced ? 'REPLACED' : 'created'}.` +
        (r.replaced ? ' The previous text is kept — casefile_doctrine { history: true }.' : '') +
        '\nIt now renders at the top of every brief for this case and cannot be hidden by a consolidation.');
    }
    case 'casefile_entry': {
      const r = ops.addEntry(a);
      let msg = `Filed as entry ${r.part_no}. Immutable - a correction is a new entry.`;
      if (String(a.kind || '').toLowerCase() === 'consolidation') {
        msg += '\n\n*** YOU JUST FILED A CONSOLIDATION. IT HAS REPLACED THE PREVIOUS ONE ' +
          'IN casefile_brief, AND EVERY ENTRY BEFORE IT IS NOW HIDDEN FROM THE BRIEF. ***\n' +
          'A consolidation is not a summary of your run - it is the whole working state, ' +
          'and anything standing that it does not carry becomes invisible to every future ' +
          'run. This has already happened once: a migration filed as a consolidation ' +
          'silently dropped the instrument notes and access map.\n' +
          'STANDING STATE SHOULD NOT BE IN HERE AT ALL. Identity anchors, method rules, ' +
          'the access map, spelling and folding rules and instrument behaviour belong in ' +
          'casefile_doctrine_set, which is mutable and is rendered at the top of every ' +
          'brief where no later entry can hide it. Move anything of that kind out of this ' +
          'consolidation now.\n' +
          'CHECK NOW with casefile_brief that nothing standing has gone missing. A run ' +
          'report or a bookkeeping entry should be kind="run".';
      }
      return text(msg);
    }
    case 'casefile_claim': {
      const item = ops.claim(a);
      if (!item) return text('Nothing open in those lanes. Say so plainly in your entry and keep the run short.');
      return json(item);
    }
    case 'casefile_fact_upsert': { mustCase(a.case); return json(ops.upsertFact(a)); }
    case 'casefile_life': {
      const c = mustCase(a.case);
      if (!a.person) return text(renderRoster(c, ops.lifeRoster(a.case)));
      const life = ops.getLife(a);
      const progress = ops.lifeProgress(a.case, a.person, a.across_cases);
      return text(renderLife(c, life, progress, { order: ops.FACT_ORDER }));
    }
    case 'casefile_person_link': { mustCase(a.case); mustCase(a.to_case); return json(ops.linkPerson(a)); }
    case 'casefile_source_add':  { mustCase(a.case); return json(ops.addSource(a)); }
    case 'casefile_sources':     { mustCase(a.case); return json(ops.listSources(a.case)); }
    case 'casefile_queue_upsert': return json(ops.upsertQueueItem(a));
    case 'casefile_exhausted':    return json(ops.addExhausted(a));
    case 'casefile_person':       return json(ops.upsertPerson(a));
    case 'casefile_evidence':     return json(ops.addEvidence(a));
    case 'casefile_citations': {
      const c = mustCase(a.case);
      if (a.across_cases) {
        const life = ops.getLife(a);
        return text(renderLife(c, life, ops.lifeProgress(a.case, a.person, true), { order: ops.FACT_ORDER }));
      }
      const p = db.prepare('SELECT * FROM persons WHERE case_slug=? AND slug=?').get(c.slug, a.person);
      if (!p) throw new Error('no such person: ' + a.person);
      return text(renderCitations(c, p));
    }
    default: {
      const r = await research.call(name, a);
      if (r !== null) return text(r);
      throw new Error('unknown tool: ' + name);
    }
  }
}

async function handle(msg) {
  const id = msg && msg.id;
  const m = msg && msg.method;
  if (m === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: (msg.params && msg.params.protocolVersion) || PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'casefile', version: '1.2.0' }
    } };
  }
  if (m === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (m === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (m === 'tools/call') {
    const p = msg.params || {};
    try {
      return { jsonrpc: '2.0', id, result: await callTool(p.name, p.arguments) };
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
  const post = async (req, res) => {
    const body = req.body;
    const msgs = Array.isArray(body) ? body : [body];
    const out = [];
    for (const msg of msgs) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.id === undefined || msg.id === null) continue;   // notification: no reply
      out.push(await handle(msg));
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
