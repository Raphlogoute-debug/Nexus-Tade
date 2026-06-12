// Missions de vente : le commerce en trois choix. La concession mine
// toute seule dans son entrepôt ; le joueur dit « vendre N de X à tel
// marché » ; un vaisseau DISPONIBLE (à quai, en mode manuel, sans
// mission) s'en charge seul : rejoindre la concession, charger, livrer,
// vendre, revenir — et plusieurs allers-retours si N dépasse sa soute.
// Tout passe par les primitives joueur (collectConcession, executeTrade,
// startTravel) : mêmes règles d'impact prix, de prestige, de réputation,
// de piraterie et d'escorte automatique que le reste de la flotte.

import { RESOURCES } from '../../data/resources.js';
import { CONFIG } from '../config.js';
import { getCurrentTick } from '../db.js';
import { getShip, getPlayer, getCargo, cargoUsed, tierOf, hasTierAccess } from './state.js';
import { collectConcession } from './concession.js';
import { executeTrade, refuel } from './trade.js';
import { startTravel } from './travel.js';
import { logEvent } from '../events.js';

// ── Lecture ──────────────────────────────────────────────────────

export function listMissions(db) {
  return db.prepare(
    `SELECT m.*, s.name AS ship_name, s.planet_id AS ship_planet_id,
            pf.name AS from_name, pt.name AS to_name
     FROM missions m
     JOIN ships s ON s.id = m.ship_id
     JOIN planets pf ON pf.id = m.from_planet_id
     JOIN planets pt ON pt.id = m.to_planet_id
     ORDER BY m.id`
  ).all().map((m) => ({
    ...m,
    resourceName: RESOURCES[m.resource_id].name,
    carrying: db.prepare(
      'SELECT COALESCE(SUM(quantity), 0) AS q FROM ship_cargo WHERE ship_id = ? AND resource_id = ?'
    ).get(m.ship_id, m.resource_id).q,
  }));
}

// ── Création / annulation ────────────────────────────────────────

