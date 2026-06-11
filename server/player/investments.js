// Parts d'industries planétaires : le joueur investit dans les industries
// des autres mondes et touche des dividendes sur leur production RÉELLE
// du tick (les runs calculés par le moteur, loi du minimum comprise).
// Une aciérie étranglée faute de minerai ne verse rien — le risque
// industriel est dans le prix de la part.

import { CONFIG } from '../config.js';
import { RESOURCES } from '../../data/resources.js';
import { RECIPES } from '../../data/recipes.js';
import { getPlayer, getShip, adjustCredits, tierOf, hasTierAccess } from './state.js';
import { marketOpen } from '../factions/standing.js';

const INV = CONFIG.PLAYER.INVEST;

// Valorisation d'une industrie : chiffre d'affaires brut à plein régime,
// amorti sur PAYBACK_TICKS au taux de marge des dividendes.
export function industryValuation(recipeId, rate) {
  const recipe = RECIPES[recipeId];
  const grossPerTick = rate * recipe.output * RESOURCES[recipeId].basePrice;
  return Math.round(grossPerTick * INV.DIVIDEND_MARGIN * INV.PAYBACK_TICKS);
}

export function getShare(db, planetId, recipeId) {
  return db.prepare(
    'SELECT share FROM industry_shares WHERE planet_id = ? AND recipe_id = ?'
  ).get(planetId, recipeId)?.share ?? 0;
}

export function listInvestments(db) {
  return db.prepare(
    `SELECT ish.*, pi.rate, p.name AS planet_name
     FROM industry_shares ish
     JOIN planet_industries pi ON pi.planet_id = ish.planet_id AND pi.recipe_id = ish.recipe_id
     JOIN planets p ON p.id = ish.planet_id
     ORDER BY ish.planet_id`
  ).all().map((i) => ({
    ...i,
    name: RESOURCES[i.recipe_id].name,
    valuation: industryValuation(i.recipe_id, i.rate),
    // estimation à plein régime — le réel dépend des pénuries
    estimatedYield: Math.round(i.rate * RECIPES[i.recipe_id].output
      * RESOURCES[i.recipe_id].basePrice * INV.DIVIDEND_MARGIN * i.share * 100) / 100,
  }));
}

// Achat de parts : à quai, marché accessible (tier + réputation).
export function investIndustry(db, recipeId, share, shipId) {
  if (!(share > 0) || !Number.isFinite(share)) return { ok: false, error: 'part invalide' };

  const ship = getShip(db, shipId);
  if (!ship || ship.planet_id === null) return { ok: false, error: 'vaisseau en transit' };

  const planet = db.prepare(
    `SELECT p.id, p.name, p.population, s.faction_id FROM planets p
     JOIN systems s ON s.id = p.system_id WHERE p.id = ?`
  ).get(ship.planet_id);
  const industry = db.prepare(
    'SELECT rate FROM planet_industries WHERE planet_id = ? AND recipe_id = ?'
  ).get(planet.id, recipeId);
  if (!industry) return { ok: false, error: 'pas d\'industrie de ce type ici' };

  const player = getPlayer(db);
  if (!hasTierAccess(player, tierOf(planet.population))) {
    return { ok: false, error: 'accès au marché requis (tier) pour investir ici' };
  }
  if (!marketOpen(db, planet.faction_id)) {
    return { ok: false, error: 'votre nom est sur liste noire ici' };
  }

  const current = getShare(db, planet.id, recipeId);
  if (current + share > INV.MAX_SHARE + 1e-9) {
    return { ok: false, error: `participation plafonnée à ${Math.round(INV.MAX_SHARE * 100)} % (vous : ${Math.round(current * 100)} %)` };
  }

  const cost = Math.round(industryValuation(recipeId, industry.rate) * share);
  if (player.credits < cost) return { ok: false, error: `crédits insuffisants (${cost} cr)` };

  db.transaction(() => {
    adjustCredits(db, -cost);
    db.prepare(
      `INSERT INTO industry_shares (planet_id, recipe_id, share) VALUES (?, ?, ?)
       ON CONFLICT(planet_id, recipe_id) DO UPDATE SET share = ROUND(share + ?, 4)`
    ).run(planet.id, recipeId, share, share);
  })();

  return {
    ok: true, planetName: planet.name, recipeId, name: RESOURCES[recipeId].name,
    share: getShare(db, planet.id, recipeId), cost,
  };
}

// Revente (avec décote) — à quai sur place.
export function divestIndustry(db, recipeId, shipId) {
  const ship = getShip(db, shipId);
  if (!ship || ship.planet_id === null) return { ok: false, error: 'vaisseau en transit' };
  const current = getShare(db, ship.planet_id, recipeId);
  if (current <= 0) return { ok: false, error: 'aucune part ici' };

  const industry = db.prepare(
    'SELECT rate FROM planet_industries WHERE planet_id = ? AND recipe_id = ?'
  ).get(ship.planet_id, recipeId);
  const refund = Math.round(industryValuation(recipeId, industry.rate) * current * INV.RESALE);

  db.transaction(() => {
    adjustCredits(db, refund);
    db.prepare('DELETE FROM industry_shares WHERE planet_id = ? AND recipe_id = ?')
      .run(ship.planet_id, recipeId);
  })();
  return { ok: true, refund, name: RESOURCES[recipeId].name };
}

// Versement des dividendes du tick, sur la production réelle.
export function tickDividends(db, industryRuns) {
  const shares = db.prepare('SELECT * FROM industry_shares').all();
  if (shares.length === 0) return 0;

  const byKey = new Map(shares.map((s) => [`${s.planet_id}:${s.recipe_id}`, s.share]));
  const priceOf = db.prepare(
    'SELECT price FROM planet_resources WHERE planet_id = ? AND resource_id = ?'
  );

  let paid = 0;
  for (const ind of industryRuns) {
    const share = byKey.get(`${ind.planet_id}:${ind.recipe_id}`);
    if (!share || !(ind.runs > 0)) continue;
    const price = priceOf.get(ind.planet_id, ind.recipe_id).price;
    paid += ind.runs * RECIPES[ind.recipe_id].output * price * INV.DIVIDEND_MARGIN * share;
  }
  if (paid > 0) adjustCredits(db, Math.round(paid * 100) / 100);
  return paid;
}
