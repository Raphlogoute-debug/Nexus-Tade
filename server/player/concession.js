// Les concessions du joueur — son industrie. Chaque site combine :
//   - une extraction (la ressource phare du biome local), qui alimente
//   - un entrepôt multi-ressources borné, dans lequel
//   - des ateliers transforment à cadence fixe (loi du minimum sur les
//     entrées disponibles ET sur la place restante).
// Les entrées qui ne sont pas extraites sur place se livrent par la soute
// (acheter du cuivre ailleurs pour nourrir sa fonderie d'alliages) ; les
// produits se chargent et se vendent où bon vous semble.
// Tout sort de l'entrepôt à coût d'acquisition nul : la revente est du
// profit pur, donc du prestige.

import { CONFIG } from '../config.js';
import { RESOURCES } from '../../data/resources.js';
import { RECIPES, recipeOutput, recipeName } from '../../data/recipes.js';
import { BIOMES } from '../../data/biomes.js';
import { getMeta } from '../db.js';
import { createRng } from '../universe/rng.js';
import { getShip, getPlayer, cargoUsed, adjustCredits, tierOf } from './state.js';
import { hasTech, unlockedRecipes } from './tech.js';

const LEVELS = CONFIG.PLAYER.CONCESSION_LEVELS;
const FAC = CONFIG.PLAYER.FACILITIES;
const DEP = CONFIG.PLAYER.DEPOSITS;

// ── Gisements : qualité géologique d'une planète ─────────────────
// Déterministe (seed ⊕ planète) : la même planète a toujours le même
// filon. Biaisé vers le bas — les gisements riches sont rares, les
// dénicher est le métier du prospecteur.

export function depositQuality(db, planetId) {
  const seed = Number(getMeta(db, 'seed')) >>> 0;
  const rng = createRng((seed ^ (planetId * 0x9e3779b1)) >>> 0);
  const q = DEP.MIN + Math.pow(rng.next(), DEP.SKEW) * DEP.SPAN;
  return Math.round(q * 100) / 100;
}

export function depositLabel(quality) {
  if (quality >= 1.7) return 'exceptionnel';
  if (quality >= 1.3) return 'riche';
  if (quality >= 0.8) return 'correct';
  return 'pauvre';
}

// ── Lecture ──────────────────────────────────────────────────────

function enrich(db, c) {
  const level = LEVELS[c.level - 1];
  const next = LEVELS[c.level] ?? null;
  const extractMult = hasTech(db, 'deep_mining_2') ? FAC.DEEP_MINING_2_MULT
    : hasTech(db, 'deep_mining') ? FAC.DEEP_MINING_MULT : 1;
  const capMult = hasTech(db, 'orbital_storage') ? FAC.WAREHOUSE_TECH_2_MULT
    : hasTech(db, 'auto_warehouse') ? FAC.WAREHOUSE_TECH_MULT : 1;
  const workshopMult = hasTech(db, 'workshop_automation') ? FAC.WORKSHOP_AUTO_MULT
    : hasTech(db, 'workshop_engineering') ? FAC.WORKSHOP_ENG_MULT : 1;
  const quality = depositQuality(db, c.planet_id);
  const rate = level.rate * extractMult * quality;
  const cap = level.cap * capMult;
  const storage = db.prepare(
    'SELECT resource_id, quantity FROM facility_storage WHERE concession_id = ? AND quantity > 0 ORDER BY resource_id'
  ).all(c.id).map((s) => ({ ...s, name: RESOURCES[s.resource_id].name }));
  return {
    ...c,
    rate: Math.round(rate * 100) / 100,
    quality,
    qualityLabel: depositLabel(quality),
    cap,
    nextLevelCost: next?.cost ?? null,
    used: storage.reduce((sum, s) => sum + s.quantity, 0),
    storage,
    workshops: db.prepare(
      'SELECT recipe_id FROM facility_workshops WHERE concession_id = ? ORDER BY recipe_id'
    ).all(c.id).map((w) => ({
      recipe_id: w.recipe_id,
      name: recipeName(w.recipe_id),
      produces: recipeOutput(w.recipe_id),
      inputs: RECIPES[w.recipe_id].inputs,
      output: RECIPES[w.recipe_id].output,
      rate: FAC.WORKSHOP_RATE * workshopMult,
    })),
  };
}

// Plafond de concessions, selon la prospection recherchée.
export function maxConcessions(db) {
  return hasTech(db, 'prospection_2') ? FAC.MAX_CONCESSIONS_2 : FAC.MAX_CONCESSIONS;
}

export function listConcessions(db) {
  return db.prepare('SELECT * FROM concessions ORDER BY id').all().map((c) => enrich(db, c));
}

export function getConcessionAt(db, planetId) {
  const c = db.prepare('SELECT * FROM concessions WHERE planet_id = ?').get(planetId);
  return c ? enrich(db, c) : null;
}

