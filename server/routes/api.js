// Endpoints REST. Seule la validation des entrées externes (params, body)
// se fait ici — le code interne est de confiance.
//
// Règle d'information (Phase 2) : les données économiques d'une planète ne
// sont servies en direct que si le vaisseau y est à quai. Sinon, le client
// reçoit ce que le joueur SAIT (dernier relevé, avec son ancienneté).

import { Router } from 'express';
import { CONFIG } from '../config.js';
import { getMeta, setMeta, getCurrentTick, wipe } from '../db.js';
import { generateUniverse } from '../universe/generator.js';
import { randomSeed } from '../universe/rng.js';
import { planetSnapshot } from '../economy/engine.js';
import { RECIPES } from '../../data/recipes.js';
import { RESOURCES } from '../../data/resources.js';
import { BIOMES } from '../../data/biomes.js';
import {
  initPlayer, getPlayer, getShip, getCargo, cargoUsed, tierOf, hasTierAccess,
} from '../player/state.js';
import { previewTrade, executeTrade, refuel, buyLicence } from '../player/trade.js';
import { previewTravel, startTravel } from '../player/travel.js';
import { getConcession, collectConcession, upgradeConcession } from '../player/concession.js';
import {
  knownMarket, knowledgeSummary, intelCost, recordIntel, systemDistance,
} from '../player/knowledge.js';

