// Comptoirs commerciaux : la présence marchande permanente du joueur.
// Un comptoir sur une planète stocke des marchandises, télégraphie son
// marché (vos relevés y restent frais), et exécute des ORDRES PERMANENTS
// chaque tick :
//   - achat  : tant que le prix local est ≤ à votre limite, il draine le
//     marché vers l'entrepôt (le prix MONTE — l'accaparement) ;
//   - vente  : tant que le prix local est ≥ à votre plancher, il déverse
//     l'entrepôt sur le marché (le prix BAISSE — l'inondation).
// Tout passe par economy/market.js : l'impact prix du comptoir suit les
// mêmes règles que le joueur, les PNJ et les factions. Aucun prestige :
// le prestige se gagne en personne, pas par procuration.

import { CONFIG } from '../config.js';
import { RESOURCES } from '../../data/resources.js';
import { getCurrentTick } from '../db.js';
import { getShip, getPlayer, getCargo, cargoUsed, adjustCredits, tierOf, hasTierAccess, recordTradeVolume } from './state.js';
import { hasTech } from './tech.js';
import { applyMarketTrade, marketContext } from '../economy/market.js';
import { recordFullSnapshot } from './knowledge.js';

const P = CONFIG.PLAYER.POSTS;

// ── Lecture ──────────────────────────────────────────────────────

function enrich(db, post) {
  const level = P.LEVELS[post.level - 1];
  const next = P.LEVELS[post.level] ?? null;
  const storage = db.prepare(
    'SELECT resource_id, quantity, avg_cost FROM post_storage WHERE post_id = ? AND quantity > 0 ORDER BY resource_id'
  ).all(post.id).map((s) => ({ ...s, name: RESOURCES[s.resource_id].name }));
  const planet = db.prepare('SELECT name, system_id FROM planets WHERE id = ?').get(post.planet_id);
  return {
    ...post,
    planetName: planet.name,
    systemId: planet.system_id,
    cap: level.cap,
    flow: level.flow,
    nextLevelCost: next?.cost ?? null,
    used: storage.reduce((sum, s) => sum + s.quantity, 0),
    storage,
    orders: db.prepare('SELECT * FROM post_orders WHERE post_id = ? ORDER BY id').all(post.id)
      .map((o) => ({ ...o, name: RESOURCES[o.resource_id].name })),
  };
}

export function maxPosts(db) {
  return hasTech(db, 'trade_network') ? P.MAX_POSTS_NETWORK : P.MAX_POSTS;
}

export function listPosts(db) {
  return db.prepare('SELECT * FROM trading_posts ORDER BY id').all().map((p) => enrich(db, p));
}

export function getPostAt(db, planetId) {
  const p = db.prepare('SELECT * FROM trading_posts WHERE planet_id = ?').get(planetId);
  return p ? enrich(db, p) : null;
}

// ── Tick : exécution des ordres permanents ───────────────────────

const upsertStorage = `
  INSERT INTO post_storage (post_id, resource_id, quantity, avg_cost) VALUES (?, ?, ?, ?)
  ON CONFLICT(post_id, resource_id) DO UPDATE SET
    avg_cost = CASE WHEN excluded.quantity > 0 AND quantity + excluded.quantity > 0
      THEN ROUND((quantity * avg_cost + excluded.quantity * excluded.avg_cost)
        / (quantity + excluded.quantity), 2)
      ELSE avg_cost END,
    quantity = ROUND(quantity + excluded.quantity, 2)`;

