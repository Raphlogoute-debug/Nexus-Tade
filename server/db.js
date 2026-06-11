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

-- ── Phase 2 : le joueur ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS player (
  id           INTEGER PRIMARY KEY CHECK (id = 1), -- singleton
  credits      REAL NOT NULL,
  prestige     REAL NOT NULL,
  licence_tier INTEGER NOT NULL DEFAULT 1 -- plus haut tier acheté en licence
);

-- Un seul vaisseau en Phase 2, mais la table est prête pour une flotte.
-- À quai : planet_id renseigné. En transit : planet_id NULL et les
-- colonnes origin/dest/departure/arrival décrivent le voyage.
CREATE TABLE IF NOT EXISTS ships (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  planet_id        INTEGER,
  origin_system_id INTEGER,
  dest_system_id   INTEGER,
  dest_planet_id   INTEGER,
  departure_tick   INTEGER,
  arrival_tick     INTEGER,
  cargo_capacity   REAL NOT NULL,
  fuel             REAL NOT NULL,
  fuel_capacity    REAL NOT NULL,
  speed            REAL NOT NULL
);

-- avg_cost : coût d'achat moyen pondéré, sert à calculer le profit
-- réalisé à la revente (→ prestige).
CREATE TABLE IF NOT EXISTS ship_cargo (
  ship_id     INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  quantity    REAL NOT NULL,
  avg_cost    REAL NOT NULL,
  PRIMARY KEY (ship_id, resource_id)
);

CREATE TABLE IF NOT EXISTS concession (
  id          INTEGER PRIMARY KEY CHECK (id = 1), -- singleton
  planet_id   INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  level       INTEGER NOT NULL,
  stockpile   REAL NOT NULL
);

-- Ce que le joueur SAIT des marchés : derniers prix vus, avec leur date.
-- stock NULL = donnée de seconde main (rumeur de quai, relevé acheté).
CREATE TABLE IF NOT EXISTS known_prices (
  planet_id   INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  price       REAL NOT NULL,
  stock       REAL,
  seen_tick   INTEGER NOT NULL,
  PRIMARY KEY (planet_id, resource_id)
);

CREATE TABLE IF NOT EXISTS trade_partners (
  planet_id        INTEGER PRIMARY KEY,
  first_trade_tick INTEGER NOT NULL
);

-- ── Phase 3 : factions, flux, PNJ ────────────────────────────────

CREATE TABLE IF NOT EXISTS factions (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  color             TEXT NOT NULL,
  capital_planet_id INTEGER NOT NULL,
  fleet             REAL NOT NULL,
  fleet_progress    REAL NOT NULL DEFAULT 0, -- chantier naval (ticks cumulés)
  readiness         REAL NOT NULL DEFAULT 1  -- disponibilité de la flotte (0..1)
);

-- Convois logistiques : des flux datés, pas des vaisseaux individuels.
-- Le stock part de l'origine au départ et arrive à destination plus tard —
-- interceptable (blocus, piraterie) dans les phases suivantes.
CREATE TABLE IF NOT EXISTS shipments (
  id             INTEGER PRIMARY KEY,
  faction_id     INTEGER,
  resource_id    TEXT NOT NULL,
  quantity       REAL NOT NULL,
  from_planet_id INTEGER NOT NULL,
  to_planet_id   INTEGER NOT NULL,
  departure_tick INTEGER NOT NULL,
  arrival_tick   INTEGER NOT NULL
);

-- Marchands indépendants : un seul lot en soute à la fois (cargo_*).
CREATE TABLE IF NOT EXISTS traders (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  planet_id      INTEGER,
  dest_planet_id INTEGER,
  arrival_tick   INTEGER,
  credits        REAL NOT NULL,
  cargo_resource TEXT,
  cargo_qty      REAL NOT NULL DEFAULT 0,
  cargo_cost     REAL NOT NULL DEFAULT 0,
  trades_done    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contracts (
  id                INTEGER PRIMARY KEY,
  faction_id        INTEGER NOT NULL,
  resource_id       TEXT NOT NULL,
  quantity          REAL NOT NULL,
  remaining         REAL NOT NULL,
  unit_price        REAL NOT NULL,
  deliver_planet_id INTEGER NOT NULL,
  expires_tick      INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open' -- open | done | expired
);

-- ── Phase 4 : guerres ────────────────────────────────────────────

-- Relations entre factions (paires a < b). war_id renseigné = en guerre.
CREATE TABLE IF NOT EXISTS faction_relations (
  faction_a INTEGER NOT NULL,
  faction_b INTEGER NOT NULL,
  relation  REAL NOT NULL,
  war_id    INTEGER,
  PRIMARY KEY (faction_a, faction_b)
);

CREATE TABLE IF NOT EXISTS wars (
  id            INTEGER PRIMARY KEY,
  attacker_id   INTEGER NOT NULL,
  defender_id   INTEGER NOT NULL,
  started_tick  INTEGER NOT NULL,
  attacker_fleet0 REAL NOT NULL, -- flottes au déclenchement (seuil d'épuisement)
  defender_fleet0 REAL NOT NULL,
  ended_tick    INTEGER,
  result        TEXT             -- NULL en cours | attacker | defender | peace
);

-- Le front : systèmes contestés. pressure ∈ [-1, 1], positif = l'attaquant
-- gagne du terrain ; à ±1 le système change de mains.
CREATE TABLE IF NOT EXISTS war_fronts (
  war_id    INTEGER NOT NULL,
  system_id INTEGER NOT NULL,
  pressure  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (war_id, system_id)
);

-- Réputation du joueur auprès de chaque faction (-100..100).
CREATE TABLE IF NOT EXISTS faction_standing (
  faction_id INTEGER PRIMARY KEY,
  standing   REAL NOT NULL DEFAULT 0
);

-- Fil d'événements du monde (guerres, conquêtes, saisies…), servi à l'UI.
CREATE TABLE IF NOT EXISTS world_events (
  id         INTEGER PRIMARY KEY,
  tick       INTEGER NOT NULL,
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  faction_id INTEGER
);
`;

// Colonnes ajoutées après coup (migration douce des parties existantes).
const MIGRATIONS = [
  { table: 'systems', column: 'faction_id', ddl: 'ALTER TABLE systems ADD COLUMN faction_id INTEGER' },
  { table: 'planets', column: 'supply', ddl: 'ALTER TABLE planets ADD COLUMN supply REAL NOT NULL DEFAULT 1' },
];

export function createDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  for (const m of MIGRATIONS) {
    const cols = db.pragma(`table_info(${m.table})`).map((c) => c.name);
    if (!cols.includes(m.column)) db.exec(m.ddl);
  }
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
      'world_events', 'faction_standing', 'war_fronts', 'wars', 'faction_relations',
      'contracts', 'traders', 'shipments', 'factions',
      'trade_partners', 'known_prices', 'concession', 'ship_cargo', 'ships',
      'player', 'price_history', 'planet_industries', 'planet_resources',
      'system_distances', 'planets', 'systems', 'meta',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  })();
}
