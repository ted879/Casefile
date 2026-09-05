# casefile

An append-only research log for investigations worked by more than one agent
over a long period.

Built for a genealogical case in which two AI agents and a human worked the same
problem for days and kept losing track of what had already been searched. It
solves the failures that actually cost time:

* **Entry numbers.** Assigned server-side, so two writers cannot fork them.
* **The queue.** Claiming is an atomic operation, so an item cannot be silently
  dropped when a run re-types the list.
* **The read.** One stable URL returns the current brief, so an agent that can
  only make GET requests can still start work correctly.
* **The size of the read.** The brief is bounded, so it stays readable however
  long the case runs.
* **Standing state.** Anchors, method rules and access maps live in doctrine,
  where a later entry cannot hide them.

Entries are immutable. Nothing is ever updated or deleted — the trail of what
was tried and failed is the point, not just the current state.

## The bounded brief

The brief used to render every entry since the consolidation in full, plus every
queue item's detail, plus every do-not-repeat note. On a live case that reached
1.2 million characters, which is past what the agents instructed to "read the
brief first" can read at all.

It is now capped (`BRIEF_MAX_CHARS`, default 60000) and carries:

* the case **doctrine**, in full
* the newest **consolidation**, in full
* a one-line **index** of every entry since it, plus the newest entry in full
* the **queue** as titles, with each item's step count
* the whole **do-not-repeat** list, trimmed per note, with ids

Nothing is deleted — the detail is one call away (`casefile_entry_read`,
`casefile_queue_get`, `casefile_exhausted_read`, `casefile_search`, or
`casefile_brief { full: true }`). If a case grows past the cap the brief
degrades in a fixed order, worst-last, and says at the top exactly what it
compressed. The queue and the do-not-repeat list are shortened per row but never
cut off, and the assembled text is never blind-sliced at the tail.

## Doctrine

Standing state — identity anchors, method rules, the access map, spelling and
folding rules, instrument behaviour — belongs in `doctrine`, not inside an entry
marked `kind='consolidation'`. Filing a new consolidation hides the previous one
from the brief; that has already happened once on a live case and silently
dropped its method rules until a later run noticed and rebuilt them.

Doctrine is mutable, rendered at the top of every brief, and versioned: replacing
a section keeps the old text in `doctrine_history`.

## Steps

A queue item's progress lives in `queue_steps`, one row per step, so marking step
(ii) done is one call and does not mean re-sending the item's detail. Before this
existed, runs wrote progress into the item's *title*, and the titles became
paragraphs.

## The fact schedule

A case answers a question. A **person** has a life, and a life has a fixed set of
answerable facts — birth, name-change, religion, adoption, education, occupation,
military, residence, emigration, arrival, naturalisation, marriage, child,
divorce, death, burial, probate, other.

`casefile_fact_upsert` records one of them with the coverage that settled it.
`casefile_life` renders the result: every fact with its status and value, the
coverage behind each null, every source attached to the person, and — last — the
facts nobody has looked for yet.

That last list is the point. It makes **exhausted** a countable condition instead
of a feeling: a person is exhausted when no fact is UNSEARCHED and none is
CONFLICTED. A null belongs in the schedule with `SEARCHED_NULL` and its coverage;
a fact that cannot apply belongs there as `NA`. Silence is neither.

`seq 0` is the fact itself, or the verdict on a repeatable category ("two
children, both enumerated"); `seq 1..n` are the instances. `casefile_life` with
a case but no person gives the roster: who is registered and how far each life
has got.

## One person, several cases

A person can be the subject of their own case and a collateral in another.
`casefile_person_link` declares that two records are one human. Evidence keeps
living in the case that found it; `casefile_life` and `casefile_citations` with
`across_cases: true` gather it all. Without the link, the same person becomes two
records that drift apart.

## Per-case sources

The built-in `source_fetch` allowlist is entirely Central European, because that
is where this investigation started. A case about someone who emigrated needs
different repositories. `casefile_source_add` widens the allowlist **for one
case**, records who added the host and why, and `source_reachability` names those
hosts in its report — so a widened allowlist is visible rather than silent. Pass
`case` to `source_fetch` for it to honour them.

## Endpoints

Read (no auth, unguessable key in the query string):

    GET /c/:case/brief?k=KEY            the working brief an agent reads (bounded)
    GET /c/:case/brief?k=KEY&full=1     the unbounded brief
    GET /c/:case/queue?k=KEY            open items as titles, with step counts
    GET /c/:case/queue?k=KEY&detail=1   ...with every item's full detail
    GET /c/:case/doctrine?k=KEY         the standing state
    GET /c/:case/entry/:n?k=KEY         one entry in full
    GET /c/:case/item/:letter?k=KEY     one queue item with its steps
    GET /c/:case/lives?k=KEY            fact-schedule completeness per person
    GET /c/:case/life/:person?k=KEY     one life in full (&across=1 spans cases)
    GET /c/:case/export?k=KEY           full text dump, for archiving

Write (Bearer token):

    POST /api/claim               atomically claim the first open item
    POST /api/entry               append an entry, server assigns the number
    POST /api/queue               add or retire a queue item
    POST /api/step                add or update one step of a queue item
    POST /api/doctrine            create or replace one doctrine section
    POST /api/exhausted           record a closed avenue with its coverage
    POST /api/person              register a person
    POST /api/evidence            attach citable evidence to a person
    POST /api/fact                record one fact of one person's life
    POST /api/link                declare two person records to be one person
    POST /api/source              add a source host to this case's allowlist

Human:

    GET  /c/:case                 read view
    GET  /c/:case/paste           one box, for landing an agent's entry
    GET  /c/:case/p/:person       a person and every source found for them
    GET  /c/:case/p/:person/citations.txt   ready to paste into a tree

## MCP

The same operations are exposed as MCP tools at `POST /mcp` (Bearer token).
`casefile_brief` is the entry point; `casefile_entry_read`, `casefile_queue_get`,
`casefile_exhausted_read` and `casefile_search` are how a run opens anything the
brief lists but does not print in full; `casefile_life` is the per-person view
and the definition of when a person is finished.
