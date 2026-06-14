// Statistiques de votre maison : valeur nette (le vrai score), classement
// face aux maisons rivales, et la composition de votre patrimoine. Sert
// le panneau MAISON et son graphe d'évolution.

import { RESOURCES } from '../../data/resources.js';
import { CONFIG } from '../config.js';
import { getPlayer } from './state.js';
import { renownOf } from './house.js';
import { industryValuation } from './investments.js';

const HQ = CONFIG.PLAYER.HQ;

const valueOf = (rows) => rows.reduce(
  (s, r) => s + r.quantity * RESOURCES[r.resource_id].basePrice, 0);

// Décomposition du patrimoine du joueur (tout valorisé au prix de base,
// pour un score stable indépendant des secousses de marché).
export function netWorthBreakdown(db) {
  const player = getPlayer(db);
  const cargo = valueOf(db.prepare('SELECT resource_id, quantity FROM ship_cargo WHERE quantity > 0').all());
  const facility = valueOf(db.prepare('SELECT resource_id, quantity FROM facility_storage WHERE quantity > 0').all());
  const post = valueOf(db.prepare('SELECT resource_id, quantity FROM post_storage WHERE quantity > 0').all());

  // Parts d'industries : valorisées à leur prix d'amortissement.
  const shares = db.prepare(
    `SELECT ish.share, pi.rate, pi.recipe_id
     FROM industry_shares ish JOIN planet_industries pi
       ON pi.planet_id = ish.planet_id AND pi.recipe_id = ish.recipe_id`
  ).all();
  // Valorisées à leur PRIX D'ACQUISITION (la même formule que l'achat de
  // parts), pour que la valeur nette reflète le capital réellement immobilisé
  // — cohérent avec la base « au coût » des maisons rivales. L'ancienne
  // formule omettait `output` et la marge de dividende, gonflant le score
  // d'un facteur 5/output.
  let industryValue = 0;
  for (const s of shares) {
    industryValue += industryValuation(s.recipe_id, s.rate) * s.share;
  }

  // Quartier général : capital immobilisé (coût de construction cumulé).
  let hqValue = 0;
  if ((player.hq_level ?? 0) > 0) {
    hqValue = HQ.BUILD_COST;
    for (let i = 0; i < player.hq_level - 1; i++) hqValue += HQ.UPGRADE_COST[i];
  }

  const parts = {
    credits: Math.round(player.credits),
    cargo: Math.round(cargo),
    storage: Math.round(facility + post),
    industry: Math.round(industryValue),
    hq: Math.round(hqValue),
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { parts, total };
}

// Classement par valeur nette : vous et les maisons rivales.
export function leaderboard(db) {
  const player = getPlayer(db);
  const me = {
    id: 'player',
    name: player.house_name ?? 'Votre maison',
    color: player.house_color ?? '#53c7f0',
    netWorth: netWorthBreakdown(db).total,
    isPlayer: true,
  };
  const rivals = db.prepare('SELECT id, name, color, net_worth FROM rivals').all().map((r) => ({
    id: `rival:${r.id}`,
    name: r.name,
    color: r.color,
    netWorth: Math.round(r.net_worth),
    isPlayer: false,
  }));
  const all = [me, ...rivals].sort((a, b) => b.netWorth - a.netWorth);
  // Classement à l'ancienne : deux valeurs nettes égales partagent le rang.
  all.forEach((e, i) => {
    e.rank = i > 0 && e.netWorth === all[i - 1].netWorth ? all[i - 1].rank : i + 1;
  });
  return all;
}

// Série temporelle de valeur nette pour chaque maison (graphe).
export function netWorthHistory(db) {
  const rows = db.prepare(
    'SELECT subject, tick, value FROM networth_history ORDER BY tick'
  ).all();
  const bySubject = new Map();
  for (const r of rows) {
    if (!bySubject.has(r.subject)) bySubject.set(r.subject, []);
    bySubject.get(r.subject).push({ tick: r.tick, value: r.value });
  }
  return Object.fromEntries(bySubject);
}

export function statsSnapshot(db) {
  const board = leaderboard(db);
  const player = getPlayer(db);
  return {
    netWorth: netWorthBreakdown(db),
    renown: renownOf(player.prestige),
    warProfit: player.war_profit ?? 0,
    rank: board.find((e) => e.isPlayer)?.rank ?? 1,
    field: board.length,
    leaderboard: board,
    history: netWorthHistory(db),
    counts: {
      fleet: db.prepare('SELECT COUNT(*) AS n FROM ships').get().n,
      concessions: db.prepare('SELECT COUNT(*) AS n FROM concessions').get().n,
      posts: db.prepare('SELECT COUNT(*) AS n FROM trading_posts').get().n,
      industries: db.prepare('SELECT COUNT(*) AS n FROM industry_shares').get().n
        + db.prepare('SELECT COUNT(*) AS n FROM facility_workshops').get().n,
      partners: db.prepare('SELECT COUNT(*) AS n FROM trade_partners').get().n,
      techs: db.prepare('SELECT COUNT(*) AS n FROM player_tech').get().n,
    },
    // Les compteurs à vie : c'est ici qu'on voit les millions passer.
    lifetime: {
      unitsSold: player.total_units_sold ?? 0,
      unitsBought: player.total_units_bought ?? 0,
      revenue: player.total_revenue ?? 0,
    },
  };
}
