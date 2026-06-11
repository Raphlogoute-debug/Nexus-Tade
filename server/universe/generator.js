// Génération procédurale de l'univers : systèmes, planètes, profils
// économiques, distances. Déterministe pour une seed donnée.

import { CONFIG } from '../config.js';
import { RESOURCES, RESOURCE_IDS } from '../../data/resources.js';
import { RECIPES, RECIPE_IDS } from '../../data/recipes.js';
import { BIOMES, BIOME_IDS } from '../../data/biomes.js';
import { createRng } from './rng.js';
import { equilibriumPrice, targetStock } from '../economy/pricing.js';
import { setMeta } from '../db.js';

const { UNIVERSE: U, ECONOMY: E } = CONFIG;

// ── Noms d'étoiles ───────────────────────────────────────────────

const NAME_START = ['Ker', 'Vel', 'Tau', 'Or', 'Az', 'Hel', 'Myr', 'Cyg', 'Dra',
  'Lyr', 'Nov', 'Zeph', 'Kha', 'Sol', 'Ery', 'Tha', 'Vor', 'Qua', 'Nyx', 'Alde',
  'Ber', 'Cas', 'Del', 'Fen', 'Gal', 'Ith', 'Jun', 'Lum', 'Ond', 'Pry'];
const NAME_MID = ['a', 'e', 'i', 'o', 'u', 'an', 'en', 'ir', 'or', 'ur', 'ara', 'eri', 'io', 'ys'];
const NAME_END = ['n', 's', 'th', 'x', 'r', 'dan', 'mar', 'tis', 'vos', 'lia', 'dor', 'nis'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

function makeStarName(rng, used) {
  for (;;) {
    let name = rng.pick(NAME_START) + rng.pick(NAME_MID) + rng.pick(NAME_END);
    if (rng.next() < 0.25) name += `-${rng.int(2, 9)}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
}

// ── Placement des systèmes ───────────────────────────────────────
// Tirage avec rejet : on garde une distance minimale entre étoiles pour
// que la carte reste lisible. La densité visée laisse une large marge.

function placeSystems(rng, count) {
  const positions = [];
  while (positions.length < count) {
    const x = rng.float(U.MAP_SIZE * 0.03, U.MAP_SIZE * 0.97);
    const y = rng.float(U.MAP_SIZE * 0.03, U.MAP_SIZE * 0.97);
    const tooClose = positions.some(
      (p) => (p.x - x) ** 2 + (p.y - y) ** 2 < U.MIN_SYSTEM_DIST ** 2
    );
    if (!tooClose) positions.push({ x, y });
  }
  return positions;
}

// ── Profil économique d'une planète ──────────────────────────────

// Production brute par tick : poids du biome × facteur de main-d'œuvre.
// La racine carrée de la population évite l'écrasement par les mondes-ruches.
function extractionFor(rng, biome, popM) {
  const workforce = E.EXTRACTION_BASE + E.EXTRACTION_POP_COEF * Math.sqrt(popM);
  const production = {};
  for (const [resourceId, weight] of Object.entries(biome.extraction)) {
    production[resourceId] = round2(weight * workforce * rng.float(0.7, 1.3));
  }
  return production;
}

// Demande civile par tick, proportionnelle à la population.
function civilConsumptionFor(popM) {
  const consumption = {};
  for (const [resourceId, perM] of Object.entries(E.POP_CONSUMPTION_PER_M)) {
    consumption[resourceId] = round2(perM * popM);
  }
  return consumption;
}

// Choix des industries : on privilégie les recettes dont les entrées sont
// disponibles localement (extraction ou industrie déjà installée) — un
// monde minier accueille des aciéries, pas des fermes hydroponiques.
function industriesFor(rng, production, popM) {
  const count = Math.max(0, Math.min(
    E.MAX_INDUSTRIES_PER_PLANET,
    Math.round(rng.float(0.5, 1.5) + Math.log10(Math.max(popM, 1)))
  ));

  const localOutputs = new Set(Object.keys(production));
  const chosen = [];
  for (let i = 0; i < count; i++) {
    let best = null;
    let bestScore = -1;
    for (const recipeId of RECIPE_IDS) {
      if (chosen.some((c) => c.recipeId === recipeId)) continue;
      const inputs = Object.keys(RECIPES[recipeId].inputs);
      const localShare = inputs.filter((r) => localOutputs.has(r)).length / inputs.length;
      const score = rng.float(0.2, 1.0) + 1.5 * localShare;
      if (score > bestScore) {
        bestScore = score;
        best = recipeId;
      }
    }
    const rate = round2(
      (E.INDUSTRY_BASE_RATE + E.INDUSTRY_POP_COEF * popM) * rng.float(0.6, 1.4)
    );
    chosen.push({ recipeId: best, rate });
    localOutputs.add(best); // les recettes suivantes peuvent chaîner dessus
  }
  return chosen;
}

// Demande totale par tick (civile + industrielle à plein régime) pour une
// ressource : sert à calculer le stock cible du modèle de prix.
function totalDemand(resourceId, consumption, industries) {
  let demand = consumption[resourceId] ?? 0;
  for (const { recipeId, rate } of industries) {
    demand += (RECIPES[recipeId].inputs[resourceId] ?? 0) * rate;
  }
  return demand;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── Génération complète ──────────────────────────────────────────

export function generateUniverse(db, seed) {
  const rng = createRng(seed);

  const insertSystem = db.prepare('INSERT INTO systems (name, x, y) VALUES (?, ?, ?)');
  const insertPlanet = db.prepare(
    'INSERT INTO planets (system_id, name, biome, population) VALUES (?, ?, ?, ?)'
  );
  const insertResource = db.prepare(
    'INSERT INTO planet_resources (planet_id, resource_id, stock, production, consumption, price) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertIndustry = db.prepare(
    'INSERT INTO planet_industries (planet_id, recipe_id, rate) VALUES (?, ?, ?)'
  );
  const insertDistance = db.prepare(
    'INSERT INTO system_distances (system_a, system_b, distance) VALUES (?, ?, ?)'
  );
  const insertHistory = db.prepare(
    'INSERT INTO price_history (planet_id, resource_id, tick, price) VALUES (?, ?, 0, ?)'
  );

  let planetCount = 0;

  db.transaction(() => {
    const systemCount = rng.int(U.MIN_SYSTEMS, U.MAX_SYSTEMS);
    const positions = placeSystems(rng, systemCount);
    const usedNames = new Set();
    const systemIds = [];

    const biomeEntries = BIOME_IDS.map((id) => ({ id, weight: BIOMES[id].weight }));

    for (const pos of positions) {
      const systemName = makeStarName(rng, usedNames);
      const systemId = insertSystem.run(systemName, round2(pos.x), round2(pos.y)).lastInsertRowid;
      systemIds.push({ id: systemId, ...pos });

      const nbPlanets = rng.int(U.MIN_PLANETS, U.MAX_PLANETS);
      for (let p = 0; p < nbPlanets; p++) {
        const biomeId = rng.pickWeighted(biomeEntries).id;
        const biome = BIOMES[biomeId];
        const popM = round2(rng.logUniform(biome.popRange[0], biome.popRange[1]));
        const planetId = insertPlanet.run(
          systemId, `${systemName} ${ROMAN[p]}`, biomeId, popM
        ).lastInsertRowid;
        planetCount++;

        const production = extractionFor(rng, biome, popM);
        const consumption = civilConsumptionFor(popM);
        const industries = industriesFor(rng, production, popM);
        for (const { recipeId, rate } of industries) {
          insertIndustry.run(planetId, recipeId, rate);
        }

        // Stocks initiaux dispersés autour du stock cible (0.3× à 2×) :
        // certains marchés démarrent en pénurie, d'autres en surplus,
        // les prix divergent dès les premiers ticks.
        for (const resourceId of RESOURCE_IDS) {
          const demand = totalDemand(resourceId, consumption, industries);
          const target = targetStock(demand);
          const stock = round2(target * rng.float(0.3, 2.0));
          const price = equilibriumPrice({
            basePrice: RESOURCES[resourceId].basePrice,
            stock,
            target,
          });
          insertResource.run(
            planetId, resourceId, stock,
            production[resourceId] ?? 0,
            consumption[resourceId] ?? 0,
            price
          );
          insertHistory.run(planetId, resourceId, price);
        }
      }
    }

    // Distances entre toutes les paires de systèmes (a < b).
    for (let i = 0; i < systemIds.length; i++) {
      for (let j = i + 1; j < systemIds.length; j++) {
        const a = systemIds[i];
        const b = systemIds[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        insertDistance.run(a.id, b.id, round2(dist));
      }
    }

    setMeta(db, 'seed', seed);
    setMeta(db, 'current_tick', 0);
    setMeta(db, 'generated_at', new Date().toISOString());
  })();

  const systems = db.prepare('SELECT COUNT(*) AS n FROM systems').get().n;
  return { seed, systems, planets: planetCount };
}
