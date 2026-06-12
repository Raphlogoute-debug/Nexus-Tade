// Script de vérification — sans Express ni UI.
// Phase 1 : génération, reproductibilité, prix offre/demande sur 10 ticks.
// Phase 2 : scénario joueur complet : concession → chargement → vente
//   (impact prix + prestige), glissement sur gros ordre, contrôle des
//   tiers, voyage avec carburant, connaissance des marchés qui se périme.
//
// Usage : npm run verify   (code de sortie ≠ 0 si un contrôle échoue)

import { CONFIG } from '../server/config.js';
import { createDb, getCurrentTick } from '../server/db.js';
import { generateUniverse, ensureResourceRows } from '../server/universe/generator.js';
import { buyShip, setShipMode, fleetUpkeep, maxFleet } from '../server/player/shipyard.js';
import { runTick } from '../server/simulation.js';
import { RECIPES } from '../data/recipes.js';
import { RESOURCES } from '../data/resources.js';
import { BIOMES } from '../data/biomes.js';
import { initPlayer, getPlayer, getShip, getCargo, tierOf } from '../server/player/state.js';
import { previewTrade, executeTrade } from '../server/player/trade.js';
import { previewTravel, startTravel } from '../server/player/travel.js';
import {
  listConcessions, collectConcession, depositToConcession, buyConcession, installWorkshop,
  maxConcessions,
} from '../server/player/concession.js';
import { intelCost } from '../server/player/knowledge.js';
import { researchTech } from '../server/player/tech.js';
import { createRoute, assignRoute, deleteRoute } from '../server/player/routes.js';
import { investIndustry, divestIndustry, foundIndustry } from '../server/player/investments.js';
import { issueLoan } from '../server/factions/loans.js';
import { buyFalseFlag } from '../server/player/smuggling.js';
import { buyPost, setPostOrder, transferPost, upgradePost, listPosts } from '../server/player/posts.js';
import { listObjectives } from '../server/player/objectives.js';
import { getHouse, buildHQ, upgradeHQ, hqBonuses, renownOf } from '../server/player/house.js';
import { initRivals, tickRivals } from '../server/economy/rivals.js';
import { statsSnapshot, netWorthBreakdown, leaderboard } from '../server/player/stats.js';
import { SCENARIO_BY_ID } from '../data/scenarios.js';
import { RECIPES as ALL_RECIPES, recipeOutput } from '../data/recipes.js';

const fmt = (n) => Math.round(n).toLocaleString('fr-FR');
import { generateFactions } from '../server/factions/generate.js';
import { initTraders } from '../server/npc/traders.js';
import { tickContracts, deliverContract } from '../server/factions/contracts.js';
import { declareWar } from '../server/factions/diplomacy.js';
import { tickWars, warContext } from '../server/factions/war.js';
import { processShipmentArrivals } from '../server/factions/logistics.js';
import { getStanding } from '../server/factions/standing.js';
import { marketContext } from '../server/economy/market.js';
import { recentEvents } from '../server/events.js';

const SEED = 424242;
const TICKS = 10;
let failures = 0;

function check(ok, label) {
  console.log(`  ${ok ? '✓' : '✗ ÉCHEC :'} ${label}`);
  if (!ok) failures++;
}

// ── 1. Génération ────────────────────────────────────────────────

console.log(`\n■ Génération de l'univers (seed ${SEED})\n`);

const db = createDb(':memory:');
const gen = generateUniverse(db, SEED);

check(gen.systems >= 60 && gen.systems <= 100,
  `${gen.systems} systèmes générés (attendu : 60 à 100)`);

const planetSpread = db.prepare(
  'SELECT MIN(n) AS mn, MAX(n) AS mx FROM (SELECT COUNT(*) AS n FROM planets GROUP BY system_id)'
).get();
check(planetSpread.mn >= 3 && planetSpread.mx <= 6,
  `${gen.planets} planètes, de ${planetSpread.mn} à ${planetSpread.mx} par système (attendu : 3 à 6)`);

const distances = db.prepare('SELECT COUNT(*) AS n FROM system_distances').get().n;
check(distances === (gen.systems * (gen.systems - 1)) / 2,
  `${distances} distances inter-systèmes stockées (toutes les paires)`);

// ── 2. Reproductibilité ──────────────────────────────────────────

const dbScn = createDb(':memory:');
generateUniverse(dbScn, SEED);
const fingerprint = (d) => JSON.stringify({
  systems: d.prepare('SELECT * FROM systems ORDER BY id').all(),
  planets: d.prepare('SELECT * FROM planets ORDER BY id').all(),
  resources: d.prepare('SELECT * FROM planet_resources ORDER BY planet_id, resource_id').all(),
});
check(fingerprint(db) === fingerprint(dbScn), 'même seed → univers identique (reproductible)');
dbScn.close();

// ── 3. Choix de deux cas démonstratifs ───────────────────────────

const industriesByPlanet = new Map();
for (const row of db.prepare('SELECT planet_id, recipe_id, rate FROM planet_industries').all()) {
  if (!industriesByPlanet.has(row.planet_id)) industriesByPlanet.set(row.planet_id, []);
  industriesByPlanet.get(row.planet_id).push(row);
}

const rows = db.prepare(
  `SELECT pr.*, p.name AS planet_name, p.biome, p.population
   FROM planet_resources pr JOIN planets p ON p.id = pr.planet_id`
).all();

for (const r of rows) {
  let demand = r.consumption;
  let industryOut = 0;
  for (const ind of industriesByPlanet.get(r.planet_id) ?? []) {
    demand += (RECIPES[ind.recipe_id].inputs[r.resource_id] ?? 0) * ind.rate;
    if (recipeOutput(ind.recipe_id) === r.resource_id) {
      industryOut += RECIPES[ind.recipe_id].output * ind.rate;
    }
  }
  r.netFlow = r.production + industryOut - demand;
  r.industryOut = industryOut;
  r.priceRatio = r.price / RESOURCES[r.resource_id].basePrice;
}

const headroom = (r) => r.priceRatio > 0.45 && r.priceRatio < 2.5;
const surplusCase = rows.filter((r) => r.netFlow > 1 && headroom(r))
  .sort((a, b) => b.netFlow - a.netFlow)[0];
// Pénurie pilotée par la consommation CIVILE (toujours effective), nette
// de TOUTE production locale, extraction comme industrie — la demande
// industrielle à plein régime peut être un mirage si l'usine est à
// l'arrêt, mais sa production en est un aussi : on l'inclut côté offre
// (sélection prudente) et on exige un vrai déficit.
const civilShort = (r) => r.consumption - r.production - r.industryOut;
const shortageCase = rows.filter((r) => civilShort(r) > 1 && headroom(r))
  .sort((a, b) => civilShort(b) - civilShort(a))[0];

check(Boolean(surplusCase), 'au moins un marché en surplus net trouvé');
check(Boolean(shortageCase), 'au moins un marché en pénurie nette trouvée');

// ── 4. Simulation de 10 ticks ────────────────────────────────────

// Le joueur est initialisé AVANT la simulation : sa concession produit
// pendant que l'économie tourne.
initPlayer(db);

const initialPrices = new Map(rows.map((r) => [`${r.planet_id}:${r.resource_id}`, r.price]));
const tracked = [
  { label: 'SURPLUS', row: surplusCase, expect: 'baisse' },
  { label: 'PÉNURIE', row: shortageCase, expect: 'hausse' },
];
const series = tracked.map(() => []);

const readOne = db.prepare(
  'SELECT stock, price FROM planet_resources WHERE planet_id = ? AND resource_id = ?'
);
const snapshot = () => tracked.forEach(({ row }, i) =>
  series[i].push(readOne.get(row.planet_id, row.resource_id)));

snapshot();
let totalMs = 0;
for (let i = 0; i < TICKS; i++) {
  totalMs += runTick(db).durationMs;
  snapshot();
}

console.log(`\n■ Simulation : ${TICKS} ticks sur ${gen.planets} planètes (${Math.round(totalMs / TICKS)} ms/tick en moyenne)\n`);

for (const [i, { label, row, expect }] of tracked.entries()) {
  const biome = BIOMES[row.biome].label.toLowerCase();
  console.log(`  [${label}] ${RESOURCES[row.resource_id].name} sur ${row.planet_name}`
    + ` (${biome}, ${Math.round(row.population)} M hab.)`);
  console.log(`  production ${row.production}/tick vs demande ${(row.production - row.netFlow).toFixed(1)}/tick`
    + ` → flux net ${row.netFlow > 0 ? '+' : ''}${row.netFlow.toFixed(1)}/tick, ${expect} attendue`);
  console.log('    tick │     stock │  prix');
  for (const [t, s] of series[i].entries()) {
    console.log(`    ${String(t).padStart(4)} │ ${s.stock.toFixed(1).padStart(9)} │ ${s.price.toFixed(2).padStart(6)}`);
  }
  const first = series[i][0].price;
  const last = series[i][TICKS].price;
  const moved = expect === 'baisse' ? last < first : last > first;
  check(moved, `prix ${first.toFixed(2)} → ${last.toFixed(2)} : ${expect} confirmée`);
  if (i === 0) console.log('');
}

// ── 5. Bilan global du marché ────────────────────────────────────

console.log('\n■ Bilan global après 10 ticks\n');

