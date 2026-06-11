// Initialisation SQLite + schéma. Le reste du serveur reçoit l'instance
// `db` en paramètre (injection), ce qui permet de tester moteur et
// générateur sur une base ':memory:' sans toucher au disque.

import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS systems (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  x    REAL NOT NULL,
  y    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS planets (
  id         INTEGER PRIMARY KEY,
  system_id  INTEGER NOT NULL REFERENCES systems(id),
  name       TEXT NOT NULL,
  biome      TEXT NOT NULL,
  population REAL NOT NULL -- en millions d'habitants
);

-- État économique d'une ressource sur une planète.
-- production  : extraction brute par tick (0 si la planète n'en extrait pas)
-- consumption : demande civile par tick (population) ; la demande
--               industrielle est calculée depuis planet_industries
CREATE TABLE IF NOT EXISTS planet_resources (
  planet_id   INTEGER NOT NULL REFERENCES planets(id),
  resource_id TEXT NOT NULL,
  stock       REAL NOT NULL,
  production  REAL NOT NULL,
  consumption REAL NOT NULL,
  price       REAL NOT NULL,
  PRIMARY KEY (planet_id, resource_id)
);

-- Industries installées : la planète exécute la recette recipe_id
-- jusqu'à "rate" fois par tick (limité par les stocks d'entrée).
CREATE TABLE IF NOT EXISTS planet_industries (
  planet_id INTEGER NOT NULL REFERENCES planets(id),
  recipe_id TEXT NOT NULL,
  rate      REAL NOT NULL,
  PRIMARY KEY (planet_id, recipe_id)
);

-- Distances précalculées entre systèmes (a < b), pour le coût de
-- transport des phases suivantes.
CREATE TABLE IF NOT EXISTS system_distances (
  system_a INTEGER NOT NULL,
  system_b INTEGER NOT NULL,
  distance REAL NOT NULL,
  PRIMARY KEY (system_a, system_b)
);

CREATE TABLE IF NOT EXISTS price_history (
  planet_id   INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  tick        INTEGER NOT NULL,
  price       REAL NOT NULL,
  PRIMARY KEY (planet_id, resource_id, tick)
);
CREATE INDEX IF NOT EXISTS idx_price_history_tick ON price_history(tick);
`;

export function createDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

// ── Helpers meta (clé/valeur) ────────────────────────────────────

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function getCurrentTick(db) {
  return Number(getMeta(db, 'current_tick') ?? 0);
}

// Vide toutes les tables (utilisé par /api/admin/regenerate).
export function wipe(db) {
  db.transaction(() => {
    for (const table of [
      'price_history', 'planet_industries', 'planet_resources',
      'system_distances', 'planets', 'systems', 'meta',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  })();
}
