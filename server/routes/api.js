// Endpoints REST. Seule la validation des entrées externes (params, body)
// se fait ici — le code interne est de confiance.

import { Router } from 'express';
import { CONFIG } from '../config.js';
import { getMeta, getCurrentTick, wipe } from '../db.js';
import { generateUniverse } from '../universe/generator.js';
import { randomSeed } from '../universe/rng.js';
import { planetSnapshot } from '../economy/engine.js';
import { RECIPES } from '../../data/recipes.js';
import { RESOURCES } from '../../data/resources.js';
import { BIOMES } from '../../data/biomes.js';

// Param d'URL → id entier positif, ou null si invalide.
function parseId(raw) {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

export function createApiRouter(db) {
  const router = Router();

  // ── GET /api/universe : systèmes, planètes, positions ──────────
  router.get('/universe', (req, res) => {
    const systems = db.prepare('SELECT id, name, x, y FROM systems ORDER BY id').all();
    const planets = db.prepare(
      'SELECT id, system_id, name, biome, population FROM planets ORDER BY id'
    ).all();

    const bySystem = new Map(systems.map((s) => [s.id, { ...s, planets: [] }]));
    for (const p of planets) {
      bySystem.get(p.system_id).planets.push({
        id: p.id,
        name: p.name,
        biome: p.biome,
        biomeLabel: BIOMES[p.biome].label,
        population: p.population,
      });
    }

    res.json({
      seed: Number(getMeta(db, 'seed')),
      mapSize: CONFIG.UNIVERSE.MAP_SIZE,
      systems: [...bySystem.values()],
    });
  });

  // ── GET /api/planet/:id : détail d'une planète ─────────────────
  router.get('/planet/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id de planète invalide' });

    const planet = db.prepare(
      `SELECT p.id, p.name, p.biome, p.population, p.system_id, s.name AS system_name
       FROM planets p JOIN systems s ON s.id = p.system_id WHERE p.id = ?`
    ).get(id);
    if (!planet) return res.status(404).json({ error: 'planète inconnue' });

    const industries = db.prepare(
      'SELECT recipe_id, rate FROM planet_industries WHERE planet_id = ? ORDER BY recipe_id'
    ).all(id).map((i) => ({
      ...i,
      name: RESOURCES[i.recipe_id].name,
      inputs: RECIPES[i.recipe_id].inputs,
      output: RECIPES[i.recipe_id].output,
    }));

    res.json({
      ...planet,
      biomeLabel: BIOMES[planet.biome].label,
      industries,
      resources: planetSnapshot(db, id),
    });
  });

  // ── GET /api/market/:planetId : prix + historique récent ───────
  router.get('/market/:planetId', (req, res) => {
    const id = parseId(req.params.planetId);
    if (id === null) return res.status(400).json({ error: 'id de planète invalide' });
    if (!db.prepare('SELECT 1 FROM planets WHERE id = ?').get(id)) {
      return res.status(404).json({ error: 'planète inconnue' });
    }

    const tick = getCurrentTick(db);
    const prices = planetSnapshot(db, id).map(({ resource_id, name, tier, price, basePrice, stock }) =>
      ({ resource_id, name, tier, price, basePrice, stock }));

    // Historique des 60 derniers ticks, groupé par ressource.
    const history = {};
    const rows = db.prepare(
      'SELECT resource_id, tick, price FROM price_history WHERE planet_id = ? AND tick > ? ORDER BY tick'
    ).all(id, tick - 60);
    for (const r of rows) {
      (history[r.resource_id] ??= []).push({ tick: r.tick, price: r.price });
    }

    res.json({ planetId: id, tick, prices, history });
  });

  // ── GET /api/state : état global ───────────────────────────────
  router.get('/state', (req, res) => {
    res.json({
      tick: getCurrentTick(db),
      seed: Number(getMeta(db, 'seed')),
      generatedAt: getMeta(db, 'generated_at'),
      systems: db.prepare('SELECT COUNT(*) AS n FROM systems').get().n,
      planets: db.prepare('SELECT COUNT(*) AS n FROM planets').get().n,
      tickMs: CONFIG.TICK_MS,
    });
  });

  // ── POST /api/admin/regenerate : nouvel univers (dev) ──────────
  // Body optionnel : { "seed": 12345 } pour un univers précis.
  router.post('/admin/regenerate', (req, res) => {
    let seed = req.body?.seed;
    if (seed !== undefined) {
      if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
        return res.status(400).json({ error: 'seed doit être un entier entre 0 et 2^32-1' });
      }
    } else {
      seed = randomSeed();
    }

    wipe(db);
    const result = generateUniverse(db, seed);
    res.json(result);
  });

  return router;
}
