// Routes logistiques : le joueur définit un circuit d'étapes, chacune
// avec ses actions, et y assigne des vaisseaux (mode 'route'). Le vaisseau
// boucle : il exécute les actions de l'étape où il est à quai, puis met le
// cap sur la suivante. C'est la couche déterministe de la flotte — la
// navette régulière entre vos concessions et leurs débouchés — là où le
// mode 'auto' est opportuniste.
//
// Actions (toutes passent par les fonctions joueur existantes, donc avec
// les règles habituelles : tiers, listes noires, impact prix) :
//   load   : entrepôt → soute (à vos concessions) — resource/qty optionnels
//   unload : soute → entrepôt — resource optionnelle (sinon : tout)
//   buy    : achat au marché local (resource + qty requis)
//   sell   : vente au marché local — resource optionnelle (sinon : tout)
// Un échec d'action (entrepôt plein, marché fermé…) ne bloque pas la
// route : l'action est sautée, le circuit continue.

import { CONFIG } from '../config.js';
import { RESOURCES } from '../../data/resources.js';
import { getPlayer, getShip, getCargo, cargoUsed } from './state.js';
import { executeTrade, refuel } from './trade.js';
import { startTravel } from './travel.js';
import { collectConcession, depositToConcession } from './concession.js';
import { marketContext } from '../economy/market.js';
import { logEvent } from '../events.js';

const ACTION_TYPES = new Set(['load', 'unload', 'buy', 'sell']);

// ── CRUD ─────────────────────────────────────────────────────────

export function createRoute(db, name, stops) {
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'nom de route requis' };
  if (!Array.isArray(stops) || stops.length < 2) return { ok: false, error: 'au moins 2 étapes' };

  for (const stop of stops) {
    if (!db.prepare('SELECT 1 FROM planets WHERE id = ?').get(stop.planetId)) {
      return { ok: false, error: `planète inconnue (étape ${stops.indexOf(stop) + 1})` };
    }
    if (!Array.isArray(stop.actions)) return { ok: false, error: 'actions manquantes' };
    for (const a of stop.actions) {
      if (!ACTION_TYPES.has(a.type)) return { ok: false, error: `action inconnue : ${a.type}` };
      if (a.resourceId != null && !RESOURCES[a.resourceId]) {
        return { ok: false, error: `ressource inconnue : ${a.resourceId}` };
      }
      if (a.quantity != null && !(a.quantity > 0)) return { ok: false, error: 'quantité invalide' };
      if (a.type === 'buy' && (!a.resourceId || !(a.quantity > 0))) {
        return { ok: false, error: 'un achat exige ressource et quantité' };
      }
    }
  }

  let id;
  db.transaction(() => {
    id = db.prepare('INSERT INTO routes (name) VALUES (?)').run(name.trim()).lastInsertRowid;
    const insert = db.prepare(
      'INSERT INTO route_stops (route_id, position, planet_id, actions) VALUES (?, ?, ?, ?)'
    );
    stops.forEach((stop, i) => insert.run(id, i, stop.planetId, JSON.stringify(stop.actions)));
  })();
  return { ok: true, id, name: name.trim(), stops: stops.length };
}

export function listRoutes(db) {
  return db.prepare('SELECT * FROM routes ORDER BY id').all().map((r) => ({
    ...r,
    stops: db.prepare(
      `SELECT rs.position, rs.planet_id, rs.actions, p.name AS planet_name
       FROM route_stops rs JOIN planets p ON p.id = rs.planet_id
       WHERE rs.route_id = ? ORDER BY rs.position`
    ).all(r.id).map((s) => ({ ...s, actions: JSON.parse(s.actions) })),
    ships: db.prepare('SELECT id, name FROM ships WHERE route_id = ?').all(r.id),
  }));
}

export function deleteRoute(db, routeId) {
  if (!db.prepare('SELECT 1 FROM routes WHERE id = ?').get(routeId)) {
    return { ok: false, error: 'route inconnue' };
  }
  db.transaction(() => {
    db.prepare(
      "UPDATE ships SET mode = 'manual', route_id = NULL, route_stop = 0 WHERE route_id = ?"
    ).run(routeId);
    db.prepare('DELETE FROM route_stops WHERE route_id = ?').run(routeId);
    db.prepare('DELETE FROM routes WHERE id = ?').run(routeId);
  })();
  return { ok: true };
}

export function assignRoute(db, shipId, routeId) {
  const ship = getShip(db, shipId);
  if (!ship) return { ok: false, error: 'vaisseau inconnu' };
  if (routeId === null) {
    db.prepare("UPDATE ships SET mode = 'manual', route_id = NULL, route_stop = 0 WHERE id = ?")
      .run(shipId);
    return { ok: true, shipId, mode: 'manual', name: ship.name };
  }
  if (!db.prepare('SELECT 1 FROM routes WHERE id = ?').get(routeId)) {
    return { ok: false, error: 'route inconnue' };
  }
  db.prepare("UPDATE ships SET mode = 'route', route_id = ?, route_stop = 0 WHERE id = ?")
    .run(routeId, shipId);
  return { ok: true, shipId, mode: 'route', routeId, name: ship.name };
}