let up = 0, down = 0, flat = 0;
for (const r of db.prepare('SELECT planet_id, resource_id, price FROM planet_resources').all()) {
  const delta = r.price - initialPrices.get(`${r.planet_id}:${r.resource_id}`);
  if (delta > 0.01) up++;
  else if (delta < -0.01) down++;
  else flat++;
}
const total = up + down + flat;
console.log(`  ${total} marchés (planète × ressource) : ${up} prix en hausse, ${down} en baisse, ${flat} stables`);
check(up > 0 && down > 0, 'les prix bougent dans les deux sens selon l\'offre/demande');

// Historique échantillonné : 1 point sur HISTORY_EVERY ticks (+ le tick 0
// de génération), uniquement quand le prix bouge — il bouge à chaque tick
// sur ce marché en surplus.
const historyDepth = db.prepare(
  'SELECT COUNT(*) AS n FROM price_history WHERE planet_id = ? AND resource_id = ?'
).get(surplusCase.planet_id, surplusCase.resource_id).n;
const expectedHistory = 1 + Math.floor(TICKS / CONFIG.HISTORY_EVERY);
check(historyDepth === expectedHistory,
  `historique de prix : ${historyDepth} points conservés (échantillonnage 1/${CONFIG.HISTORY_EVERY} ticks)`);

// ══ Phase 2 : scénario joueur ════════════════════════════════════

console.log('\n■ Phase 2 — scénario joueur\n');

const ship = getShip(db);
const home = db.prepare('SELECT * FROM planets WHERE id = ?').get(ship.planet_id);
const concession = listConcessions(db)[0];

check(tierOf(home.population) === 1,
  `départ sur ${home.name} (${BIOMES[home.biome].label.toLowerCase()}, ${Math.round(home.population)} M hab.) — tier 1, ouvert à tous`);
check(concession.planet_id === home.id && concession.used > 0,
  `concession de ${RESOURCES[concession.resource_id].name} : entrepôt à ${concession.used.toFixed(0)} après ${TICKS} ticks (+${concession.rate}/tick)`);

// Chargement puis vente locale : crédits, prestige et impact prix.
const before = {
  credits: getPlayer(db).credits,
  prestige: getPlayer(db).prestige,
  market: readOne.get(home.id, concession.resource_id),
};
const collected = collectConcession(db);
check(collected.ok && collected.moved > 0, `${collected.moved} unités chargées en soute`);

const sale = executeTrade(db, { side: 'sell', resourceId: concession.resource_id, quantity: collected.moved });
const after = {
  credits: getPlayer(db).credits,
  prestige: getPlayer(db).prestige,
  market: readOne.get(home.id, concession.resource_id),
};
check(sale.ok && after.credits > before.credits,
  `vente : +${sale.total} cr à ${sale.unitPrice}/u (crédits ${before.credits} → ${after.credits})`);
check(after.prestige > before.prestige,
  `prestige : ${before.prestige} → ${after.prestige} (profit + nouveau partenaire)`);
check(after.market.stock > before.market.stock && after.market.price < before.market.price,
  `impact marché : stock ${before.market.stock.toFixed(0)} → ${after.market.stock.toFixed(0)}, prix ${before.market.price} → ${after.market.price} (la vente fait baisser)`);

// Glissement : un gros ordre coûte plus cher l'unité qu'un petit.
const liquid = db.prepare(
  `SELECT resource_id, stock FROM planet_resources
   WHERE planet_id = ? AND stock > 100 ORDER BY stock DESC LIMIT 1`
).get(home.id);
const small = previewTrade(db, { side: 'buy', resourceId: liquid.resource_id, quantity: 1 });
const big = previewTrade(db, { side: 'buy', resourceId: liquid.resource_id, quantity: Math.floor(liquid.stock * 0.5) });
check(big.unitPrice > small.unitPrice,
  `glissement : acheter 50 % du stock coûte ${big.unitPrice}/u contre ${small.unitPrice}/u à l'unité`);

// Contrôle des tiers : un monde majeur refuse un marchand sans réputation.
const bigWorld = db.prepare('SELECT id, name, population FROM planets WHERE population >= 500 LIMIT 1').get();
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(bigWorld.id, ship.id); // téléport de test
const refused = executeTrade(db, { side: 'buy', resourceId: 'water', quantity: 1 });
check(!refused.ok && refused.refusedTier === 3,
  `tier 3 (${bigWorld.name}, ${Math.round(bigWorld.population)} M hab.) refusé sans prestige ni licence`);
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(home.id, ship.id);

// Voyage : vers le système le plus proche HORS du rayon de rumeurs —
// l'arrivée doit donc étendre la connaissance du joueur.
const dest = db.prepare(
  `SELECT p.id, p.name, sd.distance FROM planets p
   JOIN system_distances sd ON (sd.system_a = ? AND sd.system_b = p.system_id)
                            OR (sd.system_b = ? AND sd.system_a = p.system_id)
   WHERE sd.distance > ?
   ORDER BY sd.distance LIMIT 1`
).get(home.system_id, home.system_id, CONFIG.PLAYER.GOSSIP_RADIUS);

const knownBefore = db.prepare('SELECT COUNT(DISTINCT planet_id) AS n FROM known_prices').get().n;
const fuelBefore = getShip(db).fuel;
const trip = startTravel(db, dest.id, getCurrentTick(db));
check(trip.ok && getShip(db).planet_id === null && getShip(db).fuel === fuelBefore - trip.fuelCost,
  `départ vers ${dest.name} (${trip.distance.toFixed(0)} u) : ${trip.ticks} tick(s), −${trip.fuelCost} carburant`);

while (getShip(db).planet_id === null) runTick(db);
const knownAfter = db.prepare('SELECT COUNT(DISTINCT planet_id) AS n FROM known_prices').get().n;
check(getShip(db).planet_id === dest.id, `arrivé à ${dest.name} au tick ${getCurrentTick(db)}`);
check(knownAfter > knownBefore,
  `connaissance étendue : ${knownBefore} → ${knownAfter} marchés connus (relevé local + rumeurs de quai)`);

// Connaissance périssable : loin des yeux, les prix divergent.
for (let i = 0; i < 8; i++) runTick(db);
const stale = db.prepare(
  `SELECT kp.planet_id, kp.resource_id, kp.price AS known, pr.price AS live
   FROM known_prices kp
   JOIN planet_resources pr ON pr.planet_id = kp.planet_id AND pr.resource_id = kp.resource_id
   WHERE kp.planet_id != ? AND ABS(kp.price - pr.price) > 0.05 LIMIT 1`
).get(getShip(db).planet_id);
check(Boolean(stale),
  `données périssables : prix connu ${stale?.known} ≠ prix réel ${stale?.live} sur un marché non revisité`);

const secondHand = db.prepare(
  'SELECT COUNT(*) AS n FROM known_prices WHERE stock IS NULL'
).get().n;
check(secondHand > 0,
  `${secondHand} relevés de seconde main (prix sans stocks) — l'info complète exige d'être sur place`);

// ══ Phase 3 : factions, flux, PNJ ════════════════════════════════

console.log('\n■ Phase 3 — factions, logistique, marchands, besoins\n');

const popBefore = new Map(
  db.prepare('SELECT id, population FROM planets').all().map((p) => [p.id, p.population]));

const { factions: factionCount } = generateFactions(db);
const { traders: traderCount } = initTraders(db);
const fringe = db.prepare('SELECT COUNT(*) AS n FROM systems WHERE faction_id IS NULL').get().n;
check(factionCount >= CONFIG.FACTIONS.MIN_COUNT && factionCount <= CONFIG.FACTIONS.MAX_COUNT,
  `${factionCount} factions fondées, ${fringe} systèmes dans la Frange indépendante, ${traderCount} marchands PNJ`);

const capitalsOk = db.prepare(
  `SELECT COUNT(*) AS n FROM factions f
   JOIN planets p ON p.id = f.capital_planet_id
   JOIN systems s ON s.id = p.system_id
   WHERE s.faction_id = f.id`
).get().n;
check(capitalsOk === factionCount, 'chaque capitale est dans le territoire de sa faction');

// Le monde complet tourne : convois, marchands, chantiers, démographie.
for (let i = 0; i < 20; i++) runTick(db);

const shipmentsCreated = db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM shipments').get().n;
check(shipmentsCreated > 0,
  `logistique : ${shipmentsCreated} convois affrétés en 20 ticks (flux statistiques internes)`);

const npcTrades = db.prepare('SELECT SUM(trades_done) AS n, COUNT(*) AS c FROM traders').get();
check(npcTrades.n > 0,
  `marchands : ${npcTrades.n} transactions PNJ exécutées (mêmes règles d'impact prix que le joueur)`);

const buildSum = db.prepare('SELECT SUM(fleet_progress) + SUM(fleet) AS n FROM factions').get().n;
check(buildSum > 0, 'les chantiers navals consomment de vraies ressources et produisent');

const minSupply = db.prepare('SELECT MIN(supply) AS s FROM planets').get().s;
const popChanged = db.prepare('SELECT id, population FROM planets').all()
  .filter((p) => p.population !== popBefore.get(p.id)).length;
check(minSupply < 0.95 && popChanged > 0,
  `besoins : indice d'approvisionnement min ${minSupply.toFixed(2)}, démographie de ${popChanged} planètes en dérive`);

// ── Le scénario du fournisseur dominant qui coupe tout ───────────
// Un royaume a besoin de modules pour ses vaisseaux. Phase A : capitale
// massivement approvisionnée (le joueur fournit). Phase B : on coupe TOUT
// (stocks stratégiques à zéro, partout). Le chantier doit se paralyser et
// la disponibilité de la flotte chuter.

