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
import { buyShip, setShipMode } from '../server/player/shipyard.js';
import { runTick } from '../server/simulation.js';
import { RECIPES } from '../data/recipes.js';
import { RESOURCES } from '../data/resources.js';
import { BIOMES } from '../data/biomes.js';
import { initPlayer, getPlayer, getShip, getCargo, tierOf } from '../server/player/state.js';
import { previewTrade, executeTrade } from '../server/player/trade.js';
import { previewTravel, startTravel } from '../server/player/travel.js';
import {
  listConcessions, collectConcession, depositToConcession, buyConcession, installWorkshop,
} from '../server/player/concession.js';
import { researchTech } from '../server/player/tech.js';
import { RECIPES as ALL_RECIPES } from '../data/recipes.js';
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

const db2 = createDb(':memory:');
generateUniverse(db2, SEED);
const fingerprint = (d) => JSON.stringify({
  systems: d.prepare('SELECT * FROM systems ORDER BY id').all(),
  planets: d.prepare('SELECT * FROM planets ORDER BY id').all(),
  resources: d.prepare('SELECT * FROM planet_resources ORDER BY planet_id, resource_id').all(),
});
check(fingerprint(db) === fingerprint(db2), 'même seed → univers identique (reproductible)');
db2.close();

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
  for (const ind of industriesByPlanet.get(r.planet_id) ?? []) {
    demand += (RECIPES[ind.recipe_id].inputs[r.resource_id] ?? 0) * ind.rate;
  }
  r.netFlow = r.production - demand;
  r.priceRatio = r.price / RESOURCES[r.resource_id].basePrice;
}

const headroom = (r) => r.priceRatio > 0.45 && r.priceRatio < 2.5;
const surplusCase = rows.filter((r) => r.netFlow > 1 && headroom(r))
  .sort((a, b) => b.netFlow - a.netFlow)[0];
const shortageCase = rows.filter((r) => r.netFlow < -1 && headroom(r))
  .sort((a, b) => a.netFlow - b.netFlow)[0];

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

const historyDepth = db.prepare(
  'SELECT COUNT(*) AS n FROM price_history WHERE planet_id = ? AND resource_id = ?'
).get(surplusCase.planet_id, surplusCase.resource_id).n;
check(historyDepth === TICKS + 1,
  `historique de prix : ${historyDepth} points conservés (tick 0 à ${TICKS})`);

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

// Catalogue étendu : 26 ressources, marchés présents partout.
check(Object.keys(RESOURCES).length === 26,
  `${Object.keys(RESOURCES).length} ressources au catalogue (10 brutes, 10 intermédiaires, 6 finies)`);
const marketsPerPlanet = db.prepare(
  'SELECT MIN(n) AS mn FROM (SELECT COUNT(*) AS n FROM planet_resources GROUP BY planet_id)'
).get().mn;
check(marketsPerPlanet === 26, 'chaque planète a un marché pour chacune des 26 ressources');

// Migration : une planète amputée de ses nouvelles ressources les retrouve.
db.prepare(
  "DELETE FROM planet_resources WHERE planet_id = 1 AND resource_id IN ('silicon', 'meds', 'luxury_goods')"
).run();
const restored = ensureResourceRows(db);
check(restored === 3 && db.prepare(
  'SELECT COUNT(*) AS n FROM planet_resources WHERE planet_id = 1').get().n === 26,
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

db.close();
console.log(failures
  ? `\n✗ ${failures} contrôle(s) en échec\n`
  : '\n✓ Phases 1 à 6 vérifiées : économie, commerce, factions, guerres, flotte et industrie joueur OK\n');
process.exit(failures ? 1 : 0);
