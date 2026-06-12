// Clients réguliers : des planètes civiles en manque durable proposent
// des contrats d'approvisionnement à PRIX FIXÉ à la signature — immunisé
// au glissement : votre propre livraison n'écrase pas votre prix. C'est
// la relation commerciale récurrente : un client honoré se fidélise et
// revient avec des volumes plus gros et de meilleures primes. Le cœur du
// métier de fournisseur — l'empire, ce sont des débouchés fidèles.

import { CONFIG } from '../config.js';
import { RESOURCES } from '../../data/resources.js';
import { getCurrentTick } from '../db.js';
import { getPlayer, getShip, getCargo, adjustCredits, addPrestige, tierOf, hasTierAccess, recordTradeVolume } from '../player/state.js';
import { marketContext } from './market.js';
import { nextPrice, targetStock } from './pricing.js';
import { resourceDemand } from './engine.js';
import { logEvent } from '../events.js';

const C = CONFIG.CLIENTS;

// ── Lecture ──────────────────────────────────────────────────────

function enrich(db, sc) {
  const planet = db.prepare(
    `SELECT p.name, p.system_id, s.name AS system_name FROM planets p
     JOIN systems s ON s.id = p.system_id WHERE p.id = ?`
  ).get(sc.planet_id);
  return {
    ...sc,
    resourceName: RESOURCES[sc.resource_id].name,
    planetName: planet.name,
    systemId: planet.system_id,
    loyalty: loyaltyOf(db, sc.planet_id).level,
  };
}

export function loyaltyOf(db, planetId) {
  return db.prepare('SELECT * FROM client_loyalty WHERE planet_id = ?').get(planetId)
    ?? { planet_id: planetId, level: 0, completed: 0 };
}

export function listSupplyContracts(db, status = null) {
  const rows = status
    ? db.prepare('SELECT * FROM supply_contracts WHERE status = ? ORDER BY id').all(status)
    : db.prepare("SELECT * FROM supply_contracts WHERE status IN ('open', 'taken') ORDER BY id").all();
  return rows.map((sc) => enrich(db, sc));
}

export function contractsAt(db, planetId) {
  return db.prepare(
    "SELECT * FROM supply_contracts WHERE planet_id = ? AND status IN ('open', 'taken') ORDER BY id"
  ).all(planetId).map((sc) => enrich(db, sc));
}

// ── Tick : génération et expiration des offres ───────────────────

