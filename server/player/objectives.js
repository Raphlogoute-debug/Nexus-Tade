// Objectifs : les jalons de la carrière (data/objectives.js), vérifiés
// périodiquement sur l'état réel de la partie. Chaque jalon atteint est
// gravé en base (table objectives), récompensé en prestige et annoncé
// dans le journal. Le jalon « nexus » est la victoire — la partie
// continue ensuite en bac à sable.

import { OBJECTIVES } from '../../data/objectives.js';
import { getPlayer, hasTierAccess, addPrestige } from './state.js';
import { logEvent } from '../events.js';

const METRIC_LABELS = {
  credits: 'crédits',
  partners: 'partenaires commerciaux',
  fleet: 'vaisseaux',
  industry: 'unités de production',
  tier3: 'accès tier 3',
  posts: 'comptoirs',
  presence: 'systèmes couverts',
  loansRepaid: 'prêts remboursés',
  techs: 'technologies',
};

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

// L'état mesurable de la partie, en une passe de petites requêtes.
export function computeMetrics(db) {
  const player = getPlayer(db);
  return {
    credits: player.credits,
    partners: count(db, 'trade_partners'),
    fleet: count(db, 'ships'),
    industry: count(db, 'facility_workshops') + count(db, 'industry_shares'),
    tier3: hasTierAccess(player, 3) ? 1 : 0,
    posts: count(db, 'trading_posts'),
    presence: db.prepare(
      `SELECT COUNT(DISTINCT p.system_id) AS n FROM (
         SELECT planet_id FROM concessions UNION SELECT planet_id FROM trading_posts
       ) x JOIN planets p ON p.id = x.planet_id`
    ).get().n,
    loansRepaid: db.prepare(
      "SELECT COUNT(*) AS n FROM loans WHERE status = 'repaid'"
    ).get().n,
    techs: count(db, 'player_tech'),
  };
}

// Vérifie les jalons non atteints ; grave, récompense et annonce ceux
// qui viennent de l'être. Retourne les ids fraîchement accomplis.
export function checkObjectives(db, tick) {
  const done = new Set(db.prepare('SELECT id FROM objectives').all().map((o) => o.id));
  const pending = OBJECTIVES.filter((o) => !done.has(o.id));
  if (pending.length === 0) return [];

  const m = computeMetrics(db);
  const completed = [];
  for (const o of pending) {
    if (!o.requires.every((r) => m[r.metric] >= r.goal)) continue;
    db.prepare('INSERT INTO objectives (id, completed_tick) VALUES (?, ?)').run(o.id, tick);
    addPrestige(db, o.reward);
    logEvent(db, tick, o.victory ? 'victory' : 'objective',
      o.victory
        ? `★ VICTOIRE — « ${o.name} » : vous êtes LA puissance commerciale de la galaxie (+${o.reward} prestige)`
        : `OBJECTIF — « ${o.name} » atteint (+${o.reward} prestige)`);
    completed.push(o.id);
  }
  return completed;
}

// Liste complète pour l'UI : statut, progression par condition.
export function listObjectives(db) {
  const doneAt = new Map(
    db.prepare('SELECT id, completed_tick FROM objectives').all()
      .map((o) => [o.id, o.completed_tick]));
  const m = computeMetrics(db);
  return OBJECTIVES.map((o) => ({
    id: o.id,
    name: o.name,
    desc: o.desc,
    reward: o.reward,
    victory: o.victory ?? false,
    done: doneAt.has(o.id),
    completedTick: doneAt.get(o.id) ?? null,
    progress: o.requires.map((r) => ({
      label: METRIC_LABELS[r.metric] ?? r.metric,
      value: Math.min(m[r.metric], r.goal),
      goal: r.goal,
    })),
  }));
}
