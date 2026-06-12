// Maisons de commerce rivales : vos concurrents. Chacune joue au même jeu
// que vous — arbitrer bas→haut sur les VRAIS marchés (impact prix partagé
// via economy/market.js) et, quand elle en a les moyens, accaparer une
// ressource sur une planète (le prix y grimpe, puis elle écoule son stock).
// Vous les affrontez au classement par valeur nette (server/player/stats).
//
// Modélisation légère, « pyramidale » : pas de flottes pleines, mais des
// flux statistiques datés d'une identité. Une maison agit un tick sur
// ACT_EVERY (déphasée par id), pour rester bon marché à grande échelle.

import { CONFIG } from '../config.js';
import { RESOURCES, RESOURCE_IDS } from '../../data/resources.js';
import { createRng } from '../universe/rng.js';
import { getMeta } from '../db.js';
import { applyMarketTrade, marketContext } from '../economy/market.js';
import { depositQuality, depositLabel } from '../player/concession.js';
import { BIOMES } from '../../data/biomes.js';
import { logEvent } from '../events.js';

const R = CONFIG.RIVALS;

export function initRivals(db, count = R.COUNT) {
  const planets = db.prepare('SELECT id FROM planets').all();
  if (planets.length === 0 || count <= 0) return { rivals: 0 };
  const rng = createRng((Number(getMeta(db, 'seed')) ^ 0x1d2c3b4a) >>> 0);

  // Noms et couleurs tirés sans répétition.
  const names = [...R.NAMES];
  const colors = [...R.COLORS];
  const insert = db.prepare(
    'INSERT INTO rivals (name, color, credits, net_worth, home_planet_id) VALUES (?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    for (let i = 0; i < count && names.length > 0; i++) {
      const name = names.splice(Math.floor(rng.next() * names.length), 1)[0];
      const color = colors.splice(Math.floor(rng.next() * colors.length), 1)[0] ?? '#9ab1c6';
      const home = planets[Math.floor(rng.next() * planets.length)].id;
      insert.run(name, color, R.START_CREDITS, R.START_CREDITS, home);
    }
  })();
  return { rivals: Math.min(count, R.NAMES.length) };
}

// Valeur des réserves d'une maison, au prix de base (stable).
function holdingsValue(db, rivalId) {
  const rows = db.prepare(
    'SELECT resource_id, quantity FROM rival_holdings WHERE rival_id = ? AND quantity > 0'
  ).all(rivalId);
  let v = 0;
  for (const r of rows) v += r.quantity * RESOURCES[r.resource_id].basePrice;
  return v;
}

export function rivalNetWorth(db, rival) {
  const claims = db.prepare(
    'SELECT COUNT(*) AS n FROM rival_concessions WHERE rival_id = ?').get(rival.id).n;
  let claimsValue = 0;
  for (let i = 0; i < claims; i++) claimsValue += R.CLAIM_COST * 2 ** i;
  return Math.round((rival.credits + holdingsValue(db, rival.id) + claimsValue) * 100) / 100;
}

const upsertHolding = `
  INSERT INTO rival_holdings (rival_id, resource_id, quantity, avg_cost) VALUES (?, ?, ?, ?)
  ON CONFLICT(rival_id, resource_id) DO UPDATE SET quantity = ROUND(quantity + excluded.quantity, 2)`;

// Un coup d'arbitrage : deux planètes tirées au sort, on cherche une
// ressource bien moins chère ici que là, on l'y achète et la revend là —
// les deux marchés bougent, la marge rentre.
function tryArbitrage(db, rival, planetIds) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const a = planetIds[Math.floor(Math.random() * planetIds.length)];
    const b = planetIds[Math.floor(Math.random() * planetIds.length)];
    if (a === b) continue;

    const rid = RESOURCE_IDS[Math.floor(Math.random() * RESOURCE_IDS.length)];
    const here = marketContext(db, a, rid);
    const there = marketContext(db, b, rid);
    if (!here || !there || here.stock < 20) continue;
    if ((there.price - here.price) / here.price < R.MARGIN) continue;

    const qty = Math.floor(Math.min(
      R.DEAL_CAPACITY, here.stock * 0.25, rival.credits / (here.price * 1.1)));
    if (qty < 5) continue;

    const buy = applyMarketTrade(db, a, rid, qty, 'buy', here);
    const sell = applyMarketTrade(db, b, rid, qty, 'sell', there);
    const credits = Math.round((rival.credits - buy.total + sell.total) * 100) / 100;
    db.prepare('UPDATE rivals SET credits = ?, deals_done = deals_done + 1 WHERE id = ?')
      .run(credits, rival.id);
    rival.credits = credits;
    return true;
  }
  return false;
}

