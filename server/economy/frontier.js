// La frontière vivante (Phase 15) : colonies naissantes qui explosent
// démographiquement, repaires pirates qui prospèrent tant qu'on les
// laisse faire, et sondages géologiques (la prospection se mémorise).

import { CONFIG } from '../config.js';
import { getCurrentTick } from '../db.js';
import { getPlayer, getShip, adjustCredits } from '../player/state.js';
import { depositQuality } from '../player/concession.js';
import { logEvent } from '../events.js';

const COL = CONFIG.COLONIES;
const L = CONFIG.LAIRS;
const PRO = CONFIG.PROSPECTING;

// ── Colonies naissantes ──────────────────────────────────────────

export function colonyBoom(db, planetId) {
  const c = db.prepare('SELECT * FROM colonies WHERE planet_id = ?').get(planetId);
  if (!c) return null;
  return c.boom_until > getCurrentTick(db) ? c : null;
}

export function tickColonies(db, tick) {
  // Le boom : la population explose, la demande suit toute seule.
  for (const c of db.prepare('SELECT * FROM colonies WHERE boom_until > ?').all(tick)) {
    db.prepare('UPDATE planets SET population = ROUND(population * ?, 3) WHERE id = ?')
      .run(COL.GROWTH, c.planet_id);
  }

  if (tick % COL.CHECK_EVERY !== 0 || Math.random() >= COL.SPAWN_CHANCE) return;

  // Un petit monde de la Frange, sans boom passé ni présent.
  const candidate = db.prepare(
    `SELECT p.id, p.name FROM planets p
     JOIN systems s ON s.id = p.system_id
     WHERE s.faction_id IS NULL AND p.population < ?
       AND p.id NOT IN (SELECT planet_id FROM colonies)
     ORDER BY RANDOM() LIMIT 1`
  ).get(COL.MAX_POP);
  if (!candidate) return;

  db.prepare('INSERT INTO colonies (planet_id, started_tick, boom_until) VALUES (?, ?, ?)')
    .run(candidate.id, tick, tick + COL.BOOM_TICKS);
  logEvent(db, tick, 'colony',
    `★ COLONIE — ${candidate.name} entre en plein boom : la population explose,`
    + ' tout manque. Les premiers arrivés feront fortune (concessions et comptoirs à moitié prix)');
}

// ── Repaires pirates ─────────────────────────────────────────────

export function listLairs(db) {
  return db.prepare(
    `SELECT pl.*, s.name AS system_name, s.x, s.y FROM pirate_lairs pl
     JOIN systems s ON s.id = pl.system_id ORDER BY pl.system_id`
  ).all();
}

// Surdanger dû aux repaires : plein pot dans le système, moitié à portée.
export function lairDanger(db, systemId) {
  const sys = db.prepare('SELECT x, y FROM systems WHERE id = ?').get(systemId);
  if (!sys) return 0; // système inconnu (données partielles) : pas de surdanger
  let extra = 0;
  for (const lair of db.prepare(
    `SELECT pl.strength, s.x, s.y FROM pirate_lairs pl
     JOIN systems s ON s.id = pl.system_id`
  ).all()) {
    const d = Math.hypot(lair.x - sys.x, lair.y - sys.y);
    if (d === 0) extra += lair.strength * L.DANGER_PER_STRENGTH;
    else if (d <= L.NEIGHBOR_RADIUS) extra += lair.strength * L.DANGER_PER_STRENGTH * 0.5;
  }
  return extra;
}