export function tickTradingPosts(db, tick) {
  const posts = listPosts(db);
  if (posts.length === 0) return;
  const upsert = db.prepare(upsertStorage);
  const saveOrder = db.prepare('UPDATE post_orders SET last_qty = ?, last_price = ? WHERE id = ?');

  db.transaction(() => {
    for (const post of posts) {
      let used = post.used;
      let credits = getPlayer(db).credits;

      for (const o of post.orders) {
        const m = marketContext(db, post.planet_id, o.resource_id);
        let executed = 0;
        let price = 0;

        if (o.side === 'buy' && m.price <= o.limit_price && credits > 0) {
          // Borné par le débit, la place restante, le stock local et les
          // crédits (marge de 10 % contre le glissement de prix).
          const qty = Math.floor(Math.min(
            o.flow, post.cap - used, m.stock, credits / (m.price * 1.1)));
          if (qty >= 1) {
            const r = applyMarketTrade(db, post.planet_id, o.resource_id, qty, 'buy', m);
            adjustCredits(db, -r.total);
            recordTradeVolume(db, 'buy', qty);
            upsert.run(post.id, o.resource_id, qty, r.unitPrice);
            used += qty;
            credits -= r.total;
            executed = qty;
            price = r.unitPrice;
          }
        } else if (o.side === 'sell' && m.price >= o.limit_price) {
          const held = db.prepare(
            'SELECT quantity FROM post_storage WHERE post_id = ? AND resource_id = ?'
          ).get(post.id, o.resource_id)?.quantity ?? 0;
          const qty = Math.floor(Math.min(o.flow, held));
          if (qty >= 1) {
            const r = applyMarketTrade(db, post.planet_id, o.resource_id, qty, 'sell', m);
            adjustCredits(db, r.total);
            recordTradeVolume(db, 'sell', qty, r.total);
            upsert.run(post.id, o.resource_id, -qty, 0);
            used -= qty;
            credits += r.total;
            executed = qty;
            price = r.unitPrice;
          }
        }
        saveOrder.run(executed, price, o.id);
      }

      // Le comptoir télégraphie son marché : votre connaissance de cette
      // planète reste fraîche sans y envoyer de vaisseau.
      recordFullSnapshot(db, post.planet_id, tick);
    }
  })();
}

// ── Actions joueur ───────────────────────────────────────────────

// Ouvrir un comptoir sur la planète où le vaisseau est à quai.
export function buyPost(db, shipId) {
  const ship = getShip(db, shipId);
  if (!ship || ship.planet_id === null) return { ok: false, error: 'vaisseau en transit' };
  if (getPostAt(db, ship.planet_id)) return { ok: false, error: 'vous avez déjà un comptoir ici' };

  const planet = db.prepare('SELECT name, population FROM planets WHERE id = ?').get(ship.planet_id);
  const player = getPlayer(db);
  if (!hasTierAccess(player, tierOf(planet.population))) {
    return { ok: false, error: 'accès au marché requis (prestige ou licence) pour s\'y établir' };
  }

  const owned = db.prepare('SELECT COUNT(*) AS n FROM trading_posts').get().n;
  const max = maxPosts(db);
  if (owned >= max) {
    return { ok: false, error: `maximum ${max} comptoirs (Réseau de courtage pour aller plus loin)` };
  }
  const price = P.BASE_PRICE * 2 ** owned;
  if (player.credits < price) return { ok: false, error: `crédits insuffisants (${price} cr)` };

  let id;
  db.transaction(() => {
    adjustCredits(db, -price);
    id = db.prepare('INSERT INTO trading_posts (planet_id, level) VALUES (?, 1)')
      .run(ship.planet_id).lastInsertRowid;
    recordFullSnapshot(db, ship.planet_id, getCurrentTick(db));
  })();
  return { ok: true, id, price, planetName: planet.name };
}

export function upgradePost(db, postId) {
  const post = db.prepare('SELECT * FROM trading_posts WHERE id = ?').get(postId);
  if (!post) return { ok: false, error: 'comptoir inconnu' };
  const next = P.LEVELS[post.level];
  if (!next) return { ok: false, error: 'niveau maximum atteint' };
  if (getPlayer(db).credits < next.cost) return { ok: false, error: 'crédits insuffisants' };

  db.transaction(() => {
    adjustCredits(db, -next.cost);
    db.prepare('UPDATE trading_posts SET level = level + 1 WHERE id = ?').run(postId);
  })();
  return { ok: true, level: post.level + 1, cap: next.cap, flow: next.flow, cost: next.cost };
}