// ── Le tick des vaisseaux en route ───────────────────────────────

export function tickRouteShips(db, tick) {
  const ships = db.prepare(
    "SELECT * FROM ships WHERE mode = 'route' AND planet_id IS NOT NULL"
  ).all();
  if (ships.length === 0) return;

  const planetName = db.prepare('SELECT name FROM planets WHERE id = ?');

  for (const ship of ships) {
    const stops = db.prepare(
      'SELECT * FROM route_stops WHERE route_id = ? ORDER BY position'
    ).all(ship.route_id);
    if (stops.length === 0) {
      assignRoute(db, ship.id, null); // route supprimée sous ses pieds
      continue;
    }

    const stop = stops[ship.route_stop % stops.length];

    // Pas encore à l'étape courante (assignation récente) : on y va.
    if (ship.planet_id !== stop.planet_id) {
      tryDepart(db, ship, stop.planet_id, tick);
      continue;
    }

    // Exécution des actions de l'étape.
    const done = [];
    for (const action of JSON.parse(stop.actions)) {
      const summary = runAction(db, ship, action);
      if (summary) done.push(summary);
    }
    if (done.length > 0) {
      logEvent(db, tick, 'fleet',
        `ROUTE — ${ship.name} à ${planetName.get(stop.planet_id).name} : ${done.join(', ')}`);
    }

    // Étape suivante.
    const next = (ship.route_stop + 1) % stops.length;
    db.prepare('UPDATE ships SET route_stop = ? WHERE id = ?').run(next, ship.id);
    if (stops[next].planet_id !== ship.planet_id) {
      tryDepart(db, ship, stops[next].planet_id, tick);
    }
  }
}

function tryDepart(db, ship, destPlanetId, tick) {
  const fresh = getShip(db, ship.id);
  if (fresh.fuel < fresh.fuel_capacity * CONFIG.AUTOMATION.REFUEL_BELOW) {
    refuel(db, undefined, ship.id);
  }
  startTravel(db, destPlanetId, tick, ship.id); // échec (découvert…) → on réessaie au tick suivant
}

// Exécute une action ; retourne un résumé lisible, ou null si rien bougé.
function runAction(db, ship, action) {
  const name = (rid) => RESOURCES[rid].name;

  switch (action.type) {
    case 'load': {
      const r = collectConcession(db, action.quantity ?? undefined, ship.id, action.resourceId ?? undefined);
      return r.ok ? `chargé ${Math.round(r.moved)} ${name(r.resourceId)}` : null;
    }
    case 'unload': {
      if (action.resourceId) {
        const r = depositToConcession(db, action.resourceId, action.quantity ?? undefined, ship.id);
        return r.ok ? `déposé ${Math.round(r.moved)} ${name(r.resourceId)}` : null;
      }
      const moved = [];
      for (const lot of getCargo(db, ship.id)) {
        const r = depositToConcession(db, lot.resource_id, undefined, ship.id);
        if (r.ok) moved.push(`${Math.round(r.moved)} ${name(lot.resource_id)}`);
      }
      return moved.length ? `déposé ${moved.join(' + ')}` : null;
    }
    case 'sell': {
      const lots = action.resourceId
        ? getCargo(db, ship.id).filter((l) => l.resource_id === action.resourceId)
        : getCargo(db, ship.id);
      let total = 0;
      const sold = [];
      for (const lot of lots) {
        const qty = Math.min(lot.quantity, action.quantity ?? Infinity);
        const r = executeTrade(db, { side: 'sell', resourceId: lot.resource_id, quantity: qty, shipId: ship.id });
        if (r.ok) {
          total += r.total;
          sold.push(`${Math.round(qty)} ${name(lot.resource_id)}`);
        }
      }
      return sold.length ? `vendu ${sold.join(' + ')} (+${Math.round(total)} cr)` : null;
    }
    case 'buy': {
      const market = marketContext(db, ship.planet_id, action.resourceId);
      const space = ship.cargo_capacity - cargoUsed(db, ship.id);
      const qty = Math.floor(Math.min(
        action.quantity, space, market.stock,
        getPlayer(db).credits / (market.price * 1.2))); // marge sur le glissement
      if (qty < 1) return null;
      const r = executeTrade(db, { side: 'buy', resourceId: action.resourceId, quantity: qty, shipId: ship.id });
      return r.ok ? `acheté ${qty} ${name(action.resourceId)} (−${Math.round(r.total)} cr)` : null;
    }
  }
  return null;
}
