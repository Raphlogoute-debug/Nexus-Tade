// Réputation du joueur PAR FACTION. Le prestige dit que vous êtes un
// grand marchand ; la réputation dit pour qui vous roulez. Vendre du
// matériel stratégique à un belligérant plaît à l'acheteur — et son
// ennemi finit par l'apprendre (manifestes, espions, rumeurs de quai).

import { CONFIG } from '../config.js';
import { logEvent } from '../events.js';
import { warContext } from './war.js';

const S = CONFIG.STANDING;
const STRATEGIC = new Set(Object.keys(CONFIG.FLEET.BUILD));

export function getStanding(db, factionId) {
  return db.prepare('SELECT standing FROM faction_standing WHERE faction_id = ?')
    .get(factionId)?.standing ?? 0;
}

export function adjustStanding(db, factionId, delta) {
  db.prepare(
    `INSERT INTO faction_standing (faction_id, standing) VALUES (?, ?)
     ON CONFLICT(faction_id) DO UPDATE SET
       standing = MAX(-100, MIN(100, standing + ?))`
  ).run(factionId, Math.max(-100, Math.min(100, delta)), delta);
}

export function allStandings(db) {
  return db.prepare('SELECT faction_id, standing FROM faction_standing').all();
}

// Appelé après chaque VENTE du joueur. Hors guerre, le commerce est neutre ;
// en guerre, les livraisons stratégiques engagent.
export function onPlayerSale(db, tick, planetFactionId, resourceId, quantity) {
  if (planetFactionId === null || !STRATEGIC.has(resourceId)) return null;
  const ctx = warContext(db);
  const enemyId = ctx.enemyOf(planetFactionId);
  if (enemyId === null) return null;

  const gain = Math.round(quantity * S.STRATEGIC_PER_UNIT * 10) / 10;
  adjustStanding(db, planetFactionId, gain);
  adjustStanding(db, enemyId, -gain * S.ENEMY_LEAK);

  if (quantity >= 50) {
    const enemy = db.prepare('SELECT name FROM factions WHERE id = ?').get(enemyId);
    logEvent(db, tick, 'intel',
      `RENSEIGNEMENT — vos livraisons de guerre n'ont pas échappé à ${enemy.name}`,
      enemyId);
  }
  return { gain, enemyId };
}

// Le marché d'une faction vous est-il ouvert ?
export function marketOpen(db, planetFactionId) {
  if (planetFactionId === null) return true; // la Frange se moque de vos guerres
  return getStanding(db, planetFactionId) > S.BLACKLIST;
}

// Saisie de cargaison stratégique à l'arrivée dans un système de front
// tenu par une faction qui vous tient en grief.
export function maybeSeizeCargo(db, tick, ship, planetId) {
  const info = db.prepare(
    `SELECT s.id AS system_id, s.faction_id, p.name AS planet_name
     FROM planets p JOIN systems s ON s.id = p.system_id WHERE p.id = ?`
  ).get(planetId);
  if (info.faction_id === null) return null;

  const ctx = warContext(db);
  if (!ctx.frontSystems.has(info.system_id)) return null;
  if (getStanding(db, info.faction_id) > S.SEIZURE) return null;

  const seized = db.prepare(
    `SELECT resource_id, quantity FROM ship_cargo
     WHERE ship_id = ? AND quantity > 0 AND resource_id IN (${[...STRATEGIC].map(() => '?').join(',')})`
  ).all(ship.id, ...STRATEGIC);
  if (seized.length === 0) return null;

  db.prepare(
    `UPDATE ship_cargo SET quantity = 0
     WHERE ship_id = ? AND resource_id IN (${[...STRATEGIC].map(() => '?').join(',')})`
  ).run(ship.id, ...STRATEGIC);

  const faction = db.prepare('SELECT name FROM factions WHERE id = ?').get(info.faction_id);
  const detail = seized.map((s) => `${Math.round(s.quantity)} ${s.resource_id}`).join(', ');
  logEvent(db, tick, 'seizure',
    `SAISIE — la douane de ${faction.name} confisque votre cargaison stratégique`
    + ` à ${info.planet_name} (${detail})`, info.faction_id);
  return { seized };
}