// Poser (ou remplacer) un ordre permanent. Un seul ordre par couple
// (ressource, sens) et par comptoir — reposer écrase l'ancien.
export function setPostOrder(db, postId, resourceId, side, limitPrice, flow) {
  const post = db.prepare('SELECT * FROM trading_posts WHERE id = ?').get(postId);
  if (!post) return { ok: false, error: 'comptoir inconnu' };
  if (!RESOURCES[resourceId]) return { ok: false, error: 'ressource inconnue' };
  if (side !== 'buy' && side !== 'sell') return { ok: false, error: 'sens invalide (buy/sell)' };
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) return { ok: false, error: 'limite de prix invalide' };
  const maxFlow = P.LEVELS[post.level - 1].flow;
  if (!Number.isFinite(flow) || flow < 1 || flow > maxFlow) {
    return { ok: false, error: `débit entre 1 et ${maxFlow}/tick (niveau du comptoir)` };
  }

  const existing = db.prepare(
    'SELECT id FROM post_orders WHERE post_id = ? AND resource_id = ? AND side = ?'
  ).get(postId, resourceId, side);
  const count = db.prepare('SELECT COUNT(*) AS n FROM post_orders WHERE post_id = ?').get(postId).n;
  if (!existing && count >= P.MAX_ORDERS) {
    return { ok: false, error: `maximum ${P.MAX_ORDERS} ordres par comptoir` };
  }

  if (existing) {
    db.prepare('UPDATE post_orders SET limit_price = ?, flow = ?, last_qty = 0, last_price = 0 WHERE id = ?')
      .run(limitPrice, flow, existing.id);
  } else {
    db.prepare(
      'INSERT INTO post_orders (post_id, resource_id, side, limit_price, flow) VALUES (?, ?, ?, ?, ?)'
    ).run(postId, resourceId, side, limitPrice, flow);
  }
  return {
    ok: true, resourceId, name: RESOURCES[resourceId].name, side, limitPrice, flow,
    replaced: Boolean(existing),
  };
}

export function deletePostOrder(db, postId, orderId) {
  const gone = db.prepare('DELETE FROM post_orders WHERE id = ? AND post_id = ?')
    .run(orderId, postId).changes;
  return gone ? { ok: true } : { ok: false, error: 'ordre inconnu' };
}

// Transferts soute ↔ entrepôt du comptoir (vaisseau à quai sur place).
export function transferPost(db, shipId, resourceId, quantity, direction) {
  const ship = getShip(db, shipId);
  const post = ship?.planet_id !== null ? getPostAt(db, ship.planet_id) : null;
  if (!post) return { ok: false, error: 'aucun comptoir à vous sur cette planète' };
  if (!RESOURCES[resourceId]) return { ok: false, error: 'ressource inconnue' };

  if (direction === 'deposit') {
    const cargo = getCargo(db, ship.id).find((c) => c.resource_id === resourceId);
    const moved = Math.round(Math.min(
      cargo?.quantity ?? 0, post.cap - post.used, quantity ?? Infinity) * 100) / 100;
    if (moved <= 0) {
      return { ok: false, error: post.cap - post.used <= 0 ? 'comptoir plein' : 'rien de tel en soute' };
    }
    db.transaction(() => {
      db.prepare('UPDATE ship_cargo SET quantity = ROUND(quantity - ?, 2) WHERE ship_id = ? AND resource_id = ?')
        .run(moved, ship.id, resourceId);
      db.prepare(upsertStorage).run(post.id, resourceId, moved, cargo.avg_cost);
    })();
    return { ok: true, moved, name: RESOURCES[resourceId].name, direction };
  }

  if (direction === 'withdraw') {
    const held = post.storage.find((s) => s.resource_id === resourceId);
    const space = ship.cargo_capacity - cargoUsed(db, ship.id);
    const moved = Math.round(Math.min(held?.quantity ?? 0, space, quantity ?? Infinity) * 100) / 100;
    if (moved <= 0) return { ok: false, error: space <= 0 ? 'soute pleine' : 'rien à charger' };
    db.transaction(() => {
      db.prepare(upsertStorage).run(post.id, resourceId, -moved, 0);
      db.prepare(
        `INSERT INTO ship_cargo (ship_id, resource_id, quantity, avg_cost) VALUES (?, ?, ?, ?)
         ON CONFLICT(ship_id, resource_id) DO UPDATE SET
           avg_cost = ROUND((quantity * avg_cost + excluded.quantity * excluded.avg_cost)
             / (quantity + excluded.quantity), 2),
           quantity = ROUND(quantity + excluded.quantity, 2)`
      ).run(ship.id, resourceId, moved, held.avg_cost);
    })();
    return { ok: true, moved, name: RESOURCES[resourceId].name, direction };
  }

  return { ok: false, error: 'direction invalide (deposit/withdraw)' };
}
