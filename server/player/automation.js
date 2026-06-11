// Vaisseaux en mode automatique : un capitaine salarié fait le métier à
// votre place — acheter bas ici, vendre haut à portée — en passant par
// executeTrade et startTravel, donc avec VOS règles : tiers, licences,
// listes noires, prestige et réputation. L'IA est la même philosophie
// gloutonne que les marchands PNJ, mais filtre d'abord les marchés où
// vous n'avez pas vos entrées.

import { CONFIG } from '../config.js';
import { RESOURCE_IDS } from '../../data/resources.js';
import { getPlayer, getCargo, tierOf, hasTierAccess } from './state.js';
import { executeTrade, refuel } from './trade.js';
import { startTravel } from './travel.js';
import { marketOpen } from '../factions/standing.js';
import { logEvent } from '../events.js';

const A = CONFIG.AUTOMATION;

// Marchés à portée du système, avec ce qu'il faut pour filtrer l'accès.
function scan(db, systemId) {
  return db.prepare(
    `SELECT pr.planet_id, pr.resource_id, pr.stock, pr.price,
            p.population, s2.faction_id, s2.x, s2.y, me.x AS mx, me.y AS my
     FROM planet_resources pr
     JOIN planets p ON p.id = pr.planet_id
     JOIN systems s2 ON s2.id = p.system_id
     JOIN systems me ON me.id = ?
     WHERE (s2.x - me.x) * (s2.x - me.x) + (s2.y - me.y) * (s2.y - me.y) <= ?`
  ).all(systemId, A.SCAN_RADIUS ** 2);
}

export function tickAutoShips(db, tick) {
  const ships = db.prepare(
    "SELECT * FROM ships WHERE mode = 'auto' AND planet_id IS NOT NULL"
  ).all();
  if (ships.length === 0) return;

  const player = getPlayer(db);
  const systemOf = db.prepare('SELECT system_id FROM planets WHERE id = ?');
  const dist = (m) => Math.hypot(m.x - m.mx, m.y - m.my);
  const accessible = (m) =>
    hasTierAccess(player, tierOf(m.population)) && marketOpen(db, m.faction_id);

  for (const ship of ships) {
    // 1. Plein automatique quand le réservoir baisse.
    if (ship.fuel < ship.fuel_capacity * A.REFUEL_BELOW) {
      refuel(db, undefined, ship.id);
    }

    const markets = scan(db, systemOf.get(ship.planet_id).system_id)
      .filter(accessible);
    const cargo = getCargo(db, ship.id);

    if (cargo.length > 0) {
      // 2. Vendre : on suit le plus gros lot vers son meilleur marché.
      const main = cargo.sort((a, b) => b.quantity - a.quantity)[0];
      const candidates = markets.filter((m) => m.resource_id === main.resource_id);
      const here = candidates.find((m) => m.planet_id === ship.planet_id);
      const best = candidates.sort((a, b) => b.price - a.price)[0];
      if (!best) continue;

      const extraElsewhere = here && best.planet_id !== ship.planet_id
        ? (best.price - here.price) * main.quantity : -1;
      if (here && extraElsewhere <= 0) {
        for (const lot of cargo) {
          const sale = executeTrade(db, {
            side: 'sell', resourceId: lot.resource_id, quantity: lot.quantity, shipId: ship.id,
          });
          if (sale.ok) {
            logEvent(db, tick, 'fleet',
              `FLOTTE — ${ship.name} vend ${Math.round(lot.quantity)} ${lot.resource_id}`
              + ` à ${sale.unitPrice} cr/u (+${Math.round(sale.total)} cr)`);
          }
        }
      } else if (best.planet_id !== ship.planet_id) {
        startTravel(db, best.planet_id, tick, ship.id);
      }
      continue;
    }

    // 3. Acheter : meilleure paire (achat local → vente à portée).
    const local = new Map();
    for (const m of markets) {
      if (m.planet_id === ship.planet_id) local.set(m.resource_id, m);
    }
    let best = null;
    for (const resourceId of RESOURCE_IDS) {
      const here = local.get(resourceId);
      if (!here || here.stock < 20) continue;
      const qty = Math.floor(Math.min(
        ship.cargo_capacity, here.stock * A.MAX_BUY_SHARE,
        getPlayer(db).credits / here.price));
      if (qty < 5) continue;
      for (const m of markets) {
        if (m.resource_id !== resourceId || m.planet_id === ship.planet_id) continue;
        if ((m.price - here.price) / here.price < A.MIN_MARGIN) continue;
        const profit = (m.price - here.price) * qty;
        if (profit > 0 && (!best || profit > best.profit)) best = { resourceId, qty, dest: m, profit };
      }
    }

    if (best) {
      const buy = executeTrade(db, {
        side: 'buy', resourceId: best.resourceId, quantity: best.qty, shipId: ship.id,
      });
      if (buy.ok) {
        logEvent(db, tick, 'fleet',
          `FLOTTE — ${ship.name} charge ${best.qty} ${best.resourceId}`
          + ` à ${buy.unitPrice} cr/u, cap sur un marché à ${Math.round(dist(best.dest))} u`);
        startTravel(db, best.dest.planet_id, tick, ship.id);
      }
    } else if (Math.random() < A.WANDER_P && markets.length > 0) {
      // Rien d'intéressant : on va prospecter ailleurs (et rafraîchir
      // votre connaissance des marchés au passage).
      const target = markets[Math.floor(Math.random() * markets.length)];
      if (target.planet_id !== ship.planet_id) startTravel(db, target.planet_id, tick, ship.id);
    }
  }
}
