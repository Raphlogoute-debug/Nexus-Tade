// Banc d'essai : mesure le coût réel d'un tick SUR DISQUE (le cas du
// vrai jeu — la base :memory: du verify est ~3× plus rapide), avec une
// partie chargée : univers complet, factions, marchands PNJ, joueur,
// 20 vaisseaux automatiques et une route logistique.
//
// Usage : npm run bench

import fs from 'node:fs';
import { createDb } from '../server/db.js';
import { generateUniverse } from '../server/universe/generator.js';
import { generateFactions } from '../server/factions/generate.js';
import { initTraders } from '../server/npc/traders.js';
import { initPlayer, getShip } from '../server/player/state.js';
import { buyShip, setShipMode } from '../server/player/shipyard.js';
import { createRoute, assignRoute } from '../server/player/routes.js';
import { runTick } from '../server/simulation.js';

const DB_PATH = '/tmp/nexus-bench.db';
const WARMUP = 10;
const TICKS = 80;

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const db = createDb(DB_PATH);
const t0 = Date.now();
generateUniverse(db, 424242);
generateFactions(db);
initTraders(db);
initPlayer(db);
console.log(`génération : ${Date.now() - t0} ms`);

// Une flotte chargée : 20 autos + 1 route.
db.prepare('UPDATE player SET credits = 10000000, prestige = 5000, licence_tier = 3 WHERE id = 1').run();
const t2 = db.prepare('SELECT id FROM planets WHERE population >= 50 LIMIT 1').get();
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(t2.id, getShip(db).id);
const classes = ['courier', 'freighter', 'hauler'];
for (let i = 0; i < 20; i++) {
  const r = buyShip(db, classes[i % 3]);
  if (r.ok) setShipMode(db, r.shipId, 'auto');
}
const other = db.prepare('SELECT id FROM planets WHERE id != ? LIMIT 1').get(t2.id);
const route = createRoute(db, 'Bench', [
  { planetId: t2.id, actions: [{ type: 'buy', resourceId: 'water', quantity: 50 }] },
  { planetId: other.id, actions: [{ type: 'sell', resourceId: null, quantity: null }] },
]);
assignRoute(db, getShip(db).id, route.id);

for (let i = 0; i < WARMUP; i++) runTick(db);

const times = [];
const start = Date.now();
for (let i = 0; i < TICKS; i++) times.push(runTick(db).durationMs);
const wall = Date.now() - start;
times.sort((a, b) => a - b);

const size = (fs.statSync(DB_PATH).size + (fs.existsSync(`${DB_PATH}-wal`) ? fs.statSync(`${DB_PATH}-wal`).size : 0)) / 1e6;
console.log(`${TICKS} ticks sur disque (21 vaisseaux joueur actifs) :`);
console.log(`  médiane ${times[TICKS / 2]} ms | p90 ${times[Math.floor(TICKS * 0.9)]} ms | max ${times[TICKS - 1]} ms`);
console.log(`  débit : ${Math.round(TICKS / (wall / 1000))} ticks/s soutenus | DB+WAL : ${size.toFixed(1)} Mo`);
db.close();