export function tickClients(db, tick) {
  if (tick % C.CHECK_EVERY !== 0) return;

  // Expirations : offres non signées et contrats non honorés à temps.
  for (const sc of db.prepare(
    "SELECT * FROM supply_contracts WHERE status IN ('open', 'taken') AND expires_tick <= ?"
  ).all(tick)) {
    db.prepare("UPDATE supply_contracts SET status = 'expired' WHERE id = ?").run(sc.id);
    if (sc.status === 'taken') {
      // Un client lâché retombe d'un niveau de fidélité.
      db.prepare(
        'UPDATE client_loyalty SET level = MAX(0, level - 1) WHERE planet_id = ?'
      ).run(sc.planet_id);
      const p = db.prepare('SELECT name FROM planets WHERE id = ?').get(sc.planet_id);
      logEvent(db, tick, 'client',
        `CLIENT — ${p.name} attend toujours ses ${RESOURCES[sc.resource_id].name} : contrat rompu, confiance entamée`);
    }
  }

  const open = db.prepare(
    "SELECT COUNT(*) AS n FROM supply_contracts WHERE status = 'open'").get().n;
  if (open >= C.MAX_OPEN) return;

  // Pénuries civiles durables : un échantillon de planètes, les manques
  // les plus criants d'abord. Les clients fidèles repassent commande en
  // priorité.
  // Les stocks les plus bas d'abord (les clients fidèles passent devant) :
  // les offres visent les planètes qui ont vraiment faim.
  const candidates = db.prepare(
    `SELECT pr.planet_id, pr.resource_id, pr.stock, pr.price, pr.consumption,
            p.population, COALESCE(cl.level, 0) AS loyalty
     FROM planet_resources pr
     JOIN planets p ON p.id = pr.planet_id
     LEFT JOIN client_loyalty cl ON cl.planet_id = pr.planet_id
     WHERE pr.resource_id IN (${C.RESOURCES.map(() => '?').join(',')})
       AND pr.planet_id NOT IN (
         SELECT planet_id FROM supply_contracts WHERE status IN ('open', 'taken'))
     ORDER BY COALESCE(cl.level, 0) DESC, pr.stock ASC LIMIT 80`
  ).all(...C.RESOURCES);

  let spawned = 0;
  const scored = [];
  for (const c of candidates) {
    const industries = db.prepare(
      'SELECT recipe_id, rate FROM planet_industries WHERE planet_id = ?').all(c.planet_id);
    const target = targetStock(resourceDemand(c.resource_id, c.consumption, industries));
    if (target <= 0 || c.stock / target > C.PRESSURE_MIN) continue;
    scored.push({ ...c, pressure: 1 - c.stock / target });
  }
  scored.sort((a, b) => (b.loyalty - a.loyalty) || (b.pressure - a.pressure));

  for (const c of scored) {
    if (open + spawned >= C.MAX_OPEN) break;
    const premium = Math.min(C.PREMIUM_MAX, C.PREMIUM + c.loyalty * C.PREMIUM_PER_LOYALTY);
    const qty = Math.round(C.QTY_BASE * (0.6 + Math.min(2, c.population / 100))
      * (1 + c.loyalty * C.QTY_PER_LOYALTY));
    const unitPrice = Math.round(c.price * premium * 100) / 100;
    db.prepare(
      `INSERT INTO supply_contracts
         (planet_id, resource_id, quantity, remaining, unit_price, status, created_tick, expires_tick)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
    ).run(c.planet_id, c.resource_id, qty, qty, unitPrice, tick, tick + C.OFFER_TTL);
    spawned++;

    // Les clients fidèles vous préviennent personnellement.
    if (c.loyalty > 0) {
      const p = db.prepare('SELECT name FROM planets WHERE id = ?').get(c.planet_id);
      logEvent(db, tick, 'client',
        `CLIENT — ${p.name} repasse commande : ${qty} ${RESOURCES[c.resource_id].name}`
        + ` à ${unitPrice} cr/u (fidélité ${c.loyalty})`);
    }
  }
}

// ── Actions joueur ───────────────────────────────────────────────

export function acceptSupplyContract(db, contractId) {
  const sc = db.prepare("SELECT * FROM supply_contracts WHERE id = ? AND status = 'open'")
    .get(contractId);
  if (!sc) return { ok: false, error: 'offre introuvable ou déjà signée' };
  const taken = db.prepare(
    "SELECT COUNT(*) AS n FROM supply_contracts WHERE status = 'taken'").get().n;
  if (taken >= C.MAX_TAKEN) {
    return { ok: false, error: `maximum ${C.MAX_TAKEN} contrats clients en cours` };
  }
  const planet = db.prepare('SELECT name, population FROM planets WHERE id = ?')
    .get(sc.planet_id);
  if (!hasTierAccess(getPlayer(db), tierOf(planet.population))) {
    return { ok: false, error: 'marché inaccessible (prestige ou licence)' };
  }

  const tick = getCurrentTick(db);
  db.prepare(
    "UPDATE supply_contracts SET status = 'taken', expires_tick = ? WHERE id = ?"
  ).run(tick + C.CONTRACT_TTL, contractId);
  return {
    ok: true, id: contractId, planetName: planet.name,
    resourceName: RESOURCES[sc.resource_id].name,
    quantity: sc.quantity, unitPrice: sc.unit_price,
    deadline: tick + C.CONTRACT_TTL,
  };
}

// Livraison depuis la soute, vaisseau à quai chez le client. Le prix est
// CELUI DU CONTRAT — la marchandise entre quand même sur le marché local
// (le manque se comble réellement).
export function deliverSupplyContract(db, contractId, shipId) {
  const sc = db.prepare("SELECT * FROM supply_contracts WHERE id = ? AND status = 'taken'")
    .get(contractId);
  if (!sc) return { ok: false, error: 'contrat introuvable ou non signé' };
  const ship = getShip(db, shipId);
  if (!ship || ship.planet_id !== sc.planet_id) {
    return { ok: false, error: 'amarrez un vaisseau chez le client pour livrer' };
  }
  const cargo = getCargo(db, ship.id).find((l) => l.resource_id === sc.resource_id);
  if (!cargo || cargo.quantity <= 0) {
    return { ok: false, error: `aucun ${RESOURCES[sc.resource_id].name} en soute` };
  }

  const delivered = Math.min(cargo.quantity, sc.remaining);
  const paid = Math.round(delivered * sc.unit_price * 100) / 100;
  const done = delivered >= sc.remaining;
  const tick = getCurrentTick(db);
  const planetName = db.prepare('SELECT name FROM planets WHERE id = ?').get(sc.planet_id).name;

  db.transaction(() => {
    db.prepare(
      'UPDATE ship_cargo SET quantity = ROUND(quantity - ?, 2) WHERE ship_id = ? AND resource_id = ?'
    ).run(delivered, ship.id, sc.resource_id);

    // La marchandise comble le marché (prix détendu d'un pas de lissage).
    const m = marketContext(db, sc.planet_id, sc.resource_id);
    const newStock = Math.round((m.stock + delivered) * 100) / 100;
    db.prepare(
      'UPDATE planet_resources SET stock = ?, price = ? WHERE planet_id = ? AND resource_id = ?'
    ).run(newStock,
      nextPrice({ basePrice: m.basePrice, stock: newStock, target: m.target, previousPrice: m.price }),
      sc.planet_id, sc.resource_id);

    adjustCredits(db, paid);
    recordTradeVolume(db, 'sell', delivered, paid);
    db.prepare(
      `UPDATE supply_contracts SET remaining = ROUND(remaining - ?, 2),
         status = CASE WHEN remaining - ? <= 0 THEN 'done' ELSE 'taken' END WHERE id = ?`
    ).run(delivered, delivered, contractId);

    if (done) {
      addPrestige(db, C.PRESTIGE_DONE);
      db.prepare(
        `INSERT INTO client_loyalty (planet_id, level, completed) VALUES (?, 1, 1)
         ON CONFLICT(planet_id) DO UPDATE SET level = level + 1, completed = completed + 1`
      ).run(sc.planet_id);
      logEvent(db, tick, 'client',
        `CLIENT SERVI — ${planetName} honoré (+${C.PRESTIGE_DONE} prestige) : la maison gagne un fidèle`);
    }
  })();

  return {
    ok: true, delivered, paid, done,
    loyalty: loyaltyOf(db, sc.planet_id).level,
    planetName, resourceName: RESOURCES[sc.resource_id].name,
  };
}