// Accaparement : draine une ressource d'une planète vers les réserves de
// la maison (le prix monte), pendant CORNER_TICKS, puis tout est écoulé.
function tickCorner(db, rival, tick) {
  if (rival.cornering_until > tick) {
    const m = marketContext(db, rival.cornering_planet_id, rival.cornering_resource);
    const qty = Math.floor(Math.min(R.CORNER_FLOW, m.stock, rival.credits / (m.price * 1.1)));
    if (qty >= 1) {
      const buy = applyMarketTrade(db, rival.cornering_planet_id, rival.cornering_resource, qty, 'buy', m);
      db.prepare('UPDATE rivals SET credits = ROUND(credits - ?, 2) WHERE id = ?').run(buy.total, rival.id);
      db.prepare(upsertHolding).run(rival.id, rival.cornering_resource, qty, buy.unitPrice);
      rival.credits -= buy.total;
    }
    return;
  }
  // Fin de l'accaparement : on écoule tout le stock sur place.
  const held = db.prepare(
    'SELECT quantity FROM rival_holdings WHERE rival_id = ? AND resource_id = ?'
  ).get(rival.id, rival.cornering_resource)?.quantity ?? 0;
  if (held >= 1) {
    const m = marketContext(db, rival.cornering_planet_id, rival.cornering_resource);
    const sell = applyMarketTrade(db, rival.cornering_planet_id, rival.cornering_resource, Math.floor(held), 'sell', m);
    db.prepare('UPDATE rivals SET credits = ROUND(credits + ?, 2) WHERE id = ?').run(sell.total, rival.id);
    db.prepare('UPDATE rival_holdings SET quantity = 0 WHERE rival_id = ? AND resource_id = ?')
      .run(rival.id, rival.cornering_resource);
    rival.credits += sell.total;
  }
  db.prepare('UPDATE rivals SET cornering_resource = NULL, cornering_planet_id = NULL, cornering_until = NULL WHERE id = ?')
    .run(rival.id);
  rival.cornering_resource = null;
}

// Lancer un accaparement : une ressource au stock confortable sur une
// planète tirée au sort. Annoncé au journal (vous voyez le coup venir).
function maybeStartCorner(db, rival, tick, planetIds) {
  if (rival.cornering_resource || rival.credits < R.CORNER_MIN_CREDITS) return;
  if (Math.random() > R.CORNER_CHANCE) return;

  const planetId = planetIds[Math.floor(Math.random() * planetIds.length)];
  const rid = RESOURCE_IDS[Math.floor(Math.random() * RESOURCE_IDS.length)];
  const m = marketContext(db, planetId, rid);
  if (!m || m.stock < 150) return;

  const planet = db.prepare('SELECT name FROM planets WHERE id = ?').get(planetId);
  db.prepare(
    'UPDATE rivals SET cornering_resource = ?, cornering_planet_id = ?, cornering_until = ? WHERE id = ?'
  ).run(rid, planetId, tick + R.CORNER_TICKS, rival.id);
  rival.cornering_resource = rid;
  logEvent(db, tick, 'rival',
    `★ ${rival.name} accapare le ${RESOURCES[rid].name} sur ${planet.name} — le prix va grimper`);
}

// La course aux filons : une maison riche s'offre une concession sur un
// gisement riche encore libre — le filon que vous lorgnez peut partir.
function maybeClaimDeposit(db, rival, tick) {
  if (rival.credits < R.CLAIM_MIN_CREDITS || Math.random() >= R.CLAIM_CHANCE) return;
  const owned = db.prepare(
    'SELECT COUNT(*) AS n FROM rival_concessions WHERE rival_id = ?').get(rival.id).n;
  const cost = R.CLAIM_COST * 2 ** owned;
  if (rival.credits < cost) return;

  // Un échantillon de planètes libres : ni à vous, ni à un rival.
  const candidates = db.prepare(
    `SELECT p.id, p.name, p.biome FROM planets p
     WHERE p.biome IN ('rocky', 'volcanic', 'desert')
       AND p.id NOT IN (SELECT planet_id FROM concessions)
       AND p.id NOT IN (SELECT planet_id FROM rival_concessions)
     ORDER BY RANDOM() LIMIT 25`
  ).all();
  const rich = candidates
    .map((p) => ({ ...p, quality: depositQuality(db, p.id) }))
    .filter((p) => p.quality >= R.CLAIM_MIN_QUALITY)
    .sort((a, b) => b.quality - a.quality)[0];
  if (!rich) return;

  // La ressource phare du biome local, comme pour le joueur.
  const resourceId = Object.entries(BIOMES[rich.biome].extraction)
    .sort((a, b) => b[1] - a[1])[0][0];
  db.prepare(
    `INSERT INTO rival_concessions (planet_id, rival_id, resource_id, acquired_tick)
     VALUES (?, ?, ?, ?)`
  ).run(rich.id, rival.id, resourceId, tick);
  db.prepare('UPDATE rivals SET credits = ROUND(credits - ?, 2) WHERE id = ?')
    .run(cost, rival.id);
  rival.credits -= cost;
  logEvent(db, tick, 'rival',
    `★ ${rival.name} ouvre une concession sur ${rich.name} — filon ${depositLabel(rich.quality)}`
    + ` ×${rich.quality}. La course aux filons est lancée`);
}