export function tickLairs(db, tick) {
  // Croissance : un repaire qu'on laisse prospérer grossit.
  if (tick % L.GROWTH_EVERY === 0) {
    db.prepare('UPDATE pirate_lairs SET strength = MIN(?, strength + 1)').run(L.MAX_STRENGTH);
  }

  if (tick % L.CHECK_EVERY !== 0 || Math.random() >= L.SPAWN_CHANCE) return;
  if (db.prepare('SELECT COUNT(*) AS n FROM pirate_lairs').get().n >= L.MAX_LAIRS) return;

  const candidate = db.prepare(
    `SELECT s.id, s.name FROM systems s
     WHERE s.faction_id IS NULL AND s.id NOT IN (SELECT system_id FROM pirate_lairs)
     ORDER BY RANDOM() LIMIT 1`
  ).get();
  if (!candidate) return;
  db.prepare('INSERT INTO pirate_lairs (system_id, strength, created_tick) VALUES (?, 1, ?)')
    .run(candidate.id, tick);
  logEvent(db, tick, 'lair',
    `☠ REPAIRE — des pirates s'installent à ${candidate.name} : les couloirs voisins`
    + ` deviennent dangereux. Payez des mercenaires pour raser le nid avant qu'il grossisse`);
}

export function clearLairCost(strength) {
  return L.CLEAR_BASE + strength * L.CLEAR_PER_STRENGTH;
}

// Raser un repaire : des mercenaires, payés rubis sur l'ongle.
export function clearLair(db, systemId) {
  const lair = db.prepare('SELECT * FROM pirate_lairs WHERE system_id = ?').get(systemId);
  if (!lair) return { ok: false, error: 'aucun repaire connu dans ce système' };
  const cost = clearLairCost(lair.strength);
  if (getPlayer(db).credits < cost) {
    return { ok: false, error: `mercenaires à ${cost} cr — crédits insuffisants` };
  }
  const tick = getCurrentTick(db);
  const name = db.prepare('SELECT name FROM systems WHERE id = ?').get(systemId).name;
  db.transaction(() => {
    adjustCredits(db, -cost);
    db.prepare('DELETE FROM pirate_lairs WHERE system_id = ?').run(systemId);
  })();
  logEvent(db, tick, 'lair',
    `⚔ MERCENAIRES — le repaire pirate de ${name} est rasé sur votre solde (−${cost} cr) :`
    + ' les couloirs respirent');
  return { ok: true, cost, systemName: name };
}

// ── Prospection : sondages géologiques ───────────────────────────

export function listSurveys(db) {
  return db.prepare(
    `SELECT ds.planet_id, p.system_id FROM deposit_surveys ds
     JOIN planets p ON p.id = ds.planet_id`
  ).all().map((s) => ({
    planetId: s.planet_id,
    systemId: s.system_id,
    quality: depositQuality(db, s.planet_id),
  }));
}

export function isSurveyed(db, planetId) {
  return Boolean(db.prepare('SELECT 1 FROM deposit_surveys WHERE planet_id = ?').get(planetId));
}

// Sonder tout un système : un vaisseau à quai dans le système suffit.
export function surveySystem(db, systemId, shipId) {
  const ship = getShip(db, shipId);
  if (!ship || ship.planet_id === null) return { ok: false, error: 'vaisseau en transit' };
  const here = db.prepare('SELECT system_id FROM planets WHERE id = ?').get(ship.planet_id);
  if (here.system_id !== systemId) {
    return { ok: false, error: 'le vaisseau doit être à quai dans ce système' };
  }
  const planets = db.prepare(
    'SELECT id FROM planets WHERE system_id = ? AND id NOT IN (SELECT planet_id FROM deposit_surveys)'
  ).all(systemId);
  if (planets.length === 0) return { ok: false, error: 'système déjà entièrement sondé' };
  const cost = planets.length * PRO.COST_PER_PLANET;
  if (getPlayer(db).credits < cost) return { ok: false, error: `sondage à ${cost} cr — crédits insuffisants` };

  const tick = getCurrentTick(db);
  db.transaction(() => {
    adjustCredits(db, -cost);
    for (const p of planets) {
      db.prepare('INSERT INTO deposit_surveys (planet_id, surveyed_tick) VALUES (?, ?)')
        .run(p.id, tick);
    }
  })();
  const best = Math.max(...planets.map((p) => depositQuality(db, p.id)));
  return { ok: true, cost, surveyed: planets.length, bestQuality: best };
}