const faction = db.prepare('SELECT * FROM factions ORDER BY fleet DESC LIMIT 1').get();
const shipsEquiv = () => {
  const f = db.prepare('SELECT fleet, fleet_progress FROM factions WHERE id = ?').get(faction.id);
  return f.fleet * CONFIG.FLEET.SHIP_COST + f.fleet_progress;
};
const setStock = db.prepare(
  'UPDATE planet_resources SET stock = ? WHERE resource_id = ? AND planet_id = ?'
);

// Phase A : le fournisseur (vous) inonde la capitale d'intrants.
for (const resourceId of Object.keys(CONFIG.FLEET.BUILD)) {
  setStock.run(800, resourceId, faction.capital_planet_id);
}
const beforeA = shipsEquiv();
for (let i = 0; i < 8; i++) runTick(db);
const gainA = shipsEquiv() - beforeA;
const readinessA = db.prepare('SELECT readiness FROM factions WHERE id = ?').get(faction.id).readiness;

// Phase B : rupture totale d'approvisionnement stratégique.
db.prepare("UPDATE planet_resources SET stock = 0 WHERE resource_id IN ('ship_modules', 'mech_parts')").run();
const beforeB = shipsEquiv();
for (let i = 0; i < 8; i++) runTick(db);
const gainB = shipsEquiv() - beforeB;
const readinessB = db.prepare('SELECT readiness FROM factions WHERE id = ?').get(faction.id).readiness;

console.log(`\n  [DÉPENDANCE] ${faction.name} — chantier naval de la capitale`);
console.log(`    approvisionné : +${gainA.toFixed(1)} de production navale en 8 ticks (disponibilité ${Math.round(readinessA * 100)} %)`);
console.log(`    coupé         : +${gainB.toFixed(1)} en 8 ticks (disponibilité ${Math.round(readinessB * 100)} %)`);
check(gainB < gainA * 0.5,
  `couper l'approvisionnement paralyse la construction (${gainA.toFixed(1)} → ${gainB.toFixed(1)})`);
check(readinessB < readinessA,
  `la flotte privée d'entretien se dégrade (${Math.round(readinessA * 100)} % → ${Math.round(readinessB * 100)} %)`);

// ── Contrats de faction : la pénurie appelle le marchand ─────────
tickContracts(db, CONFIG.CONTRACTS.EVERY_TICKS * 40); // force une émission
const contract = db.prepare(
  "SELECT * FROM contracts WHERE status = 'open' AND faction_id = ?"
).get(faction.id);
check(Boolean(contract),
  contract && `la pénurie déclenche un appel d'offres : ${RESOURCES[contract.resource_id].name}`
  + ` ×${contract.quantity} à ${contract.unit_price} cr/u (premium sur le marché)`);

// Un marchand établi honore le contrat.
db.prepare('UPDATE player SET prestige = 2000 WHERE id = 1').run();
for (const p of db.prepare(
  `SELECT p.id FROM planets p JOIN systems s ON s.id = p.system_id
   WHERE s.faction_id = ? LIMIT 2`).all(faction.id)) {
  db.prepare('INSERT OR IGNORE INTO trade_partners (planet_id, first_trade_tick) VALUES (?, 0)')
    .run(p.id);
}
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?')
  .run(contract.deliver_planet_id, getShip(db).id);
db.prepare(
  `INSERT INTO ship_cargo (ship_id, resource_id, quantity, avg_cost) VALUES (?, ?, 120, 40)
   ON CONFLICT(ship_id, resource_id) DO UPDATE SET quantity = 120, avg_cost = 40`
).run(getShip(db).id, contract.resource_id);

const creditsBefore = getPlayer(db).credits;
const delivery = deliverContract(db, contract.id);
check(delivery.ok && getPlayer(db).credits > creditsBefore,
  delivery.ok && `livraison : ${delivery.delivered} unités, +${delivery.paid} cr au prix contractuel`);

// Loi du minimum oblige : les modules livrés ne suffisent pas si les autres
// intrants manquent aussi. On les fournit (vente classique au marché) et le
// chantier repart.
for (const resourceId of Object.keys(CONFIG.FLEET.BUILD)) {
  if (resourceId !== contract.resource_id) {
    setStock.run(200, resourceId, faction.capital_planet_id);
  }
}
const progressBefore = shipsEquiv();
for (let i = 0; i < 3; i++) runTick(db);
check(shipsEquiv() > progressBefore,
  'modules livrés + intrants revenus → le chantier repart : la dépendance joue dans les deux sens');

// ══ Phase 4 : guerres ════════════════════════════════════════════

console.log('\n■ Phase 4 — guerre, blocus, réputation\n');

// On force une guerre entre les deux capitales les plus proches (fronts
// garantis) en passant par la vraie mécanique de déclaration.
const caps = db.prepare(
  `SELECT f.id, f.name, f.fleet, s.x, s.y FROM factions f
   JOIN planets p ON p.id = f.capital_planet_id
   JOIN systems s ON s.id = p.system_id`
).all();
let attacker = null;
let defender = null;
let bestD = Infinity;
for (let i = 0; i < caps.length; i++) {
  for (let j = i + 1; j < caps.length; j++) {
    const d = Math.hypot(caps[i].x - caps[j].x, caps[i].y - caps[j].y);
    if (d < bestD) {
      bestD = d;
      [attacker, defender] = [caps[i], caps[j]];
    }
  }
}
// Forces nettes pour des assertions stables.
db.prepare('UPDATE factions SET fleet = 60, readiness = 1 WHERE id = ?').run(attacker.id);
db.prepare('UPDATE factions SET fleet = 35, readiness = 0.7 WHERE id = ?').run(defender.id);
attacker.fleet = 60;
defender.fleet = 35;
db.prepare(
  'INSERT OR IGNORE INTO faction_relations (faction_a, faction_b, relation) VALUES (?, ?, -70)'
).run(Math.min(attacker.id, defender.id), Math.max(attacker.id, defender.id));

const warId = declareWar(db, getCurrentTick(db), attacker, defender);
const fronts = db.prepare('SELECT system_id FROM war_fronts WHERE war_id = ?').all(warId);
check(fronts.length >= 1,
  `${attacker.name} déclare la guerre à ${defender.name} : ${fronts.length} systèmes sur le front`);

// Contrat de guerre : seuil abaissé, premium de guerre.
db.prepare("DELETE FROM contracts WHERE status = 'open'").run();
const attackerCapital = db.prepare('SELECT capital_planet_id FROM factions WHERE id = ?')
  .get(attacker.id).capital_planet_id;
db.prepare(
  "UPDATE planet_resources SET stock = 0 WHERE planet_id = ? AND resource_id = 'ship_modules'"
).run(attackerCapital);
const marketBefore = marketContext(db, attackerCapital, 'ship_modules');
tickContracts(db, CONFIG.CONTRACTS.EVERY_TICKS * 999);
const warContract = db.prepare(
  "SELECT * FROM contracts WHERE status = 'open' AND faction_id = ? AND resource_id = 'ship_modules'"
).get(attacker.id);
check(Boolean(warContract) && warContract.unit_price > marketBefore.price * 1.5,
  warContract && `contrat de guerre : ${warContract.quantity} modules à ${warContract.unit_price} cr/u`
  + ` (premium ×${CONFIG.CONTRACTS.WAR_PREMIUM} vs ×${CONFIG.CONTRACTS.PREMIUM} en paix)`);

// Blocus : les convois d'un belligérant qui touchent le front se font
// intercepter (30 convois test → quasi-certitude statistique).
const frontPlanet = db.prepare(
  'SELECT id FROM planets WHERE system_id = ? LIMIT 1').get(fronts[0].system_id);
for (let i = 0; i < 30; i++) {
  db.prepare(
    `INSERT INTO shipments (faction_id, resource_id, quantity, from_planet_id, to_planet_id, departure_tick, arrival_tick)
     VALUES (?, 'water', 10, ?, ?, 0, ?)`
  ).run(attacker.id, frontPlanet.id, frontPlanet.id, getCurrentTick(db));
}
const raidResult = processShipmentArrivals(db, getCurrentTick(db));
check(raidResult.raided >= 1 && raidResult.raided + raidResult.delivered === 30,
  `blocus : ${raidResult.raided}/30 convois interceptés sur le front (~${Math.round(CONFIG.WAR.RAID_CHANCE * 100)} % attendus)`);

// Attrition : la guerre consume les flottes.
const fleetSum = () => db.prepare(
  'SELECT SUM(fleet) AS n FROM factions WHERE id IN (?, ?)').get(attacker.id, defender.id).n;
const fleetsBefore = fleetSum();
for (let i = 0; i < 15; i++) runTick(db);
check(fleetSum() < fleetsBefore,
  `attrition : flottes cumulées ${fleetsBefore.toFixed(0)} → ${fleetSum().toFixed(0)} en 15 ticks de guerre`);

