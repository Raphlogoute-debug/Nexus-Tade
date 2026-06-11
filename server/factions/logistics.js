// Logistique interne des factions : des convois équilibrent les marchés
// membres (flux statistiques — un convoi représente N cargos, pas des
// vaisseaux simulés un à un, cf. simulation pyramidale).
//
// À chaque planification : pour chaque faction, on apparie les pires
// déficits avec les meilleurs surplus de la même ressource. Le stock part
// immédiatement de l'origine et n'arrive à destination qu'après le délai
// de route — pendant ce temps il est « en mer », interceptable plus tard
// (blocus, piraterie, guerre).

import { CONFIG } from '../config.js';
import { targetStock } from '../economy/pricing.js';
import { resourceDemand } from '../economy/engine.js';
import { warContext } from './war.js';

const FL = CONFIG.FLOWS;

export function planShipments(db, tick) {
  if (tick % FL.EVERY_TICKS !== 0) return 0;

  // Marchés de toutes les planètes affiliées, avec leur pression de stock.
  const rows = db.prepare(
    `SELECT pr.planet_id, pr.resource_id, pr.stock, pr.consumption,
            s.faction_id, s.x, s.y
     FROM planet_resources pr
     JOIN planets p ON p.id = pr.planet_id
     JOIN systems s ON s.id = p.system_id
     WHERE s.faction_id IS NOT NULL`
  ).all();

  const industriesByPlanet = new Map();
  for (const i of db.prepare('SELECT planet_id, recipe_id, rate FROM planet_industries').all()) {
    (industriesByPlanet.get(i.planet_id) ?? industriesByPlanet.set(i.planet_id, []).get(i.planet_id)).push(i);
  }

  // pression = (cible - stock) / cible : > 0 manque, < 0 surplus.
  const byFaction = new Map();
  for (const r of rows) {
    const target = targetStock(
      resourceDemand(r.resource_id, r.consumption, industriesByPlanet.get(r.planet_id) ?? []));
    r.target = target;
    r.pressure = (target - r.stock) / target;
    if (!byFaction.has(r.faction_id)) byFaction.set(r.faction_id, []);
    byFaction.get(r.faction_id).push(r);
  }

  const takeStock = db.prepare(
    'UPDATE planet_resources SET stock = ROUND(stock - ?, 2) WHERE planet_id = ? AND resource_id = ?'
  );
  const insertShipment = db.prepare(
    `INSERT INTO shipments (faction_id, resource_id, quantity, from_planet_id, to_planet_id, departure_tick, arrival_tick)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  let created = 0;
  db.transaction(() => {
    for (const [factionId, markets] of byFaction) {
      const deficits = markets.filter((m) => m.pressure > FL.DEFICIT_PRESSURE)
        .sort((a, b) => b.pressure - a.pressure);

      let sent = 0;
      for (const need of deficits) {
        if (sent >= FL.MAX_PER_PLANNING) break;
        // Meilleur fournisseur : le plus gros surplus de la même ressource.
        const source = markets
          .filter((m) => m.resource_id === need.resource_id
            && m.planet_id !== need.planet_id && m.pressure < FL.SURPLUS_PRESSURE)
          .sort((a, b) => a.pressure - b.pressure)[0];
        if (!source) continue;

        const qty = Math.round(Math.min(
          FL.MAX_QTY,
          (source.stock - source.target) * FL.SHARE,
          need.target - need.stock,
        ));
        if (qty < 5) continue;

        const dist = Math.hypot(source.x - need.x, source.y - need.y);
        takeStock.run(qty, source.planet_id, source.resource_id);
        source.stock -= qty; // pour ne pas re-promettre le même surplus
        insertShipment.run(factionId, need.resource_id, qty,
          source.planet_id, need.planet_id,
          tick, tick + Math.max(1, Math.ceil(dist / FL.SPEED)));
        sent++;
        created++;
      }
    }
  })();

  return created;
}

// Livraison des convois arrivés à destination. En temps de guerre, les
// convois d'un belligérant qui touchent un système de front risquent
// l'interception : la cargaison est perdue — c'est ainsi qu'un blocus
// affame une capitale.
export function processShipmentArrivals(db, tick, ctx = warContext(db)) {
  const arrived = db.prepare('SELECT * FROM shipments WHERE arrival_tick <= ?').all(tick);
  if (arrived.length === 0) return { delivered: 0, raided: 0 };

  const addStock = db.prepare(
    'UPDATE planet_resources SET stock = ROUND(stock + ?, 2) WHERE planet_id = ? AND resource_id = ?'
  );
  const systemOf = db.prepare('SELECT system_id FROM planets WHERE id = ?');

  let raided = 0;
  db.transaction(() => {
    for (const s of arrived) {
      const atWar = ctx.factionWar.has(s.faction_id);
      const touchesFront = atWar && (
        ctx.frontSystems.has(systemOf.get(s.from_planet_id).system_id)
        || ctx.frontSystems.has(systemOf.get(s.to_planet_id).system_id));
      if (touchesFront && Math.random() < CONFIG.WAR.RAID_CHANCE) {
        raided++;
        continue; // convoi intercepté, rien n'arrive
      }
      addStock.run(s.quantity, s.to_planet_id, s.resource_id);
    }
    db.prepare('DELETE FROM shipments WHERE arrival_tick <= ?').run(tick);
  })();

  return { delivered: arrived.length - raided, raided };
}
