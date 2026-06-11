// Script de vérification — sans Express ni UI.
// Phase 1 : génération, reproductibilité, prix offre/demande sur 10 ticks.
// Phase 2 : scénario joueur complet : concession → chargement → vente
//   (impact prix + prestige), glissement sur gros ordre, contrôle des
//   tiers, voyage avec carburant, connaissance des marchés qui se périme.
//
// Usage : npm run verify   (code de sortie ≠ 0 si un contrôle échoue)

import { CONFIG } from '../server/config.js';
import { createDb, getCurrentTick } from '../server/db.js';
import { generateUniverse } from '../server/universe/generator.js';
import { runTick } from '../server/simulation.js';
import { RECIPES } from '../data/recipes.js';
import { RESOURCES } from '../data/resources.js';
import { BIOMES } from '../data/biomes.js';
import { initPlayer, getPlayer, getShip, getCargo, tierOf } from '../server/player/state.js';
import { previewTrade, executeTrade } from '../server/player/trade.js';
import { previewTravel, startTravel } from '../server/player/travel.js';
import { getConcession, collectConcession } from '../server/player/concession.js';
import { generateFactions } from '../server/factions/generate.js';
import { initTraders } from '../server/npc/traders.js';
import { tickContracts, deliverContract } from '../server/factions/contracts.js';

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
const concession = getConcession(db);

check(tierOf(home.population) === 1,
  `départ sur ${home.name} (${BIOMES[home.biome].label.toLowerCase()}, ${Math.round(home.population)} M hab.) — tier 1, ouvert à tous`);
check(concession.planet_id === home.id && concession.stockpile > 0,
  `concession de ${RESOURCES[concession.resource_id].name} : entrepôt à ${concession.stockpile.toFixed(0)} après ${TICKS} ticks (+${concession.rate}/tick)`);

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

db.close();
console.log(failures
  ? `\n✗ ${failures} contrôle(s) en échec\n`
  : '\n✓ Phases 1, 2 et 3 vérifiées : économie, commerce, factions, flux, PNJ et besoins OK\n');
process.exit(failures ? 1 : 0);
