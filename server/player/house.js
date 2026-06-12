// Votre maison de commerce : son identité (nom, blason), son rang de
// renom (dérivé du prestige), et son quartier général — le siège dont
// les améliorations allègent l'entretien de la flotte, élargissent le
// plafond de vaisseaux et remisent les relevés de marché.

import { CONFIG } from '../config.js';
import { getPlayer, getShip, adjustCredits } from './state.js';

const H = CONFIG.PLAYER.HOUSE;
const HQ = CONFIG.PLAYER.HQ;

// Rang de renom courant et le prochain palier (pour une jauge).
export function renownOf(prestige) {
  let current = H.RENOWN[0];
  let next = null;
  for (let i = 0; i < H.RENOWN.length; i++) {
    if (prestige >= H.RENOWN[i].at) {
      current = H.RENOWN[i];
      next = H.RENOWN[i + 1] ?? null;
    }
  }
  return { title: current.title, at: current.at, next };
}

// Bonus actifs du QG (niveau 0 = pas de QG, aucun bonus).
export function hqBonuses(db) {
  const level = getPlayer(db).hq_level ?? 0;
  if (level <= 0) return { level: 0, upkeepReduction: 0, maxFleetBonus: 0, intelDiscount: 0 };
  return { level, ...HQ.LEVELS[level - 1] };
}

export function getHouse(db) {
  const player = getPlayer(db);
  const hqPlanet = player.hq_planet_id
    ? db.prepare(
        `SELECT p.id, p.name, p.system_id, s.name AS system_name
         FROM planets p JOIN systems s ON s.id = p.system_id WHERE p.id = ?`
      ).get(player.hq_planet_id)
    : null;
  const bonuses = hqBonuses(db);
  const nextCost = player.hq_level === 0 ? HQ.BUILD_COST
    : HQ.UPGRADE_COST[player.hq_level - 1] ?? null;
  return {
    name: player.house_name ?? 'Maison sans nom',
    color: player.house_color ?? '#53c7f0',
    renown: renownOf(player.prestige),
    prestige: player.prestige,
    hq: {
      level: player.hq_level ?? 0,
      planetId: player.hq_planet_id,
      planetName: hqPlanet?.name ?? null,
      systemId: hqPlanet?.system_id ?? null,
      systemName: hqPlanet?.system_name ?? null,
      bonuses,
      nextCost,
      maxLevel: HQ.LEVELS.length,
    },
  };
}

// ── Actions ──────────────────────────────────────────────────────

export function renameHouse(db, name) {
  const clean = String(name ?? '').trim().slice(0, 40);
  if (clean.length < 2) return { ok: false, error: 'nom trop court' };
  db.prepare('UPDATE player SET house_name = ? WHERE id = 1').run(clean);
  return { ok: true, name: clean };
}

export function setHouseColor(db, color) {
  if (!/^#[0-9a-fA-F]{6}$/.test(String(color ?? ''))) {
    return { ok: false, error: 'couleur invalide (format #rrggbb)' };
  }
  db.prepare('UPDATE player SET house_color = ? WHERE id = 1').run(color);
  return { ok: true, color };
}

// Bâtir le QG sur la planète où le vaisseau est à quai (une seule fois).
export function buildHQ(db, shipId) {
  const player = getPlayer(db);
  if (player.hq_planet_id) return { ok: false, error: 'votre maison a déjà un quartier général' };
  const ship = getShip(db, shipId);
  if (!ship || ship.planet_id === null) return { ok: false, error: 'vaisseau en transit' };
  if (player.credits < HQ.BUILD_COST) return { ok: false, error: `crédits insuffisants (${HQ.BUILD_COST} cr)` };

  const planet = db.prepare('SELECT name FROM planets WHERE id = ?').get(ship.planet_id);
  db.transaction(() => {
    adjustCredits(db, -HQ.BUILD_COST);
    db.prepare('UPDATE player SET hq_planet_id = ?, hq_level = 1 WHERE id = 1').run(ship.planet_id);
  })();
  return { ok: true, planetId: ship.planet_id, planetName: planet.name, cost: HQ.BUILD_COST };
}

export function upgradeHQ(db) {
  const player = getPlayer(db);
  if (!player.hq_planet_id) return { ok: false, error: 'aucun quartier général à améliorer' };
  if (player.hq_level >= HQ.LEVELS.length) return { ok: false, error: 'niveau maximum atteint' };
  const cost = HQ.UPGRADE_COST[player.hq_level - 1];
  if (player.credits < cost) return { ok: false, error: `crédits insuffisants (${cost} cr)` };

  db.transaction(() => {
    adjustCredits(db, -cost);
    db.prepare('UPDATE player SET hq_level = hq_level + 1 WHERE id = 1').run();
  })();
  return { ok: true, level: player.hq_level + 1, cost, bonuses: hqBonuses(db) };
}
