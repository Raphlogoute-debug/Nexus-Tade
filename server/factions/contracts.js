// Contrats de faction (tier 4) : traiter avec le royaume lui-même.
// Quand la capitale manque durablement d'une ressource stratégique, la
// faction publie un appel d'offres : gros volume, prix premium, livraison
// à la capitale. Accessibles aux marchands établis : prestige élevé ET
// partenaires commerciaux dans la faction.

import { CONFIG } from '../config.js';
import { RESOURCES } from '../../data/resources.js';
import { marketContext } from '../economy/market.js';
import { nextPrice } from '../economy/pricing.js';
import { getCurrentTick } from '../db.js';
import { getPlayer, getShip, adjustCredits, addPrestige } from '../player/state.js';

const C = CONFIG.CONTRACTS;
const STRATEGIC = Object.keys(CONFIG.FLEET.BUILD);

export function tickContracts(db, tick) {
  // Expiration des contrats non honorés.
  db.prepare("UPDATE contracts SET status = 'expired' WHERE status = 'open' AND expires_tick <= ?")
    .run(tick);

  if (tick % C.EVERY_TICKS !== 0) return 0;

  let created = 0;
  for (const f of db.prepare('SELECT id, capital_planet_id FROM factions').all()) {
    const open = db.prepare(
      "SELECT COUNT(*) AS n FROM contracts WHERE faction_id = ? AND status = 'open'"
    ).get(f.id).n;
    if (open >= C.MAX_OPEN_PER_FACTION) continue;

    // La pénurie stratégique la plus criante à la capitale.
    let worst = null;
    for (const resourceId of STRATEGIC) {
      const m = marketContext(db, f.capital_planet_id, resourceId);
      const pressure = (m.target - m.stock) / m.target;
      if (pressure > 0.4 && (!worst || pressure > worst.pressure)) {
        worst = { resourceId, pressure, market: m };
      }
    }
    if (!worst) continue;

    const gap = worst.market.target - worst.market.stock;
    const quantity = Math.round(Math.min(600, Math.max(80, gap * 2)));
    const unitPrice = Math.round(worst.market.price * C.PREMIUM * 100) / 100;
    db.prepare(
      `INSERT INTO contracts (faction_id, resource_id, quantity, remaining, unit_price,
        deliver_planet_id, expires_tick) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(f.id, worst.resourceId, quantity, quantity, unitPrice,
      f.capital_planet_id, tick + C.EXPIRY);
    created++;
  }
  return created;
}

// Le joueur a-t-il ses entrées auprès de cette faction ?
export function contractAccess(db, player, factionId) {
  if (player.prestige < C.PRESTIGE_REQUIRED) {
    return { ok: false, error: `prestige ${C.PRESTIGE_REQUIRED} requis (vous : ${Math.floor(player.prestige)})` };
  }
  const partners = db.prepare(
    `SELECT COUNT(*) AS n FROM trade_partners tp
     JOIN planets p ON p.id = tp.planet_id
     JOIN systems s ON s.id = p.system_id
     WHERE s.faction_id = ?`
  ).get(factionId).n;
  if (partners < C.PARTNERS_REQUIRED) {
    return { ok: false, error: `${C.PARTNERS_REQUIRED} partenaires commerciaux requis dans la faction (vous : ${partners})` };
  }
  return { ok: true, partners };
}

export function listContracts(db) {
  return db.prepare(
    `SELECT c.*, f.name AS faction_name, f.color AS faction_color, p.name AS deliver_planet_name
     FROM contracts c
     JOIN factions f ON f.id = c.faction_id
     JOIN planets p ON p.id = c.deliver_planet_id
     WHERE c.status = 'open' ORDER BY c.expires_tick`
  ).all().map((c) => ({ ...c, resourceName: RESOURCES[c.resource_id].name }));
}

// Livraison (partielle ou totale) depuis la soute, à quai au point de
// livraison. Payée au prix du contrat ; le stock livré entre sur le marché
// de la capitale (et nourrit donc directement le chantier naval).
export function deliverContract(db, contractId) {
  const contract = db.prepare("SELECT * FROM contracts WHERE id = ? AND status = 'open'")
    .get(contractId);
  if (!contract) return { ok: false, error: 'contrat introuvable ou clos' };

  const player = getPlayer(db);
  const access = contractAccess(db, player, contract.faction_id);
  if (!access.ok) return access;

  const ship = getShip(db);
  if (ship.planet_id !== contract.deliver_planet_id) {
    return { ok: false, error: 'il faut être à quai au point de livraison' };
  }
  const cargo = db.prepare(
    'SELECT quantity FROM ship_cargo WHERE ship_id = ? AND resource_id = ?'
  ).get(ship.id, contract.resource_id);
  if (!cargo || cargo.quantity <= 0) {
    return { ok: false, error: `aucun ${RESOURCES[contract.resource_id].name} en soute` };
  }

  const delivered = Math.min(cargo.quantity, contract.remaining);
  const paid = Math.round(delivered * contract.unit_price * 100) / 100;
  const done = delivered >= contract.remaining;

  db.transaction(() => {
    db.prepare(
      'UPDATE ship_cargo SET quantity = ROUND(quantity - ?, 2) WHERE ship_id = ? AND resource_id = ?'
    ).run(delivered, ship.id, contract.resource_id);

    // La marchandise entre sur le marché de la capitale ; le prix s'y
    // détend d'un pas de lissage, comme pour n'importe quel afflux.
    const m = marketContext(db, contract.deliver_planet_id, contract.resource_id);
    const newStock = Math.round((m.stock + delivered) * 100) / 100;
    db.prepare(
      'UPDATE planet_resources SET stock = ?, price = ? WHERE planet_id = ? AND resource_id = ?'
    ).run(newStock,
      nextPrice({ basePrice: m.basePrice, stock: newStock, target: m.target, previousPrice: m.price }),
      contract.deliver_planet_id, contract.resource_id);

    adjustCredits(db, paid);
    db.prepare(
      `UPDATE contracts SET remaining = ROUND(remaining - ?, 2),
        status = CASE WHEN remaining - ? <= 0 THEN 'done' ELSE 'open' END WHERE id = ?`
    ).run(delivered, delivered, contractId);
    if (done) addPrestige(db, C.COMPLETION_PRESTIGE);
  })();

  return {
    ok: true, delivered, paid, done,
    prestigeGained: done ? C.COMPLETION_PRESTIGE : 0,
    credits: getPlayer(db).credits,
  };
}