export function createMission(db, { resourceId, quantity, fromPlanetId, toPlanetId }) {
  if (!RESOURCES[resourceId]) return { ok: false, error: 'ressource inconnue' };
  if (!Number.isFinite(quantity) || quantity < 1) return { ok: false, error: 'quantité invalide' };
  if (fromPlanetId === toPlanetId) return { ok: false, error: 'destination identique à la source' };
  if (!db.prepare('SELECT 1 FROM concessions WHERE planet_id = ?').get(fromPlanetId)) {
    return { ok: false, error: 'aucune concession à vous sur la planète source' };
  }
  const dest = db.prepare('SELECT id, name, population FROM planets WHERE id = ?').get(toPlanetId);
  if (!dest) return { ok: false, error: 'destination inconnue' };
  const tier = tierOf(dest.population);
  if (!hasTierAccess(getPlayer(db), tier)) {
    return { ok: false, error: `marché de tier ${tier} inaccessible (prestige ou licence)` };
  }

  // Un vaisseau DISPONIBLE : à quai, en mode manuel, sans mission — de
  // préférence déjà amarré à la source.
  const ship = db.prepare(
    `SELECT * FROM ships WHERE mode = 'manual' AND planet_id IS NOT NULL
       AND id NOT IN (SELECT ship_id FROM missions)
     ORDER BY (planet_id = ?) DESC, id LIMIT 1`
  ).get(fromPlanetId);
  if (!ship) {
    return { ok: false, error: 'aucun vaisseau disponible (à quai, en mode manuel, sans mission)' };
  }

  let id;
  db.transaction(() => {
    id = db.prepare(
      `INSERT INTO missions (ship_id, resource_id, quantity, from_planet_id, to_planet_id, created_tick)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(ship.id, resourceId, Math.round(quantity), fromPlanetId, toPlanetId,
      getCurrentTick(db)).lastInsertRowid;
    db.prepare("UPDATE ships SET mode = 'mission', route_id = NULL, route_stop = 0 WHERE id = ?")
      .run(ship.id);
  })();
  return {
    ok: true, id, shipName: ship.name, quantity: Math.round(quantity),
    resourceName: RESOURCES[resourceId].name, destName: dest.name,
  };
}

export function cancelMission(db, missionId) {
  const m = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId);
  if (!m) return { ok: false, error: 'mission inconnue' };
  db.transaction(() => {
    db.prepare('DELETE FROM missions WHERE id = ?').run(missionId);
    db.prepare("UPDATE ships SET mode = 'manual' WHERE id = ?").run(m.ship_id);
  })();
  const ship = getShip(db, m.ship_id);
  return { ok: true, shipName: ship.name };
}

// Annule la mission d'un vaisseau (bascule de mode, vente du vaisseau…).
export function cancelMissionOfShip(db, shipId) {
  db.prepare('DELETE FROM missions WHERE ship_id = ?').run(shipId);
}

// ── Tick ─────────────────────────────────────────────────────────

function depart(db, ship, destPlanetId, tick) {
  const fresh = getShip(db, ship.id);
  if (fresh.fuel < fresh.fuel_capacity * CONFIG.AUTOMATION.REFUEL_BELOW) {
    refuel(db, undefined, ship.id);
  }
  startTravel(db, destPlanetId, tick, ship.id, 'auto'); // échec → retentera au tick suivant
}

function endMission(db, m, ship, tick, message) {
  db.prepare('DELETE FROM missions WHERE id = ?').run(m.id);
  db.prepare("UPDATE ships SET mode = 'manual' WHERE id = ?").run(ship.id);
  logEvent(db, tick, 'mission', message);
}

export function tickMissions(db, tick) {
  const missions = db.prepare(
    `SELECT m.* FROM missions m JOIN ships s ON s.id = m.ship_id
     WHERE s.planet_id IS NOT NULL`
  ).all();

  for (const m of missions) {
    const ship = getShip(db, m.ship_id);
    if (ship.mode !== 'mission') { // mode changé sous la mission : on classe
      db.prepare('DELETE FROM missions WHERE id = ?').run(m.id);
      continue;
    }
    const resName = RESOURCES[m.resource_id].name;
    const carrying = () => getCargo(db, ship.id)
      .find((c) => c.resource_id === m.resource_id)?.quantity ?? 0;

    // À destination avec la marchandise : vendre, puis rentrer (ou repartir
    // chercher la suite).
    if (ship.planet_id === m.to_planet_id && carrying() > 0) {
      const qty = Math.floor(Math.min(carrying(), m.quantity));
      const sale = executeTrade(db,
        { side: 'sell', resourceId: m.resource_id, quantity: qty, shipId: ship.id });
      if (!sale.ok) {
        endMission(db, m, ship, tick,
          `MISSION — ${ship.name} : vente impossible à destination (${sale.error}) — mission interrompue`);
        continue;
      }
      const left = Math.max(0, Math.round((m.quantity - qty) * 100) / 100);
      db.prepare('UPDATE missions SET quantity = ? WHERE id = ?').run(left, m.id);
      const destName = db.prepare('SELECT name FROM planets WHERE id = ?').get(m.to_planet_id).name;
      if (left <= 0) {
        endMission(db, m, ship, tick,
          `MISSION ACCOMPLIE — ${ship.name} a vendu ${Math.round(qty)} ${resName}`
          + ` à ${destName} (+${Math.round(sale.total)} cr) et rentre au bercail`);
        depart(db, ship, m.from_planet_id, tick); // retour maison en mode manuel
      } else {
        logEvent(db, tick, 'mission',
          `MISSION — ${ship.name} vend ${Math.round(qty)} ${resName} à ${destName}`
          + ` (+${Math.round(sale.total)} cr), reste ${Math.round(left)} à livrer`);
        depart(db, ship, m.from_planet_id, tick); // rotation suivante
      }
      continue;
    }

    // À la source : charger depuis l'entrepôt, partir dès que la soute est
    // pleine, que le restant est couvert, ou que l'entrepôt est à sec.
    if (ship.planet_id === m.from_planet_id) {
      if (m.quantity <= 0) {
        endMission(db, m, ship, tick, `MISSION — ${ship.name} de retour, mission classée`);
        continue;
      }
      const space = ship.cargo_capacity - cargoUsed(db, ship.id);
      const want = Math.min(m.quantity - carrying(), space);
      if (want > 0) collectConcession(db, want, ship.id, m.resource_id);
      const loaded = carrying();
      const storageLeft = db.prepare(
        `SELECT COALESCE(SUM(fs.quantity), 0) AS q FROM facility_storage fs
         JOIN concessions c ON c.id = fs.concession_id
         WHERE c.planet_id = ? AND fs.resource_id = ?`
      ).get(m.from_planet_id, m.resource_id).q;
      const full = cargoUsed(db, ship.id) >= ship.cargo_capacity - 1;
      if (loaded > 0 && (full || loaded >= m.quantity || storageLeft < 1)) {
        depart(db, ship, m.to_planet_id, tick);
      }
      // sinon : on attend que l'extraction remplisse l'entrepôt
      continue;
    }

    // Ailleurs : rejoindre la destination si la soute porte déjà la
    // marchandise, sinon la source.
    depart(db, ship, carrying() > 0 ? m.to_planet_id : m.from_planet_id, tick);
  }
}
