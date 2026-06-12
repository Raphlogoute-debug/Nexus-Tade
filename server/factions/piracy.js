// Piraterie : le risque qui donne des dents au transport. L'espace n'est
// pas uniformément sûr — un royaume police son territoire, la Frange
// grouille d'écumeurs, les fronts de guerre attirent les charognards.
// Chaque tick de transit, un vaisseau du joueur NON ESCORTÉ risque
// l'abordage (perte d'une part de cargaison, ou rançon si la soute est
// vide). L'escorte, payée au départ, sanctuarise le trajet. Les
// marchands PNJ subissent le même monde, en écrémage statistique.

import { CONFIG } from '../config.js';
import { RESOURCES } from '../../data/resources.js';
import { warContext } from './war.js';
import { logEvent } from '../events.js';

const P = CONFIG.PIRACY;

// Danger d'un système : probabilité d'interception par tick de transit.
export function systemDanger(db, systemId, ctx = warContext(db)) {
  if (ctx.frontSystems.has(systemId)) return P.CHANCE_FRONT;
  const row = db.prepare('SELECT faction_id FROM systems WHERE id = ?').get(systemId);
  return row?.faction_id === null ? P.CHANCE_FRINGE : P.CHANCE_CORE;
}

// Danger d'un trajet : l'espace le plus dangereux des deux bouts.
export function routeDanger(db, fromSystemId, toSystemId, ctx = warContext(db)) {
  return Math.max(systemDanger(db, fromSystemId, ctx), systemDanger(db, toSystemId, ctx));
}

export function dangerLabel(chance) {
  if (chance >= P.CHANCE_FRONT) return 'extrême';
  if (chance >= P.CHANCE_FRINGE) return 'élevé';
  return 'faible';
}

export function escortCost(distance) {
  return Math.round(P.ESCORT_FLAT + distance * P.ESCORT_PER_DIST);
}

export function tickPiracy(db, tick) {
  const ctx = warContext(db);

  // Vaisseaux du joueur en transit, sans escorte.
  const ships = db.prepare(
    'SELECT * FROM ships WHERE planet_id IS NULL AND escorted = 0'
  ).all();
  for (const ship of ships) {
    const chance = routeDanger(db, ship.origin_system_id, ship.dest_system_id, ctx);
    if (Math.random() >= chance) continue;
    raidPlayerShip(db, tick, ship);
  }

  // Marchands PNJ chargés : le même monde, en plus discret.
  const traders = db.prepare(
    'SELECT id, cargo_qty FROM traders WHERE planet_id IS NULL AND cargo_qty > 0'
  ).all();
  const skim = db.prepare('UPDATE traders SET cargo_qty = ROUND(cargo_qty * ?, 2) WHERE id = ?');
  for (const t of traders) {
    if (Math.random() >= P.TRADER_CHANCE) continue;
    skim.run(1 - P.CARGO_LOSS, t.id);
  }
}

function raidPlayerShip(db, tick, ship) {
  const cargo = db.prepare(
    'SELECT resource_id, quantity FROM ship_cargo WHERE ship_id = ? AND quantity > 0'
  ).all(ship.id);

  if (cargo.length > 0) {
    // Les pirates raflent une part de chaque cargaison.
    const taken = [];
    const cut = db.prepare(
      'UPDATE ship_cargo SET quantity = ROUND(quantity - ?, 2) WHERE ship_id = ? AND resource_id = ?'
    );
    for (const c of cargo) {
      const loss = Math.round(c.quantity * P.CARGO_LOSS * 100) / 100;
      if (loss <= 0) continue;
      cut.run(loss, ship.id, c.resource_id);
      taken.push(`${Math.round(loss)} ${RESOURCES[c.resource_id].name}`);
    }
    logEvent(db, tick, 'piracy',
      `☠ PIRATERIE — ${ship.name} abordé en plein vol : ${taken.join(', ')} raflés`
      + ' (une escorte aurait dissuadé)');
  } else {
    // Soute vide : on rançonne l'équipage.
    const credits = db.prepare('SELECT credits FROM player WHERE id = 1').get().credits;
    if (credits <= 0) return; // rien à prendre, les pirates passent leur chemin
    const ransom = Math.min(P.RANSOM_MAX,
      Math.max(P.RANSOM_MIN, Math.round(credits * P.RANSOM_RATE)));
    db.prepare('UPDATE player SET credits = ROUND(credits - ?, 2) WHERE id = 1').run(ransom);
    logEvent(db, tick, 'piracy',
      `☠ PIRATERIE — ${ship.name} arraisonné, soute vide : rançon de ${ransom} cr payée`);
  }
}
