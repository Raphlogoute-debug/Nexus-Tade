// Achat/vente du JOUEUR sur le marché de la planète où il est à quai.
// Les effets marché (glissement, stock, prix) passent par economy/market.js,
// partagé avec les marchands PNJ — mêmes règles pour tout le monde.
//
// Spécifique au joueur :
//   - l'accès dépend du tier de la planète (prestige ou licence) ; les
//     avant-postes T1 traitent avec n'importe qui. Exception : le
//     ravitaillement en carburant est un service portuaire ouvert à tous.
//   - le profit réalisé et les nouveaux partenaires construisent le prestige.

import { CONFIG } from '../config.js';
import { RESOURCES } from '../../data/resources.js';
import { tradeUnitPrice } from '../economy/pricing.js';
import { marketContext, applyMarketTrade } from '../economy/market.js';
import { getCurrentTick } from '../db.js';
import {
  getPlayer, getShip, cargoUsed, adjustCredits, addPrestige, tierOf, hasTierAccess,
} from './state.js';
import { recordFullSnapshot } from './knowledge.js';

const PRESTIGE = CONFIG.PLAYER.PRESTIGE;

// Vérifications communes ; retourne le contexte si l'ordre est jouable.
function prepareOrder(db, { side, resourceId, quantity }) {
  const ship = getShip(db);
  if (ship.planet_id === null) return { ok: false, error: 'vaisseau en transit' };
  if (!RESOURCES[resourceId]) return { ok: false, error: 'ressource inconnue' };
  if (!(quantity > 0) || !Number.isFinite(quantity)) return { ok: false, error: 'quantité invalide' };

  const player = getPlayer(db);
  const planet = db.prepare('SELECT id, name, population FROM planets WHERE id = ?')
    .get(ship.planet_id);
  const tier = tierOf(planet.population);
  if (!hasTierAccess(player, tier)) {
    return {
      ok: false, refusedTier: tier,
      error: `marché de tier ${tier} : prestige ${CONFIG.PLAYER.TIERS[tier].prestige} ou licence requis`,
    };
  }

  const market = marketContext(db, planet.id, resourceId);
  if (side === 'buy' && quantity > market.stock) {
    return { ok: false, error: `stock du marché insuffisant (${Math.floor(market.stock)} disponibles)` };
  }

  const unitPrice = tradeUnitPrice({
    basePrice: market.basePrice, currentPrice: market.price,
    stock: market.stock, quantity, side,
  });
  const total = Math.round(unitPrice * quantity * 100) / 100;

  return { ok: true, ship, player, planet, market, unitPrice, total };
}

// Aperçu sans exécution (pour l'UI : montrer le glissement avant de signer).
export function previewTrade(db, order) {
  const p = prepareOrder(db, order);
  if (!p.ok) return p;
  return {
    ok: true,
    unitPrice: p.unitPrice,
    total: p.total,
    currentPrice: p.market.price,
    stock: p.market.stock,
  };
}

