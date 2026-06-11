// Moteur économique : fait avancer la simulation d'un tick.
// Module indépendant d'Express et du DOM — il ne connaît que la DB
// (injectée) et les données de jeu. Testable en isolation sur une
// base ':memory:' (voir scripts/verify.js).
//
// Déroulé d'un tick, planète par planète :
//   1. Extraction   : les ressources brutes du biome s'ajoutent aux stocks.
//   2. Industrie    : chaque recette tourne jusqu'à `rate` fois, limitée
//                     par les stocks d'entrée disponibles (une pénurie en
//                     amont étrangle la production en aval).
//   3. Consommation : la population prélève sa demande civile (bornée
//                     par le stock — la pénurie ne crée pas de négatif).
//   4. Prix         : recalculés d'après le nouveau stock (cf. pricing.js),
//                     historisés, l'historique ancien est purgé.
// Le tout dans une transaction unique : un tick est atomique.

import { CONFIG } from '../config.js';
import { RESOURCES, RESOURCE_IDS } from '../../data/resources.js';
import { RECIPES } from '../../data/recipes.js';
import { targetStock, nextPrice } from './pricing.js';
import { getCurrentTick, setMeta } from '../db.js';

export function runTick(db) {
  const startedAt = Date.now();
  const tick = getCurrentTick(db) + 1;

  const resourceRows = db.prepare(
    'SELECT planet_id, resource_id, stock, production, consumption, price FROM planet_resources'
  ).all();
  const industryRows = db.prepare(
    'SELECT planet_id, recipe_id, rate FROM planet_industries'
  ).all();

  // Regroupement par planète : chaque planète est un marché fermé en Phase 1.
  const planets = new Map();
  for (const row of resourceRows) {
    if (!planets.has(row.planet_id)) {
      planets.set(row.planet_id, { resources: new Map(), industries: [] });
    }
    planets.get(row.planet_id).resources.set(row.resource_id, row);
  }
  for (const row of industryRows) {
    planets.get(row.planet_id).industries.push(row);
  }

  const updateResource = db.prepare(
    'UPDATE planet_resources SET stock = ?, price = ? WHERE planet_id = ? AND resource_id = ?'
  );
  const insertHistory = db.prepare(
    'INSERT INTO price_history (planet_id, resource_id, tick, price) VALUES (?, ?, ?, ?)'
  );
  const pruneHistory = db.prepare('DELETE FROM price_history WHERE tick <= ?');

  db.transaction(() => {
    for (const planet of planets.values()) {
      simulatePlanet(planet);

      for (const row of planet.resources.values()) {
        // Demande totale par tick = civile + besoins industriels à plein
        // régime ; elle fixe le stock cible du modèle de prix.
        let demand = row.consumption;
        for (const { recipe_id, rate } of planet.industries) {
          demand += (RECIPES[recipe_id].inputs[row.resource_id] ?? 0) * rate;
        }
        const price = nextPrice({
          basePrice: RESOURCES[row.resource_id].basePrice,
          stock: row.stock,
          target: targetStock(demand),
          previousPrice: row.price,
        });

        updateResource.run(round2(row.stock), price, row.planet_id, row.resource_id);
        insertHistory.run(row.planet_id, row.resource_id, tick, price);
      }
    }

    pruneHistory.run(tick - CONFIG.HISTORY_TICKS);
    setMeta(db, 'current_tick', tick);
  })();

  return { tick, planets: planets.size, durationMs: Date.now() - startedAt };
}

// Fait tourner extraction, industrie et consommation d'une planète,
// en mutant les stocks en mémoire.
function simulatePlanet(planet) {
  const stocks = planet.resources;

  // 1. Extraction brute
  for (const row of stocks.values()) {
    row.stock += row.production;
  }

  // 2. Industrie : le nombre de runs réels est borné par l'entrée la plus
  // rare (loi du minimum). Les runs sont fractionnaires : on modélise des
  // flux continus, pas des lots.
  for (const { recipe_id, rate } of planet.industries) {
    const recipe = RECIPES[recipe_id];
    let runs = rate;
    for (const [inputId, qty] of Object.entries(recipe.inputs)) {
      runs = Math.min(runs, stocks.get(inputId).stock / qty);
    }
    if (runs <= 0) continue;
    for (const [inputId, qty] of Object.entries(recipe.inputs)) {
      stocks.get(inputId).stock -= qty * runs;
    }
    stocks.get(recipe_id).stock += recipe.output * runs;
  }

  // 3. Consommation civile (bornée par le stock disponible)
  for (const row of stocks.values()) {
    row.stock = Math.max(0, row.stock - row.consumption);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Instantané économique d'une planète (utilisé par l'API et verify).
export function planetSnapshot(db, planetId) {
  const rows = db.prepare(
    'SELECT resource_id, stock, production, consumption, price FROM planet_resources WHERE planet_id = ? ORDER BY resource_id'
  ).all(planetId);
  return rows.map((r) => ({
    ...r,
    basePrice: RESOURCES[r.resource_id].basePrice,
    name: RESOURCES[r.resource_id].name,
    tier: RESOURCES[r.resource_id].tier,
  }));
}
