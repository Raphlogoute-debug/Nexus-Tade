// Point d'entrée : Express (API + fichiers statiques) et horloge de
// simulation contrôlable (pause / ×1 / ×2 / ×4, saut jusqu'à l'arrivée).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CONFIG } from './config.js';
import { createDb, getMeta, setMeta, getCurrentTick } from './db.js';
import { generateUniverse, ensureResourceRows } from './universe/generator.js';
import { randomSeed } from './universe/rng.js';
import { runTick } from './simulation.js';
import { generateFactions } from './factions/generate.js';
import { initTraders } from './npc/traders.js';
import { initPlayer, getPlayer, getShip } from './player/state.js';
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

// Nouvelles ressources du catalogue : les parties existantes reçoivent
// les lignes de marché manquantes.
const addedRows = ensureResourceRows(db);
if (addedRows > 0) console.log(`✦ Catalogue étendu : ${addedRows} marchés ajoutés aux planètes existantes`);

// Factions et marchands : créés s'ils manquent (migration des parties
// antérieures à la Phase 3 comprise).
if (!db.prepare('SELECT 1 FROM factions LIMIT 1').get()) {
  const { factions } = generateFactions(db);
  console.log(`✦ ${factions} factions fondées`);
}
if (!db.prepare('SELECT 1 FROM traders LIMIT 1').get()) {
  const { traders } = initTraders(db);
  console.log(`✦ ${traders} marchands indépendants en activité`);
}

// Nouvelle partie si aucun joueur (couvre aussi les DB de la Phase 1).
if (!getPlayer(db)) {
  const { homePlanetId, concessionResource } = initPlayer(db);
  console.log(`✦ Nouvelle partie — concession de ${concessionResource} sur la planète #${homePlanetId}`);
}

// ── Horloge ──────────────────────────────────────────────────────
// La vitesse multiplie la fréquence des ticks (0 = pause). Le saut
// exécute les ticks de façon synchrone jusqu'à l'arrivée du vaisseau.

const SPEEDS = [0, 1, 2, 4];

function createClock() {
  let speed = Number(getMeta(db, 'time_speed') ?? 1);
  let timer = null;

  function tickOnce() {
    const r = runTick(db);
    if (r.tick % 10 === 0 || r.events.length > 0) {
      console.log(`  tick ${r.tick} — ${r.planets} planètes, ${r.durationMs} ms`
        + (r.events.length ? ` — ${r.events.length} événement(s)` : ''));
    }
  }

  function reschedule() {
    if (timer) clearInterval(timer);
    timer = speed > 0 ? setInterval(tickOnce, CONFIG.TICK_MS / speed) : null;
  }

  return {
    speeds: SPEEDS,
    getSpeed: () => speed,
    setSpeed(s) {
      speed = s;
      setMeta(db, 'time_speed', s);
      reschedule();
    },
    // Avance jusqu'au tick cible (borné). Retourne le nombre de ticks joués.
    skipUntil(targetTick) {
      let played = 0;
      while (getCurrentTick(db) < targetTick && played < CONFIG.PLAYER.SKIP_MAX_TICKS) {
        runTick(db);
        played++;
      }
      return played;
    },
    start: reschedule,
    stop: () => timer && clearInterval(timer),
  };
}

const clock = createClock();

const app = express();
app.use(express.json());
app.use('/api', createApiRouter(db, clock));
app.use(express.static(path.join(rootDir, 'public')));

app.listen(CONFIG.PORT, () => {
  const ship = getShip(db);
  console.log(`✦ Nexus Trade sur http://localhost:${CONFIG.PORT}`
    + ` (tick ${CONFIG.TICK_MS} ms ×${clock.getSpeed()}, vaisseau sur planète #${ship.planet_id ?? 'transit'})`);
});

clock.start();

process.on('SIGINT', () => {
  clock.stop();
  db.close();
  process.exit(0);
});
