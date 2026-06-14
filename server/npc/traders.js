// Marchands indépendants : la couche « agents pleins » de la simulation
// pyramidale. Chacun fait le métier du joueur — acheter bas, voyager,
// vendre haut — sur les mêmes marchés et avec le même impact prix
// (economy/market.js). Ils resserrent les écarts de prix, disputent les
// arbitrages au joueur, et comblent (partiellement) les approvisionnements
// qu'un fournisseur dominant viendrait à couper.
//
// IA volontairement simple : un marchand ne connaît que sa région
// (SCAN_RADIUS), décide une fois par tick quand il est à quai, et vend
// toujours sa cargaison au meilleur marché atteignable.

import { CONFIG } from '../config.js';
import { RESOURCE_IDS } from '../../data/resources.js';
import { createRng } from '../universe/rng.js';
import { getMeta } from '../db.js';
import { applyMarketTrade } from '../economy/market.js';

const T = CONFIG.TRADERS;
const CALLSIGNS = ['Kestrel', 'Vagrant', 'Mirage', 'Sirocco', 'Pélican', 'Corsaire',
  'Albatros', 'Comète', 'Zéphyr', 'Mistral', 'Boussole', 'Hirondelle'];

export function initTraders(db) {
  const systems = db.prepare('SELECT COUNT(*) AS n FROM systems').get().n;
  const planets = db.prepare('SELECT id FROM planets').all();
  const rng = createRng((Number(getMeta(db, 'seed')) ^ 0x7e4d11) >>> 0);
  const count = Math.floor(systems / T.PER_SYSTEMS);

  const insert = db.prepare(
    'INSERT INTO traders (name, planet_id, credits) VALUES (?, ?, ?)'
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run(`${rng.pick(CALLSIGNS)}-${i + 1}`, rng.pick(planets).id, T.START_CREDITS);
    }
  })();
  return { traders: count };
}

// Les voisinages stellaires sont statiques : la liste des planètes à
// portée d'un système (avec leur distance) se calcule une fois et se
// garde en mémoire. Le scan d'un marchand devient une simple lecture de
// planet_resources sur une liste d'ids.
function neighborsOf(db, systemId) {
  if (!db.__traderNeighbors) db.__traderNeighbors = new Map();
  let cached = db.__traderNeighbors.get(systemId);
  if (!cached) {
    cached = db.prepare(
      `SELECT p.id AS planet_id,
              SQRT((s2.x - me.x) * (s2.x - me.x) + (s2.y - me.y) * (s2.y - me.y)) AS dist
       FROM planets p
       JOIN systems s2 ON s2.id = p.system_id
       JOIN systems me ON me.id = ?
       WHERE (s2.x - me.x) * (s2.x - me.x) + (s2.y - me.y) * (s2.y - me.y) <= ?`
    ).all(systemId, T.SCAN_RADIUS ** 2);
    db.__traderNeighbors.set(systemId, cached);
  }
  return cached;
}

// Marchés (toutes ressources) des planètes à portée d'un système donné.
function marketsInRange(db, systemId) {
  const neighbors = neighborsOf(db, systemId);
  const distOf = new Map(neighbors.map((n) => [n.planet_id, n.dist]));
  // Les ids viennent de notre propre base : inlining sans risque, et la
  // requête (une par système) reste en cache de préparation.
  const rows = db.prepare(
    `SELECT planet_id, resource_id, stock, price FROM planet_resources
     WHERE planet_id IN (${neighbors.map((n) => n.planet_id).join(',')})`
  ).all();
  for (const r of rows) r.dist = distOf.get(r.planet_id);
  return rows;
}

