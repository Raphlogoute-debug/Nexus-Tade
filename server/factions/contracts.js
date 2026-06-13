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
import { getPlayer, getShip, adjustCredits, addPrestige, recordTradeVolume } from '../player/state.js';
import { warContext } from './war.js';
import { getStanding, adjustStanding } from './standing.js';
import { addSupport } from './influence.js';

const C = CONFIG.CONTRACTS;
const STRATEGIC = Object.keys(CONFIG.FLEET.BUILD);

export function tickContracts(db, tick) {
  // Expiration des contrats non honorés.
  db.prepare("UPDATE contracts SET status = 'expired' WHERE status = 'open' AND expires_tick <= ?")
    .run(tick);

  if (tick % C.EVERY_TICKS !== 0) return 0;

  const ctx = warContext(db);
  let created = 0;
  for (const f of db.prepare('SELECT id, capital_planet_id FROM factions').all()) {
    // En guerre : seuil plus nerveux, premium plus gras, plus de contrats —
    // l'effort de guerre achète à n'importe quel prix.
    const atWar = ctx.factionWar.has(f.id);
    const maxOpen = atWar ? C.WAR_MAX_OPEN : C.MAX_OPEN_PER_FACTION;
    const threshold = atWar ? C.WAR_PRESSURE : 0.4;
    const premium = atWar ? C.WAR_PREMIUM : C.PREMIUM;

    const open = db.prepare(
      "SELECT COUNT(*) AS n FROM contracts WHERE faction_id = ? AND status = 'open'"
    ).get(f.id).n;
    if (open >= maxOpen) continue;

    // La pénurie stratégique la plus criante à la capitale.
    let worst = null;
    for (const resourceId of STRATEGIC) {
      const m = marketContext(db, f.capital_planet_id, resourceId);
      const pressure = (m.target - m.stock) / m.target;
      if (pressure > threshold && (!worst || pressure > worst.pressure)) {
        worst = { resourceId, pressure, market: m };
      }
    }
    if (!worst) continue;

    const gap = worst.market.target - worst.market.stock;
    const quantity = Math.round(Math.min(600, Math.max(80, gap * 2)));
    const unitPrice = Math.round(worst.market.price * premium * 100) / 100;
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
  // Accord commercial : les seuils d'accès sont divisés par deux.
  const pact = Boolean(db.prepare(
    'SELECT 1 FROM faction_pacts WHERE faction_id = ?').get(factionId));
  const mult = pact ? CONFIG.PACTS.CONTRACT_REQ_MULT : 1;
  const prestigeReq = Math.ceil(C.PRESTIGE_REQUIRED * mult);
  const partnersReq = Math.ceil(C.PARTNERS_REQUIRED * mult);
  if (player.prestige < prestigeReq) {
    return { ok: false, error: `prestige ${prestigeReq} requis (vous : ${Math.floor(player.prestige)})` };
  }
  const partners = db.prepare(
    `SELECT COUNT(*) AS n FROM trade_partners tp
     JOIN planets p ON p.id = tp.planet_id
     JOIN systems s ON s.id = p.system_id
     WHERE s.faction_id = ?`
  ).get(factionId).n;
  if (partners < partnersReq) {
    return { ok: false, error: `${partnersReq} partenaires commerciaux requis dans la faction (vous : ${partners})` };
  }
  const standing = getStanding(db, factionId);
  if (standing < CONFIG.STANDING.CONTRACT_MIN) {
    return { ok: false, error: `réputation trop dégradée auprès de cette faction (${Math.round(standing)})` };
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
export function deliverContract(db, contractId, shipId) {
  const contract = db.prepare("SELECT * FROM contracts WHERE id = ? AND status = 'open'")
    .get(contractId);
  if (!contract) return { ok: false, error: 'contrat introuvable ou clos' };

  const player = getPlayer(db);
  const access = contractAccess(db, player, contract.faction_id);
  if (!access.ok) return access;

  const ship = getShip(db, shipId);
  if (!ship || ship.planet_id !== contract.deliver_planet_id) {
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
    recordTradeVolume(db, 'sell', delivered, paid);
    // Livrer un belligérant, c'est du revenu de guerre (score du profiteur).
    if (warContext(db).factionWar.has(contract.faction_id)) {
      db.prepare('UPDATE player SET war_profit = ROUND(war_profit + ?, 2) WHERE id = 1').run(paid);
      addSupport(db, contract.faction_id, (paid / 1000) * CONFIG.INFLUENCE.CONTRACT_PER_1000);
    }
    db.prepare(
      `UPDATE contracts SET remaining = ROUND(remaining - ?, 2),
        status = CASE WHEN remaining - ? <= 0 THEN 'done' ELSE 'open' END WHERE id = ?`
    ).run(delivered, delivered, contractId);
    if (done) addPrestige(db, C.COMPLETION_PRESTIGE);

    // Réputation : livrer l'effort de guerre engage — et l'ennemi le saura.
    const ctx = warContext(db);
    const enemyId = ctx.enemyOf(contract.faction_id);
    if (enemyId !== null) {
      const gain = delivered * CONFIG.STANDING.STRATEGIC_PER_UNIT;
      adjustStanding(db, contract.faction_id, gain);
      adjustStanding(db, enemyId, -gain * CONFIG.STANDING.ENEMY_LEAK);
    }
    if (done) adjustStanding(db, contract.faction_id, CONFIG.STANDING.CONTRACT_BONUS);
  })();

  return {
    ok: true, delivered, paid, done,
    prestigeGained: done ? C.COMPLETION_PRESTIGE : 0,
    credits: getPlayer(db).credits,
  };
}