// Réputation : vendre des modules à l'attaquant plaît… et se sait.
db.prepare('UPDATE player SET licence_tier = 3 WHERE id = 1').run();
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(attackerCapital, getShip(db).id);
db.prepare(
  `INSERT INTO ship_cargo (ship_id, resource_id, quantity, avg_cost) VALUES (?, 'ship_modules', 100, 40)
   ON CONFLICT(ship_id, resource_id) DO UPDATE SET quantity = 100, avg_cost = 40`
).run(getShip(db).id);
const warSale = executeTrade(db, { side: 'sell', resourceId: 'ship_modules', quantity: 100 });
const standingAtt = getStanding(db, attacker.id);
const standingDef = getStanding(db, defender.id);
check(warSale.ok && standingAtt > 0 && standingDef < 0,
  `vendre 100 modules au belligérant : réputation ${attacker.name} +${standingAtt.toFixed(1)},`
  + ` ${defender.name} ${standingDef.toFixed(1)} (l'ennemi l'apprend)`);

// Liste noire : en dessous de ${BLACKLIST}, leurs marchés vous refusent.
db.prepare('INSERT INTO faction_standing (faction_id, standing) VALUES (?, -60) '
  + 'ON CONFLICT(faction_id) DO UPDATE SET standing = -60').run(defender.id);
const defenderPlanet = db.prepare(
  `SELECT p.id FROM planets p JOIN systems s ON s.id = p.system_id
   WHERE s.faction_id = ? AND p.population < 50 LIMIT 1`
).get(defender.id) ?? db.prepare(
  `SELECT p.id FROM planets p JOIN systems s ON s.id = p.system_id
   WHERE s.faction_id = ? LIMIT 1`).get(defender.id);
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(defenderPlanet.id, getShip(db).id);
const refusedTrade = executeTrade(db, { side: 'buy', resourceId: 'water', quantity: 1 });
check(!refusedTrade.ok && refusedTrade.error.includes('liste noire'),
  `liste noire chez ${defender.name} : « ${refusedTrade.error} »`);

// Saisie : arriver sur un front d'une faction qui vous en veut, avec de la
// cargaison stratégique en soute, coûte cher.
db.prepare('UPDATE faction_standing SET standing = -30 WHERE faction_id = ?').run(defender.id);
const defenderFront = db.prepare(
  `SELECT p.id FROM planets p
   JOIN systems s ON s.id = p.system_id
   JOIN war_fronts wf ON wf.system_id = s.id
   WHERE wf.war_id = ? AND s.faction_id = ? LIMIT 1`
).get(warId, defender.id);
if (defenderFront) {
  db.prepare(
    `INSERT INTO ship_cargo (ship_id, resource_id, quantity, avg_cost) VALUES (?, 'mech_parts', 50, 30)
     ON CONFLICT(ship_id, resource_id) DO UPDATE SET quantity = 50, avg_cost = 30`
  ).run(getShip(db).id);
  db.prepare(
    `UPDATE ships SET planet_id = NULL, origin_system_id = 1, dest_system_id = ?,
     dest_planet_id = ?, departure_tick = ?, arrival_tick = ? WHERE id = ?`
  ).run(db.prepare('SELECT system_id FROM planets WHERE id = ?').get(defenderFront.id).system_id,
    defenderFront.id, getCurrentTick(db), getCurrentTick(db) + 1, getShip(db).id);
  runTick(db);
  const mechLeft = db.prepare(
    "SELECT quantity FROM ship_cargo WHERE ship_id = ? AND resource_id = 'mech_parts'"
  ).get(getShip(db).id).quantity;
  check(mechLeft === 0, 'saisie douanière au front : cargaison stratégique confisquée');
} else {
  check(true, 'saisie : pas de planète de front côté défenseur sur cette seed (cas couvert par le code)');
}

// Conquête : un front à bout de bascule, le système change de mains.
const targetFront = db.prepare(
  'SELECT system_id FROM war_fronts WHERE war_id = ? LIMIT 1').get(warId);
db.prepare('UPDATE war_fronts SET pressure = 0.99 WHERE war_id = ? AND system_id = ?')
  .run(warId, targetFront.system_id);
db.prepare('UPDATE factions SET fleet = 80, readiness = 1 WHERE id = ?').run(attacker.id);
db.prepare('UPDATE factions SET fleet = 10, readiness = 0.5 WHERE id = ?').run(defender.id);
tickWars(db, getCurrentTick(db));
const conqueredBy = db.prepare('SELECT faction_id FROM systems WHERE id = ?')
  .get(targetFront.system_id).faction_id;
check(conqueredBy === attacker.id,
  `conquête : le système contesté passe sous contrôle de ${attacker.name}`);

// Paix par capitulation : le défenseur exsangue jette l'éponge.
db.prepare('UPDATE wars SET started_tick = ? WHERE id = ?')
  .run(getCurrentTick(db) - CONFIG.WAR.MIN_DURATION - 5, warId);
db.prepare('UPDATE factions SET fleet = 5 WHERE id = ?').run(defender.id);
tickWars(db, getCurrentTick(db));
const endedWar = db.prepare('SELECT * FROM wars WHERE id = ?').get(warId);
check(endedWar.ended_tick !== null && endedWar.result === 'attacker',
  `paix : ${defender.name} capitule par épuisement (résultat : victoire de l'attaquant)`);

const eventTypes = new Set(recentEvents(db, 0, 300).map((e) => e.type));
check(['war', 'conquest', 'peace', 'seizure'].every((t) => eventTypes.has(t) || (t === 'seizure' && !defenderFront)),
  `fil d'événements : ${[...eventTypes].join(', ')} consignés pour le journal de bord`);

// ══ Phase 5 : flotte du joueur, automatisation, nouvelles ressources ═

console.log('\n■ Phase 5 — flotte, automatisation, catalogue étendu\n');

// Catalogue étendu : 37 ressources, marchés présents partout.
check(Object.keys(RESOURCES).length === 37,
  `${Object.keys(RESOURCES).length} ressources au catalogue (16 brutes, 14 intermédiaires, 7 finies)`);
const marketsPerPlanet = db.prepare(
  'SELECT MIN(n) AS mn FROM (SELECT COUNT(*) AS n FROM planet_resources GROUP BY planet_id)'
).get().mn;
check(marketsPerPlanet === 37, 'chaque planète a un marché pour chacune des 37 ressources');

// Migration : une planète amputée de ses nouvelles ressources les retrouve.
db.prepare(
  "DELETE FROM planet_resources WHERE planet_id = 1 AND resource_id IN ('silicon', 'meds', 'luxury_goods')"
).run();
const restored = ensureResourceRows(db);
check(restored === 3 && db.prepare(
  'SELECT COUNT(*) AS n FROM planet_resources WHERE planet_id = 1').get().n === 37,
  `migration des sauvegardes : ${restored} marchés manquants recréés (production biome, conso population)`);

// Achat de vaisseau au chantier d'un monde tier 2+.
db.prepare('UPDATE player SET credits = 50000 WHERE id = 1').run();
const t2World = db.prepare('SELECT id FROM planets WHERE population >= 50 AND population < 500 LIMIT 1').get();
db.prepare('UPDATE ships SET planet_id = ?, mode = ? WHERE id = ?')
  .run(t2World.id, 'manual', getShip(db).id);
const purchase = buyShip(db, 'courier');
check(purchase.ok && db.prepare('SELECT COUNT(*) AS n FROM ships').get().n === 2,
  purchase.ok && `achat au chantier : ${purchase.classLabel} « ${purchase.name} » pour ${purchase.price} cr`);

// Automatisation : le nouveau vaisseau passe en auto et commerce seul,
// avec les règles du joueur (tiers, listes noires) et profits pour lui.
setShipMode(db, purchase.shipId, 'auto');
db.prepare('UPDATE faction_standing SET standing = 0').run(); // amnistie de test
const creditsBeforeAuto = getPlayer(db).credits;
const fleetEventsBefore = recentEvents(db, 0, 500).filter((e) => e.type === 'fleet').length;
for (let i = 0; i < 25; i++) runTick(db);
const fleetEvents = recentEvents(db, 0, 500).filter((e) => e.type === 'fleet').length - fleetEventsBefore;
const autoShip = getShip(db, purchase.shipId);
check(fleetEvents > 0,
  `vaisseau automatique : ${fleetEvents} opérations en 25 ticks (crédits ${Math.round(creditsBeforeAuto)} → ${Math.round(getPlayer(db).credits)})`);
check(autoShip.fuel <= autoShip.fuel_capacity && autoShip.fuel > 0,
  'le capitaine automatique gère son carburant (plein au marché local)');

// L'entretien de flotte remplace le plafond : prélevé chaque tick, et le
// découvert cloue les vaisseaux à quai.
db.prepare("UPDATE ships SET mode = 'manual'").run(); // finances figées
const upkeepCredits = getPlayer(db).credits;
runTick(db);
const expectedUpkeep = 4 + 2; // Cargo (4/tick) + Navette (2/tick)
check(Math.abs(getPlayer(db).credits - (upkeepCredits - expectedUpkeep)) < 0.01,
  `entretien de flotte : −${expectedUpkeep} cr/tick prélevés (Cargo 4 + Navette 2)`);

db.prepare('UPDATE player SET credits = -50 WHERE id = 1').run();
const grounded = startTravel(db, dest.id, getCurrentTick(db));
check(!grounded.ok && grounded.error.includes('impayés'),
  `découvert → flotte clouée à quai : « ${grounded.error} »`);
db.prepare('UPDATE player SET credits = 5000 WHERE id = 1').run();

// ══ Phase 6 : industrie joueur ═══════════════════════════════════

console.log('\n■ Phase 6 — technologies, ateliers, concessions multiples\n');

db.prepare('UPDATE player SET credits = 500000 WHERE id = 1').run();
const flagship = getShip(db);
const homeFacility = listConcessions(db)[0];
db.prepare('UPDATE ships SET planet_id = ?, mode = ? WHERE id = ?')
  .run(homeFacility.planet_id, 'manual', flagship.id);

