// Script de vérification de la Phase 1 — sans Express ni UI :
//   1. génère un univers en mémoire et contrôle ses invariants,
//   2. vérifie la reproductibilité (même seed → même univers),
//   3. fait tourner 10 ticks et montre que les prix suivent l'offre/demande
//      (surplus → baisse, pénurie → hausse), cas concrets à l'appui.
//
// Usage : npm run verify   (code de sortie ≠ 0 si un contrôle échoue)

import { createDb } from '../server/db.js';
import { generateUniverse } from '../server/universe/generator.js';
import { runTick } from '../server/economy/engine.js';
import { RECIPES } from '../data/recipes.js';
import { RESOURCES } from '../data/resources.js';
import { BIOMES } from '../data/biomes.js';

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
// Demande totale par tick = consommation civile + entrées industrielles,
// comme dans le moteur. On choisit le plus gros surplus net et la plus
// grosse pénurie nette, en évitant les prix déjà collés aux bornes.

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

const headroom = (r) => r.priceRatio > 0.45 && r.priceRatio < 2.5; // pas déjà aux bornes
const surplusCase = rows.filter((r) => r.netFlow > 1 && headroom(r))
  .sort((a, b) => b.netFlow - a.netFlow)[0];
const shortageCase = rows.filter((r) => r.netFlow < -1 && headroom(r))
  .sort((a, b) => a.netFlow - b.netFlow)[0];

check(Boolean(surplusCase), 'au moins un marché en surplus net trouvé');
check(Boolean(shortageCase), 'au moins un marché en pénurie nette trouvée');

// ── 4. Simulation de 10 ticks ────────────────────────────────────

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

db.close();
console.log(failures ? `\n✗ ${failures} contrôle(s) en échec\n` : '\n✓ Phase 1 vérifiée : génération, simulation et prix offre/demande OK\n');
process.exit(failures ? 1 : 0);
