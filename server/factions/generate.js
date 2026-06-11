// Génération des factions : les plus grands mondes deviennent des
// capitales, chaque système rejoint la capitale la plus proche (dans la
// limite d'un rayon territorial), le reste forme la Frange indépendante.
// Déterministe pour une seed donnée — appelable aussi sur une partie
// existante (migration Phase 2 → Phase 3).

import { CONFIG } from '../config.js';
import { createRng } from '../universe/rng.js';
import { getMeta } from '../db.js';

const F = CONFIG.FACTIONS;
const FORMS = ['Royaume', 'Empire', 'Ligue', 'Hégémonie', 'Consortium', 'Dominion', 'Pacte'];

function factionName(rng, capitalSystemName) {
  const form = rng.pick(FORMS);
  const elision = /^[AEIOUYÉ]/i.test(capitalSystemName) ? "d'" : 'de ';
  return `${form} ${elision}${capitalSystemName}`;
}

export function generateFactions(db) {
  const rng = createRng((Number(getMeta(db, 'seed')) ^ 0x51f15e) >>> 0);
  const count = rng.int(F.MIN_COUNT, F.MAX_COUNT);

  // Capitales : les planètes les plus peuplées, dans des systèmes
  // suffisamment espacés pour dessiner de vrais territoires.
  const candidates = db.prepare(
    `SELECT p.id AS planet_id, p.name, s.id AS system_id, s.name AS system_name, s.x, s.y
     FROM planets p JOIN systems s ON s.id = p.system_id
     ORDER BY p.population DESC`
  ).all();

  const capitals = [];
  for (const c of candidates) {
    if (capitals.length >= count) break;
    if (capitals.some((k) => k.system_id === c.system_id
      || Math.hypot(k.x - c.x, k.y - c.y) < F.MIN_CAPITAL_SPACING)) continue;
    capitals.push(c);
  }

  const insertFaction = db.prepare(
    'INSERT INTO factions (name, color, capital_planet_id, fleet) VALUES (?, ?, ?, ?)'
  );
  const assignSystem = db.prepare('UPDATE systems SET faction_id = ? WHERE id = ?');

  db.transaction(() => {
    const factionIds = capitals.map((cap, i) =>
      insertFaction.run(
        factionName(rng, cap.system_name), F.COLORS[i % F.COLORS.length],
        cap.planet_id, 0
      ).lastInsertRowid);

    // Chaque système rejoint la capitale la plus proche — s'il y en a une
    // dans le rayon territorial. Sinon : la Frange (faction_id NULL).
    const memberSystems = capitals.map(() => 0);
    for (const sys of db.prepare('SELECT id, x, y FROM systems').all()) {
      let best = -1;
      let bestDist = F.TERRITORY_RADIUS;
      for (const [i, cap] of capitals.entries()) {
        const d = Math.hypot(sys.x - cap.x, sys.y - cap.y);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      if (best >= 0) {
        assignSystem.run(factionIds[best], sys.id);
        memberSystems[best]++;
      }
    }

    // Flotte initiale proportionnelle à la taille du territoire.
    const setFleet = db.prepare('UPDATE factions SET fleet = ? WHERE id = ?');
    for (const [i, id] of factionIds.entries()) {
      setFleet.run(F.START_FLEET_BASE + F.START_FLEET_PER_SYSTEM * memberSystems[i], id);
    }
  })();

  return { factions: capitals.length };
}