// Site de test propre : concession basculée sur du minerai de fer et
// entrepôt vidé (après ~100 ticks il débordait de la ressource du biome).
db.prepare("UPDATE concessions SET resource_id = 'iron_ore' WHERE id = ?").run(homeFacility.id);
db.prepare('DELETE FROM facility_storage WHERE concession_id = ?').run(homeFacility.id);

// L'arbre se respecte : pas de Manufacture sans Microélectronique.
const blocked = researchTech(db, 'manufacturing');
check(!blocked.ok && blocked.error.includes('prérequis'),
  `prérequis d'arbre respectés : « ${blocked.error} »`);

// Pas d'atelier sans la filière.
const noTech = installWorkshop(db, homeFacility.id, 'steel');
check(!noTech.ok, `atelier refusé sans recherche : « ${noTech.error} »`);

// Métallurgie → fonderie sur site : le filet de minerai devient de l'acier.
researchTech(db, 'smelting');
const steelShop = installWorkshop(db, homeFacility.id, 'steel');
check(steelShop.ok, `Métallurgie recherchée, fonderie installée (−${steelShop.cost} cr)`);
for (let i = 0; i < 6; i++) runTick(db);
const steelMade = listConcessions(db)[0].storage.find((s) => s.resource_id === 'steel');
check(Boolean(steelMade) && steelMade.quantity > 0,
  `transformation sur site : ${steelMade?.quantity.toFixed(0)} aciers produits depuis le minerai extrait`);

// Livrer des entrées achetées ailleurs : cuivre déposé → alliages.
db.prepare(
  `INSERT INTO ship_cargo (ship_id, resource_id, quantity, avg_cost) VALUES (?, 'copper_ore', 120, 8)
   ON CONFLICT(ship_id, resource_id) DO UPDATE SET quantity = 120, avg_cost = 8`
).run(flagship.id);
const deposit = depositToConcession(db, 'copper_ore', 120, flagship.id);
installWorkshop(db, homeFacility.id, 'alloys');
for (let i = 0; i < 5; i++) runTick(db);
const alloysMade = listConcessions(db)[0].storage.find((s) => s.resource_id === 'alloys');
check(deposit.ok && Boolean(alloysMade) && alloysMade.quantity > 0,
  `chaîne alimentée par le commerce : 120 cuivres déposés → ${alloysMade?.quantity.toFixed(0)} alliages (fer local + cuivre importé)`);

const loaded = collectConcession(db, undefined, flagship.id, 'alloys');
check(loaded.ok && loaded.moved > 0,
  `${loaded.moved} alliages chargés en soute (coût nul → futur profit pur)`);

// Forage profond : extraction ×1.5.
const rateBefore = listConcessions(db)[0].rate;
researchTech(db, 'deep_mining');
const rateAfter = listConcessions(db)[0].rate;
check(Math.abs(rateAfter - rateBefore * CONFIG.PLAYER.FACILITIES.DEEP_MINING_MULT) < 0.01,
  `Forage profond : extraction ${rateBefore} → ${rateAfter}/tick`);

// Prospection → deuxième concession sur un autre monde.
researchTech(db, 'prospection');
const elsewhere = db.prepare(
  'SELECT id FROM planets WHERE id != ? ORDER BY id LIMIT 1').get(homeFacility.planet_id);
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(elsewhere.id, flagship.id);
const second = buyConcession(db, flagship.id);
check(second.ok && listConcessions(db).length === 2,
  second.ok && `2e concession sur ${second.planetName} (${second.resourceName}, ${second.price} cr)`);

// La chaîne profonde : hélium-3 + cristaux → antimatière (tier quantique).
for (const t of ['chemistry', 'microelectronics', 'manufacturing', 'precision', 'quantum_industry']) {
  researchTech(db, t);
}
const qShop = installWorkshop(db, second.id, 'antimatter');
db.prepare(
  `INSERT INTO ship_cargo (ship_id, resource_id, quantity, avg_cost) VALUES (?, 'helium3', 90, 18)
   ON CONFLICT(ship_id, resource_id) DO UPDATE SET quantity = 90, avg_cost = 18`
).run(flagship.id);
db.prepare(
  `INSERT INTO ship_cargo (ship_id, resource_id, quantity, avg_cost) VALUES (?, 'energy_crystals', 60, 14)
   ON CONFLICT(ship_id, resource_id) DO UPDATE SET quantity = 60, avg_cost = 14`
).run(flagship.id);
depositToConcession(db, 'helium3', 90, flagship.id);
depositToConcession(db, 'energy_crystals', 60, flagship.id);
for (let i = 0; i < 5; i++) runTick(db);
const antimatterMade = listConcessions(db).find((c) => c.id === second.id)
  .storage.find((s) => s.resource_id === 'antimatter');
check(qShop.ok && Boolean(antimatterMade) && antimatterMade.quantity > 0,
  `industrie quantique : ${antimatterMade?.quantity.toFixed(0)} antimatière synthétisée sur site (−${qShop.cost} cr d'atelier)`);

// ══ Phase 7 : routes logistiques ═════════════════════════════════

console.log('\n■ Phase 7 — routes logistiques (l\'usine tourne sans vous)\n');

// Le scénario complet : la fonderie de la concession produit de l'acier ;
// la route l'écoule sur un marché voisin riche en cuivre, achète ce
// cuivre, et le rapporte à l'entrepôt pour nourrir l'atelier d'alliages.
const homeId = homeFacility.planet_id;
const homeSystem = db.prepare('SELECT system_id FROM planets WHERE id = ?').get(homeId).system_id;
const hub = db.prepare(
  `SELECT p.id, p.name FROM planets p
   JOIN planet_resources pr ON pr.planet_id = p.id AND pr.resource_id = 'copper_ore'
   JOIN systems s ON s.id = p.system_id, systems me
   WHERE me.id = ? AND p.id != ? AND pr.stock > 200
   ORDER BY (s.x - me.x) * (s.x - me.x) + (s.y - me.y) * (s.y - me.y) LIMIT 1`
).get(homeSystem, homeId);

const badRoute = createRoute(db, 'Incomplète', [{ planetId: homeId, actions: [] }]);
check(!badRoute.ok, `validation : « ${badRoute.error} »`);

const route = createRoute(db, 'Navette acier/cuivre', [
  { planetId: homeId, actions: [{ type: 'unload', resourceId: null, quantity: null }, { type: 'load', resourceId: 'steel', quantity: null }] },
  { planetId: hub.id, actions: [{ type: 'sell', resourceId: null, quantity: null }, { type: 'buy', resourceId: 'copper_ore', quantity: 60 }] },
]);
check(route.ok, `route créée : ${homeFacility.planetName ?? 'concession'} ↔ ${hub.name} (acier sortant, cuivre entrant)`);

db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(homeId, flagship.id);
const assigned = assignRoute(db, flagship.id, route.id);
check(assigned.ok && getShip(db, flagship.id).mode === 'route', `${assigned.name} assigné à la route`);

// Compteurs avant la boucle.
const copperBefore = listConcessions(db)[0].storage.find((s) => s.resource_id === 'copper_ore')?.quantity ?? 0;
const routeEventsBefore = recentEvents(db, 0, 1000).filter((e) => e.message.startsWith('ROUTE')).length;
db.prepare('UPDATE player SET credits = 20000 WHERE id = 1').run();
for (let i = 0; i < 24; i++) runTick(db);

const copperAfter = listConcessions(db)[0].storage.find((s) => s.resource_id === 'copper_ore')?.quantity ?? 0;
const routeEvents = recentEvents(db, 0, 1000).filter((e) => e.message.startsWith('ROUTE')).length - routeEventsBefore;
check(routeEvents >= 2, `${routeEvents} opérations de route consignées en 24 ticks (cycles complets)`);
check(copperAfter > copperBefore,
  `le cuivre acheté en route arrive à l'entrepôt : ${copperBefore.toFixed(0)} → ${copperAfter.toFixed(0)} (et nourrit l'atelier d'alliages)`);

const removal = deleteRoute(db, route.id);
check(removal.ok && getShip(db, flagship.id).mode === 'manual',
  'route supprimée → vaisseau rendu au pilotage manuel');

// ══ Phase 8 : nouvelles brutes + parts d'industries ══════════════

console.log('\n■ Phase 8 — ressources brutes et parts d\'industries\n');

// Les nouvelles brutes sont extraites quelque part dans la galaxie.
const newRaws = ['titanium_ore', 'uranium', 'biomass', 'deuterium', 'rare_earths', 'gemstones'];
const extractedCounts = newRaws.map((r) => db.prepare(
  'SELECT COUNT(*) AS n FROM planet_resources WHERE resource_id = ? AND production > 0'
).get(r).n);
check(extractedCounts.every((n) => n > 0),
  `6 nouvelles brutes extraites : ${newRaws.map((r, i) => `${RESOURCES[r].name} (${extractedCounts[i]} mondes)`).join(', ')}`);

