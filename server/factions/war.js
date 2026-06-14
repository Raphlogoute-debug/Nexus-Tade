// Résolution militaire — entièrement pilotée par l'économie.
// Force effective = flotte × disponibilité, et la disponibilité dépend de
// l'entretien réellement payé (fleet.js). Un camp privé de modules, de
// pièces ou de carburant construit moins, entretient moins, perd ses
// fronts — la guerre s'exploite par le commerce, jamais par les ordres.

import { CONFIG } from '../config.js';
import { logEvent } from '../events.js';
import { resolveWarLoans } from './loans.js';
import { attributeConquest, attributeWarEnd, clearWarSupport } from './influence.js';

const W = CONFIG.WAR;

export function activeWars(db) {
  return db.prepare('SELECT * FROM wars WHERE ended_tick IS NULL').all();
}

// Contexte de guerre du tick : qui se bat, où sont les fronts.
// Utilisé par les chantiers (effort de guerre), la logistique (raids),
// les contrats (urgence) et les arrivées du joueur (saisies).
export function warContext(db) {
  const wars = activeWars(db);
  const factionWar = new Map();   // factionId → war
  const frontSystems = new Map(); // systemId → war
  for (const war of wars) {
    factionWar.set(war.attacker_id, war);
    factionWar.set(war.defender_id, war);
    for (const f of db.prepare('SELECT system_id FROM war_fronts WHERE war_id = ?').all(war.id)) {
      frontSystems.set(f.system_id, war);
    }
  }
  return {
    wars,
    factionWar,
    frontSystems,
    enemyOf: (factionId) => {
      const war = factionWar.get(factionId);
      if (!war) return null;
      return war.attacker_id === factionId ? war.defender_id : war.attacker_id;
    },
  };
}

export function tickWars(db, tick) {
  const getFaction = db.prepare('SELECT * FROM factions WHERE id = ?');
  const setFleet = db.prepare('UPDATE factions SET fleet = ? WHERE id = ?');

  for (const war of activeWars(db)) {
    const attacker = getFaction.get(war.attacker_id);
    const defender = getFaction.get(war.defender_id);

    // Force effective : la flotte ne vaut que par son entretien.
    const sAtt = attacker.fleet * attacker.readiness;
    const sDef = defender.fleet * defender.readiness;
    const total = sAtt + sDef;
    // Deux flottes anéanties : la guerre est militairement morte. On la
    // clôt (épuisement mutuel) au lieu de la laisser traîner jusqu'au
    // plafond de durée sans que rien ne se passe.
    if (total <= 0) {
      if (tick - war.started_tick >= W.MIN_DURATION) {
        endWar(db, tick, war, 'peace', attacker, defender);
      }
      continue;
    }

    // 1. Attrition : chacun perd proportionnellement à la force adverse.
    const lossAtt = W.ATTRITION * sDef * (0.8 + Math.random() * 0.4);
    const lossDef = W.ATTRITION * sAtt * (0.8 + Math.random() * 0.4);
    setFleet.run(Math.max(0, round2(attacker.fleet - lossAtt)), attacker.id);
    setFleet.run(Math.max(0, round2(defender.fleet - lossDef)), defender.id);

    // 2. Les fronts basculent selon le rapport de force du moment.
    const balance = (sAtt - sDef) / total;
    for (const front of db.prepare('SELECT * FROM war_fronts WHERE war_id = ?').all(war.id)) {
      const pressure = front.pressure
        + W.FRONT_RATE * balance + (Math.random() - 0.5) * 0.02;
      if (Math.abs(pressure) >= 1) {
        conquerSystem(db, tick, war, front.system_id, pressure > 0 ? attacker : defender);
      } else {
        db.prepare('UPDATE war_fronts SET pressure = ? WHERE war_id = ? AND system_id = ?')
          .run(round2(pressure), war.id, front.system_id);
      }
    }

    // 3. Fin de guerre : capitulation par épuisement, ou enlisement.
    const age = tick - war.started_tick;
    if (age < W.MIN_DURATION) continue;
    const attExhausted = attacker.fleet < war.attacker_fleet0 * W.EXHAUSTION;
    const defExhausted = defender.fleet < war.defender_fleet0 * W.EXHAUSTION;
    if (attExhausted || defExhausted || age > W.MAX_DURATION) {
      const result = attExhausted === defExhausted ? 'peace'
        : attExhausted ? 'defender' : 'attacker';
      endWar(db, tick, war, result, attacker, defender);
    }
  }
}

function conquerSystem(db, tick, war, systemId, winner) {
  const system = db.prepare('SELECT id, name FROM systems WHERE id = ?').get(systemId);
  db.prepare('UPDATE systems SET faction_id = ? WHERE id = ?').run(winner.id, systemId);
  // Le système reste un front (reprenable), repart à mi-chemin.
  db.prepare('UPDATE war_fronts SET pressure = ? WHERE war_id = ? AND system_id = ?')
    .run(winner.id === war.attacker_id ? -0.5 : 0.5, war.id, systemId);
  logEvent(db, tick, 'conquest',
    `CONQUÊTE — ${system.name} tombe aux mains de ${winner.name}`, winner.id);
  // Le profiteur : si vous armez nettement le vainqueur, le mérite est vôtre.
  const loserId = winner.id === war.attacker_id ? war.defender_id : war.attacker_id;
  attributeConquest(db, tick, winner.id, loserId, system.name);
}

function endWar(db, tick, war, result, attacker, defender) {
  db.prepare('UPDATE wars SET ended_tick = ?, result = ? WHERE id = ?')
    .run(tick, result, war.id);
  db.prepare('DELETE FROM war_fronts WHERE war_id = ?').run(war.id);
  const [a, b] = war.attacker_id < war.defender_id
    ? [war.attacker_id, war.defender_id] : [war.defender_id, war.attacker_id];
  db.prepare(
    'UPDATE faction_relations SET war_id = NULL, relation = ? WHERE faction_a = ? AND faction_b = ?'
  ).run(CONFIG.DIPLOMACY.PEACE_RELATION, a, b);

  const message = result === 'peace'
    ? `PAIX — ${attacker.name} et ${defender.name} signent une paix d'épuisement`
    : `VICTOIRE — ${(result === 'attacker' ? attacker : defender).name} l'emporte sur `
      + `${(result === 'attacker' ? defender : attacker).name}`;
  logEvent(db, tick, 'peace', message, null);

  resolveWarLoans(db, war, result, tick); // l'heure des comptes pour les créanciers
  // Faiseur de rois : avez-vous armé le vainqueur ?
  const winnerId = result === 'attacker' ? war.attacker_id
    : result === 'defender' ? war.defender_id : null;
  attributeWarEnd(db, tick, winnerId);
  // Le soutien envers ces factions est soldé : il ne doit pas se reporter
  // sur une guerre future sans rapport. (Après attribution, jamais avant.)
  clearWarSupport(db, [war.attacker_id, war.defender_id]);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
