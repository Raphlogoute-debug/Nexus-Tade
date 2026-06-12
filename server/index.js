// Point d'entrée : Express (API + fichiers statiques) et horloge de
// simulation contrôlable (pause / ×1 / ×2 / ×4, saut jusqu'à l'arrivée).
// La partie active vit dans un « holder » qu'on peut remplacer à chaud
// (changement de sauvegarde) sans redémarrer le serveur.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CONFIG } from './config.js';
import { setMeta, getCurrentTick } from './db.js';
import { runTick } from './simulation.js';
import { getShip } from './player/state.js';
import { openGame } from './game.js';
import { listSaves, newSave, deleteSave, migrateLegacy, ensureSavesDir } from './saves.js';
import { createApiRouter } from './routes/api.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAVES_DIR = path.resolve(rootDir, 'saves');

// ── Horloge ──────────────────────────────────────────────────────
// La vitesse multiplie la fréquence des ticks (0 = pause). Le saut
// exécute les ticks de façon synchrone jusqu'à l'arrivée du vaisseau.

const SPEEDS = [0, 1, 2, 4];

function createClock(db) {
  let speed = Number(db.prepare("SELECT value FROM meta WHERE key = 'time_speed'").get()?.value ?? 1);
  let timer = null;
  let lastTickAt = Date.now();

  function tickOnce() {
    const r = runTick(db);
    lastTickAt = Date.now();
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
    getProgress: () => speed === 0 ? 0
      : Math.min(1, (Date.now() - lastTickAt) / (CONFIG.TICK_MS / speed)),
    setSpeed(s) {
      speed = s;
      setMeta(db, 'time_speed', s);
      reschedule();
    },
    skipUntil(targetTick) {
      let played = 0;
      while (getCurrentTick(db) < targetTick && played < CONFIG.PLAYER.SKIP_MAX_TICKS) {
        runTick(db);
        played++;
      }
      lastTickAt = Date.now();
      return played;
    },
    start: reschedule,
    stop: () => timer && clearInterval(timer),
  };
}

// ── Partie active (holder remplaçable) ───────────────────────────

ensureSavesDir(SAVES_DIR);
migrateLegacy(SAVES_DIR, path.resolve(rootDir, CONFIG.DB_PATH));

// La partie à ouvrir au démarrage : la dernière jouée, ou une neuve.
function pickStartupSave() {
  const saves = listSaves(SAVES_DIR);
  if (saves.length > 0) return saves[0].file;
  const created = newSave(SAVES_DIR, { name: 'Première partie', scenario: 'colporteur' });
  return created.file;
}

const game = { db: null, clock: null, file: null, apiRouter: null };

function loadGame(file) {
  if (game.clock) game.clock.stop();
  if (game.db) game.db.close();
  game.file = file;
  game.db = openGame(path.join(SAVES_DIR, file));
  game.clock = createClock(game.db);
  game.apiRouter = createApiRouter(game.db, game.clock);
  game.clock.start();
  const seed = game.db.prepare("SELECT value FROM meta WHERE key = 'seed'").get()?.value;
  console.log(`✦ Partie « ${file} » chargée — seed ${seed}`);
}

loadGame(pickStartupSave());

// ── Serveur ──────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Gestion des sauvegardes : routeur stable (monté en premier), avec accès
// au holder pour basculer de partie à chaud.
app.use('/api/saves', createSavesRouter());

// API de jeu : délègue toujours au routeur de la partie courante.
app.use('/api', (req, res, next) => game.apiRouter(req, res, next));

app.use(express.static(path.join(rootDir, 'public')));

app.listen(CONFIG.PORT, () => {
  const ship = getShip(game.db);
  console.log(`✦ Nexus Trade sur http://localhost:${CONFIG.PORT}`
    + ` (tick ${CONFIG.TICK_MS} ms ×${game.clock.getSpeed()},`
    + ` vaisseau sur planète #${ship?.planet_id ?? 'transit'})`);
});

process.on('SIGINT', () => {
  game.clock?.stop();
  game.db?.close();
  process.exit(0);
});

// ── Routeur des sauvegardes ──────────────────────────────────────

function createSavesRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ active: game.file, saves: listSaves(SAVES_DIR, game.file, game.db) });
  });

  router.post('/new', (req, res) => {
    const { name, scenario, seed, settings } = req.body ?? {};
    try {
      const created = newSave(SAVES_DIR, { name, scenario, seed, settings });
      loadGame(created.file); // on bascule aussitôt sur la nouvelle partie
      res.json({ ok: true, ...created, active: created.file });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e.message ?? e) });
    }
  });

  router.post('/load', (req, res) => {
    const file = path.basename(String(req.body?.file ?? ''));
    if (!fs.existsSync(path.join(SAVES_DIR, file))) {
      return res.status(404).json({ ok: false, error: 'sauvegarde introuvable' });
    }
    loadGame(file);
    res.json({ ok: true, active: file });
  });

  router.delete('/:file', (req, res) => {
    const r = deleteSave(SAVES_DIR, req.params.file, game.file);
    res.status(r.ok ? 200 : 400).json(r);
  });

  return router;
}