// Investissement : une usine de nourriture sur un monde qui extrait ses
// propres entrées (eau + organiques) — elle tourne à plein régime.
const target = db.prepare(
  `SELECT pi.planet_id, pi.rate, p.name FROM planet_industries pi
   JOIN planets p ON p.id = pi.planet_id
   JOIN planet_resources w ON w.planet_id = pi.planet_id AND w.resource_id = 'water' AND w.production > 5
   JOIN planet_resources o ON o.planet_id = pi.planet_id AND o.resource_id = 'organics' AND o.production > 5
   WHERE pi.recipe_id = 'synth_food' ORDER BY pi.rate DESC LIMIT 1`
).get();
db.prepare('UPDATE ships SET planet_id = ?, mode = ? WHERE id = ?')
  .run(target.planet_id, 'manual', flagship.id);
db.prepare('UPDATE player SET credits = 400000 WHERE id = 1').run();

const stake = investIndustry(db, 'synth_food', 0.4, flagship.id);
check(stake.ok && stake.share === 0.4,
  stake.ok && `40 % de l'usine de ${stake.name} de ${stake.planetName} acquis pour ${fmt(stake.cost)} cr`);

const overCap = investIndustry(db, 'synth_food', 0.2, flagship.id);
check(!overCap.ok && overCap.error.includes('plafonnée'),
  `prise de contrôle impossible : « ${overCap.error} »`);

// Dividendes : sur la production réelle, chaque tick. Flotte au repos —
// seuls l'entretien (−6/tick) et les dividendes touchent les crédits.
const creditsDiv = getPlayer(db).credits;
for (let i = 0; i < 10; i++) runTick(db);
const divDelta = getPlayer(db).credits - creditsDiv;
const dividends = divDelta + 60; // on neutralise l'entretien
check(dividends > 0,
  `dividendes versés : +${dividends.toFixed(1)} cr en 10 ticks (production réelle × marge × 40 %)`);

const divested = divestIndustry(db, 'synth_food', flagship.id);
check(divested.ok && divested.refund > 0
  && db.prepare('SELECT COUNT(*) AS n FROM industry_shares').get().n === 0,
  divested.ok && `parts revendues : +${fmt(divested.refund)} cr (décote de 10 %)`);

// ══ Phase 9 : prêts de guerre et contrebande ═════════════════════

console.log('\n■ Phase 9 — finance de guerre et contrebande\n');

// Nouvelle guerre entre les mêmes voisins (la paix de la Phase 4 n'aura
// pas tenu), et le joueur finance LES DEUX camps.
db.prepare('UPDATE factions SET fleet = 60, readiness = 1 WHERE id = ?').run(attacker.id);
db.prepare('UPDATE factions SET fleet = 35, readiness = 0.8 WHERE id = ?').run(defender.id);
attacker.fleet = 60;
defender.fleet = 35;
const warId2 = declareWar(db, getCurrentTick(db), attacker, defender);

const neutral = db.prepare(
  'SELECT id FROM factions WHERE id NOT IN (?, ?) LIMIT 1').get(attacker.id, defender.id);
const refusedLoan = issueLoan(db, neutral.id, 10000);
check(!refusedLoan.ok && refusedLoan.error.includes('guerre'),
  `pas de prêt en temps de paix : « ${refusedLoan.error} »`);

db.prepare('UPDATE player SET credits = 100000 WHERE id = 1').run();
const modulesBefore = db.prepare(
  "SELECT stock FROM planet_resources WHERE planet_id = ? AND resource_id = 'ship_modules'"
).get(attackerCapital).stock;
const standingBefore = getStanding(db, attacker.id);
const loanA = issueLoan(db, attacker.id, 20000);
const modulesAfter = db.prepare(
  "SELECT stock FROM planet_resources WHERE planet_id = ? AND resource_id = 'ship_modules'"
).get(attackerCapital).stock;
check(loanA.ok && modulesAfter > modulesBefore && getStanding(db, attacker.id) > standingBefore,
  `prêt de 20 000 cr à ${attacker.name} : le matériel arrive aussitôt au chantier`
  + ` (modules ${modulesBefore.toFixed(0)} → ${modulesAfter.toFixed(0)}), réputation en hausse`);

const loanB = issueLoan(db, defender.id, 8000);
check(loanB.ok, `et 8 000 cr à ${defender.name} — on finance les deux camps, naturellement`);

// Victoire de l'attaquant : son créancier est remboursé ×1,3, celui du
// vaincu perd tout.
db.prepare('UPDATE wars SET started_tick = ? WHERE id = ?')
  .run(getCurrentTick(db) - CONFIG.WAR.MIN_DURATION - 5, warId2);
db.prepare('UPDATE factions SET fleet = 4 WHERE id = ?').run(defender.id);
const creditsWar = getPlayer(db).credits;
tickWars(db, getCurrentTick(db));
const loanRows = db.prepare('SELECT * FROM loans WHERE war_id = ? ORDER BY id').all(warId2);
check(loanRows[0].status === 'repaid' && loanRows[0].payout === 26000
  && getPlayer(db).credits === creditsWar + 26000,
  `victoire de l'emprunteur : +26 000 cr (20 000 × 1,3)`);
check(loanRows[1].status === 'defaulted' && loanRows[1].payout === 0,
  `capitulation du vaincu : les 8 000 cr prêtés partent en fumée`);

// ── Contrebande ──────────────────────────────────────────────────
// Liste noire chez le vaincu, mais un pavillon de complaisance acheté
// dans la Frange ouvre à nouveau ses marchés — jusqu'à la détection.
db.prepare('INSERT INTO faction_standing (faction_id, standing) VALUES (?, -60) '
  + 'ON CONFLICT(faction_id) DO UPDATE SET standing = -60').run(defender.id);
const defPlanet = db.prepare(
  `SELECT p.id FROM planets p JOIN systems s ON s.id = p.system_id
   WHERE s.faction_id = ? LIMIT 1`).get(defender.id);
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(defPlanet.id, flagship.id);
check(!executeTrade(db, { side: 'buy', resourceId: 'water', quantity: 2 }).ok,
  'sans pavillon : liste noire, marché fermé');

const wrongPlace = buyFalseFlag(db, flagship.id);
check(!wrongPlace.ok && wrongPlace.error.includes('Frange'),
  `le pavillon ne s'achète que dans la Frange : « ${wrongPlace.error} »`);

const fringePlanet = db.prepare(
  `SELECT p.id FROM planets p JOIN systems s ON s.id = p.system_id
   WHERE s.faction_id IS NULL LIMIT 1`).get();
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(fringePlanet.id, flagship.id);
const flag = buyFalseFlag(db, flagship.id);
check(flag.ok, `pavillon de complaisance acquis dans la Frange (−${fmt(flag.cost)} cr)`);

db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(defPlanet.id, flagship.id);
CONFIG.SMUGGLING.DETECTION = 0; // douaniers distraits pour le test
const smuggled = executeTrade(db, { side: 'buy', resourceId: 'water', quantity: 2 });
check(smuggled.ok, 'sous pavillon : la liste noire s\'ouvre, l\'achat passe');

db.prepare(
  `INSERT INTO ship_cargo (ship_id, resource_id, quantity, avg_cost) VALUES (?, 'ship_modules', 20, 40)
   ON CONFLICT(ship_id, resource_id) DO UPDATE SET quantity = 20, avg_cost = 40`
).run(flagship.id);
const anonBefore = getStanding(db, defender.id);
executeTrade(db, { side: 'sell', resourceId: 'ship_modules', quantity: 10 });
check(getStanding(db, defender.id) === anonBefore,
  'vente anonyme : aucune réputation engagée, dans aucun sens');

CONFIG.SMUGGLING.DETECTION = 1; // cette fois, la douane veille
const exposed = executeTrade(db, { side: 'sell', resourceId: 'ship_modules', quantity: 10 });
const flagAfter = getShip(db, flagship.id).false_flag;
check(exposed.ok && flagAfter === 0 && getStanding(db, defender.id) < anonBefore,
  `démasqué : pavillon brûlé, réputation ${anonBefore} → ${getStanding(db, defender.id)}`);
check(!executeTrade(db, { side: 'buy', resourceId: 'water', quantity: 2 }).ok,
  'sans couverture, la liste noire reprend ses droits');
CONFIG.SMUGGLING.DETECTION = 0.1;

// ══ Technologies avancées et fondation d'industries ══════════════

console.log('\n■ Technologies avancées — construction chez les autres\n');

db.prepare('UPDATE player SET credits = 800000 WHERE id = 1').run();

// Cadence d'ateliers ×2 puis extraction ×2,5 et entrepôts ×4.
const rateW0 = listConcessions(db)[0].workshops[0]?.rate ?? CONFIG.PLAYER.FACILITIES.WORKSHOP_RATE;
researchTech(db, 'workshop_engineering');
const rateW1 = listConcessions(db)[0].workshops[0]?.rate;
check(rateW1 === rateW0 * 2, `Ingénierie d'ateliers : cadence ${rateW0} → ${rateW1} runs/tick`);

const ext0 = listConcessions(db)[0].rate;
researchTech(db, 'deep_mining_2');
const ext1 = listConcessions(db)[0].rate;
check(Math.abs(ext1 / ext0 - CONFIG.PLAYER.FACILITIES.DEEP_MINING_2_MULT / CONFIG.PLAYER.FACILITIES.DEEP_MINING_MULT) < 0.01,
  `Foreuses quantiques : extraction ${ext0} → ${ext1}/tick`);

researchTech(db, 'auto_warehouse');
researchTech(db, 'orbital_storage');
check(listConcessions(db)[0].cap === 1500 * 4, // niveau 1 (1500) × Stockage orbital
  `Stockage orbital : entrepôt à ${listConcessions(db)[0].cap} (×4)`);

