// Voyage du vaisseau : ordre de départ, et amarrage à l'arrivée (appelé
// par la boucle de simulation). Le monde continue de tourner pendant le
// trajet — les prix vus au départ ne sont pas garantis à l'arrivée.

import { CONFIG } from '../config.js';
import { getShip, getPlayer, adjustCredits } from './state.js';
import { systemDistance, recordFullSnapshot, recordGossipAround } from './knowledge.js';
import { maybeSeizeCargo } from '../factions/standing.js';
import { routeDanger, dangerLabel, escortCost } from '../factions/piracy.js';

const SHIP = CONFIG.PLAYER.SHIP;

// Coût d'un trajet vers une planète. Un saut intra-système est quasi
// gratuit : 1 tick, pas de carburant.
export function previewTravel(db, destPlanetId, shipId) {
  const ship = getShip(db, shipId);
  if (!ship) return { ok: false, error: 'vaisseau inconnu' };
  if (ship.planet_id === null) return { ok: false, error: 'vaisseau déjà en transit' };
  // L'entretien impayé cloue la flotte au sol : c'est lui, la vraie
  // limite de taille de flotte.
  if (getPlayer(db).credits < 0) {
    return { ok: false, error: 'équipages impayés — régularisez vos comptes avant de repartir' };
  }

  const dest = db.prepare('SELECT id, system_id FROM planets WHERE id = ?').get(destPlanetId);
  if (!dest) return { ok: false, error: 'planète inconnue' };
  if (dest.id === ship.planet_id) return { ok: false, error: 'vous êtes déjà à quai ici' };

  const originSystem = db.prepare('SELECT system_id FROM planets WHERE id = ?')
    .get(ship.planet_id).system_id;
  const distance = systemDistance(db, originSystem, dest.system_id);
  const ticks = Math.max(1, Math.ceil(distance / ship.speed));
  // Moteurs économes : −30 % de carburant sur tous les trajets.
  const efficient = db.prepare(
    "SELECT 1 FROM player_tech WHERE tech_id = 'efficient_drives'").get();
  const fuelCost = Math.ceil(
    (distance / SHIP.DIST_PER_FUEL) * (efficient ? CONFIG.PLAYER.FACILITIES.FUEL_SAVING_MULT : 1));

  if (fuelCost > ship.fuel) {
    return { ok: false, error: 'carburant insuffisant', distance, ticks, fuelCost, fuel: ship.fuel };
  }

  // Risque pirate du trajet, et prix de l'escorte qui l'annule.
  const danger = routeDanger(db, originSystem, dest.system_id);
  return {
    ok: true, distance, ticks, fuelCost, originSystem, destSystem: dest.system_id,
    danger, dangerLabel: dangerLabel(danger), escortCost: escortCost(distance),
  };
}

// escort : true (payée, refus si crédits insuffisants), false (à vos
// risques), ou 'auto' — les capitaines en pilotage automatique paient
// l'escorte en zone dangereuse quand la trésorerie le permet.
export function startTravel(db, destPlanetId, currentTick, shipId, escort = false) {
  const preview = previewTravel(db, destPlanetId, shipId);
  if (!preview.ok) return preview;

  if (escort === 'auto') {
    escort = preview.danger >= CONFIG.PIRACY.CHANCE_FRINGE
      && getPlayer(db).credits >= preview.escortCost;
  } else if (escort && getPlayer(db).credits < preview.escortCost) {
    return { ok: false, error: `escorte à ${preview.escortCost} cr — crédits insuffisants` };
  }

  const ship = getShip(db, shipId);
  db.transaction(() => {
    if (escort) adjustCredits(db, -preview.escortCost);
    db.prepare(
      `UPDATE ships SET
         planet_id = NULL,
         origin_system_id = ?, dest_system_id = ?, dest_planet_id = ?,
         departure_tick = ?, arrival_tick = ?,
         fuel = fuel - ?, escorted = ?
       WHERE id = ?`
    ).run(preview.originSystem, preview.destSystem, destPlanetId,
      currentTick, currentTick + preview.ticks, preview.fuelCost, escort ? 1 : 0, ship.id);
  })();

  return {
    ok: true, arrivalTick: currentTick + preview.ticks, escorted: Boolean(escort), ...preview,
  };
}

// Amarre les vaisseaux arrivés à destination. À quai : instantané complet
// du marché local + rumeurs des systèmes voisins. Attention aux zones de
// guerre : la douane d'un front saisit la cargaison stratégique des
// marchands qu'elle tient en grief.
export function processArrivals(db, tick) {
  const arrivals = db.prepare(
    'SELECT * FROM ships WHERE planet_id IS NULL AND arrival_tick <= ?'
  ).all(tick);

  const events = [];
  for (const ship of arrivals) {
    db.prepare(
      `UPDATE ships SET
         planet_id = dest_planet_id,
         origin_system_id = NULL, dest_system_id = NULL, dest_planet_id = NULL,
         departure_tick = NULL, arrival_tick = NULL, escorted = 0
       WHERE id = ?`
    ).run(ship.id);

    recordFullSnapshot(db, ship.dest_planet_id, tick);
    recordGossipAround(db, ship.dest_system_id, tick);
    maybeSeizeCargo(db, tick, ship, ship.dest_planet_id);
    events.push({ type: 'arrival', shipId: ship.id, planetId: ship.dest_planet_id });
  }
  return events;
}