export function executeTrade(db, { side, resourceId, quantity }) {
  const p = prepareOrder(db, { side, resourceId, quantity });
  if (!p.ok) return p;
  const { ship, planet, market } = p;
  const tick = getCurrentTick(db);

  const cargoRow = db.prepare(
    'SELECT quantity, avg_cost FROM ship_cargo WHERE ship_id = ? AND resource_id = ?'
  ).get(ship.id, resourceId);

  if (side === 'buy') {
    if (p.player.credits < p.total) return { ok: false, error: 'crédits insuffisants' };
    const space = ship.cargo_capacity - cargoUsed(db, ship.id);
    if (quantity > space) return { ok: false, error: `soute pleine (${Math.floor(space)} places libres)` };
  } else if (!cargoRow || cargoRow.quantity < quantity) {
    return { ok: false, error: 'pas assez en soute' };
  }

  let prestigeGained = 0;
  let executed;

  db.transaction(() => {
    executed = applyMarketTrade(db, planet.id, resourceId, quantity, side, market);

    if (side === 'buy') {
      adjustCredits(db, -executed.total);
      const oldQty = cargoRow?.quantity ?? 0;
      const oldCost = cargoRow?.avg_cost ?? 0;
      const newAvg = Math.round(((oldQty * oldCost + executed.total) / (oldQty + quantity)) * 100) / 100;
      db.prepare(
        `INSERT INTO ship_cargo (ship_id, resource_id, quantity, avg_cost) VALUES (?, ?, ?, ?)
         ON CONFLICT(ship_id, resource_id) DO UPDATE SET quantity = ROUND(quantity + ?, 2), avg_cost = ?`
      ).run(ship.id, resourceId, quantity, newAvg, quantity, newAvg);
    } else {
      adjustCredits(db, executed.total);
      db.prepare(
        'UPDATE ship_cargo SET quantity = ROUND(quantity - ?, 2) WHERE ship_id = ? AND resource_id = ?'
      ).run(quantity, ship.id, resourceId);

      // Prestige : le profit réalisé compte, pas le volume — acheter-revendre
      // à perte ne construit aucune réputation.
      const profit = (executed.unitPrice - cargoRow.avg_cost) * quantity;
      if (profit > 0) prestigeGained += profit / PRESTIGE.PROFIT_PER_POINT;
    }

    // Premier échange avec cette planète : un nouveau partenaire commercial.
    const isNew = !db.prepare('SELECT 1 FROM trade_partners WHERE planet_id = ?').get(planet.id);
    if (isNew) {
      db.prepare('INSERT INTO trade_partners (planet_id, first_trade_tick) VALUES (?, ?)')
        .run(planet.id, tick);
      prestigeGained += PRESTIGE.NEW_PARTNER;
    }
    if (prestigeGained > 0) addPrestige(db, prestigeGained);

    recordFullSnapshot(db, planet.id, tick); // on voit ce qu'on vient de faire
  })();

  return {
    ok: true, side, resourceId, quantity,
    unitPrice: executed.unitPrice, total: executed.total,
    prestigeGained: Math.round(prestigeGained * 10) / 10,
    credits: getPlayer(db).credits,
  };
}

// Ravitaillement : achète du carburant du marché local directement dans le
// réservoir. Service portuaire — pas de contrôle de tier, pas de prestige.
export function refuel(db, quantity) {
  const ship = getShip(db);
  if (ship?.planet_id === null) return { ok: false, error: 'vaisseau en transit' };

  const need = Math.floor(ship.fuel_capacity - ship.fuel);
  if (need <= 0) return { ok: false, error: 'réservoir plein' };

  const market = marketContext(db, ship.planet_id, 'fuel');
  const player = getPlayer(db);
  let qty = Math.floor(Math.min(quantity ?? need, need, market.stock));
  if (qty <= 0) return { ok: false, error: 'pas de carburant disponible sur ce marché' };

  // Si les crédits ne couvrent pas tout, on prend ce qu'on peut payer.
  const priceFor = (q) => tradeUnitPrice({
    basePrice: market.basePrice, currentPrice: market.price,
    stock: market.stock, quantity: q, side: 'buy',
  });
  if (priceFor(qty) * qty > player.credits) {
    qty = Math.floor(player.credits / priceFor(qty));
    if (qty <= 0) return { ok: false, error: 'crédits insuffisants' };
  }

  let executed;
  db.transaction(() => {
    executed = applyMarketTrade(db, ship.planet_id, 'fuel', qty, 'buy', market);
    adjustCredits(db, -executed.total);
    db.prepare('UPDATE ships SET fuel = ROUND(fuel + ?, 2) WHERE id = ?').run(qty, ship.id);
  })();

  return { ok: true, quantity: qty, unitPrice: executed.unitPrice, total: executed.total, fuel: getShip(db).fuel };
}

// Licence commerciale : accès payant à un tier sans le prestige requis.
export function buyLicence(db, tier) {
  const t = CONFIG.PLAYER.TIERS[tier];
  if (!t) return { ok: false, error: 'tier de licence invalide' };
  const player = getPlayer(db);
  if (player.licence_tier >= tier) return { ok: false, error: 'licence déjà acquise' };
  if (tier === 3 && !hasTierAccess(player, 2)) {
    return { ok: false, error: 'accès au tier 2 requis avant la licence T3' };
  }
  if (player.credits < t.licenceCost) return { ok: false, error: 'crédits insuffisants' };

  db.transaction(() => {
    adjustCredits(db, -t.licenceCost);
    db.prepare('UPDATE player SET licence_tier = ? WHERE id = 1').run(tier);
  })();
  return { ok: true, tier, cost: t.licenceCost };
}
