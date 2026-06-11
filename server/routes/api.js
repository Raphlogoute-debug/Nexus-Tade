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
  initPlayer, getPlayer, getShip, getFleet, getCargo, cargoUsed, tierOf, hasTierAccess,
} from '../player/state.js';
import { buyShip, setShipMode, fleetUpkeep } from '../player/shipyard.js';
import { createRoute, listRoutes, deleteRoute, assignRoute } from '../player/routes.js';
import {
  investIndustry, divestIndustry, listInvestments, industryValuation, getShare,
} from '../player/investments.js';
import { buyFalseFlag } from '../player/smuggling.js';
import { issueLoan, listLoans } from '../factions/loans.js';
import { previewTrade, executeTrade, refuel, buyLicence } from '../player/trade.js';
import { previewTravel, startTravel } from '../player/travel.js';
import {
  listConcessions, collectConcession, depositToConcession, upgradeConcession,
  buyConcession, installWorkshop,
} from '../player/concession.js';
import { techCatalog, researchTech, unlockedRecipes } from '../player/tech.js';
import {
  knownMarket, knowledgeSummary, intelCost, recordIntel, systemDistance,
} from '../player/knowledge.js';
import { generateFactions } from '../factions/generate.js';
import { initTraders } from '../npc/traders.js';
import { marketContext } from '../economy/market.js';
import { listContracts, deliverContract, contractAccess } from '../factions/contracts.js';
import { activeWars, warContext } from '../factions/war.js';
import { getStanding } from '../factions/standing.js';
import { recentEvents } from '../events.js';

