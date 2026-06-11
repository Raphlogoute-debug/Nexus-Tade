// Modèle de prix par offre/demande — volontairement simple et lisible.
//
// Idée : chaque marché vise un stock « confortable » (de quoi couvrir
// quelques dizaines de ticks de demande). Le prix dépend du rapport
// stock cible / stock réel :
//
//   rareté  = cible / stock        (> 1 → pénurie, < 1 → surplus)
//   prix    = prixBase × rareté^ÉLASTICITÉ, borné à [MIN_MULT, MAX_MULT]
//
// puis le prix affiché se déplace progressivement vers cette valeur
// (lissage), ce qui donne des courbes continues plutôt que des sauts.
//
// Module pur (aucune dépendance Express/DOM/DB) : facile à tester, et
// à remplacer plus tard par un modèle plus riche (élasticité par
// ressource, spéculation, embargos…).

import { CONFIG } from '../config.js';

const P = CONFIG.PRICING;

// Stock cible d'un marché pour une ressource, en fonction de sa demande
// totale par tick (civile + industrielle à plein régime).
export function targetStock(demandPerTick) {
  return P.TARGET_FLOOR + P.TARGET_DEMAND_COVER * demandPerTick;
}

// Prix d'équilibre instantané pour un niveau de stock donné.
export function equilibriumPrice({ basePrice, stock, target }) {
  const scarcity = target / Math.max(stock, 1);
  const price = basePrice * Math.pow(scarcity, P.ELASTICITY);
  return round2(clamp(price, basePrice * P.MIN_MULT, basePrice * P.MAX_MULT));
}

// Prix au tick suivant : déplacement partiel vers le prix d'équilibre.
export function nextPrice({ basePrice, stock, target, previousPrice }) {
  const eq = equilibriumPrice({ basePrice, stock, target });
  return round2(previousPrice + (eq - previousPrice) * P.SMOOTHING);
}

// Prix unitaire effectif d'un ordre joueur, glissement inclus : la rareté
// est évaluée au stock médian pendant l'exécution. Plus l'ordre est gros
// par rapport au marché, plus le prix se déplace contre vous — c'est ce
// qui rend les petits marchés (avant-postes) peu profonds.
export function tradeUnitPrice({ basePrice, currentPrice, stock, quantity, side }) {
  const midStock = side === 'buy' ? stock - quantity / 2 : stock + quantity / 2;
  const impact = Math.pow(stock / Math.max(midStock, 1), CONFIG.PRICING.ELASTICITY);
  return round2(clamp(currentPrice * impact, basePrice * P.MIN_MULT, basePrice * P.MAX_MULT));
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