// ── Tick : extraction puis ateliers, dans l'entrepôt ─────────────

const upsertStorage = `
  INSERT INTO facility_storage (concession_id, resource_id, quantity) VALUES (?, ?, ?)
  ON CONFLICT(concession_id, resource_id) DO UPDATE SET quantity = ROUND(quantity + excluded.quantity, 2)`;

export function tickConcessions(db) {
  const concessions = listConcessions(db);
  if (concessions.length === 0) return;
  const upsert = db.prepare(upsertStorage);

  db.transaction(() => {
    for (const c of concessions) {
      const stock = new Map(c.storage.map((s) => [s.resource_id, s.quantity]));
      let used = c.used;

      // 1. Extraction, bornée par la place.
      const extracted = Math.max(0, Math.min(c.rate, c.cap - used));
      if (extracted > 0) {
        upsert.run(c.id, c.resource_id, Math.round(extracted * 100) / 100);
        stock.set(c.resource_id, (stock.get(c.resource_id) ?? 0) + extracted);
        used += extracted;
      }

      // 2. Ateliers : cadence bornée par l'entrée la plus rare et par la
      // place nette créée (les sorties prennent plus de place que les
      // entrées n'en libèrent, pour les recettes expansives).
      for (const w of c.workshops) {
        let runs = w.rate;
        let inputVolume = 0;
        for (const [inputId, qty] of Object.entries(w.inputs)) {
          runs = Math.min(runs, (stock.get(inputId) ?? 0) / qty);
          inputVolume += qty;
        }
        const netSpace = w.output - inputVolume;
        if (netSpace > 0) runs = Math.min(runs, (c.cap - used) / netSpace);
        if (runs <= 0.01) continue;

        for (const [inputId, qty] of Object.entries(w.inputs)) {
          upsert.run(c.id, inputId, -Math.round(qty * runs * 100) / 100);
          stock.set(inputId, stock.get(inputId) - qty * runs);
        }
        const produced = Math.round(w.output * runs * 100) / 100;
        upsert.run(c.id, w.produces, produced);
        stock.set(w.produces, (stock.get(w.produces) ?? 0) + produced);
        used += netSpace * runs;
      }
    }
  })();
}

// ── Actions joueur ───────────────────────────────────────────────

// Entrepôt → soute (coût d'acquisition nul).
export function collectConcession(db, quantity, shipId, resourceId) {
  const ship = getShip(db, shipId);
  const c = ship?.planet_id !== null ? getConcessionAt(db, ship.planet_id) : null;
  if (!c) return { ok: false, error: 'aucune concession à vous sur cette planète' };

  // Sans ressource précisée : la plus abondante de l'entrepôt.
  const target = resourceId
    ? c.storage.find((s) => s.resource_id === resourceId)
    : [...c.storage].sort((a, b) => b.quantity - a.quantity)[0];
  if (!target) return { ok: false, error: 'entrepôt vide' };

  const space = ship.cargo_capacity - cargoUsed(db, ship.id);
  const moved = Math.round(Math.min(target.quantity, space, quantity ?? Infinity) * 100) / 100;
  if (moved <= 0) return { ok: false, error: space <= 0 ? 'soute pleine' : 'rien à charger' };

  db.transaction(() => {
    db.prepare(upsertStorage).run(c.id, target.resource_id, -moved);
    db.prepare(
      `INSERT INTO ship_cargo (ship_id, resource_id, quantity, avg_cost) VALUES (?, ?, ?, 0)
       ON CONFLICT(ship_id, resource_id) DO UPDATE SET
         avg_cost = ROUND((quantity * avg_cost) / (quantity + excluded.quantity), 2),
         quantity = ROUND(quantity + excluded.quantity, 2)`
    ).run(ship.id, target.resource_id, moved);
  })();
  return { ok: true, moved, resourceId: target.resource_id, name: RESOURCES[target.resource_id].name };
}

// Soute → entrepôt (livrer les entrées de vos ateliers).
export function depositToConcession(db, resourceId, quantity, shipId) {
  const ship = getShip(db, shipId);
  const c = ship?.planet_id !== null ? getConcessionAt(db, ship.planet_id) : null;
  if (!c) return { ok: false, error: 'aucune concession à vous sur cette planète' };

  const cargo = db.prepare(
    'SELECT quantity FROM ship_cargo WHERE ship_id = ? AND resource_id = ?'
  ).get(ship.id, resourceId);
  const moved = Math.round(Math.min(
    cargo?.quantity ?? 0, c.cap - c.used, quantity ?? Infinity) * 100) / 100;
  if (moved <= 0) {
    return { ok: false, error: c.cap - c.used <= 0 ? 'entrepôt plein' : 'rien de tel en soute' };
  }

  db.transaction(() => {
    db.prepare(
      'UPDATE ship_cargo SET quantity = ROUND(quantity - ?, 2) WHERE ship_id = ? AND resource_id = ?'
    ).run(moved, ship.id, resourceId);
    db.prepare(upsertStorage).run(c.id, resourceId, moved);
  })();
  return { ok: true, moved, resourceId, name: RESOURCES[resourceId].name };
}

