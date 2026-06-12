// Grands chantiers : les mégaprojets des factions. Une capitale lance une
// Porte de saut, une Station-monde, une Arche — et publie un programme
// d'achat MASSIF à prix garanti (base × premium, fixé au lancement).
// C'est le débouché des Léviathans et des concessions niveau 6 : des
// dizaines de milliers d'unités par poste. Le chantier absorbe aussi un
// filet depuis son propre marché : il finira sans vous — lentement. Le
// plus gros contributeur (si sa part dépasse le seuil) entre dans la
// légende : prestige, réputation, et la capitale grandit.

import { CONFIG } from '../config.js';
import { RESOURCES } from '../../data/resources.js';
import { getPlayer, getShip, getCargo, adjustCredits, addPrestige, recordTradeVolume } from '../player/state.js';
import { adjustStanding } from '../factions/standing.js';
import { logEvent } from '../events.js';

const M = CONFIG.MEGAPROJECTS;

export function listMegaprojects(db, status = 'active') {
  return db.prepare(
    `SELECT mp.*, f.name AS faction_name, f.color AS faction_color,
            f.capital_planet_id, p.name AS capital_name, p.system_id AS capital_system_id
     FROM megaprojects mp
     JOIN factions f ON f.id = mp.faction_id
     JOIN planets p ON p.id = f.capital_planet_id
     WHERE mp.status = ? ORDER BY mp.id DESC`
  ).all(status).map((mp) => ({
    ...mp,
    needs: db.prepare(
      'SELECT * FROM megaproject_needs WHERE project_id = ? ORDER BY resource_id'
    ).all(mp.id).map((n) => ({ ...n, resourceName: RESOURCES[n.resource_id].name })),
  }));
}

export function tickMegaprojects(db, tick) {
  // 1. Absorption du filet local + complétion + expiration.
  for (const mp of listMegaprojects(db)) {
    let allDone = true;
    for (const need of mp.needs) {
      if (need.delivered >= need.required) continue;
      // Le chantier ponctionne son propre marché (part du stock, bornée).
      const m = db.prepare(
        'SELECT stock FROM planet_resources WHERE planet_id = ? AND resource_id = ?'
      ).get(mp.capital_planet_id, need.resource_id);
      const take = Math.min(
        Math.floor(m.stock * M.SELF_SUPPLY),
        need.required - need.delivered);
      if (take > 0) {
        db.prepare(
          'UPDATE planet_resources SET stock = ROUND(stock - ?, 2) WHERE planet_id = ? AND resource_id = ?'
        ).run(take, mp.capital_planet_id, need.resource_id);
        db.prepare(
          'UPDATE megaproject_needs SET delivered = ROUND(delivered + ?, 2) WHERE project_id = ? AND resource_id = ?'
        ).run(take, mp.id, need.resource_id);
        need.delivered += take;
      }
      if (need.delivered < need.required) allDone = false;
    }

    if (allDone) {
      completeProject(db, mp, tick);
    } else if (tick >= mp.expires_tick) {
      db.prepare("UPDATE megaprojects SET status = 'abandoned' WHERE id = ?").run(mp.id);
      logEvent(db, tick, 'megaproject',
        `GRAND CHANTIER ABANDONNÉ — ${mp.name} de ${mp.faction_name} : les caisses sont vides`);
    }
  }

  // 2. Lancements.
  if (tick % M.CHECK_EVERY !== 0) return;
  const active = db.prepare(
    "SELECT COUNT(*) AS n FROM megaprojects WHERE status = 'active'").get().n;
  if (active >= M.MAX_ACTIVE || Math.random() >= M.SPAWN_CHANCE) return;

  const factions = db.prepare(
    `SELECT f.* FROM factions f WHERE f.id NOT IN (
       SELECT faction_id FROM megaprojects WHERE status = 'active')`
  ).all();
  if (factions.length === 0) return;
  const faction = factions[Math.floor(Math.random() * factions.length)];
  const type = M.TYPES[Math.floor(Math.random() * M.TYPES.length)];

  const id = db.prepare(
    `INSERT INTO megaprojects (faction_id, type_id, name, started_tick, expires_tick)
     VALUES (?, ?, ?, ?, ?)`
  ).run(faction.id, type.id, type.name, tick, tick + M.EXPIRES).lastInsertRowid;
  for (const [resourceId, required] of Object.entries(type.needs)) {
    db.prepare(
      `INSERT INTO megaproject_needs (project_id, resource_id, required, unit_price)
       VALUES (?, ?, ?, ?)`
    ).run(id, resourceId, required,
      Math.round(RESOURCES[resourceId].basePrice * M.PREMIUM * 100) / 100);
  }
  logEvent(db, tick, 'megaproject',
    `★ GRAND CHANTIER — ${faction.name} lance « ${type.name} » : programme d'achat massif`
    + ' à prix garanti à sa capitale (voir ÉCO)');
}

