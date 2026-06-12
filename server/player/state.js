// État du joueur : initialisation d'une nouvelle partie, accès aux
// tiers de marché, helpers communs aux autres modules joueur.

import { CONFIG } from '../config.js';
import { BIOMES } from '../../data/biomes.js';
import { createRng } from '../universe/rng.js';
import { getMeta, getCurrentTick } from '../db.js';
import { recordFullSnapshot, recordGossipAround } from './knowledge.js';
import { SCENARIO_BY_ID, DEFAULT_SCENARIO } from '../../data/scenarios.js';
// Import circulaire bénin (fonctions appelées à l'exécution seulement).
import { depositQuality } from './concession.js';

const PL = CONFIG.PLAYER;

// ── Tiers de marché ──────────────────────────────────────────────

export function tierOf(populationM) {
  if (populationM >= PL.TIERS[3].minPop) return 3;
  if (populationM >= PL.TIERS[2].minPop) return 2;
  return 1;
}

export function hasTierAccess(player, tier) {
  if (tier <= 1) return true;
  return player.prestige >= PL.TIERS[tier].prestige || player.licence_tier >= tier;
}

// ── Accès ─────────────────────────────────────────────────────────

export function getPlayer(db) {
  return db.prepare('SELECT * FROM player WHERE id = 1').get();
}

// Sans id : le vaisseau-amiral (le plus ancien). Toutes les commandes
// joueur acceptent un shipId optionnel depuis la Phase 5 (flotte).
export function getShip(db, shipId) {
  if (shipId !== undefined && shipId !== null) {
    return db.prepare('SELECT * FROM ships WHERE id = ?').get(shipId);
  }
  return db.prepare('SELECT * FROM ships ORDER BY id LIMIT 1').get();
}

export function getFleet(db) {
  return db.prepare('SELECT * FROM ships ORDER BY id').all();
}

export function getCargo(db, shipId) {
  return db.prepare(
    'SELECT resource_id, quantity, avg_cost FROM ship_cargo WHERE ship_id = ? AND quantity > 0 ORDER BY resource_id'
  ).all(shipId);
}

export function cargoUsed(db, shipId) {
  return db.prepare(
    'SELECT COALESCE(SUM(quantity), 0) AS used FROM ship_cargo WHERE ship_id = ?'
  ).get(shipId).used;
}

export function adjustCredits(db, delta) {
  db.prepare('UPDATE player SET credits = ROUND(credits + ?, 2) WHERE id = 1').run(delta);
}

export function addPrestige(db, points) {
  db.prepare('UPDATE player SET prestige = ROUND(prestige + ?, 1) WHERE id = 1').run(points);
}

// ── Nouvelle partie ──────────────────────────────────────────────
// Le scénario fixe le capital, la flotte et la présence de départ. Par
// défaut (« colporteur »), le joueur démarre sur un monde minier T1 avec
// une concession qui extrait la ressource phare du biome local : comme la
// planète extrait déjà la même chose, le marché y est saturé, le prix bas,
// ce qui pousse immédiatement à transporter ailleurs.

export function initPlayer(db, opts = {}) {
  const scenario = SCENARIO_BY_ID[opts.scenarioId] ?? SCENARIO_BY_ID[DEFAULT_SCENARIO];
  const rng = createRng((Number(getMeta(db, 'seed')) ^ 0x9e3779b9) >>> 0);
  const tick = getCurrentTick(db);

  // Monde de départ : un monde minier ouvert à tous, ou un monde de la
  // Frange (sans faction) pour les départs précaires.
  const query = scenario.home === 'fringe'
    ? `SELECT p.id, p.system_id, p.biome FROM planets p
       JOIN systems s ON s.id = p.system_id
       WHERE p.population < ? AND s.faction_id IS NULL
         AND p.biome IN ('rocky', 'volcanic', 'desert') ORDER BY p.id`
    : `SELECT p.id, p.system_id, p.biome FROM planets p
       WHERE p.population < ? AND p.biome IN ('rocky', 'volcanic', 'desert') ORDER BY p.id`;
  let candidates = db.prepare(query).all(PL.TIERS[2].minPop);
  if (candidates.length === 0) {
    candidates = db.prepare(
      `SELECT id, system_id, biome FROM planets WHERE population < ?
       AND biome IN ('rocky', 'volcanic', 'desert') ORDER BY id`
    ).all(PL.TIERS[2].minPop);
  }
  // Le filon de départ est garanti correct : on ne commence pas sur un
  // gisement pauvre (la variance, c'est pour la prospection).
  const decent = candidates.filter((p) => depositQuality(db, p.id) >= PL.DEPOSITS.HOME_MIN);
  const pool = decent.length > 0 ? decent : candidates;
  const home = pool[Math.floor(rng.next() * pool.length)];

  const extraction = BIOMES[home.biome].extraction;
  const resourceId = Object.entries(extraction).sort((a, b) => b[1] - a[1])[0][0];

  // Identité de la maison : fournie, ou tirée au sort (déterministe).
  const H = PL.HOUSE;
  const houseName = opts.houseName?.trim()
    || H.DEFAULT_NAMES[Math.floor(rng.next() * H.DEFAULT_NAMES.length)];
  const houseColor = opts.houseColor
    || H.CREST_COLORS[Math.floor(rng.next() * H.CREST_COLORS.length)];

  db.transaction(() => {
    db.prepare(
      `INSERT INTO player (id, credits, prestige, licence_tier, house_name, house_color, hq_level)
       VALUES (1, ?, 0, ?, ?, ?, 0)`
    ).run(scenario.credits, scenario.licenceTier, houseName, houseColor);

    // Vaisseau-amiral, puis les éventuels vaisseaux supplémentaires du
    // scénario (livrés sur le monde de départ).
    db.prepare(
      `INSERT INTO ships (name, planet_id, cargo_capacity, fuel, fuel_capacity, speed, mode, class)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', 'freighter')`
    ).run(PL.SHIP.NAME, home.id, PL.SHIP.CARGO, PL.SHIP.FUEL_CAP, PL.SHIP.FUEL_CAP, PL.SHIP.SPEED);
    scenario.ships.forEach((classId, i) => {
      const cls = CONFIG.SHIPS.CLASSES[classId];
      if (!cls) return;
      db.prepare(
        `INSERT INTO ships (name, planet_id, cargo_capacity, fuel, fuel_capacity, speed, mode, class)
         VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`
      ).run(CONFIG.SHIPS.NAMES[(i + 1) % CONFIG.SHIPS.NAMES.length],
        home.id, cls.cargo, cls.fuel, cls.fuel, cls.speed, classId);
    });

    if (scenario.concession) {
      db.prepare('INSERT INTO concessions (planet_id, resource_id, level) VALUES (?, ?, 1)')
        .run(home.id, resourceId);
    }

    recordFullSnapshot(db, home.id, tick);
    recordGossipAround(db, home.system_id, tick);
  })();

  return {
    homePlanetId: home.id,
    concessionResource: scenario.concession ? resourceId : null,
    scenario,
  };
}