export function tickTraders(db, tick) {
  // 1. Arrivées
  db.prepare(
    `UPDATE traders SET planet_id = dest_planet_id, dest_planet_id = NULL, arrival_tick = NULL
     WHERE planet_id IS NULL AND arrival_tick <= ?`
  ).run(tick);

  // 2. Décisions des marchands à quai
  const docked = db.prepare('SELECT * FROM traders WHERE planet_id IS NOT NULL').all();
  if (docked.length === 0) return;

  const systemOf = db.prepare('SELECT system_id FROM planets WHERE id = ?');
  const depart = db.prepare(
    `UPDATE traders SET planet_id = NULL, from_planet_id = ?, departure_tick = ?,
     dest_planet_id = ?, arrival_tick = ?, credits = ROUND(MAX(0, credits - ?), 2) WHERE id = ?`
  );
  const saveCargo = db.prepare(
    'UPDATE traders SET credits = ?, cargo_resource = ?, cargo_qty = ?, cargo_cost = ?, trades_done = trades_done + 1 WHERE id = ?'
  );

  // Le scan régional est ce qui coûte : il est partagé entre marchands du
  // même système, et chaque marchand ne délibère qu'un tick sur deux
  // (décalés par id — personne ne remarque qu'un capitaine réfléchit 10 s).
  const scanCache = new Map();
  const scanFor = (systemId) => {
    if (!scanCache.has(systemId)) scanCache.set(systemId, marketsInRange(db, systemId));
    return scanCache.get(systemId);
  };

  for (const trader of docked) {
    if ((tick + trader.id) % 2 !== 0) continue;
    const systemId = systemOf.get(trader.planet_id).system_id;
    const markets = scanFor(systemId);
    const dist = (m) => m.dist;

    if (trader.cargo_qty > 0) {
      // Vendre : au meilleur marché atteignable, ici si c'est ici.
      const candidates = markets.filter((m) => m.resource_id === trader.cargo_resource);
      const best = candidates.sort((a, b) => b.price - a.price)[0];
      const here = candidates.find((m) => m.planet_id === trader.planet_id);

      const extraElsewhere = best && best.planet_id !== trader.planet_id
        ? (best.price - here.price) * trader.cargo_qty - dist(best) * T.MOVE_COST_PER_DIST
        : -1;

      if (extraElsewhere > 0) {
        depart.run(trader.planet_id, tick, best.planet_id, tick + travelTicks(dist(best)),
          dist(best) * T.MOVE_COST_PER_DIST, trader.id);
      } else {
        const sale = applyMarketTrade(db, trader.planet_id, trader.cargo_resource,
          trader.cargo_qty, 'sell');
        saveCargo.run(Math.round((trader.credits + sale.total) * 100) / 100,
          null, 0, 0, trader.id);
      }
      continue;
    }

    // Acheter : la meilleure paire (ressource locale bon marché → marché
    // cher à portée), si la marge nette dépasse le seuil.
    const local = new Map();
    for (const m of markets) {
      if (m.planet_id === trader.planet_id) local.set(m.resource_id, m);
    }
    let best = null;
    for (const resourceId of RESOURCE_IDS) {
      const here = local.get(resourceId);
      if (!here || here.stock < 20) continue;
      // Marge pour le glissement de prix (×1,1, comme les rivaux) : sans
      // elle, le coût réel peut dépasser la trésorerie et la dette est
      // ensuite silencieusement effacée (création de monnaie).
      const qty = Math.floor(Math.min(
        T.CAPACITY, here.stock * T.MAX_BUY_SHARE, trader.credits / (here.price * 1.1)));
      if (qty < 5) continue;

      for (const m of markets) {
        if (m.resource_id !== resourceId || m.planet_id === trader.planet_id) continue;
        if ((m.price - here.price) / here.price < T.MIN_MARGIN) continue;
        const profit = (m.price - here.price) * qty - dist(m) * T.MOVE_COST_PER_DIST;
        if (profit > 0 && (!best || profit > best.profit)) {
          best = { resourceId, qty, dest: m, profit, here };
        }
      }
    }

    if (best) {
      const buy = applyMarketTrade(db, trader.planet_id, best.resourceId, best.qty, 'buy');
      // On enregistre la quantité RÉELLEMENT achetée (bornée au stock du
      // moment, scan en cache pouvant être périmé) — pas de cargaison fantôme.
      saveCargo.run(Math.round((trader.credits - buy.total) * 100) / 100,
        best.resourceId, buy.quantity, buy.unitPrice, trader.id);
      const d = dist(best.dest);
      depart.run(trader.planet_id, tick, best.dest.planet_id, tick + travelTicks(d),
        d * T.MOVE_COST_PER_DIST, trader.id);
    } else if (Math.random() < 0.35) {
      // Rien d'intéressant ici : on va voir ailleurs.
      const elsewhere = markets.filter((m) => m.planet_id !== trader.planet_id);
      if (elsewhere.length > 0) {
        const target = elsewhere[Math.floor(Math.random() * elsewhere.length)];
        const d = dist(target);
        depart.run(trader.planet_id, tick, target.planet_id, tick + travelTicks(d),
          d * T.MOVE_COST_PER_DIST, trader.id);
      }
    }
  }
}

function travelTicks(distance) {
  return Math.max(1, Math.ceil(distance / T.SPEED));
}
