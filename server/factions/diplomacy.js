// Diplomatie : les relations entre factions dérivent au fil des cycles —
// les voisins se frottent, les lointains s'ignorent. Sous le seuil de
// rupture, c'est la guerre ; elle se termine par épuisement, capitulation
// ou enlisement (voir war.js pour la résolution militaire).

import { CONFIG } from '../config.js';
import { logEvent } from '../events.js';

const D = CONFIG.DIPLOMACY;

const pairKey = (a, b) => (a < b ? [a, b] : [b, a]);

export function getRelation(db, a, b) {
  const [x, y] = pairKey(a, b);
  return db.prepare(
    'SELECT * FROM faction_relations WHERE faction_a = ? AND faction_b = ?'
  ).get(x, y);
}

// Crée les paires manquantes (premier lancement ou migration de partie).
function ensureRelations(db, factions, rngLike = Math.random) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO faction_relations (faction_a, faction_b, relation) VALUES (?, ?, ?)'
  );
  for (let i = 0; i < factions.length; i++) {
    for (let j = i + 1; j < factions.length; j++) {
      const r = D.START_RELATION[0] + rngLike() * (D.START_RELATION[1] - D.START_RELATION[0]);
      insert.run(factions[i].id, factions[j].id, Math.round(r));
    }
  }
}

export function tickDiplomacy(db, tick) {
  if (tick % D.EVERY_TICKS !== 0) return;

  const factions = db.prepare(
    `SELECT f.id, f.name, f.fleet, s.x, s.y FROM factions f
     JOIN planets p ON p.id = f.capital_planet_id
     JOIN systems s ON s.id = p.system_id`
  ).all();
  if (factions.length < 2) return;
  ensureRelations(db, factions);

  const byId = new Map(factions.map((f) => [f.id, f]));
  const atWar = new Set();
  for (const r of db.prepare('SELECT * FROM faction_relations WHERE war_id IS NOT NULL').all()) {
    atWar.add(r.faction_a);
    atWar.add(r.faction_b);
  }

  const update = db.prepare(
    'UPDATE faction_relations SET relation = ? WHERE faction_a = ? AND faction_b = ?'
  );

  for (const rel of db.prepare('SELECT * FROM faction_relations').all()) {
    if (rel.war_id !== null) continue; // la guerre fige la diplomatie
    const a = byId.get(rel.faction_a);
    const b = byId.get(rel.faction_b);

    // Dérive : bruit + frottement de voisinage.
    const capitalDist = Math.hypot(a.x - b.x, a.y - b.y);
    const bias = capitalDist < D.NEIGHBOR_RADIUS ? D.NEIGHBOR_BIAS : 0.2;
    const relation = Math.max(-100, Math.min(100,
      rel.relation + (Math.random() * 2 - 1) * D.DRIFT + bias));
    update.run(Math.round(relation * 10) / 10, rel.faction_a, rel.faction_b);

    // Casus belli : relation au fond du trou, les deux camps en état de
    // se battre, et chacun limité à une guerre à la fois.
    if (relation < D.WAR_THRESHOLD
      && !atWar.has(rel.faction_a) && !atWar.has(rel.faction_b)
      && a.fleet >= D.MIN_FLEET_FOR_WAR && b.fleet >= D.MIN_FLEET_FOR_WAR) {
      declareWar(db, tick, a, b);
      atWar.add(a.id);
      atWar.add(b.id);
    }
  }
}

export function declareWar(db, tick, attacker, defender) {
  const warId = db.prepare(
    `INSERT INTO wars (attacker_id, defender_id, started_tick, attacker_fleet0, defender_fleet0)
     VALUES (?, ?, ?, ?, ?)`
  ).run(attacker.id, defender.id, tick, attacker.fleet, defender.fleet).lastInsertRowid;

  const [x, y] = pairKey(attacker.id, defender.id);
  db.prepare(
    'UPDATE faction_relations SET war_id = ? WHERE faction_a = ? AND faction_b = ?'
  ).run(warId, x, y);

  // Le front : les systèmes des deux camps les plus proches de l'ennemi.
  const aSystems = db.prepare('SELECT id, x, y FROM systems WHERE faction_id = ?').all(attacker.id);
  const bSystems = db.prepare('SELECT id, x, y FROM systems WHERE faction_id = ?').all(defender.id);
  const pairs = [];
  for (const sa of aSystems) {
    for (const sb of bSystems) {
      const d = Math.hypot(sa.x - sb.x, sa.y - sb.y);
      if (d <= CONFIG.WAR.FRONT_RADIUS) pairs.push({ d, ids: [sa.id, sb.id] });
    }
  }
  pairs.sort((p, q) => p.d - q.d);
  const frontIds = new Set();
  for (const p of pairs) {
    for (const id of p.ids) {
      if (frontIds.size < CONFIG.WAR.MAX_FRONTS) frontIds.add(id);
    }
  }
  const insertFront = db.prepare(
    'INSERT OR IGNORE INTO war_fronts (war_id, system_id) VALUES (?, ?)'
  );
  for (const id of frontIds) insertFront.run(warId, id);

  logEvent(db, tick, 'war',
    `GUERRE — ${attacker.name} déclare la guerre à ${defender.name}`
    + ` (${frontIds.size} systèmes sur le front)`, attacker.id);
  return warId;
}
