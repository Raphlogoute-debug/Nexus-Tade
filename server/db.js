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

-- Concessions du joueur (plusieurs depuis la Phase 6). resource_id =
-- ressource extraite (la plus abondante du biome local).
CREATE TABLE IF NOT EXISTS concessions (
  id          INTEGER PRIMARY KEY,
  planet_id   INTEGER NOT NULL UNIQUE,
  resource_id TEXT NOT NULL,
  level       INTEGER NOT NULL DEFAULT 1
);

-- Entrepôt multi-ressources d'une concession : l'extraction y entre, les
-- ateliers y puisent et y déposent, le joueur charge/décharge sa soute.
CREATE TABLE IF NOT EXISTS facility_storage (
  concession_id INTEGER NOT NULL,
  resource_id   TEXT NOT NULL,
  quantity      REAL NOT NULL,
  PRIMARY KEY (concession_id, resource_id)
);

-- Ateliers installés : chaque atelier exécute sa recette à cadence fixe,
-- borné par les entrées disponibles dans l'entrepôt (loi du minimum).
CREATE TABLE IF NOT EXISTS facility_workshops (
  concession_id INTEGER NOT NULL,
  recipe_id     TEXT NOT NULL,
  PRIMARY KEY (concession_id, recipe_id)
);

-- Comptoirs commerciaux (Phase 10) : présence marchande permanente.
-- L'entrepôt du comptoir et ses ordres permanents (acheter sous une
-- limite / vendre au-dessus d'un plancher, exécutés chaque tick).
CREATE TABLE IF NOT EXISTS trading_posts (
  id        INTEGER PRIMARY KEY,
  planet_id INTEGER NOT NULL UNIQUE,
  level     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS post_storage (
  post_id     INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  quantity    REAL NOT NULL DEFAULT 0,
  avg_cost    REAL NOT NULL DEFAULT 0, -- coût moyen d'acquisition (suivi du profit)
  PRIMARY KEY (post_id, resource_id)
);

CREATE TABLE IF NOT EXISTS post_orders (
  id          INTEGER PRIMARY KEY,
  post_id     INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  side        TEXT NOT NULL,        -- buy | sell
  limit_price REAL NOT NULL,        -- achat si prix ≤ limite ; vente si prix ≥ plancher
  flow        REAL NOT NULL,        -- unités max échangées par tick
  last_qty    REAL NOT NULL DEFAULT 0, -- exécuté au dernier tick (retour UI)
  last_price  REAL NOT NULL DEFAULT 0
);

-- Objectifs : jalons de la carrière marchande (id du catalogue
-- data/objectives.js), avec le tick où chacun a été atteint.
CREATE TABLE IF NOT EXISTS objectives (
  id             TEXT PRIMARY KEY,
  completed_tick INTEGER NOT NULL
);

-- Missions de vente (Phase 12) : « vendre N de X à tel marché ». Un
-- vaisseau disponible charge à la concession, livre, vend, revient —
-- plusieurs allers-retours si la quantité dépasse sa soute. quantity =
-- restant à vendre.
CREATE TABLE IF NOT EXISTS missions (
  id             INTEGER PRIMARY KEY,
  ship_id        INTEGER NOT NULL UNIQUE,
  resource_id    TEXT NOT NULL,
  quantity       REAL NOT NULL,
  from_planet_id INTEGER NOT NULL,
  to_planet_id   INTEGER NOT NULL,
  created_tick   INTEGER NOT NULL
);

-- Équipement des vaisseaux (Phase 13) : un module de chaque type par
-- vaisseau (l'effet est appliqué aux colonnes du vaisseau à l'achat).
CREATE TABLE IF NOT EXISTS ship_equipment (
  ship_id   INTEGER NOT NULL,
  module_id TEXT NOT NULL,
  PRIMARY KEY (ship_id, module_id)
);

-- Clients réguliers (Phase 13) : contrats d'approvisionnement civils à
-- prix fixé à la signature. status : open (offre) | taken (signé) |
-- done | expired.
CREATE TABLE IF NOT EXISTS supply_contracts (
  id           INTEGER PRIMARY KEY,
  planet_id    INTEGER NOT NULL,
  resource_id  TEXT NOT NULL,
  quantity     REAL NOT NULL,
  remaining    REAL NOT NULL,
  unit_price   REAL NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  created_tick INTEGER NOT NULL,
  expires_tick INTEGER NOT NULL
);

-- Fidélité des clients : chaque contrat honoré fait grimper le niveau —
-- volumes plus gros, primes meilleures, offres prioritaires.
CREATE TABLE IF NOT EXISTS client_loyalty (
  planet_id INTEGER PRIMARY KEY,
  level     INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0
);

-- Accords commerciaux (Phase 13) : pactes signés avec des factions amies.
CREATE TABLE IF NOT EXISTS faction_pacts (
  faction_id  INTEGER PRIMARY KEY,
  signed_tick INTEGER NOT NULL
);

-- Influence de guerre : soutien matériel (décroissant) du joueur à chaque
-- faction. Sert à attribuer au joueur le mérite des conquêtes/victoires.
CREATE TABLE IF NOT EXISTS war_support (
  faction_id INTEGER PRIMARY KEY,
  support    REAL NOT NULL DEFAULT 0
);

-- Phase 15 : sondages géologiques (la qualité des gisements se mémorise).
CREATE TABLE IF NOT EXISTS deposit_surveys (
  planet_id     INTEGER PRIMARY KEY,
  surveyed_tick INTEGER NOT NULL
);

-- Grands chantiers : mégaprojets de faction, programme d'achat massif à
-- prix garanti. delivered_player suit votre part (prestige du bâtisseur).
CREATE TABLE IF NOT EXISTS megaprojects (
  id           INTEGER PRIMARY KEY,
  faction_id   INTEGER NOT NULL,
  type_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active', -- active | done | abandoned
  started_tick INTEGER NOT NULL,
  expires_tick INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS megaproject_needs (
  project_id       INTEGER NOT NULL,
  resource_id      TEXT NOT NULL,
  required         REAL NOT NULL,
  delivered        REAL NOT NULL DEFAULT 0,
  delivered_player REAL NOT NULL DEFAULT 0,
  unit_price       REAL NOT NULL, -- fixé au lancement (base × premium)
  PRIMARY KEY (project_id, resource_id)
);

-- Colonies naissantes : un petit monde en plein boom démographique.
CREATE TABLE IF NOT EXISTS colonies (
  planet_id    INTEGER PRIMARY KEY,
  started_tick INTEGER NOT NULL,
  boom_until   INTEGER NOT NULL
);

-- Repaires pirates : ils grossissent tant qu'on les laisse faire.
CREATE TABLE IF NOT EXISTS pirate_lairs (
  system_id    INTEGER PRIMARY KEY,
  strength     INTEGER NOT NULL DEFAULT 1,
  created_tick INTEGER NOT NULL
);

-- La course aux filons : concessions des maisons rivales.
CREATE TABLE IF NOT EXISTS rival_concessions (
  planet_id     INTEGER PRIMARY KEY,
  rival_id      INTEGER NOT NULL,
  resource_id   TEXT NOT NULL,
  acquired_tick INTEGER NOT NULL
);

-- Observatoire : l'histoire de l'empire, échantillonnée.
CREATE TABLE IF NOT EXISTS empire_history (
  tick       INTEGER PRIMARY KEY,
  revenue    REAL NOT NULL,
  units_sold REAL NOT NULL,
  credits    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS player_tech (
  tech_id       TEXT PRIMARY KEY,
  acquired_tick INTEGER NOT NULL
);

-- Prêts de guerre du joueur : remboursés (avec intérêts) si l'emprunteur
-- gagne ou signe la paix ; perdus s'il capitule.
CREATE TABLE IF NOT EXISTS loans (
  id          INTEGER PRIMARY KEY,
  faction_id  INTEGER NOT NULL,
  war_id      INTEGER NOT NULL,
  amount      REAL NOT NULL,
  issued_tick INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open', -- open | repaid | defaulted
  payout      REAL
);

-- Parts du joueur dans les industries planétaires (share ∈ ]0, 0.49]).
CREATE TABLE IF NOT EXISTS industry_shares (
  planet_id INTEGER NOT NULL,
  recipe_id TEXT NOT NULL,
  share     REAL NOT NULL,
  PRIMARY KEY (planet_id, recipe_id)
);

-- Routes logistiques : un circuit d'étapes que des vaisseaux assignés
-- parcourent en boucle (mode 'route'), exécutant les actions de chaque
-- étape (charger/déposer à vos concessions, acheter/vendre au marché).
CREATE TABLE IF NOT EXISTS routes (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_stops (
  route_id  INTEGER NOT NULL,
  position  INTEGER NOT NULL,
  planet_id INTEGER NOT NULL,
  actions   TEXT NOT NULL, -- JSON : [{ type, resourceId?, quantity? }]
  PRIMARY KEY (route_id, position)
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

-- Maisons de commerce rivales (Phase 11) : des concurrents nommés qui
-- arbitrent et accaparent sur les vrais marchés. cornering_* décrit un
-- accaparement en cours (ressource, planète, tick de fin).
CREATE TABLE IF NOT EXISTS rivals (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  color               TEXT NOT NULL,
  credits             REAL NOT NULL,
  net_worth           REAL NOT NULL DEFAULT 0,
  home_planet_id      INTEGER,
  cornering_resource  TEXT,
  cornering_planet_id INTEGER,
  cornering_until     INTEGER,
  deals_done          INTEGER NOT NULL DEFAULT 0
);

-- Réserves d'une maison rivale (ce qu'elle a accaparé et pas encore écoulé).
CREATE TABLE IF NOT EXISTS rival_holdings (
  rival_id    INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  quantity    REAL NOT NULL DEFAULT 0,
  avg_cost    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (rival_id, resource_id)
);

-- Historique de valeur nette (échantillonné) : joueur et rivaux, pour le
-- graphe de classement. subject = 'player' ou 'rival:<id>'.
CREATE TABLE IF NOT EXISTS networth_history (
  subject TEXT NOT NULL,
  tick    INTEGER NOT NULL,
  value   REAL NOT NULL,
  PRIMARY KEY (subject, tick)
);
`;

// Colonnes ajoutées après coup (migration douce des parties existantes).
const MIGRATIONS = [
  { table: 'systems', column: 'faction_id', ddl: 'ALTER TABLE systems ADD COLUMN faction_id INTEGER' },
  { table: 'planets', column: 'supply', ddl: 'ALTER TABLE planets ADD COLUMN supply REAL NOT NULL DEFAULT 1' },
  { table: 'ships', column: 'mode', ddl: "ALTER TABLE ships ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual'" },
  { table: 'ships', column: 'class', ddl: "ALTER TABLE ships ADD COLUMN class TEXT NOT NULL DEFAULT 'freighter'" },
  { table: 'ships', column: 'route_id', ddl: 'ALTER TABLE ships ADD COLUMN route_id INTEGER' },
  { table: 'ships', column: 'route_stop', ddl: 'ALTER TABLE ships ADD COLUMN route_stop INTEGER NOT NULL DEFAULT 0' },
  { table: 'ships', column: 'false_flag', ddl: 'ALTER TABLE ships ADD COLUMN false_flag INTEGER NOT NULL DEFAULT 0' },
  // Trajets visibles sur la carte : il faut savoir d'où part un marchand.
  { table: 'traders', column: 'from_planet_id', ddl: 'ALTER TABLE traders ADD COLUMN from_planet_id INTEGER' },
  { table: 'traders', column: 'departure_tick', ddl: 'ALTER TABLE traders ADD COLUMN departure_tick INTEGER' },
  // Maison de commerce du joueur (Phase 11) : identité + quartier général.
  { table: 'player', column: 'house_name', ddl: 'ALTER TABLE player ADD COLUMN house_name TEXT' },
  { table: 'player', column: 'house_color', ddl: 'ALTER TABLE player ADD COLUMN house_color TEXT' },
  { table: 'player', column: 'hq_planet_id', ddl: 'ALTER TABLE player ADD COLUMN hq_planet_id INTEGER' },
  { table: 'player', column: 'hq_level', ddl: 'ALTER TABLE player ADD COLUMN hq_level INTEGER NOT NULL DEFAULT 0' },
  // Phase 12 : escorte payée pour le trajet en cours ; revenus de guerre.
  { table: 'ships', column: 'escorted', ddl: 'ALTER TABLE ships ADD COLUMN escorted INTEGER NOT NULL DEFAULT 0' },
  { table: 'player', column: 'war_profit', ddl: 'ALTER TABLE player ADD COLUMN war_profit REAL NOT NULL DEFAULT 0' },
  // Phase 13 : recettes cumulées par route (tableau de bord de la flotte).
  { table: 'routes', column: 'earned', ddl: 'ALTER TABLE routes ADD COLUMN earned REAL NOT NULL DEFAULT 0' },
  // Phase 14 : l'échelle — compteurs à vie (les millions deviennent visibles).
  { table: 'player', column: 'total_units_sold', ddl: 'ALTER TABLE player ADD COLUMN total_units_sold REAL NOT NULL DEFAULT 0' },
  { table: 'player', column: 'total_units_bought', ddl: 'ALTER TABLE player ADD COLUMN total_units_bought REAL NOT NULL DEFAULT 0' },
  { table: 'player', column: 'total_revenue', ddl: 'ALTER TABLE player ADD COLUMN total_revenue REAL NOT NULL DEFAULT 0' },
  // Phase 15 : missions récurrentes ; escorte systématique par route.
  { table: 'missions', column: 'recurring', ddl: 'ALTER TABLE missions ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0' },
  { table: 'missions', column: 'quantity0', ddl: 'ALTER TABLE missions ADD COLUMN quantity0 REAL NOT NULL DEFAULT 0' },
  { table: 'routes', column: 'always_escort', ddl: 'ALTER TABLE routes ADD COLUMN always_escort INTEGER NOT NULL DEFAULT 0' },
];

export function createDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // NORMAL + WAL : fsync aux checkpoints seulement. Le pire cas (coupure
  // de courant) perd quelques ticks de simulation — acceptable pour un
  // jeu, et plusieurs fois plus rapide en écriture.
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);

  // Cache global de requêtes préparées : tout le code appelle db.prepare
  // avec des SQL statiques, souvent à chaque tick voire à chaque ordre.
  // Préparer une seule fois par SQL évite des milliers de compilations.
  const rawPrepare = db.prepare.bind(db);
  const stmtCache = new Map();
  db.prepare = (sql) => {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = rawPrepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  };
  for (const m of MIGRATIONS) {
    const cols = db.pragma(`table_info(${m.table})`).map((c) => c.name);
    if (!cols.includes(m.column)) db.exec(m.ddl);
  }

  // Migration Phase 6 : l'ancienne concession unique devient la première
  // entrée de la table des concessions, son entrepôt mono-ressource passe
  // dans le stockage multi-ressources.
  const hasOldTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'concession'"
  ).get();
  if (hasOldTable) {
    const old = db.prepare('SELECT * FROM concession WHERE id = 1').get();
    if (old && !db.prepare('SELECT 1 FROM concessions LIMIT 1').get()) {
      db.transaction(() => {
        const newId = db.prepare(
          'INSERT INTO concessions (planet_id, resource_id, level) VALUES (?, ?, ?)'
        ).run(old.planet_id, old.resource_id, old.level).lastInsertRowid;
        if (old.stockpile > 0) {
          db.prepare(
            'INSERT INTO facility_storage (concession_id, resource_id, quantity) VALUES (?, ?, ?)'
          ).run(newId, old.resource_id, old.stockpile);
        }
      })();
    }
    db.exec('DROP TABLE concession');
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
      'war_support', 'empire_history', 'rival_concessions', 'pirate_lairs', 'colonies',
      'megaproject_needs', 'megaprojects', 'deposit_surveys',
      'faction_pacts', 'client_loyalty', 'supply_contracts', 'ship_equipment',
      'missions', 'networth_history', 'rival_holdings', 'rivals',
      'objectives', 'post_orders', 'post_storage', 'trading_posts',
      'loans', 'industry_shares', 'route_stops', 'routes',
      'player_tech', 'facility_workshops', 'facility_storage', 'concessions',
      'world_events', 'faction_standing', 'war_fronts', 'wars', 'faction_relations',
      'contracts', 'traders', 'shipments', 'factions',
      'trade_partners', 'known_prices', 'ship_cargo', 'ships',
      'player', 'price_history', 'planet_industries', 'planet_resources',
      'system_distances', 'planets', 'systems', 'meta',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  })();
}
