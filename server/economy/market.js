// Primitives de marché partagées : le joueur, les marchands PNJ et les
// livraisons de contrats passent TOUS par ici — mêmes règles d'impact
// prix pour tout le monde, c'est ce qui rend le monde cohérent.

import { RESOURCES } from '../../data/resources.js';
import { tradeUnitPrice, nextPrice, targetStock } from './pricing.js';
import { resourceDemand } from './engine.js';

// État courant d'une ressource sur un marché, avec son stock cible.
export function marketContext(db, planetId, resourceId) {
  const row = db.prepare(
    'SELECT stock, price, consumption FROM planet_resources WHERE planet_id = ? AND resource_id = ?'
  ).get(planetId, resourceId);
  const industries = db.prepare(
    'SELECT recipe_id, rate FROM planet_industries WHERE planet_id = ?'
  ).all(planetId);
  return {
    ...row,
    basePrice: RESOURCES[resourceId].basePrice,
    target: targetStock(resourceDemand(resourceId, row.consumption, industries)),
  };
}

// Exécute l'effet marché d'un ordre : stock modifié, prix déplacé d'un pas
// de lissage vers le nouvel équilibre. Retourne le prix unitaire effectif
// (glissement inclus). Le règlement (crédits, soute) est à la charge de
// l'appelant. Pré-conditions (stock suffisant côté achat) déjà vérifiées.
export function applyMarketTrade(db, planetId, resourceId, quantity, side, market = null) {
  const m = market ?? marketContext(db, planetId, resourceId);
  const unitPrice = tradeUnitPrice({
    basePrice: m.basePrice, currentPrice: m.price,
    stock: m.stock, quantity, side,
  });
  const newStock = Math.round((m.stock + (side === 'buy' ? -quantity : quantity)) * 100) / 100;
  const newPrice = nextPrice({
    basePrice: m.basePrice, stock: newStock,
    target: m.target, previousPrice: m.price,
  });
  db.prepare(
    'UPDATE planet_resources SET stock = ?, price = ? WHERE planet_id = ? AND resource_id = ?'
  ).run(newStock, newPrice, planetId, resourceId);

  return {
    unitPrice,
    total: Math.round(unitPrice * quantity * 100) / 100,
    newStock,
    newPrice,
  };
}