// Param d'URL → id entier positif, ou null si invalide.
function parseId(raw) {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

// shipId optionnel (body ou query) : undefined = vaisseau-amiral,
// null = invalide.
function parseShipId(raw) {
  if (raw === undefined) return undefined;
  return Number.isInteger(raw) && raw > 0 ? raw
    : /^\d+$/.test(String(raw)) ? Number(raw) : null;
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

  // ── GET /api/universe : systèmes, planètes, positions, factions ─
  router.get('/universe', (req, res) => {
    const systems = db.prepare('SELECT id, name, x, y, faction_id FROM systems ORDER BY id').all();
    const planets = db.prepare(
      'SELECT id, system_id, name, biome, population FROM planets ORDER BY id'
    ).all();
    const factions = db.prepare(
      'SELECT id, name, color, capital_planet_id FROM factions ORDER BY id'
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
      factions,
    });
  });

  // ── GET /api/planet/:id : fiche publique + économie si à quai ──
  router.get('/planet/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id de planète invalide' });

    const planet = db.prepare(
      `SELECT p.id, p.name, p.biome, p.population, p.supply, p.system_id,
              s.name AS system_name, s.faction_id,
              f.name AS faction_name, f.color AS faction_color
       FROM planets p
       JOIN systems s ON s.id = p.system_id
       LEFT JOIN factions f ON f.id = s.faction_id
       WHERE p.id = ?`
    ).get(id);
    if (!planet) return res.status(404).json({ error: 'planète inconnue' });

    // À quai = au moins un vaisseau de VOTRE flotte est amarré ici.
    const docked = getFleet(db).some((s) => s.planet_id === id);
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
        valuation: industryValuation(i.recipe_id, i.rate),
        playerShare: getShare(db, id, i.recipe_id),
        maxShare: CONFIG.PLAYER.INVEST.MAX_SHARE,
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

    if (getFleet(db).some((s) => s.planet_id === id)) {
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

  // ── GET /api/state : état global (+ guerres en cours) ──────────
  router.get('/state', (req, res) => {
    const wars = activeWars(db).map((w) => ({
      id: w.id,
      attacker: db.prepare('SELECT name FROM factions WHERE id = ?').get(w.attacker_id).name,
      defender: db.prepare('SELECT name FROM factions WHERE id = ?').get(w.defender_id).name,
      since: w.started_tick,
      fronts: db.prepare('SELECT system_id FROM war_fronts WHERE war_id = ?')
        .all(w.id).map((f) => f.system_id),
    }));
    res.json({
      tick: getCurrentTick(db),
      seed: Number(getMeta(db, 'seed')),
      generatedAt: getMeta(db, 'generated_at'),
      systems: db.prepare('SELECT COUNT(*) AS n FROM systems').get().n,
      planets: db.prepare('SELECT COUNT(*) AS n FROM planets').get().n,
      tickMs: CONFIG.TICK_MS,
      speed: clock.getSpeed(),
      speeds: clock.speeds,
      wars,
    });
  });

  // ── GET /api/events?since=ID : fil d'événements du monde ────────
  router.get('/events', (req, res) => {
    const since = /^\d+$/.test(String(req.query.since ?? '')) ? Number(req.query.since) : 0;
    res.json(recentEvents(db, since));
  });

  // ── GET /api/player : joueur, flotte, cargo, concession ────────
  router.get('/player', (req, res) => {
    const player = getPlayer(db);
    const ships = getFleet(db).map((s) => ({
      ...s,
      classLabel: CONFIG.SHIPS.CLASSES[s.class]?.label ?? s.class,
      cargo: getCargo(db, s.id).map((c) => ({ ...c, name: RESOURCES[c.resource_id].name })),
      cargoUsed: cargoUsed(db, s.id),
    }));
    const concessions = listConcessions(db).map((c) => ({
      ...c,
      resourceName: RESOURCES[c.resource_id].name,
      planetName: db.prepare('SELECT name FROM planets WHERE id = ?').get(c.planet_id).name,
    }));

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
      ships,
      ship: ships[0], // compatibilité : le vaisseau-amiral
      shipClasses: CONFIG.SHIPS.CLASSES,
      maxFleet: CONFIG.SHIPS.MAX_FLEET,
      fleetUpkeep: fleetUpkeep(db),
      concessions,
      nextConcessionPrice: CONFIG.PLAYER.FACILITIES.CONCESSION_BASE_PRICE
        * 2 ** Math.max(0, concessions.length - 1),
      maxConcessions: CONFIG.PLAYER.FACILITIES.MAX_CONCESSIONS,
      // Ateliers installables (selon les filières recherchées).
      workshopCatalog: (() => {
        const unlocked = unlockedRecipes(db);
        const FAC = CONFIG.PLAYER.FACILITIES;
        return Object.keys(RECIPES).map((rid) => ({
          recipe_id: rid,
          name: RESOURCES[rid].name,
          cost: FAC.WORKSHOP_COST_OVERRIDE[rid] ?? FAC.WORKSHOP_COST[RESOURCES[rid].tier],
          unlocked: unlocked.has(rid),
        }));
      })(),
      investments: listInvestments(db),
      loans: listLoans(db),
      tradePartners: db.prepare('SELECT COUNT(*) AS n FROM trade_partners').get().n,
    });
  });

  // ── Contrebande & finance de guerre ────────────────────────────
  router.post('/ships/:id/flag', (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id de vaisseau invalide' });
    answer(res, buyFalseFlag(db, id));
  });

  router.post('/loans', (req, res) => {
    const { factionId, amount } = req.body ?? {};
    if (!Number.isInteger(factionId) || !Number.isFinite(amount)) {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, issueLoan(db, factionId, amount));
  });

  // ── Parts d'industries ─────────────────────────────────────────
  router.post('/industry/invest', (req, res) => {
    const { recipeId, share } = req.body ?? {};
    const shipId = parseShipId(req.body?.shipId);
    if (typeof recipeId !== 'string' || !Number.isFinite(share) || shipId === null) {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, investIndustry(db, recipeId, share, shipId));
  });

  router.post('/industry/divest', (req, res) => {
    const { recipeId } = req.body ?? {};
    const shipId = parseShipId(req.body?.shipId);
    if (typeof recipeId !== 'string' || shipId === null) {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, divestIndustry(db, recipeId, shipId));
  });

  // ── Technologies ───────────────────────────────────────────────
  router.get('/tech', (req, res) => {
    res.json(techCatalog(db));
  });

  router.post('/tech/research', (req, res) => {
    const techId = req.body?.techId;
    if (typeof techId !== 'string') return res.status(400).json({ error: 'techId requis' });
    answer(res, researchTech(db, techId));
  });

  // ── Flotte : achat et automatisation ───────────────────────────
  router.post('/ships/buy', (req, res) => {
    const classId = req.body?.classId;
    if (typeof classId !== 'string') return res.status(400).json({ error: 'classId requis' });
    answer(res, buyShip(db, classId));
  });

  router.post('/ships/:id/mode', (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id de vaisseau invalide' });
    answer(res, setShipMode(db, id, req.body?.mode));
  });

  // ── Routes logistiques ─────────────────────────────────────────
  router.get('/routes', (req, res) => {
    res.json(listRoutes(db));
  });

  router.post('/routes', (req, res) => {
    answer(res, createRoute(db, req.body?.name, req.body?.stops));
  });

  router.delete('/routes/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id de route invalide' });
    answer(res, deleteRoute(db, id));
  });

  router.post('/ships/:id/route', (req, res) => {
    const id = parseId(req.params.id);
    const routeId = req.body?.routeId;
    if (id === null || (routeId !== null && !Number.isInteger(routeId))) {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, assignRoute(db, id, routeId));
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
    const shipId = parseShipId(req.query.shipId);
    if (!['buy', 'sell'].includes(side) || quantity === null || shipId === null) {
      return res.status(400).json({ error: 'paramètres side/qty/shipId invalides' });
    }
    answer(res, previewTrade(db, { side, resourceId: resource, quantity, shipId }));
  });

  router.post('/trade', (req, res) => {
    const { side, resourceId } = req.body ?? {};
    const quantity = parseQty(req.body?.quantity);
    const shipId = parseShipId(req.body?.shipId);
    if (!['buy', 'sell'].includes(side) || quantity === null || shipId === null) {
      return res.status(400).json({ error: 'paramètres side/quantity/shipId invalides' });
    }
    answer(res, executeTrade(db, { side, resourceId, quantity, shipId }));
  });

  router.post('/refuel', (req, res) => {
    const quantity = req.body?.quantity === undefined ? undefined : parseQty(req.body.quantity);
    const shipId = parseShipId(req.body?.shipId);
    if (quantity === null || shipId === null) return res.status(400).json({ error: 'paramètres invalides' });
    answer(res, refuel(db, quantity, shipId));
  });

  router.post('/licence', (req, res) => {
    const tier = req.body?.tier;
    if (![2, 3].includes(tier)) return res.status(400).json({ error: 'tier invalide (2 ou 3)' });
    answer(res, buyLicence(db, tier));
  });

  // ── Voyage ─────────────────────────────────────────────────────
  router.get('/travel/preview', (req, res) => {
    const planetId = parseId(String(req.query.planetId ?? ''));
    const shipId = parseShipId(req.query.shipId);
    if (planetId === null || shipId === null) return res.status(400).json({ error: 'paramètres invalides' });
    res.json(previewTravel(db, planetId, shipId));
  });

  router.post('/travel', (req, res) => {
    const planetId = req.body?.planetId;
    const shipId = parseShipId(req.body?.shipId);
    if (!Number.isInteger(planetId) || planetId <= 0 || shipId === null) {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, startTravel(db, planetId, getCurrentTick(db), shipId));
  });

  // ── Concessions & ateliers ─────────────────────────────────────
  router.post('/concession/collect', (req, res) => {
    const quantity = req.body?.quantity === undefined ? undefined : parseQty(req.body.quantity);
    const shipId = parseShipId(req.body?.shipId);
    const resourceId = req.body?.resourceId; // optionnel
    if (quantity === null || shipId === null) return res.status(400).json({ error: 'paramètres invalides' });
    answer(res, collectConcession(db, quantity, shipId, resourceId));
  });

  router.post('/concession/deposit', (req, res) => {
    const quantity = req.body?.quantity === undefined ? undefined : parseQty(req.body.quantity);
    const shipId = parseShipId(req.body?.shipId);
    const resourceId = req.body?.resourceId;
    if (quantity === null || shipId === null || typeof resourceId !== 'string') {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, depositToConcession(db, resourceId, quantity, shipId));
  });

  router.post('/concession/upgrade', (req, res) => {
    const concessionId = req.body?.concessionId;
    if (!Number.isInteger(concessionId)) return res.status(400).json({ error: 'concessionId requis' });
    answer(res, upgradeConcession(db, concessionId));
  });

  router.post('/concessions/buy', (req, res) => {
    const shipId = parseShipId(req.body?.shipId);
    if (shipId === null) return res.status(400).json({ error: 'shipId invalide' });
    answer(res, buyConcession(db, shipId));
  });

  router.post('/concessions/:id/workshops', (req, res) => {
    const id = parseId(req.params.id);
    const recipeId = req.body?.recipeId;
    if (id === null || typeof recipeId !== 'string') {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, installWorkshop(db, id, recipeId));
  });

  // ── Renseignement ──────────────────────────────────────────────
  router.get('/intel/preview', (req, res) => {
    const systemId = parseId(String(req.query.systemId ?? ''));
    const shipId = parseShipId(req.query.shipId);
    if (systemId === null || shipId === null) return res.status(400).json({ error: 'paramètres invalides' });
    if (!db.prepare('SELECT 1 FROM systems WHERE id = ?').get(systemId)) {
      return res.status(404).json({ error: 'système inconnu' });
    }
    const ship = getShip(db, shipId);
    if (!ship || ship.planet_id === null) return res.status(400).json({ error: 'vaisseau en transit' });
    const from = db.prepare('SELECT system_id FROM planets WHERE id = ?')
      .get(ship.planet_id).system_id;
    res.json({ ok: true, cost: intelCost(db, from, systemId) });
  });

  router.post('/intel', (req, res) => {
    const systemId = req.body?.systemId;
    const shipId = parseShipId(req.body?.shipId);
    if (!Number.isInteger(systemId) || systemId <= 0 || shipId === null) {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    if (!db.prepare('SELECT 1 FROM systems WHERE id = ?').get(systemId)) {
      return res.status(404).json({ error: 'système inconnu' });
    }
    const ship = getShip(db, shipId);
    if (!ship || ship.planet_id === null) return res.status(400).json({ error: 'vaisseau en transit' });

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

  // Saute jusqu'à l'arrivée du vaisseau (piloté) en transit.
  router.post('/time/skip', (req, res) => {
    const shipId = parseShipId(req.body?.shipId);
    if (shipId === null) return res.status(400).json({ error: 'shipId invalide' });
    const ship = getShip(db, shipId);
    if (!ship || ship.planet_id !== null) return res.status(400).json({ error: 'aucun voyage en cours' });
    const played = clock.skipUntil(ship.arrival_tick);
    res.json({ ok: true, ticksPlayed: played, tick: getCurrentTick(db) });
  });

  // ── Factions ───────────────────────────────────────────────────
  router.get('/factions', (req, res) => {
    const factions = db.prepare(
      `SELECT f.*, p.name AS capital_name,
              (SELECT COUNT(*) FROM systems s WHERE s.faction_id = f.id) AS systems,
              (SELECT COUNT(*) FROM planets pl JOIN systems s ON s.id = pl.system_id
                WHERE s.faction_id = f.id) AS planets
       FROM factions f JOIN planets p ON p.id = f.capital_planet_id ORDER BY f.id`
    ).all();
    res.json(factions);
  });

  router.get('/faction/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id de faction invalide' });
    const faction = db.prepare(
      `SELECT f.*, p.name AS capital_name, p.id AS capital_id,
              (SELECT COUNT(*) FROM systems s WHERE s.faction_id = f.id) AS systems,
              (SELECT COUNT(*) FROM planets pl JOIN systems s ON s.id = pl.system_id
                WHERE s.faction_id = f.id) AS planets
       FROM factions f JOIN planets p ON p.id = f.capital_planet_id WHERE f.id = ?`
    ).get(id);
    if (!faction) return res.status(404).json({ error: 'faction inconnue' });

    // Tensions stratégiques à la capitale (info publique : les pénuries
    // d'un royaume se savent — c'est ce qui attire les marchands).
    const shortages = [];
    for (const resourceId of Object.keys(CONFIG.FLEET.BUILD)) {
      const m = marketContext(db, faction.capital_planet_id, resourceId);
      const pressure = (m.target - m.stock) / m.target;
      if (pressure > 0.25) {
        shortages.push({
          resource_id: resourceId,
          name: RESOURCES[resourceId].name,
          pressure: Math.round(pressure * 100) / 100,
          price: m.price,
        });
      }
    }

    const player = getPlayer(db);
    const access = contractAccess(db, player, id);

    // Guerres et relations de la faction.
    const ctx = warContext(db);
    const war = ctx.factionWar.get(id) ?? null;
    const factionName = db.prepare('SELECT id, name FROM factions WHERE id = ?');
    const relations = db.prepare(
      'SELECT * FROM faction_relations WHERE faction_a = ? OR faction_b = ?'
    ).all(id, id).map((r) => {
      const otherId = r.faction_a === id ? r.faction_b : r.faction_a;
      return { faction: factionName.get(otherId), relation: r.relation, atWar: r.war_id !== null };
    }).sort((a, b) => a.relation - b.relation);

    res.json({
      ...faction,
      standing: Math.round(getStanding(db, id) * 10) / 10,
      war: war && {
        enemy: factionName.get(war.attacker_id === id ? war.defender_id : war.attacker_id).name,
        since: war.started_tick,
        fronts: db.prepare(
          `SELECT s.name, wf.pressure FROM war_fronts wf
           JOIN systems s ON s.id = wf.system_id WHERE wf.war_id = ?`
        ).all(war.id),
      },
      relations,
      shortages: shortages.sort((a, b) => b.pressure - a.pressure),
      contractAccess: access.ok,
      contractAccessReason: access.ok ? null : access.error,
      contracts: listContracts(db).filter((c) => c.faction_id === id),
    });
  });

  // ── Contrats ───────────────────────────────────────────────────
  router.get('/contracts', (req, res) => {
    const player = getPlayer(db);
    res.json(listContracts(db).map((c) => ({
      ...c,
      access: contractAccess(db, player, c.faction_id).ok,
    })));
  });

  router.post('/contracts/:id/deliver', (req, res) => {
    const id = parseId(req.params.id);
    const shipId = parseShipId(req.body?.shipId);
    if (id === null || shipId === null) return res.status(400).json({ error: 'paramètres invalides' });
    answer(res, deliverContract(db, id, shipId));
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
    const factions = generateFactions(db);
    const traders = initTraders(db);
    const game = initPlayer(db);
    setMeta(db, 'time_speed', clock.getSpeed());
    res.json({ ...result, ...factions, ...traders, ...game });
  });

  return router;
}
