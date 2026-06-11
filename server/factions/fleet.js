// Programme naval des factions. Le chantier de la capitale consomme de
// VRAIES ressources sur le VRAI marché local (modules, pièces, carburant) :
// couper l'approvisionnement d'une capitale paralyse sa construction et
// fait chuter la disponibilité de sa flotte — c'est le levier économique
// que les guerres (Phase 4) viendront encaisser.

import { CONFIG } from '../config.js';
import { warContext } from './war.js';

const FT = CONFIG.FLEET;

export function tickFleets(db) {
  const factions = db.prepare('SELECT * FROM factions').all();
  const ctx = warContext(db);
  const getStock = db.prepare(
    'SELECT stock FROM planet_resources WHERE planet_id = ? AND resource_id = ?'
  );
  const takeStock = db.prepare(
    'UPDATE planet_resources SET stock = ROUND(MAX(0, stock - ?), 2) WHERE planet_id = ? AND resource_id = ?'
  );
  const save = db.prepare(
    'UPDATE factions SET fleet = ?, fleet_progress = ?, readiness = ? WHERE id = ?'
  );

  db.transaction(() => {
    for (const f of factions) {
      const atWar = ctx.factionWar.has(f.id);

      // 1. Construction : cadence bornée par l'entrée la plus rare au
      // chantier (loi du minimum). En guerre, l'effort de guerre multiplie
      // la cadence visée — donc la demande en intrants.
      const maxRuns = atWar ? CONFIG.WAR.BUILD_MULT : 1;
      let runs = maxRuns;
      for (const [resourceId, qty] of Object.entries(FT.BUILD)) {
        runs = Math.min(runs, getStock.get(f.capital_planet_id, resourceId).stock / qty);
      }
      runs = Math.max(0, runs);
      if (runs > 0) {
        for (const [resourceId, qty] of Object.entries(FT.BUILD)) {
          takeStock.run(qty * runs, f.capital_planet_id, resourceId);
        }
      }
      let progress = f.fleet_progress + runs;
      let fleet = f.fleet;
      if (progress >= FT.SHIP_COST) {
        fleet += Math.floor(progress / FT.SHIP_COST);
        progress %= FT.SHIP_COST;
      }

      // 2. Entretien : la disponibilité suit la part d'entretien réellement
      // payée. Une flotte mobilisée coûte plus cher ; privée de carburant
      // et de pièces, elle se dégrade — et perd ses fronts.
      const upkeepMult = atWar ? CONFIG.WAR.UPKEEP_MULT : 1;
      let upkeepMet = 1;
      for (const [resourceId, perShip] of Object.entries(FT.UPKEEP_PER_SHIP)) {
        const need = perShip * fleet * upkeepMult;
        if (need <= 0) continue;
        const available = getStock.get(f.capital_planet_id, resourceId).stock;
        const paid = Math.min(available, need);
        takeStock.run(paid, f.capital_planet_id, resourceId);
        upkeepMet = Math.min(upkeepMet, paid / need);
      }
      const readiness = Math.round(
        (f.readiness + FT.READINESS_EMA * (upkeepMet - f.readiness)) * 1000) / 1000;

      save.run(fleet, Math.round(progress * 100) / 100, readiness, f.id);
    }
  })();
}