function completeProject(db, mp, tick) {
  db.prepare("UPDATE megaprojects SET status = 'done' WHERE id = ?").run(mp.id);

  // La part du joueur décide des honneurs.
  const totals = mp.needs.reduce(
    (acc, n) => ({ all: acc.all + n.required, player: acc.player + n.delivered_player }),
    { all: 0, player: 0 });
  const share = totals.player / totals.all;
  if (share >= M.MIN_SHARE) {
    addPrestige(db, M.PRESTIGE);
    adjustStanding(db, mp.faction_id, M.STANDING_BONUS);
    logEvent(db, tick, 'megaproject',
      `★ CHANTIER ACHEVÉ — « ${mp.name} » de ${mp.faction_name} : votre maison en a fourni`
      + ` ${Math.round(share * 100)} % — le bâtisseur entre dans la légende (+${M.PRESTIGE} prestige)`);
  } else {
    logEvent(db, tick, 'megaproject',
      `GRAND CHANTIER ACHEVÉ — « ${mp.name} » de ${mp.faction_name} est en service`);
  }

  // La capitale grandit : une porte de saut attire le monde.
  db.prepare('UPDATE planets SET population = ROUND(population * ?, 2) WHERE id = ?')
    .run(M.POP_BOOST, mp.capital_planet_id);
}

// Livraison du joueur : à quai à la capitale, payée au prix garanti.
export function deliverToProject(db, projectId, resourceId, shipId) {
  const mp = db.prepare(
    `SELECT mp.*, f.capital_planet_id FROM megaprojects mp
     JOIN factions f ON f.id = mp.faction_id
     WHERE mp.id = ? AND mp.status = 'active'`
  ).get(projectId);
  if (!mp) return { ok: false, error: 'chantier introuvable ou clos' };
  const need = db.prepare(
    'SELECT * FROM megaproject_needs WHERE project_id = ? AND resource_id = ?'
  ).get(projectId, resourceId);
  if (!need) return { ok: false, error: 'ce chantier ne demande pas cette ressource' };
  if (need.delivered >= need.required) return { ok: false, error: 'poste déjà couvert' };

  const ship = getShip(db, shipId);
  if (!ship || ship.planet_id !== mp.capital_planet_id) {
    return { ok: false, error: 'amarrez un vaisseau à la capitale du chantier' };
  }
  const cargo = getCargo(db, ship.id).find((l) => l.resource_id === resourceId);
  if (!cargo || cargo.quantity <= 0) {
    return { ok: false, error: `aucun ${RESOURCES[resourceId].name} en soute` };
  }

  const delivered = Math.min(cargo.quantity, need.required - need.delivered);
  const paid = Math.round(delivered * need.unit_price * 100) / 100;
  db.transaction(() => {
    db.prepare(
      'UPDATE ship_cargo SET quantity = ROUND(quantity - ?, 2) WHERE ship_id = ? AND resource_id = ?'
    ).run(delivered, ship.id, resourceId);
    db.prepare(
      `UPDATE megaproject_needs SET delivered = ROUND(delivered + ?, 2),
         delivered_player = ROUND(delivered_player + ?, 2)
       WHERE project_id = ? AND resource_id = ?`
    ).run(delivered, delivered, projectId, resourceId);
    adjustCredits(db, paid);
    recordTradeVolume(db, 'sell', delivered, paid);
  })();
  return {
    ok: true, delivered, paid,
    resourceName: RESOURCES[resourceId].name, projectName: mp.name,
    credits: getPlayer(db).credits,
  };
}
