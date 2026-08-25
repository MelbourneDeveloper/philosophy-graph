-- The Lineage Engine — canonical store. See SPEC.md.
PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS edge;
DROP TABLE IF EXISTS quote;
DROP TABLE IF EXISTS work;
DROP TABLE IF EXISTS school;
DROP TABLE IF EXISTS person;
DROP TABLE IF EXISTS sep_entry;
DROP TABLE IF EXISTS edge_type;

-- Authoritative slug index pulled from plato.stanford.edu/contents.html.
-- Every sep reference in the data must resolve here or the build fails.
CREATE TABLE sep_entry (
  slug    TEXT PRIMARY KEY,
  title   TEXT NOT NULL,
  summary TEXT,               -- opening excerpt of the entry (fetch_sep_summaries.py)
  authors TEXT                -- entry authorship, for attribution
);

CREATE TABLE person (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  born   INTEGER,              -- negative = BCE
  died   INTEGER,              -- NULL = living
  region TEXT,
  sep    TEXT REFERENCES sep_entry(slug),
  blurb  TEXT NOT NULL
);

CREATE TABLE school (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  span_from INTEGER,
  span_to   INTEGER,
  sep      TEXT REFERENCES sep_entry(slug),
  blurb    TEXT NOT NULL
);

CREATE TABLE work (
  id     TEXT PRIMARY KEY,
  title  TEXT NOT NULL,
  by     TEXT NOT NULL REFERENCES person(id),
  year   INTEGER,
  blurb  TEXT NOT NULL
);

CREATE TABLE quote (
  id    TEXT PRIMARY KEY,
  text  TEXT NOT NULL,
  by    TEXT NOT NULL REFERENCES person(id),
  work  TEXT REFERENCES work(id),
  ref   TEXT,                  -- citation locus
  flag  TEXT CHECK (flag IN ('apocryphal') OR flag IS NULL)
);

-- The relation taxonomy is data, not magic strings.
CREATE TABLE edge_type (
  type      TEXT PRIMARY KEY,
  domain    TEXT NOT NULL,     -- p | w | q | m
  range     TEXT NOT NULL,
  label_fwd TEXT NOT NULL,     -- how a → b reads from a's side
  label_rev TEXT NOT NULL,     -- how it reads from b's side
  directed  INTEGER NOT NULL,  -- 1 = arrowed
  style     TEXT NOT NULL      -- solid | dashed | dotted
);

CREATE TABLE edge (
  a    TEXT NOT NULL,
  b    TEXT NOT NULL,
  type TEXT NOT NULL REFERENCES edge_type(type),
  note TEXT,
  PRIMARY KEY (a, b, type)
);

CREATE INDEX idx_edge_a ON edge(a);
CREATE INDEX idx_edge_b ON edge(b);
CREATE INDEX idx_work_by ON work(by);
CREATE INDEX idx_quote_by ON quote(by);
