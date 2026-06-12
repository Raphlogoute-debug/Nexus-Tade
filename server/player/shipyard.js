// La flotte du joueur : achat de vaisseaux aux chantiers civils des
// mondes établis (tier 2+), et bascule manuel/automatique.

import { CONFIG } from '../config.js';
import { getPlayer, getShip, getFleet, adjustCredits, tierOf } from './state.js';
import { hasTech } from './tech.js';
import { hqBonuses } from './house.js';

const SH = CONFIG.SHIPS;

// Plafond de flotte : garde-fou technique + bonus du quartier général.
export function maxFleet(db) {
  return SH.MAX_FLEET + hqBonuses(db).maxFleetBonus;
}

export function buyShip(db, classId) {
  const cls = SH.CLASSES[classId];
  if (!cls) return { ok: false, error: 'classe de vaisseau inconnue' };

  const fleet = getFleet(db);
  const cap = maxFleet(db);
  if (fleet.length >= cap) {
    return { ok: false, error: `limite de ${cap} vaisseaux atteinte (agrandissez le QG)` };
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
  const cargo = Math.round(cls.cargo
    * (hasTech(db, 'expanded_holds') ? CONFIG.PLAYER.FACILITIES.HOLDS_MULT : 1));
  let shipId;
  db.transaction(() => {
    adjustCredits(db, -cls.price);
    shipId = db.prepare(
      `INSERT INTO ships (name, planet_id, cargo_capacity, fuel, fuel_capacity, speed, mode, class)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`
    ).run(name, dockyard.planet_id, cargo, cls.fuel, cls.fuel, cls.speed, classId).lastInsertRowid;
  })();

  return { ok: true, shipId, name, classLabel: cls.label, price: cls.price, upkeep: cls.upkeep, planetId: dockyard.planet_id };
}

// Entretien de la flotte, prélevé à chaque tick (peut mettre le compte en
// découvert — la flotte reste alors à quai jusqu'à régularisation). Le
// quartier général allège la facture.
export function fleetUpkeep(db) {
  let total = 0;
  for (const s of getFleet(db)) total += SH.CLASSES[s.class]?.upkeep ?? 0;
  total *= (1 - hqBonuses(db).upkeepReduction);
  return Math.round(total * 100) / 100;
}

export function tickFleetUpkeep(db) {
  const total = fleetUpkeep(db);
  if (total > 0) adjustCredits(db, -total);
  return total;
}

// ── Équipement (Phase 13) : un module de chaque type par vaisseau ──
// L'effet est appliqué immédiatement aux colonnes du vaisseau (même
// principe que les rétrofits technologiques).

export function shipEquipment(db, shipId) {
  return db.prepare('SELECT module_id FROM ship_equipment WHERE ship_id = ?')
    .all(shipId).map((e) => e.module_id);
}

export function equipShip(db, shipId, moduleId) {
  const mod = SH.EQUIPMENT[moduleId];
  if (!mod) return { ok: false, error: 'module inconnu' };
  const ship = getShip(db, shipId);
  if (!ship) return { ok: false, error: 'vaisseau inconnu' };
  if (ship.planet_id === null) return { ok: false, error: 'vaisseau en transit' };
  const pop = db.prepare('SELECT population FROM planets WHERE id = ?')
    .get(ship.planet_id).population;
  if (tierOf(pop) < SH.BUY_MIN_TIER) {
    return { ok: false, error: `équipement aux chantiers civils (mondes tier ${SH.BUY_MIN_TIER}+)` };
  }
  if (db.prepare('SELECT 1 FROM ship_equipment WHERE ship_id = ? AND module_id = ?')
    .get(shipId, moduleId)) {
    return { ok: false, error: 'module déjà installé sur ce vaisseau' };
  }
  if (getPlayer(db).credits < mod.price) {
    return { ok: false, error: `crédits insuffisants (${mod.price} cr)` };
  }

  const column = { cargo: 'cargo_capacity', fuel: 'fuel_capacity', speed: 'speed' }[mod.effect];
  db.transaction(() => {
    adjustCredits(db, -mod.price);
    db.prepare('INSERT INTO ship_equipment (ship_id, module_id) VALUES (?, ?)')
      .run(shipId, moduleId);
    db.prepare(`UPDATE ships SET ${column} = ROUND(${column} * ?) WHERE id = ?`)
      .run(mod.mult, shipId);
    // Un réservoir agrandi est livré plein de ce qu'il avait (pas plus).
  })();
  const after = getShip(db, shipId);
  return {
    ok: true, shipName: ship.name, moduleId, label: mod.label, desc: mod.desc,
    price: mod.price,
    cargo: after.cargo_capacity, fuel: after.fuel_capacity, speed: after.speed,
  };
}

export function setShipMode(db, shipId, mode) {
  if (!['manual', 'auto'].includes(mode)) return { ok: false, error: 'mode invalide (manual | auto)' };
  const ship = getShip(db, shipId);
  if (!ship) return { ok: false, error: 'vaisseau inconnu' };
  // Quitter une route assignée remet le compteur d'étapes à zéro ;
  // quitter une mission l'annule (le vaisseau garde sa cargaison).
  db.prepare('DELETE FROM missions WHERE ship_id = ?').run(shipId);
  db.prepare('UPDATE ships SET mode = ?, route_id = NULL, route_stop = 0 WHERE id = ?')
    .run(mode, shipId);
  return { ok: true, shipId, mode, name: ship.name };
}