// Les concessions rivales produisent et vendent sur place : l'offre
// locale monte (prix en baisse), leur trésorerie aussi.
function tickRivalConcessions(db) {
  const rows = db.prepare(
    `SELECT rc.*, r.id AS rid FROM rival_concessions rc
     JOIN rivals r ON r.id = rc.rival_id`
  ).all();
  for (const rc of rows) {
    const qty = Math.round(R.CLAIM_RATE * depositQuality(db, rc.planet_id));
    const m = marketContext(db, rc.planet_id, rc.resource_id);
    db.prepare(
      'UPDATE planet_resources SET stock = ROUND(stock + ?, 2) WHERE planet_id = ? AND resource_id = ?'
    ).run(qty, rc.planet_id, rc.resource_id);
    db.prepare('UPDATE rivals SET credits = ROUND(credits + ?, 2) WHERE id = ?')
      .run(Math.round(qty * m.price * R.CLAIM_SELL_SHARE * 100) / 100, rc.rival_id);
  }
}

export function tickRivals(db, tick) {
  const rivals = db.prepare('SELECT * FROM rivals').all();
  if (rivals.length === 0) return;
  tickRivalConcessions(db);

  // Un échantillon de planètes partagé par tous les rivaux de ce tick.
  const sample = db.prepare(
    'SELECT id FROM planets ORDER BY RANDOM() LIMIT ?'
  ).all(R.SCAN_PLANETS).map((p) => p.id);
  if (sample.length < 2) return;

  db.transaction(() => {
    for (const rival of rivals) {
      if (rival.cornering_resource || rival.cornering_until) {
        tickCorner(db, rival, tick);
        continue; // une maison qui accapare ne fait que ça
      }
      if ((tick + rival.id) % R.ACT_EVERY !== 0) continue;
      tryArbitrage(db, rival, sample);
      maybeStartCorner(db, rival, tick, sample);
      maybeClaimDeposit(db, rival, tick);
    }

    // Valeur nette : recalcul à chaque tick (peu de rivaux), historisée
    // régulièrement pour le graphe de classement.
    for (const rival of db.prepare('SELECT * FROM rivals').all()) {
      db.prepare('UPDATE rivals SET net_worth = ? WHERE id = ?')
        .run(rivalNetWorth(db, rival), rival.id);
    }
    if (tick % R.HISTORY_EVERY === 0) recordNetWorthHistory(db, tick);
  })();
}

// Historique de valeur nette : joueur + rivaux, échantillonné et borné.
function recordNetWorthHistory(db, tick) {
  // Import paresseux pour éviter un cycle (stats importe rivals).
  const value = playerNetWorthLite(db);
  const ins = db.prepare(
    'INSERT OR REPLACE INTO networth_history (subject, tick, value) VALUES (?, ?, ?)');
  ins.run('player', tick, value);
  // L'observatoire : CA, volumes et trésorerie de l'empire dans le temps.
  const pl = db.prepare(
    'SELECT credits, total_revenue, total_units_sold FROM player WHERE id = 1').get();
  if (pl) {
    db.prepare(
      'INSERT OR REPLACE INTO empire_history (tick, revenue, units_sold, credits) VALUES (?, ?, ?, ?)'
    ).run(tick, pl.total_revenue ?? 0, pl.total_units_sold ?? 0, pl.credits);
    db.prepare(
      `DELETE FROM empire_history WHERE tick <= (
         SELECT COALESCE(MAX(tick), 0) - ? FROM empire_history)`
    ).run(R.HISTORY_KEEP * R.HISTORY_EVERY);
  }
  for (const r of db.prepare('SELECT id, net_worth FROM rivals').all()) {
    ins.run(`rival:${r.id}`, tick, r.net_worth);
  }
  // Élagage : on ne garde que les HISTORY_KEEP derniers points par sujet.
  db.prepare(
    `DELETE FROM networth_history WHERE tick <= (
       SELECT COALESCE(MAX(tick), 0) - ? FROM networth_history)`
  ).run(R.HISTORY_KEEP * R.HISTORY_EVERY);
}

// Valeur nette du joueur, version légère (crédits + cargo + stocks
// d'installations au prix de base). La version complète vit dans stats.js
// mais on en a besoin ici sans créer de cycle d'import.
function playerNetWorthLite(db) {
  const credits = db.prepare('SELECT credits FROM player WHERE id = 1').get()?.credits ?? 0;
  const valueOf = (rows) => rows.reduce(
    (s, r) => s + r.quantity * RESOURCES[r.resource_id].basePrice, 0);
  const cargo = valueOf(db.prepare('SELECT resource_id, quantity FROM ship_cargo WHERE quantity > 0').all());
  const facility = valueOf(db.prepare('SELECT resource_id, quantity FROM facility_storage WHERE quantity > 0').all());
  const post = valueOf(db.prepare('SELECT resource_id, quantity FROM post_storage WHERE quantity > 0').all());
  return Math.round((credits + cargo + facility + post) * 100) / 100;
}
