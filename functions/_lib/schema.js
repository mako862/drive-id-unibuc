// Schema bazei de date. Sursa unică: schema.sql este generat din acest fișier (npm run schema).
// Tabelele au prefixul cd_ ca să nu se ciocnească cu tabelele vechi (drive_items) din versiunea anterioară.
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cd_items (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   TEXT NOT NULL DEFAULT 'root',
  is_folder   BOOLEAN NOT NULL DEFAULT FALSE,
  size        BIGINT NOT NULL DEFAULT 0,
  type        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS cd_items_parent_idx ON cd_items (parent_id)`,
  `CREATE INDEX IF NOT EXISTS cd_items_status_idx ON cd_items (status)`,
  `CREATE TABLE IF NOT EXISTS cd_links (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  created_at  BIGINT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS cd_tables (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
)`,
];