// Param d'URL → id entier positif, ou null si invalide.
function parseId(raw) {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

// Quantité de body/query → nombre fini > 0, ou null.
function parseQty(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Mappe un résultat { ok, error } des modules joueur vers HTTP.
function answer(res, result) {
  if (result.ok) return res.json(result);
  return res.status(result.refusedTier ? 403 : 400).json(result);
}

export function createApiRouter(db, clock) {
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
        tier: tierOf(p.population),
      });
    }

    res.json({
      seed: Number(getMeta(db, 'seed')),
      mapSize: CONFIG.UNIVERSE.MAP_SIZE,
      systems: [...bySystem.values()],
    });
  });

  // ── GET /api/planet/:id : fiche publique + économie si à quai ──
  router.get('/planet/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id de planète invalide' });

    const planet = db.prepare(
      `SELECT p.id, p.name, p.biome, p.population, p.system_id, s.name AS system_name
       FROM planets p JOIN systems s ON s.id = p.system_id WHERE p.id = ?`
    ).get(id);
    if (!planet) return res.status(404).json({ error: 'planète inconnue' });

    const ship = getShip(db);
    const docked = ship.planet_id === id;
    const payload = {
      ...planet,
      biomeLabel: BIOMES[planet.biome].label,
      tier: tierOf(planet.population),
      docked,
    };

    // Les détails économiques (industries, stocks, flux) sont du
    // renseignement local : il faut être sur place.
    if (docked) {
      payload.industries = db.prepare(
        'SELECT recipe_id, rate FROM planet_industries WHERE planet_id = ? ORDER BY recipe_id'
      ).all(id).map((i) => ({
        ...i,
        name: RESOURCES[i.recipe_id].name,
        inputs: RECIPES[i.recipe_id].inputs,
        output: RECIPES[i.recipe_id].output,
      }));
      payload.resources = planetSnapshot(db, id);
    }

    res.json(payload);
  });

  // ── GET /api/market/:planetId : direct si à quai, sinon connu ──
  router.get('/market/:planetId', (req, res) => {
    const id = parseId(req.params.planetId);
    if (id === null) return res.status(400).json({ error: 'id de planète invalide' });
    if (!db.prepare('SELECT 1 FROM planets WHERE id = ?').get(id)) {
      return res.status(404).json({ error: 'planète inconnue' });
    }

    const tick = getCurrentTick(db);
    const ship = getShip(db);

    if (ship.planet_id === id) {
      const prices = planetSnapshot(db, id).map(
        ({ resource_id, name, tier, price, basePrice, stock }) =>
          ({ resource_id, name, tier, price, basePrice, stock }));

      const history = {};
      const rows = db.prepare(
        'SELECT resource_id, tick, price FROM price_history WHERE planet_id = ? AND tick > ? ORDER BY tick'
      ).all(id, tick - 60);
      for (const r of rows) {
        (history[r.resource_id] ??= []).push({ tick: r.tick, price: r.price });
      }
      return res.json({ planetId: id, tick, live: true, prices, history });
    }

    const known = knownMarket(db, id);
    res.json({
      planetId: id,
      tick,
      live: false,
      known: known.length > 0,
      ageTicks: known.length ? tick - Math.max(...known.map((k) => k.seen_tick)) : null,
      prices: known,
    });
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
      speed: clock.getSpeed(),
      speeds: clock.speeds,
    });
  });

  // ── GET /api/player : joueur, vaisseau, cargo, concession ──────
  router.get('/player', (req, res) => {
    const player = getPlayer(db);
    const ship = getShip(db);
    const cargo = getCargo(db, ship.id).map((c) => ({
      ...c, name: RESOURCES[c.resource_id].name,
    }));
    const concession = getConcession(db);

    const tiers = {};
    for (const [tier, t] of Object.entries(CONFIG.PLAYER.TIERS)) {
      tiers[tier] = {
        minPop: t.minPop,
        prestigeRequired: t.prestige,
        licenceCost: t.licenceCost,
        unlocked: hasTierAccess(player, Number(tier)),
      };
    }

    res.json({
      credits: player.credits,
      prestige: player.prestige,
      licenceTier: player.licence_tier,
      tiers,
      ship: { ...ship, cargo, cargoUsed: cargoUsed(db, ship.id) },
      concession: concession && {
        ...concession,
        resourceName: RESOURCES[concession.resource_id].name,
        planetName: db.prepare('SELECT name FROM planets WHERE id = ?')
          .get(concession.planet_id).name,
      },
      tradePartners: db.prepare('SELECT COUNT(*) AS n FROM trade_partners').get().n,
    });
  });

  // ── GET /api/knowledge : fraîcheur par système (pour la carte) ──
  router.get('/knowledge', (req, res) => {
    const tick = getCurrentTick(db);
    res.json(knowledgeSummary(db).map((k) => ({
      systemId: k.system_id,
      ageTicks: tick - k.last_seen,
    })));
  });

  // ── Commerce ───────────────────────────────────────────────────
  router.get('/trade/preview', (req, res) => {
    const { side, resource } = req.query;
    const quantity = parseQty(req.query.qty);
    if (!['buy', 'sell'].includes(side) || quantity === null) {
      return res.status(400).json({ error: 'paramètres side/qty invalides' });
    }
    answer(res, previewTrade(db, { side, resourceId: resource, quantity }));
  });

  router.post('/trade', (req, res) => {
    const { side, resourceId } = req.body ?? {};
    const quantity = parseQty(req.body?.quantity);
    if (!['buy', 'sell'].includes(side) || quantity === null) {
      return res.status(400).json({ error: 'paramètres side/quantity invalides' });
    }
    answer(res, executeTrade(db, { side, resourceId, quantity }));
  });

  router.post('/refuel', (req, res) => {
    const quantity = req.body?.quantity === undefined ? undefined : parseQty(req.body.quantity);
    if (quantity === null) return res.status(400).json({ error: 'quantité invalide' });
    answer(res, refuel(db, quantity));
  });

  router.post('/licence', (req, res) => {
    const tier = req.body?.tier;
    if (![2, 3].includes(tier)) return res.status(400).json({ error: 'tier invalide (2 ou 3)' });
    answer(res, buyLicence(db, tier));
  });

  // ── Voyage ─────────────────────────────────────────────────────
  router.get('/travel/preview', (req, res) => {
    const planetId = parseId(String(req.query.planetId ?? ''));
    if (planetId === null) return res.status(400).json({ error: 'planetId invalide' });
    res.json(previewTravel(db, planetId));
  });

  router.post('/travel', (req, res) => {
    const planetId = req.body?.planetId;
    if (!Number.isInteger(planetId) || planetId <= 0) {
      return res.status(400).json({ error: 'planetId invalide' });
    }
    answer(res, startTravel(db, planetId, getCurrentTick(db)));
  });

  // ── Concession ─────────────────────────────────────────────────
  router.post('/concession/collect', (req, res) => {
    const quantity = req.body?.quantity === undefined ? undefined : parseQty(req.body.quantity);
    if (quantity === null) return res.status(400).json({ error: 'quantité invalide' });
    answer(res, collectConcession(db, quantity));
  });

  router.post('/concession/upgrade', (req, res) => {
    answer(res, upgradeConcession(db));
  });

  // ── Renseignement ──────────────────────────────────────────────
  router.get('/intel/preview', (req, res) => {
    const systemId = parseId(String(req.query.systemId ?? ''));
    if (systemId === null) return res.status(400).json({ error: 'systemId invalide' });
    if (!db.prepare('SELECT 1 FROM systems WHERE id = ?').get(systemId)) {
      return res.status(404).json({ error: 'système inconnu' });
    }
    const ship = getShip(db);
    if (ship.planet_id === null) return res.status(400).json({ error: 'vaisseau en transit' });
    const from = db.prepare('SELECT system_id FROM planets WHERE id = ?')
      .get(ship.planet_id).system_id;
    res.json({ ok: true, cost: intelCost(db, from, systemId) });
  });

  router.post('/intel', (req, res) => {
    const systemId = req.body?.systemId;
    if (!Number.isInteger(systemId) || systemId <= 0) {
      return res.status(400).json({ error: 'systemId invalide' });
    }
    if (!db.prepare('SELECT 1 FROM systems WHERE id = ?').get(systemId)) {
      return res.status(404).json({ error: 'système inconnu' });
    }
    const ship = getShip(db);
    if (ship.planet_id === null) return res.status(400).json({ error: 'vaisseau en transit' });

    const from = db.prepare('SELECT system_id FROM planets WHERE id = ?')
      .get(ship.planet_id).system_id;
    const cost = intelCost(db, from, systemId);
    const player = getPlayer(db);
    if (player.credits < cost) return res.status(400).json({ ok: false, error: 'crédits insuffisants' });

    db.prepare('UPDATE player SET credits = ROUND(credits - ?, 2) WHERE id = 1').run(cost);
    recordIntel(db, systemId, getCurrentTick(db));
    res.json({ ok: true, cost });
  });

  // ── Temps ──────────────────────────────────────────────────────
  router.post('/time', (req, res) => {
    const speed = req.body?.speed;
    if (!clock.speeds.includes(speed)) {
      return res.status(400).json({ error: `vitesse invalide (${clock.speeds.join(', ')})` });
    }
    clock.setSpeed(speed);
    res.json({ ok: true, speed });
  });

  // Saute jusqu'à l'arrivée du vaisseau en transit.
  router.post('/time/skip', (req, res) => {
    const ship = getShip(db);
    if (ship.planet_id !== null) return res.status(400).json({ error: 'aucun voyage en cours' });
    const played = clock.skipUntil(ship.arrival_tick);
    res.json({ ok: true, ticksPlayed: played, tick: getCurrentTick(db) });
  });

  // ── POST /api/admin/regenerate : nouvel univers + partie (dev) ─
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
    const game = initPlayer(db);
    setMeta(db, 'time_speed', clock.getSpeed());
    res.json({ ...result, ...game });
  });

  return router;
}