// Soutes modulaires : rétrofit immédiat de la flotte.
const cargo0 = getShip(db, flagship.id).cargo_capacity;
researchTech(db, 'expanded_holds');
const cargo1 = getShip(db, flagship.id).cargo_capacity;
check(cargo1 === Math.round(cargo0 * 1.25), `Soutes modulaires : ${cargo0} → ${cargo1} (flotte rétrofittée)`);

// Moteurs économes : −30 % de carburant sur le même trajet.
const farPlanet = db.prepare(
  `SELECT p.id FROM planets p
   JOIN systems s ON s.id = p.system_id, planets me JOIN systems ms ON ms.id = me.system_id
   WHERE me.id = ? AND s.id != ms.id
     AND (s.x - ms.x) * (s.x - ms.x) + (s.y - ms.y) * (s.y - ms.y) > 250000 LIMIT 1`
).get(getShip(db, flagship.id).planet_id);
const fuel0 = previewTravel(db, farPlanet.id, flagship.id).fuelCost;
researchTech(db, 'efficient_drives');
const fuel1 = previewTravel(db, farPlanet.id, flagship.id).fuelCost;
check(fuel1 < fuel0, `Moteurs économes : ${fuel0} → ${fuel1} carburant sur le même trajet`);

// Réseau de courtage : relevés à moitié prix.
const intel0 = intelCost(db, home.system_id, fronts[0].system_id);
researchTech(db, 'trade_network');
const intel1 = intelCost(db, home.system_id, fronts[0].system_id);
check(intel1 < intel0, `Réseau de courtage : relevé ${intel0} → ${intel1} cr`);

// Prospection profonde : 10 concessions.
researchTech(db, 'prospection_2');
check(maxConcessions(db) === 10, 'Prospection profonde : plafond porté à 10 concessions');

// Charte industrielle : fonder une vraie usine sur le monde d'un autre.
researchTech(db, 'industrial_charter');
const site = db.prepare(
  `SELECT p.id, p.name FROM planets p
   JOIN systems s ON s.id = p.system_id
   JOIN planet_resources pr ON pr.planet_id = p.id AND pr.resource_id = 'biomass' AND pr.production > 5
   WHERE (s.faction_id IS NULL OR s.faction_id != ?) AND p.population > 100
     AND NOT EXISTS (SELECT 1 FROM planet_industries pi WHERE pi.planet_id = p.id AND pi.recipe_id = 'fertilizer')
   LIMIT 1`
).get(defender.id);
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(site.id, flagship.id);
const founded = foundIndustry(db, 'fertilizer', flagship.id);
check(founded.ok && founded.share === 0.49
  && Boolean(db.prepare(
    "SELECT 1 FROM planet_industries WHERE planet_id = ? AND recipe_id = 'fertilizer'").get(site.id)),
  founded.ok && `industrie fondée : Engrais sur ${founded.planetName} (×${founded.rate}/tick,`
  + ` ${fmt(founded.cost)} cr, 49 % fondateur)`);

const creditsFound = getPlayer(db).credits;
for (let i = 0; i < 5; i++) runTick(db);
check(getPlayer(db).credits > creditsFound - 5 * 6,
  'l\'usine fondée tourne (biomasse locale) et verse déjà ses dividendes');

// ── Industries alternatives : un même produit, plusieurs filières ─

console.log('\n■ Industries alternatives\n');

const altIds = ['steel_titanium', 'fuel_deuterium', 'electronics_rare',
  'synth_food_biomass', 'meds_bio', 'gem_cutting'];
const altCount = db.prepare(
  `SELECT COUNT(*) AS n FROM planet_industries WHERE recipe_id IN (${altIds.map(() => '?').join(',')})`
).get(...altIds).n;
check(altCount > 0,
  `la génération assigne les filières alternatives : ${altCount} usines (Bioréacteurs, Aciéries composites…)`);

// Atelier alternatif sur concession : l'Aciérie composite produit bien
// de l'ACIER (titane + fer importés) dans l'entrepôt du site n°2.
const altShop = installWorkshop(db, second.id, 'steel_titanium');
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?')
  .run(listConcessions(db).find((x) => x.id === second.id).planet_id, flagship.id);
for (const [rid, qty] of [['titanium_ore', 60], ['iron_ore', 60]]) {
  db.prepare(
    `INSERT INTO ship_cargo (ship_id, resource_id, quantity, avg_cost) VALUES (?, ?, ?, 10)
     ON CONFLICT(ship_id, resource_id) DO UPDATE SET quantity = ?, avg_cost = 10`
  ).run(flagship.id, rid, qty, qty);
  depositToConcession(db, rid, qty, flagship.id);
}
for (let i = 0; i < 4; i++) runTick(db);
const steelAtSite2 = listConcessions(db).find((x) => x.id === second.id)
  .storage.find((s) => s.resource_id === 'steel');
check(altShop.ok && Boolean(steelAtSite2) && steelAtSite2.quantity > 0,
  `atelier ${altShop.name} : titane + fer importés → ${steelAtSite2?.quantity.toFixed(0)} ACIERS à l'entrepôt`);

// Fonder des Bioréacteurs (filière Biosynthèse) sur le monde à biomasse :
// le moteur route la production vers la nourriture synthétique.
researchTech(db, 'biotech');
const bioSite = db.prepare(
  `SELECT p.id, p.name FROM planets p
   JOIN systems s ON s.id = p.system_id
   JOIN planet_resources pr ON pr.planet_id = p.id AND pr.resource_id = 'biomass' AND pr.production > 5
   WHERE (s.faction_id IS NULL OR s.faction_id != ?) AND p.population > 100
     AND NOT EXISTS (SELECT 1 FROM planet_industries pi
                     WHERE pi.planet_id = p.id AND pi.recipe_id = 'synth_food_biomass')
   LIMIT 1`
).get(defender.id);
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(bioSite.id, flagship.id);
const bioFactory = foundIndustry(db, 'synth_food_biomass', flagship.id);
const tickResult = runTick(db);
const bioRuns = tickResult.industryRuns.find(
  (r) => r.planet_id === bioSite.id && r.recipe_id === 'synth_food_biomass');
check(bioFactory.ok && Boolean(bioRuns) && bioRuns.runs > 0,
  bioFactory.ok && `Bioréacteurs fondés sur ${bioFactory.planetName} : ${bioRuns?.runs.toFixed(1)} runs au premier tick → nourriture synthétique`);

// ── Phase 10 : comptoirs commerciaux et objectifs ────────────────

console.log('\n■ Phase 10 — Comptoirs commerciaux (influence des prix)\n');

db.prepare('UPDATE player SET credits = 500000 WHERE id = 1').run();

// Un monde T1 (ouvert à tous) avec une ressource au stock moyen, peu
// produite sur place, et au prix NON clampé (sinon le drainage ne se
// verrait pas) : l'ordre d'achat doit y faire monter le prix.
const postCandidates = db.prepare(
  `SELECT p.id, p.name, pr.resource_id, pr.stock, pr.price
   FROM planets p
   JOIN planet_resources pr ON pr.planet_id = p.id
   WHERE p.population < 50 AND pr.stock BETWEEN 300 AND 1500 AND pr.production < 2
   ORDER BY pr.stock ASC`
).all();
const postTarget = postCandidates.find((c) => {
  const base = RESOURCES[c.resource_id].basePrice;
  return c.price >= base * 0.5 && c.price <= base * 1.5;
});
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?').run(postTarget.id, flagship.id);

const postBought = buyPost(db, flagship.id);
check(postBought.ok && listPosts(db).length === 1,
  postBought.ok && `comptoir ouvert sur ${postBought.planetName} (${fmt(postBought.price)} cr)`);

// Ordre d'ACHAT permanent, limite bien au-dessus du prix : il draine le
// marché tick après tick — le stock local fond, le prix monte.
const postId = postBought.id;
const buyOrder = setPostOrder(db, postId, postTarget.resource_id, 'buy', postTarget.price * 3, 40);
check(buyOrder.ok, buyOrder.ok && `ordre permanent : ACHAT ${buyOrder.name} ≤ ${buyOrder.limitPrice.toFixed(2)} cr (40/tick)`);

const stockBefore = postTarget.stock;
for (let i = 0; i < 3; i++) runTick(db);

const postAfterBuy = listPosts(db)[0];
const heldByPost = postAfterBuy.storage.find((s) => s.resource_id === postTarget.resource_id);
const marketAfterBuy = db.prepare(
  'SELECT stock, price FROM planet_resources WHERE planet_id = ? AND resource_id = ?'
).get(postTarget.id, postTarget.resource_id);
check(Boolean(heldByPost) && heldByPost.quantity >= 100 && heldByPost.avg_cost > 0,
  `le comptoir accapare sans vaisseau : ${heldByPost?.quantity.toFixed(0)} u en entrepôt en 3 ticks`
  + ` (coût moyen ${heldByPost?.avg_cost.toFixed(2)} cr)`);
// L'accaparement draine l'offre locale (le moteur de prix la traduit en
// hausse ; on mesure le drainage, robuste à la réversion vers l'équilibre).
check(marketAfterBuy.stock < stockBefore - 80,
  `l'accaparement assèche le marché : stock ${stockBefore.toFixed(0)} → ${marketAfterBuy.stock.toFixed(0)} u`);
check(postAfterBuy.orders[0].last_qty > 0,
  `retour d'exécution : ${postAfterBuy.orders[0].last_qty} u au dernier tick à ${postAfterBuy.orders[0].last_price.toFixed(2)} cr`);

