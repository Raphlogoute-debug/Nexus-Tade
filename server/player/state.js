// État du joueur : initialisation d'une nouvelle partie, accès aux
// tiers de marché, helpers communs aux autres modules joueur.

import { CONFIG } from '../config.js';
import { BIOMES } from '../../data/biomes.js';
import { createRng } from '../universe/rng.js';
import { getMeta, getCurrentTick } from '../db.js';
import { recordFullSnapshot, recordGossipAround } from './knowledge.js';

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
// Le joueur démarre sur un monde minier T1 (ouvert à tous) avec une
// concession qui extrait la ressource phare du biome local. Comme la
// planète extrait déjà la même chose, le marché local est saturé : le prix
// y est bas, ce qui pousse immédiatement à transporter ailleurs.

export function initPlayer(db) {
  const rng = createRng((Number(getMeta(db, 'seed')) ^ 0x9e3779b9) >>> 0);
  const tick = getCurrentTick(db);

  const candidates = db.prepare(
    `SELECT id, system_id, biome FROM planets
     WHERE population < ? AND biome IN ('rocky', 'volcanic', 'desert')
     ORDER BY id`
  ).all(PL.TIERS[2].minPop);
  const home = candidates[Math.floor(rng.next() * candidates.length)];

  // Ressource de concession = la plus extraite par le biome de départ.
  const extraction = BIOMES[home.biome].extraction;
  const resourceId = Object.entries(extraction).sort((a, b) => b[1] - a[1])[0][0];

  db.transaction(() => {
    db.prepare('INSERT INTO player (id, credits, prestige, licence_tier) VALUES (1, ?, 0, 1)')
      .run(PL.START_CREDITS);
    db.prepare(
      `INSERT INTO ships (name, planet_id, cargo_capacity, fuel, fuel_capacity, speed, mode, class)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', 'freighter')`
    ).run(PL.SHIP.NAME, home.id, PL.SHIP.CARGO, PL.SHIP.FUEL_CAP, PL.SHIP.FUEL_CAP, PL.SHIP.SPEED);
    db.prepare(
      'INSERT INTO concessions (planet_id, resource_id, level) VALUES (?, ?, 1)'
    ).run(home.id, resourceId);

    recordFullSnapshot(db, home.id, tick);
    recordGossipAround(db, home.system_id, tick);
  })();

  return { homePlanetId: home.id, concessionResource: resourceId };
}
