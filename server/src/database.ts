import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createDatabase(databasePath: string) {
  if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS accepted_operations (
      operation_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      FOREIGN KEY (device_id) REFERENCES devices(id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS entities (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
      payload TEXT,
      updated_at TEXT NOT NULL,
      source_device_id TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id),
      FOREIGN KEY (source_device_id) REFERENCES devices(id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS change_log (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
      payload TEXT,
      updated_at TEXT NOT NULL,
      source_device_id TEXT NOT NULL,
      FOREIGN KEY (source_device_id) REFERENCES devices(id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS change_log_sequence_idx ON change_log(sequence);
  `);
  return database;
}

export type DayDeskDatabase = ReturnType<typeof createDatabase>;