export function upgradeConcession(db, concessionId) {
  const c = db.prepare('SELECT * FROM concessions WHERE id = ?').get(concessionId);
  if (!c) return { ok: false, error: 'concession inconnue' };
  const next = LEVELS[c.level];
  if (!next) return { ok: false, error: 'niveau maximum atteint' };
  if (getPlayer(db).credits < next.cost) return { ok: false, error: 'crédits insuffisants' };

  db.transaction(() => {
    adjustCredits(db, -next.cost);
    db.prepare('UPDATE concessions SET level = level + 1 WHERE id = ?').run(concessionId);
  })();
  const after = enrich(db, db.prepare('SELECT * FROM concessions WHERE id = ?').get(concessionId));
  return { ok: true, level: after.level, rate: after.rate, cap: after.cap, cost: next.cost };
}

// Acheter une concession sur la planète où le vaisseau est à quai.
// Exige la technologie Prospection ; le prix double à chaque site.
export function buyConcession(db, shipId) {
  const ship = getShip(db, shipId);
  if (!ship || ship.planet_id === null) return { ok: false, error: 'vaisseau en transit' };
  if (getConcessionAt(db, ship.planet_id)) return { ok: false, error: 'vous avez déjà une concession ici' };
  // La course aux filons : une maison rivale est passée avant vous.
  const claim = db.prepare(
    `SELECT r.name FROM rival_concessions rc JOIN rivals r ON r.id = rc.rival_id
     WHERE rc.planet_id = ?`).get(ship.planet_id);
  if (claim) return { ok: false, error: `${claim.name} exploite déjà ce filon — trop tard` };
  if (!hasTech(db, 'prospection')) return { ok: false, error: 'technologie Prospection planétaire requise' };

  const owned = db.prepare('SELECT COUNT(*) AS n FROM concessions').get().n;
  const max = maxConcessions(db);
  if (owned >= max) return { ok: false, error: `maximum ${max} concessions (Prospection profonde pour aller plus loin)` };

  const planet = db.prepare('SELECT biome, name FROM planets WHERE id = ?').get(ship.planet_id);
  const extraction = BIOMES[planet.biome].extraction;
  const resourceId = Object.entries(extraction).sort((a, b) => b[1] - a[1])[0][0];
  // Colonie en plein boom : les pionniers paient moitié prix.
  const boom = db.prepare(
    `SELECT 1 FROM colonies WHERE planet_id = ? AND boom_until > (
       SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'current_tick')`
  ).get(ship.planet_id);
  const price = Math.round(FAC.CONCESSION_BASE_PRICE * 2 ** (owned - 1)
    * (boom ? CONFIG.COLONIES.DISCOUNT : 1));
  if (getPlayer(db).credits < price) return { ok: false, error: `crédits insuffisants (${price} cr)` };

  let id;
  db.transaction(() => {
    adjustCredits(db, -price);
    id = db.prepare(
      'INSERT INTO concessions (planet_id, resource_id, level) VALUES (?, ?, 1)'
    ).run(ship.planet_id, resourceId).lastInsertRowid;
  })();
  const quality = depositQuality(db, ship.planet_id);
  return {
    ok: true, id, price, planetName: planet.name,
    resourceId, resourceName: RESOURCES[resourceId].name,
    quality, qualityLabel: depositLabel(quality),
  };
}

// Installer un atelier (recette débloquée par la recherche).
export function installWorkshop(db, concessionId, recipeId) {
  const c = db.prepare('SELECT * FROM concessions WHERE id = ?').get(concessionId);
  if (!c) return { ok: false, error: 'concession inconnue' };
  if (!RECIPES[recipeId]) return { ok: false, error: 'recette inconnue' };
  if (!unlockedRecipes(db).has(recipeId)) {
    return { ok: false, error: 'filière non recherchée (voir Technologies)' };
  }
  if (db.prepare(
    'SELECT 1 FROM facility_workshops WHERE concession_id = ? AND recipe_id = ?'
  ).get(concessionId, recipeId)) {
    return { ok: false, error: 'atelier déjà installé' };
  }

  const cost = FAC.WORKSHOP_COST_OVERRIDE[recipeId]
    ?? FAC.WORKSHOP_COST[RESOURCES[recipeOutput(recipeId)].tier];
  if (getPlayer(db).credits < cost) return { ok: false, error: `crédits insuffisants (${cost} cr)` };

  db.transaction(() => {
    adjustCredits(db, -cost);
    db.prepare(
      'INSERT INTO facility_workshops (concession_id, recipe_id) VALUES (?, ?)'
    ).run(concessionId, recipeId);
  })();
  return { ok: true, recipeId, name: recipeName(recipeId), cost };
}
