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
import { RECIPES, recipeOutput } from '../../data/recipes.js';
import { targetStock, nextPrice } from './pricing.js';
import { compressionFactor, VITAL_SET } from './needs.js';
import { getCurrentTick, setMeta } from '../db.js';

// Demande totale par tick d'une ressource sur une planète : consommation
// civile + besoins industriels à plein régime. Partagée entre le tick
// économique et le marché joueur (les deux doivent voir le même stock cible).
export function resourceDemand(resourceId, civilConsumption, industries) {
  let demand = civilConsumption;
  for (const { recipe_id, rate } of industries) {
    demand += (RECIPES[recipe_id].inputs[resourceId] ?? 0) * rate;
  }
  return demand;
}

export function runTick(db) {
  const startedAt = Date.now();
  const tick = getCurrentTick(db) + 1;

  const resourceRows = db.prepare(
    'SELECT planet_id, resource_id, stock, production, consumption, price FROM planet_resources'
  ).all();
  const industryRows = db.prepare(
    'SELECT planet_id, recipe_id, rate FROM planet_industries'
  ).all();

  // Regroupement par planète (les échanges inter-planétaires passent par
  // les convois et les marchands, traités hors du tick économique local).
  const planets = new Map();
  for (const row of resourceRows) {
    row.stock0 = row.stock; // pour ne réécrire que ce qui a bougé
    if (!planets.has(row.planet_id)) {
      planets.set(row.planet_id, { resources: new Map(), industries: [], supply: 1 });
    }
    planets.get(row.planet_id).resources.set(row.resource_id, row);
  }
  for (const row of industryRows) {
    planets.get(row.planet_id).industries.push(row);
  }
  for (const row of db.prepare('SELECT id, supply FROM planets').all()) {
    const p = planets.get(row.id);
    if (p) p.supply = row.supply;
  }

  const updateResource = db.prepare(
    'UPDATE planet_resources SET stock = ?, price = ? WHERE planet_id = ? AND resource_id = ?'
  );
  const insertHistory = db.prepare(
    'INSERT INTO price_history (planet_id, resource_id, tick, price) VALUES (?, ?, ?, ?)'
  );
  const pruneHistory = db.prepare('DELETE FROM price_history WHERE tick <= ?');
  const updateSupply = db.prepare('UPDATE planets SET supply = ? WHERE id = ?');

  db.transaction(() => {
    for (const [planetId, planet] of planets) {
      // L'indice d'approvisionnement suit la part des besoins vitaux servis.
      const vitalMet = simulatePlanet(planet);
      const supply = Math.round(
        (planet.supply + CONFIG.NEEDS.SUPPLY_EMA * (vitalMet - planet.supply)) * 1000
      ) / 1000;
      if (supply !== planet.supply) updateSupply.run(supply, planetId);

      for (const row of planet.resources.values()) {
        // Demande totale par tick = civile + besoins industriels à plein
        // régime ; elle fixe le stock cible du modèle de prix.
        const demand = resourceDemand(row.resource_id, row.consumption, planet.industries);
        const price = nextPrice({
          basePrice: RESOURCES[row.resource_id].basePrice,
          stock: row.stock,
          target: targetStock(demand),
          previousPrice: row.price,
        });

        // Beaucoup de marchés sont dormants (ni production, ni demande,
        // prix figé à sa borne) : ne réécrire que ce qui a bougé, et
        // n'historiser que les prix qui vivent.
        const newStock = round2(row.stock);
        if (newStock !== row.stock0 || price !== row.price) {
          updateResource.run(newStock, price, row.planet_id, row.resource_id);
        }
        if (tick % CONFIG.HISTORY_EVERY === 0 && price !== row.price) {
          insertHistory.run(row.planet_id, row.resource_id, tick, price);
        }
      }
    }

    pruneHistory.run(tick - CONFIG.HISTORY_TICKS);
    setMeta(db, 'current_tick', tick);
  })();

  return {
    tick,
    planets: planets.size,
    industryRuns: industryRows, // avec .runs réels du tick (dividendes)
    durationMs: Date.now() - startedAt,
  };
}

// Fait tourner extraction, industrie et consommation d'une planète, en
// mutant les stocks en mémoire. Retourne la part des besoins vitaux servis
// (0..1) — l'indice d'approvisionnement s'en nourrit.
function simulatePlanet(planet) {
  const stocks = planet.resources;

  // 1. Extraction brute
  for (const row of stocks.values()) {
    row.stock += row.production;
  }

  // 2. Industrie : le nombre de runs réels est borné par l'entrée la plus
  // rare (loi du minimum). Les runs sont fractionnaires : on modélise des
  // flux continus, pas des lots. C'est cette règle qui fait qu'une pénurie
  // amont paralyse toute la chaîne aval — y compris les chantiers navals.
  // Les runs réels sont notés sur la ligne (dividendes des actionnaires).
  for (const industry of planet.industries) {
    const recipe = RECIPES[industry.recipe_id];
    let runs = industry.rate;
    for (const [inputId, qty] of Object.entries(recipe.inputs)) {
      runs = Math.min(runs, stocks.get(inputId).stock / qty);
    }
    industry.runs = Math.max(0, runs);
    if (runs <= 0) continue;
    for (const [inputId, qty] of Object.entries(recipe.inputs)) {
      stocks.get(inputId).stock -= qty * runs;
    }
    stocks.get(recipeOutput(industry.recipe_id)).stock += recipe.output * runs;
  }

  // 3. Consommation civile : élastique au prix (on se rationne quand c'est
  // cher), bornée par le stock. On mesure au passage la satisfaction des
  // besoins vitaux.
  let vitalWanted = 0;
  let vitalTaken = 0;
  for (const row of stocks.values()) {
    if (row.consumption <= 0) continue;
    const wanted = row.consumption
      * compressionFactor(row.price, RESOURCES[row.resource_id].basePrice);
    const taken = Math.min(row.stock, wanted);
    row.stock -= taken;
    if (VITAL_SET.has(row.resource_id)) {
      vitalWanted += wanted;
      vitalTaken += taken;
    }
  }
  return vitalWanted > 0 ? vitalTaken / vitalWanted : 1;
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
