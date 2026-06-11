// Connaissance des marchés : le joueur ne voit que ce qu'il a observé.
// Trois qualités de donnée, de la meilleure à la pire :
//   - instantané complet (prix + stocks) : la planète où l'on est à quai ;
//   - rumeur de quai : à chaque amarrage, les locaux donnent les prix
//     (sans les stocks) des systèmes voisins, vieux de quelques ticks ;
//   - relevé acheté : même qualité que la rumeur mais plus frais, pour
//     n'importe quel système, contre des crédits.
// Une donnée plus fraîche écrase toujours une donnée plus vieille,
// jamais l'inverse.

import { CONFIG } from '../config.js';
import { RESOURCES, RESOURCE_IDS } from '../../data/resources.js';

const PL = CONFIG.PLAYER;

const upsertSql = `
  INSERT INTO known_prices (planet_id, resource_id, price, stock, seen_tick)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(planet_id, resource_id) DO UPDATE
    SET price = excluded.price, stock = excluded.stock, seen_tick = excluded.seen_tick
    WHERE excluded.seen_tick >= known_prices.seen_tick`;

// Instantané complet de la planète où l'on se trouve.
export function recordFullSnapshot(db, planetId, tick) {
  const upsert = db.prepare(upsertSql);
  const rows = db.prepare(
    'SELECT resource_id, stock, price FROM planet_resources WHERE planet_id = ?'
  ).all(planetId);
  for (const r of rows) upsert.run(planetId, r.resource_id, r.price, r.stock, tick);
}

// Donnée de seconde main pour une planète : prix tels qu'ils étaient il y
// a quelques ticks (puisés dans l'historique), stocks inconnus.
function recordSecondHand(db, planetId, asOfTick) {
  const upsert = db.prepare(upsertSql);
  const past = db.prepare(
    `SELECT price FROM price_history
     WHERE planet_id = ? AND resource_id = ? AND tick <= ?
     ORDER BY tick DESC LIMIT 1`
  );
  for (const resourceId of RESOURCE_IDS) {
    const row = past.get(planetId, resourceId, asOfTick);
    if (row) upsert.run(planetId, resourceId, row.price, null, asOfTick);
  }
}

// Rumeurs de quai : tous les systèmes dans GOSSIP_RADIUS du point
// d'amarrage (y compris le système local), avec une ancienneté qui varie
// d'une planète à l'autre — les nouvelles voyagent mal.
export function recordGossipAround(db, systemId, tick) {
  const nearSystems = db.prepare(
    `SELECT s.id FROM systems s, systems me
     WHERE me.id = ?
       AND (s.x - me.x) * (s.x - me.x) + (s.y - me.y) * (s.y - me.y) <= ?`
  ).all(systemId, PL.GOSSIP_RADIUS ** 2);

  const planetsOf = db.prepare('SELECT id FROM planets WHERE system_id = ?');
  for (const sys of nearSystems) {
    for (const planet of planetsOf.all(sys.id)) {
      const age = 5 + (planet.id % (PL.GOSSIP_MAX_AGE - 4)); // 5..GOSSIP_MAX_AGE
      recordSecondHand(db, planet.id, Math.max(0, tick - age));
    }
  }
}

// Relevé de marché acheté pour un système entier. Retourne le coût.
export function intelCost(db, fromSystemId, targetSystemId) {
  const dist = systemDistance(db, fromSystemId, targetSystemId);
  return Math.round(PL.INTEL.BASE_COST + PL.INTEL.COST_PER_DIST * dist);
}

export function recordIntel(db, targetSystemId, tick) {
  const planets = db.prepare('SELECT id FROM planets WHERE system_id = ?').all(targetSystemId);
  for (const planet of planets) {
    recordSecondHand(db, planet.id, Math.max(0, tick - PL.INTEL.AGE));
  }
}

export function systemDistance(db, a, b) {
  if (a === b) return 0;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return db.prepare(
    'SELECT distance FROM system_distances WHERE system_a = ? AND system_b = ?'
  ).get(lo, hi).distance;
}

// Ce que le joueur sait d'un marché distant (peut être vide).
export function knownMarket(db, planetId) {
  return db.prepare(
    'SELECT resource_id, price, stock, seen_tick FROM known_prices WHERE planet_id = ? ORDER BY resource_id'
  ).all(planetId).map((r) => ({
    ...r,
    name: RESOURCES[r.resource_id].name,
    tier: RESOURCES[r.resource_id].tier,
    basePrice: RESOURCES[r.resource_id].basePrice,
  }));
}

// Fraîcheur de la connaissance par système (pour griser la carte) :
// dernier tick où AU MOINS une planète du système a été observée.
export function knowledgeSummary(db) {
  return db.prepare(
    `SELECT p.system_id AS system_id, MAX(kp.seen_tick) AS last_seen
     FROM known_prices kp JOIN planets p ON p.id = kp.planet_id
     GROUP BY p.system_id`
  ).all();
}
