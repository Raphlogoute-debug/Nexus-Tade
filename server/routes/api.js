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
import { RECIPES, recipeOutput, recipeName } from '../../data/recipes.js';
import { RESOURCES, RESOURCE_IDS, CATEGORIES } from '../../data/resources.js';
import { BIOMES } from '../../data/biomes.js';
import {
  initPlayer, getPlayer, getShip, getFleet, getCargo, cargoUsed, tierOf, hasTierAccess,
} from '../player/state.js';
import { buyShip, setShipMode, fleetUpkeep, maxFleet } from '../player/shipyard.js';
import {
  getHouse, renameHouse, setHouseColor, buildHQ, upgradeHQ,
} from '../player/house.js';
import { statsSnapshot } from '../player/stats.js';
import { SCENARIOS } from '../../data/scenarios.js';
import { createRoute, listRoutes, deleteRoute, assignRoute } from '../player/routes.js';
import {
  investIndustry, divestIndustry, foundIndustry, listInvestments, industryValuation, getShare,
} from '../player/investments.js';
import { buyFalseFlag } from '../player/smuggling.js';
import { issueLoan, listLoans } from '../factions/loans.js';
import { previewTrade, executeTrade, refuel, buyLicence } from '../player/trade.js';
import { previewTravel, startTravel } from '../player/travel.js';
import {
  listConcessions, collectConcession, depositToConcession, upgradeConcession,
  buyConcession, installWorkshop, maxConcessions,
} from '../player/concession.js';
import {
  listPosts, buyPost, upgradePost, setPostOrder, deletePostOrder,
  transferPost, maxPosts,
} from '../player/posts.js';
import { listObjectives } from '../player/objectives.js';
import { createMission, cancelMission, listMissions } from '../player/missions.js';
import { equipShip, shipEquipment } from '../player/shipyard.js';
import { depositQuality, depositLabel } from '../player/concession.js';
import {
  listSupplyContracts, contractsAt, acceptSupplyContract, deliverSupplyContract,
} from '../economy/clients.js';
import { signPact, listPacts, pactActive } from '../factions/pacts.js';
import { listMegaprojects, deliverToProject } from '../economy/megaprojects.js';
import {
  listLairs, clearLair, clearLairCost, listSurveys, surveySystem, isSurveyed, colonyBoom,
} from '../economy/frontier.js';
import { setRouteEscort } from '../player/routes.js';
import { techCatalog, researchTech, unlockedRecipes, hasTech } from '../player/tech.js';
import {
  knownMarket, knowledgeSummary, intelCost, recordIntel, systemDistance,
} from '../player/knowledge.js';
import { generateFactions } from '../factions/generate.js';
import { initTraders } from '../npc/traders.js';
import { marketContext } from '../economy/market.js';
import { listContracts, deliverContract, contractAccess } from '../factions/contracts.js';
import { activeWars, warContext } from '../factions/war.js';
import { getStanding } from '../factions/standing.js';
import { supportOf } from '../factions/influence.js';
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
      resources: RESOURCE_IDS.map((id) => ({
        id, name: RESOURCES[id].name, tier: RESOURCES[id].tier,
        basePrice: RESOURCES[id].basePrice, cat: RESOURCES[id].cat,
      })),
      categories: CATEGORIES,
      // Chaînes de production (pour le Codex) : id de recette, produit,
      // intrants. Données statiques, chargées une fois.
      recipes: Object.entries(RECIPES).map(([id, r]) => ({
        id, output: recipeOutput(id), inputs: r.inputs,
        name: recipeName(id),
      })),
    });
  });

  // ── GET /api/market-scan/:resourceId : tout ce que le joueur SAIT
  // d'une ressource, à travers la galaxie (alimente carte thermique +
  // comparateur d'arbitrage). Respecte le brouillard : uniquement les
  // marchés déjà observés (known_prices).
  router.get('/market-scan/:resourceId', (req, res) => {
    const resourceId = req.params.resourceId;
    if (!RESOURCES[resourceId]) return res.status(400).json({ error: 'ressource inconnue' });

    const tick = getCurrentTick(db);
    const rows = db.prepare(
      `SELECT kp.planet_id, kp.price, kp.stock, kp.seen_tick,
              p.name AS planet_name, p.system_id, p.population,
              s.name AS system_name, s.x, s.y, s.faction_id
       FROM known_prices kp
       JOIN planets p ON p.id = kp.planet_id
       JOIN systems s ON s.id = p.system_id
       WHERE kp.resource_id = ?`
    ).all(resourceId);

    res.json({
      resourceId,
      name: RESOURCES[resourceId].name,
      basePrice: RESOURCES[resourceId].basePrice,
      tick,
      markets: rows.map((r) => ({
        planetId: r.planet_id,
        planetName: r.planet_name,
        systemId: r.system_id,
        systemName: r.system_name,
        x: r.x, y: r.y,
        factionId: r.faction_id,
        tier: tierOf(r.population),
        price: r.price,
        stock: r.stock,
        ageTicks: tick - r.seen_tick,
      })),
    });
  });

  // ── GET /api/alerts : ce qui réclame votre attention maintenant ─
  router.get('/alerts', (req, res) => {
    const player = getPlayer(db);
    const alerts = [];

    if (player.credits < 0) {
      alerts.push({ level: 'crit',
        message: `Découvert (${Math.round(player.credits)} cr) — vos vaisseaux restent à quai` });
    } else {
      const upkeep = fleetUpkeep(db);
      const divs = listInvestments(db).reduce((s, i) => s + i.estimatedYield, 0);
      const net = divs - upkeep;
      if (net < 0 && player.credits < -net * 60) {
        alerts.push({ level: 'warn',
          message: `Trésorerie à sec dans ~${Math.floor(player.credits / -net)} jours (${Math.round(net)}/jour)` });
      }
    }

    // Réputation : marchés fermés.
    const blacklisted = db.prepare(
      `SELECT f.name FROM faction_standing fs JOIN factions f ON f.id = fs.faction_id
       WHERE fs.standing <= ?`
    ).all(CONFIG.STANDING.BLACKLIST);
    for (const f of blacklisted) {
      alerts.push({ level: 'warn', message: `Liste noire chez ${f.name} — leurs marchés vous sont fermés` });
    }

    // Concessions : entrepôt saturé, ou guerre sur le système.
    const ctx = warContext(db);
    for (const c of listConcessions(db)) {
      const meta = db.prepare(
        `SELECT p.name, p.system_id, s.faction_id FROM planets p
         JOIN systems s ON s.id = p.system_id WHERE p.id = ?`
      ).get(c.planet_id);
      if (c.cap > 0 && c.used / c.cap >= 0.95) {
        alerts.push({ level: 'warn', planetId: c.planet_id,
          message: `Entrepôt saturé sur ${meta.name} — production perdue` });
      }
      if (ctx.frontSystems.has(meta.system_id)) {
        alerts.push({ level: 'crit', planetId: c.planet_id,
          message: `⚔ Front de guerre sur le système de votre concession (${meta.name})` });
      } else if (meta.faction_id !== null && ctx.factionWar.has(meta.faction_id)) {
        alerts.push({ level: 'warn', planetId: c.planet_id,
          message: `La faction de votre concession ${meta.name} est en guerre` });
      }
    }

    // Vaisseaux automatiques à sec de carburant et incapables de bouger.
    for (const ship of getFleet(db)) {
      if (ship.mode !== 'manual' && ship.planet_id !== null
        && ship.fuel < 5 && player.credits < 100) {
        alerts.push({ level: 'warn', planetId: ship.planet_id,
          message: `${ship.name} est immobilisé (carburant + crédits au plus bas)` });
      }
    }

    res.json(alerts);
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
    // La géologie ne se lit que sur place ou après sondage (prospection).
    const surveyed = isSurveyed(db, id);
    const quality = (docked || surveyed) ? depositQuality(db, id) : null;
    const rivalClaim = db.prepare(
      `SELECT r.name, r.color FROM rival_concessions rc
       JOIN rivals r ON r.id = rc.rival_id WHERE rc.planet_id = ?`).get(id);
    const payload = {
      ...planet,
      biomeLabel: BIOMES[planet.biome].label,
      tier: tierOf(planet.population),
      docked,
      surveyed,
      depositQuality: quality,
      depositLabel: quality === null ? null : depositLabel(quality),
      rivalClaim: rivalClaim ?? null,
      colonyBoom: Boolean(colonyBoom(db, id)),
      clients: contractsAt(db, id),
      megaprojects: listMegaprojects(db).filter((mp) => mp.capital_planet_id === id),
    };

    // Les détails économiques (industries, stocks, flux) sont du
    // renseignement local : il faut être sur place.
    if (docked) {
      payload.industries = db.prepare(
        'SELECT recipe_id, rate FROM planet_industries WHERE planet_id = ? ORDER BY recipe_id'
      ).all(id).map((i) => ({
        ...i,
        name: recipeName(i.recipe_id),
        produces: recipeOutput(i.recipe_id),
        inputs: RECIPES[i.recipe_id].inputs,
        output: RECIPES[i.recipe_id].output,
        valuation: industryValuation(i.recipe_id, i.rate),
        playerShare: getShare(db, id, i.recipe_id),
        maxShare: CONFIG.PLAYER.INVEST.MAX_SHARE,
      }));
      payload.resources = planetSnapshot(db, id);

      // Industries fondables ici (Charte industrielle + filières du joueur).
      if (hasTech(db, 'industrial_charter')) {
        const existing = new Set(payload.industries.map((i) => i.recipe_id));
        const E = CONFIG.ECONOMY;
        const rate = Math.round(
          (E.INDUSTRY_BASE_RATE + E.INDUSTRY_POP_COEF * planet.population) * 100) / 100;
        payload.foundable = [...unlockedRecipes(db)]
          .filter((r) => !existing.has(r))
          .map((r) => ({
            recipe_id: r,
            name: recipeName(r),
            cost: Math.round(industryValuation(r, rate) * CONFIG.PLAYER.FACILITIES.FOUND_MULT),
          }));
      }
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
      progress: clock.getProgress(),
      wars,
      lairs: db.prepare(
        'SELECT pl.system_id, pl.strength FROM pirate_lairs pl').all(),
      rivalClaims: db.prepare(
        `SELECT p.system_id, rc.planet_id, r.color, r.name FROM rival_concessions rc
         JOIN planets p ON p.id = rc.planet_id
         JOIN rivals r ON r.id = rc.rival_id`).all(),
    });
  });

  // ── GET /api/traffic : tout ce qui vole entre les systèmes ──────
  // Convois de factions (shipments) et marchands indépendants en transit,
  // avec coordonnées d'origine/destination — la carte les anime pour
  // montrer un monde vivant. Purement cosmétique : aucune donnée de
  // marché ne fuite (observer des vaisseaux est de bonne guerre).
  router.get('/traffic', (req, res) => {
    const tick = getCurrentTick(db);
    const traders = db.prepare(
      `SELECT t.id, t.departure_tick AS dep, t.arrival_tick AS arr,
              sf.x AS fx, sf.y AS fy, st.x AS tx, st.y AS ty,
              sf.id AS fromSystem, st.id AS toSystem
       FROM traders t
       JOIN planets pf ON pf.id = t.from_planet_id
       JOIN systems sf ON sf.id = pf.system_id
       JOIN planets pt ON pt.id = t.dest_planet_id
       JOIN systems st ON st.id = pt.system_id
       WHERE t.planet_id IS NULL AND t.from_planet_id IS NOT NULL AND sf.id != st.id
       LIMIT 300`
    ).all();
    const convoys = db.prepare(
      `SELECT sh.id, sh.departure_tick AS dep, sh.arrival_tick AS arr, sh.quantity,
              f.color, sf.x AS fx, sf.y AS fy, st.x AS tx, st.y AS ty,
              sf.id AS fromSystem, st.id AS toSystem
       FROM shipments sh
       LEFT JOIN factions f ON f.id = sh.faction_id
       JOIN planets pf ON pf.id = sh.from_planet_id
       JOIN systems sf ON sf.id = pf.system_id
       JOIN planets pt ON pt.id = sh.to_planet_id
       JOIN systems st ON st.id = pt.system_id
       WHERE sh.departure_tick <= ? AND sh.arrival_tick > ? AND sf.id != st.id
       ORDER BY sh.arrival_tick LIMIT 500`
    ).all(tick, tick);
    res.json({ tick, traders, convoys });
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
      equipment: shipEquipment(db, s.id),
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
      maxFleet: maxFleet(db),
      fleetUpkeep: fleetUpkeep(db),
      concessions,
      nextConcessionPrice: CONFIG.PLAYER.FACILITIES.CONCESSION_BASE_PRICE
        * 2 ** Math.max(0, concessions.length - 1),
      maxConcessions: maxConcessions(db),
      posts: listPosts(db),
      nextPostPrice: CONFIG.PLAYER.POSTS.BASE_PRICE
        * 2 ** db.prepare('SELECT COUNT(*) AS n FROM trading_posts').get().n,
      maxPosts: maxPosts(db),
      maxPostOrders: CONFIG.PLAYER.POSTS.MAX_ORDERS,
      // Ateliers installables (selon les filières recherchées).
      workshopCatalog: (() => {
        const unlocked = unlockedRecipes(db);
        const FAC = CONFIG.PLAYER.FACILITIES;
        return Object.keys(RECIPES).map((rid) => ({
          recipe_id: rid,
          name: recipeName(rid),
          produces: recipeOutput(rid),
          cost: FAC.WORKSHOP_COST_OVERRIDE[rid]
            ?? FAC.WORKSHOP_COST[RESOURCES[recipeOutput(rid)].tier],
          unlocked: unlocked.has(rid),
        }));
      })(),
      investments: listInvestments(db),
      missions: listMissions(db),
      supplyContracts: listSupplyContracts(db, 'taken'),
      pacts: listPacts(db),
      equipmentCatalog: CONFIG.SHIPS.EQUIPMENT,
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

  router.post('/industry/found', (req, res) => {
    const { recipeId } = req.body ?? {};
    const shipId = parseShipId(req.body?.shipId);
    if (typeof recipeId !== 'string' || shipId === null) {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, foundIndustry(db, recipeId, shipId));
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
    answer(res, startTravel(db, planetId, getCurrentTick(db), shipId, req.body?.escort === true));
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

  // ── Comptoirs commerciaux (Phase 10) ───────────────────────────
  router.post('/posts/buy', (req, res) => {
    const shipId = parseShipId(req.body?.shipId);
    if (shipId === null) return res.status(400).json({ error: 'shipId invalide' });
    answer(res, buyPost(db, shipId));
  });

  router.post('/posts/:id/upgrade', (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id invalide' });
    answer(res, upgradePost(db, id));
  });

  // Poser/remplacer un ordre permanent (un par ressource et par sens).
  router.post('/posts/:id/orders', (req, res) => {
    const id = parseId(req.params.id);
    const { resourceId, side } = req.body ?? {};
    const limitPrice = Number(req.body?.limitPrice);
    const flow = Number(req.body?.flow);
    if (id === null || typeof resourceId !== 'string' || typeof side !== 'string') {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, setPostOrder(db, id, resourceId, side, limitPrice, flow));
  });

  router.delete('/posts/:id/orders/:orderId', (req, res) => {
    const id = parseId(req.params.id);
    const orderId = parseId(req.params.orderId);
    if (id === null || orderId === null) return res.status(400).json({ error: 'id invalide' });
    answer(res, deletePostOrder(db, id, orderId));
  });

  // Transferts soute ↔ entrepôt du comptoir.
  router.post('/posts/transfer', (req, res) => {
    const shipId = parseShipId(req.body?.shipId);
    const { resourceId, direction } = req.body ?? {};
    const quantity = req.body?.quantity === undefined ? undefined : parseQty(req.body.quantity);
    if (shipId === null || typeof resourceId !== 'string' || quantity === null) {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, transferPost(db, shipId, resourceId, quantity, direction));
  });

  // ── Missions de vente : « vendre N de X à tel marché » ──────────
  router.post('/missions', (req, res) => {
    const { resourceId, fromPlanetId, toPlanetId } = req.body ?? {};
    const quantity = Number(req.body?.quantity);
    if (typeof resourceId !== 'string' || !Number.isInteger(fromPlanetId)
      || !Number.isInteger(toPlanetId)) {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, createMission(db, {
      resourceId, quantity, fromPlanetId, toPlanetId,
      recurring: req.body?.recurring === true,
    }));
  });

  router.delete('/missions/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id invalide' });
    answer(res, cancelMission(db, id));
  });

  // ── Équipement des vaisseaux ────────────────────────────────────
  router.post('/ships/:id/equip', (req, res) => {
    const id = parseId(req.params.id);
    const moduleId = req.body?.moduleId;
    if (id === null || typeof moduleId !== 'string') {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, equipShip(db, id, moduleId));
  });

  // ── Clients réguliers (contrats d'approvisionnement) ────────────
  router.post('/clients/:id/accept', (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id invalide' });
    answer(res, acceptSupplyContract(db, id));
  });

  router.post('/clients/:id/deliver', (req, res) => {
    const id = parseId(req.params.id);
    const shipId = parseShipId(req.body?.shipId);
    if (id === null || shipId === null) return res.status(400).json({ error: 'paramètres invalides' });
    answer(res, deliverSupplyContract(db, id, shipId));
  });

  // ── Accords commerciaux ─────────────────────────────────────────
  router.post('/factions/:id/pact', (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id invalide' });
    answer(res, signPact(db, id));
  });

  // ── Phase 15 : observatoire, chantiers, frontière ───────────────
  router.get('/observatory', (req, res) => {
    res.json({
      history: db.prepare('SELECT * FROM empire_history ORDER BY tick').all(),
      routes: db.prepare('SELECT id, name, earned, always_escort FROM routes ORDER BY earned DESC').all(),
      megaprojects: listMegaprojects(db),
      lairs: listLairs(db).map((l) => ({ ...l, clearCost: clearLairCost(l.strength) })),
    });
  });

  router.post('/megaprojects/:id/deliver', (req, res) => {
    const id = parseId(req.params.id);
    const shipId = parseShipId(req.body?.shipId);
    const resourceId = req.body?.resourceId;
    if (id === null || shipId === null || typeof resourceId !== 'string') {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, deliverToProject(db, id, resourceId, shipId));
  });

  router.get('/surveys', (req, res) => {
    res.json(listSurveys(db));
  });

  router.post('/surveys', (req, res) => {
    const systemId = req.body?.systemId;
    const shipId = parseShipId(req.body?.shipId);
    if (!Number.isInteger(systemId) || shipId === null) {
      return res.status(400).json({ error: 'paramètres invalides' });
    }
    answer(res, surveySystem(db, systemId, shipId));
  });

  router.post('/lairs/:systemId/clear', (req, res) => {
    const systemId = parseId(req.params.systemId);
    if (systemId === null) return res.status(400).json({ error: 'id invalide' });
    answer(res, clearLair(db, systemId));
  });

  router.post('/routes/:id/escort', (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id invalide' });
    answer(res, setRouteEscort(db, id, req.body?.escorted === true));
  });

  // ── Objectifs / fin de partie ───────────────────────────────────
  router.get('/objectives', (req, res) => {
    res.json(listObjectives(db));
  });

  // ── Maison de commerce : identité + quartier général ────────────
  router.get('/house', (req, res) => {
    res.json(getHouse(db));
  });

  router.post('/house/rename', (req, res) => {
    answer(res, renameHouse(db, req.body?.name));
  });

  router.post('/house/color', (req, res) => {
    answer(res, setHouseColor(db, req.body?.color));
  });

  router.post('/hq/build', (req, res) => {
    const shipId = parseShipId(req.body?.shipId);
    if (shipId === null) return res.status(400).json({ error: 'shipId invalide' });
    answer(res, buildHQ(db, shipId));
  });

  router.post('/hq/upgrade', (req, res) => {
    answer(res, upgradeHQ(db));
  });

  // ── Statistiques & classement des maisons ───────────────────────
  router.get('/stats', (req, res) => {
    res.json(statsSnapshot(db));
  });

  // ── GET /api/wars : le tableau de bord du profiteur de guerre ───
  // Pour chaque guerre : les deux camps, leurs pénuries stratégiques aux
  // capitales (prix vs base — où vendre cher), votre réputation et vos
  // créances de chaque côté, les fronts. Vendre aux DEUX camps est tout
  // l'art : chaque camp paie, et la guerre dure.
  router.get('/wars', (req, res) => {
    const ctx = warContext(db);
    const player = getPlayer(db);
    const sideOf = (factionId, war) => {
      const f = db.prepare('SELECT * FROM factions WHERE id = ?').get(factionId);
      const shortages = Object.keys(CONFIG.FLEET.BUILD).map((resourceId) => {
        const m = marketContext(db, f.capital_planet_id, resourceId);
        return {
          resource_id: resourceId,
          name: RESOURCES[resourceId].name,
          price: m.price,
          basePrice: m.basePrice,
          ratio: Math.round((m.price / m.basePrice) * 100) / 100,
          pressure: Math.round(Math.max(0, (m.target - m.stock) / m.target) * 100) / 100,
        };
      }).sort((a, b) => b.ratio - a.ratio);
      return {
        id: f.id,
        name: f.name,
        color: f.color,
        capitalPlanetId: f.capital_planet_id,
        capitalName: db.prepare('SELECT name FROM planets WHERE id = ?')
          .get(f.capital_planet_id).name,
        capitalSystemId: db.prepare('SELECT system_id FROM planets WHERE id = ?')
          .get(f.capital_planet_id).system_id,
        fleet: Math.round(f.fleet),
        fleet0: Math.round(war.attacker_id === f.id ? war.attacker_fleet0 : war.defender_fleet0),
        readiness: Math.round(f.readiness * 100) / 100,
        standing: Math.round(getStanding(db, f.id)),
        support: Math.round(supportOf(db, f.id)),
        shortages,
        openLoans: db.prepare(
          "SELECT COALESCE(SUM(amount), 0) AS s FROM loans WHERE faction_id = ? AND status = 'open'"
        ).get(f.id).s,
        contracts: db.prepare(
          "SELECT COUNT(*) AS n FROM contracts WHERE faction_id = ? AND status = 'open'"
        ).get(f.id).n,
      };
    };
    res.json({
      warProfit: player.war_profit ?? 0,
      wars: ctx.wars.map((war) => ({
        id: war.id,
        since: war.started_tick,
        attacker: sideOf(war.attacker_id, war),
        defender: sideOf(war.defender_id, war),
        fronts: db.prepare(
          `SELECT wf.system_id, wf.pressure, s.name FROM war_fronts wf
           JOIN systems s ON s.id = wf.system_id WHERE wf.war_id = ?`
        ).all(war.id),
      })),
    });
  });

  // ── Catalogue des scénarios de départ ───────────────────────────
  router.get('/scenarios', (req, res) => {
    res.json(SCENARIOS.map((s) => ({
      id: s.id, name: s.name, desc: s.desc, difficulty: s.difficulty,
    })));
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
      pact: pactActive(db, id),
      pactCost: CONFIG.PACTS.COST,
      pactStandingRequired: CONFIG.PACTS.STANDING_REQUIRED,
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
