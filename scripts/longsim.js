// Analyse de longue partie : on simule des milliers de jours et on mesure
// (1) la PERFORMANCE du tick dans le temps et (2) la SANTÉ de l'économie —
// prix qui s'emballent ou s'effondrent, stocks aberrants, inflation,
// trajectoire de richesse du joueur, valeurs invalides (NaN/Inf). Révèle
// les bugs d'équilibrage qu'aucun test unitaire ne montre.
//
// Usage : node scripts/longsim.js [ticks]   (défaut 5000)

import fs from 'node:fs';
import { createDb } from '../server/db.js';
import { generateUniverse } from '../server/universe/generator.js';
import { generateFactions } from '../server/factions/generate.js';
import { initTraders } from '../server/npc/traders.js';
import { initRivals } from '../server/economy/rivals.js';
import { initPlayer, getShip } from '../server/player/state.js';
import { buyShip, setShipMode } from '../server/player/shipyard.js';
import { createRoute, assignRoute } from '../server/player/routes.js';
import { runTick } from '../server/simulation.js';
import { RESOURCES, RESOURCE_IDS } from '../data/resources.js';

const TICKS = Number(process.argv[2]) || 5000;
// Chemin de base paramétrable (LONGSIM_DB) pour pouvoir lancer plusieurs
// simulations en parallèle sans qu'elles se marchent dessus.
const DB_PATH = process.env.LONGSIM_DB || '/tmp/nexus-longsim.db';
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const db = createDb(DB_PATH);
generateUniverse(db, 424242);
generateFactions(db);
initTraders(db);
initRivals(db);
initPlayer(db);

// Joueur établi : flotte automatique + route, pour qu'il pèse sur l'économie.
db.prepare('UPDATE player SET credits = 2000000, prestige = 3000, licence_tier = 3 WHERE id = 1').run();
const hub = db.prepare('SELECT id FROM planets WHERE population >= 500 LIMIT 1').get()
  ?? db.prepare('SELECT id FROM planets WHERE population >= 50 LIMIT 1').get();
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(hub.id, getShip(db).id);
for (let i = 0; i < 15; i++) {
  const r = buyShip(db, ['courier', 'freighter', 'hauler'][i % 3]);
  if (r.ok) setShipMode(db, r.shipId, 'auto');
}

const num = (n) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 0 });
const anomalies = [];
function priceHealth() {
  const rows = db.prepare('SELECT resource_id, stock, price FROM planet_resources').all();
  let runaway = 0; let collapsed = 0; let badStock = 0; let invalid = 0;
  for (const r of rows) {
    const base = RESOURCES[r.resource_id].basePrice;
    if (!Number.isFinite(r.price) || !Number.isFinite(r.stock)) invalid++;
    else {
      if (r.price > base * 8) runaway++;
      if (r.price < base * 0.12) collapsed++;
    }
    if (r.stock < -0.01) badStock++;
  }
  return { n: rows.length, runaway, collapsed, badStock, invalid };
}
function avgPriceRatio() {
  // Prix médian par ressource rapporté à la base — détecte une dérive globale.
  let sum = 0; let count = 0;
  for (const rid of RESOURCE_IDS) {
    const m = db.prepare('SELECT AVG(price) AS p FROM planet_resources WHERE resource_id = ?').get(rid);
    if (m.p) { sum += m.p / RESOURCES[rid].basePrice; count++; }
  }
  return sum / count;
}

const times = [];
console.log(`\n■ Longue partie — ${num(TICKS)} jours simulés (15 vaisseaux auto + rivaux)\n`);
console.log('  jour     tick(ms)  crédits      prix/base  emballés effondrés  pop.totale');

const startWall = Date.now();
for (let i = 1; i <= TICKS; i++) {
  const r = runTick(db);
  times.push(r.durationMs);

  if (i % Math.max(250, Math.floor(TICKS / 20)) === 0) {
    const p = db.prepare('SELECT credits, prestige FROM player WHERE id = 1').get();
    const h = priceHealth();
    const ratio = avgPriceRatio();
    const pop = db.prepare('SELECT SUM(population) AS t FROM planets').get().t;
    if (h.invalid > 0) anomalies.push(`tick ${i}: ${h.invalid} prix/stock invalides (NaN/Inf)`);
    if (h.badStock > 0) anomalies.push(`tick ${i}: ${h.badStock} stocks négatifs`);
    if (!Number.isFinite(p.credits)) anomalies.push(`tick ${i}: crédits joueur invalides`);
    console.log(
      `  ${String(i).padStart(5)}   ${String(r.durationMs).padStart(6)}    `
      + `${num(p.credits).padStart(11)}  ${ratio.toFixed(2).padStart(7)}  `
      + `${String(h.runaway).padStart(7)}  ${String(h.collapsed).padStart(8)}   ${num(pop).padStart(9)}`);
  }
}
const wall = Date.now() - startWall;
times.sort((a, b) => a - b);

const finalPlayer = db.prepare('SELECT credits, prestige, total_units_sold, total_revenue FROM player WHERE id = 1').get();
const wars = db.prepare('SELECT COUNT(*) AS n FROM wars').get().n;
const liveRivals = db.prepare('SELECT id, name, net_worth FROM rivals ORDER BY net_worth DESC').all();
const finalHealth = priceHealth();

console.log(`\n■ Performance`);
console.log(`  médiane ${times[Math.floor(TICKS / 2)]} ms · p90 ${times[Math.floor(TICKS * 0.9)]} ms · `
  + `p99 ${times[Math.floor(TICKS * 0.99)]} ms · max ${times[TICKS - 1]} ms`);
console.log(`  débit soutenu : ${Math.round(TICKS / (wall / 1000))} ticks/s · budget tick 5000 ms — `
  + `marge ×${Math.round(5000 / (times[Math.floor(TICKS * 0.99)] || 1))}`);

console.log(`\n■ Santé finale de l'économie`);
console.log(`  prix/base moyen : ${avgPriceRatio().toFixed(2)} (1,00 = neutre)`);
console.log(`  marchés emballés (>8× base) : ${finalHealth.runaway}/${finalHealth.n} · `
  + `effondrés (<0,12×) : ${finalHealth.collapsed}/${finalHealth.n}`);
console.log(`  prix/stock invalides : ${finalHealth.invalid} · stocks négatifs : ${finalHealth.badStock}`);

console.log(`\n■ Joueur & monde après ${num(TICKS)} jours`);
console.log(`  crédits ${num(finalPlayer.credits)} · prestige ${num(finalPlayer.prestige)} · `
  + `${num(finalPlayer.total_units_sold)} unités vendues · CA ${num(finalPlayer.total_revenue)}`);
console.log(`  guerres survenues : ${wars}`);
// Classement complet des maisons rivales, avec leur écart au joueur : on
// veut une VRAIE course (rivaux à 0,3–1× du joueur), ni un plafond ridicule
// (≪ 0,1×) ni un emballement (≫ 1×).
console.log(`\n■ Classement des maisons rivales (réf. crédits joueur)`);
for (const r of liveRivals) {
  const ratio = finalPlayer.credits > 0 ? r.net_worth / finalPlayer.credits : 0;
  console.log(`  ${r.name.padEnd(24)} ${num(r.net_worth).padStart(12)} cr   ×${ratio.toFixed(2)}`);
}

console.log(`\n${anomalies.length ? '✗ ANOMALIES :\n  ' + anomalies.slice(0, 12).join('\n  ') : '✓ Aucune anomalie structurelle détectée (pas de NaN/Inf, pas de stock négatif)'}\n`);
db.close();