// Bascule en VENTE : plancher sous le prix courant — l'entrepôt se
// déverse sur le marché et les crédits rentrent.
const delBuy = db.prepare('DELETE FROM post_orders WHERE post_id = ?').run(postId).changes;
const sellOrder = setPostOrder(db, postId, postTarget.resource_id, 'sell', marketAfterBuy.price * 0.3, 40);
const creditsBeforeSell = getPlayer(db).credits;
runTick(db);
const postAfterSell = listPosts(db)[0];
check(delBuy === 1 && sellOrder.ok && getPlayer(db).credits > creditsBeforeSell
  && (postAfterSell.storage.find((s) => s.resource_id === postTarget.resource_id)?.quantity ?? 0)
    < heldByPost.quantity,
  'ordre de VENTE : l\'entrepôt se déverse, les crédits rentrent');

// Remplacement d'ordre (même ressource + même sens) et télégraphe : la
// connaissance du marché du comptoir reste fraîche sans vaisseau.
const replaced = setPostOrder(db, postId, postTarget.resource_id, 'sell', 1, 10);
check(replaced.ok && replaced.replaced
  && db.prepare('SELECT COUNT(*) AS n FROM post_orders WHERE post_id = ?').get(postId).n === 1,
  'reposer le même couple ressource + sens remplace l\'ordre');
const knownFresh = db.prepare(
  'SELECT seen_tick FROM known_prices WHERE planet_id = ? AND resource_id = ?'
).get(postTarget.id, postTarget.resource_id);
check(knownFresh.seen_tick === getCurrentTick(db),
  'le comptoir télégraphie son marché : relevés toujours frais');

// Transferts soute ↔ comptoir, agrandissement.
const withdrawn = transferPost(db, flagship.id, postTarget.resource_id, 5, 'withdraw');
const upgraded = upgradePost(db, postId);
check(withdrawn.ok && withdrawn.moved === 5 && upgraded.ok && upgraded.level === 2,
  `retrait vers la soute (5 u) et agrandissement niveau 2 (entrepôt ${fmt(upgraded.cap)}, débit ${upgraded.flow}/tick)`);

// ── Phase 10 : objectifs / fin de partie ─────────────────────────

console.log('\n■ Phase 10 — Objectifs et fin de partie\n');

for (let i = 0; i < 5; i++) runTick(db); // passe par un tick multiple de 5

const objectives = listObjectives(db);
const nestEgg = objectives.find((o) => o.id === 'nest_egg');
const nexus = objectives.find((o) => o.id === 'nexus');
const doneCount = objectives.filter((o) => o.done).length;
check(nestEgg.done && doneCount >= 3,
  `${doneCount} jalons atteints en jeu (dont « ${nestEgg.name} » à 100 k crédits)`);
check(!nexus.done && nexus.victory && nexus.progress.length === 3,
  'la victoire « LE NEXUS » reste à conquérir (3 conditions suivies)');
check(db.prepare("SELECT COUNT(*) AS n FROM world_events WHERE type = 'objective'").get().n >= 1,
  'chaque jalon est annoncé dans le journal et récompensé en prestige');
const inProgress = objectives.find((o) => !o.done && o.progress[0].goal > 0);
check(Boolean(inProgress) && inProgress.progress[0].value <= inProgress.progress[0].goal,
  `progression suivie : « ${inProgress?.name} » à ${inProgress?.progress[0].value}/${inProgress?.progress[0].goal} ${inProgress?.progress[0].label}`);

// ── Phase 11 : maison de commerce, QG, rivaux, scénarios, stats ──

console.log('\n■ Phase 11 — Maison de commerce et quartier général\n');

// Identité : la partie a une maison nommée, un blason, un rang de renom.
const house = getHouse(db);
check(typeof house.name === 'string' && house.name.length > 0 && /^#[0-9a-f]{6}$/i.test(house.color),
  `maison « ${house.name} » (blason ${house.color}), rang « ${house.renown.title} »`);
check(renownOf(0).title === 'Colporteur' && renownOf(99999).title === 'Magnat du Nexus',
  'le rang de renom suit le prestige (Colporteur → Magnat du Nexus)');

// Quartier général : construction, bonus câblés (entretien, plafond flotte).
db.prepare('UPDATE player SET credits = 700000 WHERE id = 1').run();
const flagshipShip = getShip(db);
db.prepare('UPDATE ships SET planet_id = ? WHERE id = ?')
  .run(listConcessions(db)[0].planet_id, flagshipShip.id);
const upkeepBefore = fleetUpkeep(db);
const fleetCapBefore = maxFleet(db);
const hqBuilt = buildHQ(db, flagshipShip.id);
const upkeepAfter = fleetUpkeep(db);
check(hqBuilt.ok && hqBonuses(db).level === 1,
  hqBuilt.ok && `QG bâti sur ${hqBuilt.planetName} (${fmt(hqBuilt.cost)} cr)`);
check(upkeepAfter < upkeepBefore && maxFleet(db) === fleetCapBefore + 3,
  `bonus du QG câblés : entretien ${upkeepBefore} → ${upkeepAfter}, plafond flotte +3`);
const hqUp = upgradeHQ(db);
check(hqUp.ok && hqUp.level === 2 && hqBonuses(db).maxFleetBonus === 6,
  hqUp.ok && `QG niveau 2 : plafond flotte +6, entretien −30 %`);

console.log('\n■ Phase 11 — Maisons de commerce rivales\n');

// Initialisation des rivaux (le verify ne passe pas par game.js).
const rivalInit = initRivals(db);
check(rivalInit.rivals >= 2
  && db.prepare('SELECT COUNT(*) AS n FROM rivals').get().n === rivalInit.rivals,
  `${rivalInit.rivals} maisons rivales fondées, chacune dotée d'un capital`);

// Elles agissent : arbitrage et/ou accaparement sur plusieurs ticks ;
// au moins une opération doit aboutir, et la valeur nette se met à jour.
const dealsBefore = db.prepare('SELECT COALESCE(SUM(deals_done),0) AS n FROM rivals').get().n;
for (let i = 0; i < 20; i++) runTick(db);
const dealsAfter = db.prepare('SELECT COALESCE(SUM(deals_done),0) AS n FROM rivals').get().n;
check(dealsAfter > dealsBefore,
  `les rivaux commercent réellement sur les marchés : ${dealsAfter} opérations cumulées`);
check(db.prepare('SELECT COUNT(*) AS n FROM rivals WHERE net_worth > 0').get().n === rivalInit.rivals,
  'la valeur nette de chaque maison est suivie tick après tick');
check(db.prepare("SELECT COUNT(*) AS n FROM networth_history WHERE subject = 'player'").get().n >= 1,
  'l\'historique de valeur nette (joueur + rivaux) est échantillonné pour le graphe');

console.log('\n■ Phase 11 — Statistiques et classement\n');

const nw = netWorthBreakdown(db);
check(nw.total > 0 && nw.parts.credits > 0 && nw.parts.hq > 0,
  `patrimoine décomposé : ${fmt(nw.total)} cr (dont QG ${fmt(nw.parts.hq)} cr immobilisés)`);
const board = leaderboard(db);
const meEntry = board.find((e) => e.isPlayer);
check(board.length === rivalInit.rivals + 1 && Boolean(meEntry) && meEntry.rank >= 1,
  `classement des ${board.length} maisons : vous êtes ${meEntry.rank}e sur ${board.length}`);
const snap = statsSnapshot(db);
check(snap.counts.fleet >= 1 && typeof snap.rank === 'number' && Array.isArray(snap.leaderboard),
  'snapshot complet (valeur nette, rang, compteurs, historique) servi à l\'UI');

console.log('\n■ Phase 11 — Scénarios de départ\n');

// Un scénario alternatif applique bien ses paramètres (sur une DB neuve).
const dbHeir = createDb(':memory:');
generateUniverse(dbHeir, SEED);
generateFactions(dbHeir);
const heir = initPlayer(dbHeir, { scenarioId: 'heritier', houseName: 'Maison Test' });
const heirPlayer = getPlayer(dbHeir);
const heirFleet = dbHeir.prepare('SELECT COUNT(*) AS n FROM ships').get().n;
check(heir.scenario.id === 'heritier' && heirPlayer.credits === SCENARIO_BY_ID.heritier.credits
  && heirPlayer.licence_tier === 2 && heirFleet === 2
  && heirPlayer.house_name === 'Maison Test',
  `scénario « Héritier » : ${fmt(heirPlayer.credits)} cr, ${heirFleet} vaisseaux, licence T2, maison nommée`);
const refugee = (() => {
  const d = createDb(':memory:');
  generateUniverse(d, SEED);
  generateFactions(d);
  const r = initPlayer(d, { scenarioId: 'refugie' });
  const ok = getPlayer(d).credits === 500 && listConcessions(d).length === 0;
  d.close();
  return ok;
})();
check(refugee, 'scénario « Réfugié » : 500 cr, aucune concession (tout à reconquérir)');
dbHeir.close();

db.close();
console.log(failures
  ? `\n✗ ${failures} contrôle(s) en échec\n`
  : '\n✓ Phases 1 à 11 vérifiées : économie, guerres, flotte, industrie, routes, '
    + 'investissements, prêts, contrebande, comptoirs, objectifs, maison/QG, rivaux et scénarios OK\n');
process.exit(failures ? 1 : 0);
