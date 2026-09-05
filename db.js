'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || '/data/casefile.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS cases (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  subject     TEXT,
  question    TEXT,
  read_key    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Entries are IMMUTABLE. There is no update or delete path anywhere in the API.
CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_slug   TEXT NOT NULL REFERENCES cases(slug),
  part_no     INTEGER NOT NULL,
  agent       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'run',
  claimed     TEXT,
  headline    TEXT,
  body        TEXT NOT NULL,
  stamp       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(case_slug, part_no)
);

CREATE TABLE IF NOT EXISTS queue_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  case_slug     TEXT NOT NULL REFERENCES cases(slug),
  letter        TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT,
  lane          TEXT NOT NULL DEFAULT 'agent',
  status        TEXT NOT NULL DEFAULT 'open',
  rank          INTEGER NOT NULL DEFAULT 100,
  claimed_by    TEXT,
  claimed_at    TEXT,
  claim_entry   INTEGER,
  resolution    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(case_slug, letter)
);

-- A queue item's progress, as rows rather than as prose inside detail.
-- Marking one step done used to mean re-sending the whole detail body, so runs
-- wrote status into the TITLE instead and the titles became paragraphs.
CREATE TABLE IF NOT EXISTS queue_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_slug   TEXT NOT NULL REFERENCES cases(slug),
  letter      TEXT NOT NULL,
  step        TEXT NOT NULL,
  title       TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  note        TEXT,
  rank        INTEGER NOT NULL DEFAULT 100,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(case_slug, letter, step)
);

-- DOCTRINE is the case's standing state: identity anchors, method rules, the
-- access map, spelling and folding rules, instrument behaviour. It used to live
-- inside whichever entry was marked kind='consolidation', which meant filing a
-- new consolidation silently hid it -- that has already happened once and cost
-- the susz case an entire recovery entry. Doctrine is mutable and always
-- rendered in the brief, so it can never be hidden by a later entry.
CREATE TABLE IF NOT EXISTS doctrine (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_slug   TEXT NOT NULL REFERENCES cases(slug),
  section     TEXT NOT NULL,
  body        TEXT NOT NULL,
  rank        INTEGER NOT NULL DEFAULT 100,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(case_slug, section)
);

-- Mutable, but nothing is ever lost: every set files the previous body here.
CREATE TABLE IF NOT EXISTS doctrine_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_slug   TEXT NOT NULL,
  section     TEXT NOT NULL,
  body        TEXT NOT NULL,
  updated_by  TEXT,
  replaced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exhausted (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_slug   TEXT NOT NULL REFERENCES cases(slug),
  note        TEXT NOT NULL,
  entry_id    INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS persons (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  case_slug     TEXT NOT NULL REFERENCES cases(slug),
  slug          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  aka           TEXT,
  born          TEXT,
  died          TEXT,
  relation      TEXT,
  status        TEXT NOT NULL DEFAULT 'family',
  tree_id       TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(case_slug, slug)
);

CREATE TABLE IF NOT EXISTS evidence (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  case_slug     TEXT NOT NULL REFERENCES cases(slug),
  person_id     INTEGER REFERENCES persons(id),
  kind          TEXT,
  asserts       TEXT NOT NULL,
  record_date   TEXT,
  source_title  TEXT NOT NULL,
  repository    TEXT,
  locator       TEXT,
  url           TEXT,
  quote         TEXT,
  confidence    TEXT NOT NULL DEFAULT 'CANDIDATE',
  entry_id      INTEGER,
  accessed_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entries_case  ON entries(case_slug, part_no);
CREATE INDEX IF NOT EXISTS idx_queue_case    ON queue_items(case_slug, status, rank);
CREATE INDEX IF NOT EXISTS idx_evidence_pers ON evidence(person_id);
CREATE INDEX IF NOT EXISTS idx_steps_item    ON queue_steps(case_slug, letter, rank);
CREATE INDEX IF NOT EXISTS idx_doctrine_case ON doctrine(case_slug, rank);
`);

module.exports = { db, DB_PATH };
