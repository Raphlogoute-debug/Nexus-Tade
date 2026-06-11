// Point d'entrée : Express (API + fichiers statiques) et boucle de tick.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CONFIG } from './config.js';
import { createDb, getMeta } from './db.js';
import { generateUniverse } from './universe/generator.js';
import { randomSeed } from './universe/rng.js';
import { runTick } from './economy/engine.js';
import { createApiRouter } from './routes/api.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = createDb(path.resolve(rootDir, CONFIG.DB_PATH));

// Premier lancement : pas de seed en DB → on génère l'univers.
if (getMeta(db, 'seed') === null) {
  const { seed, systems, planets } = generateUniverse(db, randomSeed());
  console.log(`✦ Univers généré — seed ${seed} : ${systems} systèmes, ${planets} planètes`);
} else {
  console.log(`✦ Univers chargé — seed ${getMeta(db, 'seed')}`);
}

const app = express();
app.use(express.json());
app.use('/api', createApiRouter(db));
app.use(express.static(path.join(rootDir, 'public')));

app.listen(CONFIG.PORT, () => {
  console.log(`✦ Nexus Trade sur http://localhost:${CONFIG.PORT} (tick toutes les ${CONFIG.TICK_MS} ms)`);
});

const ticker = setInterval(() => {
  const { tick, planets, durationMs } = runTick(db);
  console.log(`  tick ${tick} — ${planets} planètes simulées en ${durationMs} ms`);
}, CONFIG.TICK_MS);

process.on('SIGINT', () => {
  clearInterval(ticker);
  db.close();
  process.exit(0);
});
