// La concession minière du joueur : extrait sa ressource à chaque tick
// dans un entrepôt borné. Le joueur charge l'entrepôt en soute quand il
// est à quai, et améliore l'extraction contre des crédits.
// (Phase 4 : la technologie débloquera la transformation sur site.)

import { CONFIG } from '../config.js';
import { getShip, getPlayer, cargoUsed, adjustCredits } from './state.js';

const LEVELS = CONFIG.PLAYER.CONCESSION_LEVELS;

export function getConcession(db) {
  const c = db.prepare('SELECT * FROM concession WHERE id = 1').get();
  if (!c) return null;
  const level = LEVELS[c.level - 1];
  const next = LEVELS[c.level] ?? null;
  return { ...c, rate: level.rate, cap: level.cap, nextLevelCost: next?.cost ?? null };
}

// Appelé par la boucle de simulation : l'extraction continue même quand
// le joueur est ailleurs, mais l'entrepôt déborde vite — il faut passer.
export function tickConcession(db) {
  const c = getConcession(db);
  if (!c) return;
  db.prepare('UPDATE concession SET stockpile = MIN(?, ROUND(stockpile + ?, 2)) WHERE id = 1')
    .run(c.cap, c.rate);
}

// Charge l'entrepôt dans la soute (coût d'acquisition nul : la revente
// est du profit pur, donc du prestige).
export function collectConcession(db, quantity) {
  const c = getConcession(db);
  const ship = getShip(db);
  if (ship.planet_id !== c.planet_id) return { ok: false, error: 'le vaisseau n\'est pas à quai à la concession' };

  const space = ship.cargo_capacity - cargoUsed(db, ship.id);
  const moved = Math.round(Math.min(c.stockpile, space, quantity ?? Infinity) * 100) / 100;
  if (moved <= 0) return { ok: false, error: space <= 0 ? 'soute pleine' : 'entrepôt vide' };

  db.transaction(() => {
    db.prepare('UPDATE concession SET stockpile = ROUND(stockpile - ?, 2) WHERE id = 1').run(moved);
    db.prepare(
      `INSERT INTO ship_cargo (ship_id, resource_id, quantity, avg_cost)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(ship_id, resource_id) DO UPDATE SET
         avg_cost = ROUND((quantity * avg_cost) / (quantity + excluded.quantity), 2),
         quantity = ROUND(quantity + excluded.quantity, 2)`
    ).run(ship.id, c.resource_id, moved);
  })();

  return { ok: true, moved, resourceId: c.resource_id };
}

export function upgradeConcession(db) {
  const c = getConcession(db);
  if (c.nextLevelCost === null) return { ok: false, error: 'niveau maximum atteint' };
  if (getPlayer(db).credits < c.nextLevelCost) return { ok: false, error: 'crédits insuffisants' };

  db.transaction(() => {
    adjustCredits(db, -c.nextLevelCost);
    db.prepare('UPDATE concession SET level = level + 1 WHERE id = 1').run();
  })();

  const after = getConcession(db);
  return { ok: true, level: after.level, rate: after.rate, cap: after.cap, cost: c.nextLevelCost };
}
