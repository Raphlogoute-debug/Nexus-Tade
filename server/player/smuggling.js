// Pavillon de complaisance : acheté dans la Frange (systèmes
// indépendants), il rend un vaisseau anonyme — listes noires ouvertes,
// douanes des fronts passées, ventes de guerre sans engagement de
// réputation (dans aucun sens : l'anonymat coupe aussi les gains).
// Chaque opération risquée peut percer la couverture (standing.js).

import { CONFIG } from '../config.js';
import { getPlayer, getShip, adjustCredits } from './state.js';

export function buyFalseFlag(db, shipId) {
  const ship = getShip(db, shipId);
  if (!ship || ship.planet_id === null) return { ok: false, error: 'vaisseau en transit' };
  if (ship.false_flag) return { ok: false, error: 'ce vaisseau navigue déjà sous pavillon de complaisance' };

  const factionId = db.prepare(
    `SELECT s.faction_id FROM planets p JOIN systems s ON s.id = p.system_id WHERE p.id = ?`
  ).get(ship.planet_id).faction_id;
  if (factionId !== null) {
    return { ok: false, error: 'les pavillons de complaisance se négocient dans la Frange (systèmes indépendants)' };
  }

  const cost = CONFIG.SMUGGLING.FLAG_COST;
  if (getPlayer(db).credits < cost) return { ok: false, error: `crédits insuffisants (${cost} cr)` };

  db.transaction(() => {
    adjustCredits(db, -cost);
    db.prepare('UPDATE ships SET false_flag = 1 WHERE id = ?').run(shipId);
  })();
  return { ok: true, shipName: ship.name, cost };
}
