# casefile

An append-only research log for investigations worked by more than one agent
over a long period.

Built for a genealogical case in which two AI agents and a human worked the same
problem for days and kept losing track of what had already been searched. It
solves the three failures that actually cost time:

* **Entry numbers.** Assigned server-side, so two writers cannot fork them.
* **The queue.** Claiming is an atomic operation, so an item cannot be silently
  dropped when a run re-types the list.
* **The read.** One stable URL returns the current brief, so an agent that can
  only make GET requests can still start work correctly.

Entries are immutable. Nothing is ever updated or deleted — the trail of what
was tried and failed is the point, not just the current state.

## Endpoints

Read (no auth, unguessable key in the query string):

    GET /c/:case/brief?k=KEY      the working brief an agent reads
    GET /c/:case/queue?k=KEY      open items and who holds them
    GET /c/:case/export?k=KEY     full text dump, for archiving

Write (Bearer token):

    POST /api/claim               atomically claim the first open item
    POST /api/entry               append an entry, server assigns the number
    POST /api/queue               add or retire a queue item
    POST /api/person              register a person
    POST /api/evidence            attach citable evidence to a person

Human:

    GET  /c/:case                 read view
    GET  /c/:case/paste           one box, for landing an agent's entry
    GET  /c/:case/p/:person       a person and every source found for them
    GET  /c/:case/p/:person/citations.txt   ready to paste into a tree
