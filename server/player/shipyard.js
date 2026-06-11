// La flotte du joueur : achat de vaisseaux aux chantiers civils des
// mondes établis (tier 2+), et bascule manuel/automatique.

import { CONFIG } from '../config.js';
import { getPlayer, getShip, getFleet, adjustCredits, tierOf } from './state.js';

const SH = CONFIG.SHIPS;

export function buyShip(db, classId) {
  const cls = SH.CLASSES[classId];
  if (!cls) return { ok: false, error: 'classe de vaisseau inconnue' };

  const fleet = getFleet(db);
  if (fleet.length >= SH.MAX_FLEET) {
    return { ok: false, error: `limite technique de ${SH.MAX_FLEET} vaisseaux atteinte` };
  }

  // L'achat se fait là où se trouve N'IMPORTE quel vaisseau à quai sur un
  // monde tier 2+. Le nouveau vaisseau y est livré.
  const dockyard = fleet.find((s) => {
    if (s.planet_id === null) return false;
    const pop = db.prepare('SELECT population FROM planets WHERE id = ?').get(s.planet_id).population;
    return tierOf(pop) >= SH.BUY_MIN_TIER;
  });
  if (!dockyard) {
    return { ok: false, error: `il faut un vaisseau à quai sur un monde tier ${SH.BUY_MIN_TIER}+ (chantier civil)` };
  }

  const player = getPlayer(db);
  if (player.credits < cls.price) return { ok: false, error: 'crédits insuffisants' };

  const n = fleet.length;
  const name = SH.NAMES[n % SH.NAMES.length]
    + (n >= SH.NAMES.length ? ` ${Math.floor(n / SH.NAMES.length) + 1}` : '');
  let shipId;
  db.transaction(() => {
    adjustCredits(db, -cls.price);
    shipId = db.prepare(
      `INSERT INTO ships (name, planet_id, cargo_capacity, fuel, fuel_capacity, speed, mode, class)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`
    ).run(name, dockyard.planet_id, cls.cargo, cls.fuel, cls.fuel, cls.speed, classId).lastInsertRowid;
  })();

  return { ok: true, shipId, name, classLabel: cls.label, price: cls.price, upkeep: cls.upkeep, planetId: dockyard.planet_id };
}

// Entretien de la flotte, prélevé à chaque tick (peut mettre le compte en
// découvert — la flotte reste alors à quai jusqu'à régularisation).
export function fleetUpkeep(db) {
  let total = 0;
  for (const s of getFleet(db)) total += SH.CLASSES[s.class]?.upkeep ?? 0;
  return total;
}

export function tickFleetUpkeep(db) {
  const total = fleetUpkeep(db);
  if (total > 0) adjustCredits(db, -total);
  return total;
}

export function setShipMode(db, shipId, mode) {
  if (!['manual', 'auto'].includes(mode)) return { ok: false, error: 'mode invalide (manual | auto)' };
  const ship = getShip(db, shipId);
  if (!ship) return { ok: false, error: 'vaisseau inconnu' };
  // Quitter une route assignée remet le compteur d'étapes à zéro.
  db.prepare('UPDATE ships SET mode = ?, route_id = NULL, route_stop = 0 WHERE id = ?')
    .run(mode, shipId);
  return { ok: true, shipId, mode, name: ship.name };
}
