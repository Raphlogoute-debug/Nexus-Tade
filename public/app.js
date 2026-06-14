// Client Nexus Trade : carte des systèmes (canvas), panneau d'inspection
// et de commerce, HUD joueur, contrôles du temps. Données via l'API REST,
// rafraîchies par polling.

const $ = (sel) => document.querySelector(sel);
const canvas = $('#map');
const ctx = canvas.getContext('2d');
const tooltip = $('#tooltip');
const panel = $('#panel-content');
const initialPanelHTML = panel.innerHTML; // accueil + légende (bouton ?)

const POLL_MS = 1000;

const BIOME_COLORS = {
  rocky: '#a78b6d',
  oceanic: '#3fa7d6',
  gas_giant: '#c77dff',
  desert: '#e0b34c',
  ice: '#9ad7e8',
  volcanic: '#e0633f',
};
const STAR_COLORS = ['#fff4d6', '#cfe5ff', '#ffd9a0', '#ffc4b0', '#e8f0ff'];
const TIER_LABELS = { raw: 'Brut', intermediate: 'Intermédiaire', finished: 'Fini' };

// ── Identité visuelle des ressources ─────────────────────────────
// Index id → { name, tier, cat… } et catégories (couleur + glyphe),
// remplis depuis /api/universe. Une « puce » colorée par famille rend
// les 37 ressources lisibles d'un coup d'œil partout dans l'UI.
const resById = new Map();
let resCats = {};
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function indexResources(universe) {
  resById.clear();
  for (const r of universe.resources ?? []) resById.set(r.id, r);
  resCats = universe.categories ?? {};
}

function resName(id) {
  return resById.get(id)?.name ?? id;
}

// Glyphe coloré de la famille (seul, pour les en-têtes compacts).
function resGlyph(id) {
  const cat = resCats[resById.get(id)?.cat];
  if (!cat) return '';
  return `<span class="rc-glyph" style="color:${cat.color}" title="${cat.label}">${cat.glyph}</span>`;
}

// Puce complète : glyphe de famille + nom. C'est ce qu'on met partout
// où une ressource est nommée.
function resChip(id, name) {
  return `${resGlyph(id)}${escapeHtml(name ?? resName(id))}`;
}

const fmtNum = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const fmtPrice = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Calendrier galactique : 1 tick = 1 jour, an 3000 au tick 0 ─────
// Les trajets se comptent en jours, les guerres en mois, les chantiers
// en années — le temps devient lisible.
const EPOCH_MS = Date.UTC(3000, 0, 1);
const fmtDateFull = new Intl.DateTimeFormat('fr-FR',
  { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
const fmtDateShort = new Intl.DateTimeFormat('fr-FR',
  { day: 'numeric', month: 'short', timeZone: 'UTC' });

function dateOf(tick) {
  return fmtDateFull.format(new Date(EPOCH_MS + (tick ?? 0) * 86400000));
}

function dateShort(tick) {
  return fmtDateShort.format(new Date(EPOCH_MS + (tick ?? 0) * 86400000));
}

// Grands nombres : 12 345 → « 12,3 k », 4 567 890 → « 4,57 M »…
function fmtQty(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${fmtNum.format(n / 1e9)} Md`;
  if (abs >= 1e6) return `${fmtNum.format(n / 1e6)} M`;
  if (abs >= 10000) return `${fmtNum.format(n / 1e3)} k`;
  return fmtNum.format(n);
}

function formatPop(popM) {
  return popM >= 1000
    ? `${fmtNum.format(popM / 1000)} Md hab.`
    : `${fmtNum.format(popM)} M hab.`;
}

const state = {
  universe: null,
  planetIndex: new Map(), // planetId → { planet, system }
  factionById: new Map(),
  capitalSystems: new Map(), // systemId → faction (pour le marqueur capitale)
  tick: null,
  speed: 1,
  player: null,
  knowledge: new Map(), // systemId → ageTicks
  selectedSystem: null,
  selectedPlanet: null,
  hoverSystem: null,
  view: null,
  tradeSel: null, // ressource sélectionnée dans le marché local
  fronts: new Set(), // systèmes contestés (guerres en cours)
  wars: [],
  lastEventId: 0,
  selectedShipId: null, // vaisseau piloté (les commandes s'appliquent à lui)
  prevShips: new Map(), // pour détecter les arrivées
  heatmap: null, // { resourceId, name, basePrice, bySystem: Map(systemId → ratio) }
  marketSel: 'iron_ore', // ressource du comparateur de marchés
  traffic: null, // { traders, convoys } en transit (vie de la carte)
  lanes: [], // voies commerciales agrégées depuis le trafic
  showTraffic: true,
  tickSync: null, // { at, progress, periodMs } : interpolation sous-tick
  house: null, // identité de la maison (nom, blason, QG, renom)
  newSaveScenario: 'colporteur',
  newSaveSettings: { rivals: 4, piracy: 'normaux', universe: 'normal' },
  lairs: [], // repaires pirates { system_id, strength }
  rivalClaims: [], // concessions rivales { system_id, planet_id, color, name }
  surveys: null, // sondages géologiques { planetId, systemId, quality }
  geoMap: false, // mode carte « filons »
};

function selectedShip() {
  const ships = state.player?.ships ?? [];
  return ships.find((s) => s.id === state.selectedShipId) ?? ships[0];
}

async function api(path) {
  const res = await fetch('/api' + path);
  const data = await res.json();
  if (!res.ok && data.error === undefined) throw new Error(`API ${path} → ${res.status}`);
  return data;
}

async function apiPost(path, body = {}) {
  const res = await fetch('/api' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json(); // les refus arrivent en { ok: false, error } — gérés par l'appelant
}

// ── Ergonomie du panneau : sections repliables + en-tête collant ──
// Post-traitement générique appliqué après chaque rendu : chaque
// .section-label devient un bouton qui replie tout ce qui le suit
// (jusqu'au prochain), avec mémoire (localStorage). Les en-têtes de tier
// des tables de marché se replient de la même façon. L'en-tête du
// panneau (retour + titre) devient collant pour garder le contexte.

const collapsePrefs = (() => {
  try { return JSON.parse(localStorage.getItem('nx-collapse') ?? '{}'); }
  catch { return {}; }
})();

function saveCollapsePrefs() {
  try { localStorage.setItem('nx-collapse', JSON.stringify(collapsePrefs)); } catch { /* navigation privée */ }
}

// Clé stable d'une étiquette : on retire compteurs et ticks dynamiques.
const collapseKey = (text) => text.toLowerCase()
  .replace(/[\d()×/—–-]|tick/g, '').replace(/\s+/g, ' ').trim();

// Repliées par défaut tant que le joueur n'a pas choisi le contraire.
const DEFAULT_COLLAPSED = ['ateliers', 'chantier civil', 'industries investissables',
  'bas fonds de la frange', 'commerce permanent'];

function isCollapsed(key) {
  return collapsePrefs[key] ?? DEFAULT_COLLAPSED.some((d) => key.startsWith(d));
}

// Transition de panneau : un fondu/glissement bref, joué seulement à la
// NAVIGATION (clic système/planète, bouton de panneau) — jamais sur les
// rafraîchissements live du polling, qui sinon feraient clignoter l'écran.
let pendingPanelAnim = false;
function animatePanelOnce() { pendingPanelAnim = true; }

function enhancePanel() {
  if (pendingPanelAnim) {
    panel.classList.remove('panel-enter');
    void panel.offsetWidth; // force le redémarrage de l'animation
    panel.classList.add('panel-enter');
    pendingPanelAnim = false;
  }
  // 1. En-tête collant : ← retour + titre + sous-titre regroupés.
  if (panel.firstElementChild?.classList.contains('back-link')) {
    const head = document.createElement('div');
    head.className = 'panel-head';
    while (panel.firstElementChild
      && (panel.firstElementChild.classList.contains('back-link')
        || panel.firstElementChild.classList.contains('panel-title')
        || panel.firstElementChild.classList.contains('panel-sub'))) {
      head.appendChild(panel.firstElementChild);
    }
    panel.prepend(head);
  }

  // 2. Sections repliables sur les .section-label de premier niveau.
  const labels = [...panel.children].filter((el) => el.classList.contains('section-label'));
  for (const label of labels) {
    const key = collapseKey(label.textContent);
    const body = document.createElement('div');
    body.className = 'sec-body';
    let sib = label.nextElementSibling;
    while (sib && !sib.classList.contains('section-label') && sib.id !== 'trade-form') {
      const next = sib.nextElementSibling;
      body.appendChild(sib); // déplacé, les listeners sont conservés
      sib = next;
    }
    label.after(body);
    const chev = document.createElement('span');
    chev.className = 'chev';
    label.prepend(chev);
    const apply = () => {
      const closed = isCollapsed(key);
      body.hidden = closed;
      chev.textContent = closed ? '▸ ' : '▾ ';
      label.classList.toggle('closed', closed);
    };
    apply();
    label.classList.add('collapsible');
    label.addEventListener('click', () => {
      collapsePrefs[key] = !isCollapsed(key);
      saveCollapsePrefs();
      apply();
    });
  }

  // 3. Tiers des tables de marché : BRUT / INTERMÉDIAIRE / FINI se
  // replient aussi (avec le nombre de lignes masquées).
  for (const tierRow of panel.querySelectorAll('tr.tier-row')) {
    const td = tierRow.querySelector('td');
    const key = 'tier:' + collapseKey(td.textContent);
    const rows = [];
    let r = tierRow.nextElementSibling;
    while (r && !r.classList.contains('tier-row')) {
      rows.push(r);
      r = r.nextElementSibling;
    }
    const base = td.textContent;
    const apply = () => {
      const closed = collapsePrefs[key] ?? false;
      for (const row of rows) row.hidden = closed;
      td.textContent = `${closed ? '▸' : '▾'} ${base} (${rows.length})`;
    };
    apply();
    tierRow.classList.add('collapsible');
    tierRow.addEventListener('click', () => {
      collapsePrefs[key] = !(collapsePrefs[key] ?? false);
      saveCollapsePrefs();
      apply();
    });
  }

  // Le guide pointe peut-être un bouton qui vient d'apparaître.
  updateGuide();
}

// ── Le jus : sons, toasts, texte flottant ─────────────────────────
// Les grands moments se voient et s'entendent. Sons synthétiques
// (WebAudio, zéro fichier), toasts en haut à droite de la carte, et
// crédits qui s'envolent du vaisseau à chaque transaction.

let audioCtx = null;
let muted = false;
try { muted = localStorage.getItem('nx-muted') === '1'; } catch { /* privé */ }

function playSound(kind) {
  if (muted) return;
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    const tone = (freq, start, dur, type = 'sine', gain = 0.07) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0 + start);
      g.gain.linearRampToValueAtTime(gain, t0 + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + start);
      o.stop(t0 + start + dur + 0.05);
    };
    if (kind === 'sell') { tone(660, 0, 0.1); tone(880, 0.08, 0.15); }
    else if (kind === 'buy') { tone(440, 0, 0.09, 'sine', 0.05); }
    else if (kind === 'objective') { tone(523, 0, 0.14); tone(659, 0.11, 0.14); tone(784, 0.22, 0.28); }
    else if (kind === 'alert') { tone(233, 0, 0.2, 'square', 0.045); tone(185, 0.16, 0.26, 'square', 0.045); }
    else if (kind === 'war') { tone(196, 0, 0.35, 'sawtooth', 0.04); tone(147, 0.18, 0.4, 'sawtooth', 0.04); }
  } catch { /* pas d'audio : tant pis, le jeu reste muet */ }
}

function toast(message, kind = 'info', ms = 4600) {
  const box = $('#toasts');
  if (!box) return;
  while (box.children.length >= 4) box.firstChild.remove();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 600);
}

// Drapeaux « une seule fois par partie » (mémorisés par seed) : sert aux
// invites de découverte — par ex. expliquer la guerre la première fois
// qu'elle éclate, sans jamais reharceler.
function gameFlagKey(name) { return `nx-${name}-${state.universe?.seed ?? 0}`; }
function gameFlag(name) { try { return localStorage.getItem(gameFlagKey(name)) === '1'; } catch { return false; } }
function setGameFlag(name) { try { localStorage.setItem(gameFlagKey(name), '1'); } catch { /* navigation privée */ } }

// Invite de découverte « une seule fois » : un nouveau système devient
// pertinent → on l'explique, on fait briller son bouton un instant, puis
// plus jamais. Renvoie true si l'invite a bien été montrée cette fois.
function discoverOnce(flag, message, targetSel, ms = 9000) {
  if (gameFlag(flag)) return false;
  setGameFlag(flag);
  toast(message, 'warn', ms);
  playSound('objective');
  if (targetSel) {
    for (const el of document.querySelectorAll(targetSel)) {
      el.classList.add('discover-pulse');
      setTimeout(() => el.classList.remove('discover-pulse'), 12000);
    }
  }
  return true;
}

// Déblocages détectés au fil de l'eau (depuis le résumé `discoverable` du
// serveur) : on signale chaque grand système la première fois qu'il s'ouvre.
function checkDiscoveries() {
  const d = state.player?.discoverable;
  if (!d) return;
  if (d.contracts) {
    discoverOnce('disc-contracts',
      `Vous avez l'envergure de traiter avec les royaumes eux-mêmes : leurs appels `
      + `d'offres paient au-dessus du marché (×1,35, davantage en guerre). Ils `
      + `apparaissent sur la fiche d'une faction et dans ⚔ GUERRES.`,
      '#btn-wars');
  }
  if (d.hq) {
    discoverOnce('disc-hq',
      `Vous pouvez fonder votre quartier général (60 000 cr) : il allège `
      + `l'entretien de la flotte, agrandit son plafond et remise les relevés `
      + `de marché. Ça se passe dans MAISON.`,
      '#btn-house');
  }
}

// Texte flottant sur la carte (coordonnées carte) : monte et s'efface.
state.floaters = [];

function addFloater(x, y, text, color) {
  state.floaters.push({ x, y, text, color, born: performance.now() });
}

function drawFloaters() {
  if (state.floaters.length === 0) return;
  const now = performance.now();
  ctx.font = 'bold 13px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  state.floaters = state.floaters.filter((f) => {
    const age = (now - f.born) / 1000;
    if (age > 2) return false;
    const [sx, sy] = toScreen(f.x, f.y);
    ctx.globalAlpha = Math.max(0, 1 - age / 2);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, sx, sy - 14 - age * 22);
    return true;
  });
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

// ── Journal ──────────────────────────────────────────────────────

// Catégorie d'une entrée pour le filtrage du journal.
const EVENT_CAT = {
  war: 'guerre', peace: 'guerre', conquest: 'guerre', profiteer: 'guerre',
  seizure: 'guerre', intel: 'guerre', smuggle: 'guerre', loan: 'guerre', piracy: 'guerre',
  mission: 'eco', client: 'eco', objective: 'eco', victory: 'eco', rival: 'eco',
  colony: 'monde', lair: 'monde', megaproject: 'monde', pact: 'monde',
  fleet: 'monde', arrival: 'monde',
};
let journalFilter = 'tout';

function log(message, cat = 'vous') {
  const li = document.createElement('li');
  li.dataset.cat = cat;
  li.hidden = journalFilter !== 'tout' && journalFilter !== cat;
  li.innerHTML = `<span class="tick-stamp">${dateShort(state.tick)}</span><strong>${message}</strong>`;
  const list = $('#journal-list');
  list.prepend(li);
  while (list.children.length > 80) list.lastChild.remove();
}

function setJournalFilter(f) {
  journalFilter = f;
  for (const li of $('#journal-list').children) {
    li.hidden = f !== 'tout' && li.dataset.cat !== f;
  }
  for (const b of document.querySelectorAll('.journal-filter')) {
    b.classList.toggle('active', b.dataset.f === f);
  }
}

for (const b of document.querySelectorAll('.journal-filter')) {
  b.addEventListener('click', () => setJournalFilter(b.dataset.f));
}

// Journal repliable : un clic sur l'étiquette le réduit à une ligne.
$('#journal-toggle').addEventListener('click', () => {
  const j = $('#journal');
  j.classList.toggle('folded');
  $('#journal-chevron').textContent = j.classList.contains('folded') ? '▸' : '▾';
});

// ── Carte ────────────────────────────────────────────────────────

// La carte est rendue en continu (requestAnimationFrame) : fond étoilé
// en parallaxe, territoires en halos doux, étoiles-sprites, trafic
// interpolé entre les ticks, flotte orientée avec traînée. Caméra :
// molette = zoom, glisser = déplacer, clic = sélectionner.

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const pad = 36;
  const fit = Math.min(rect.width - 2 * pad, rect.height - 2 * pad) / state.universe.mapSize;
  if (!state.view) {
    state.view = { zoom: 1, cx: state.universe.mapSize / 2, cy: state.universe.mapSize / 2 };
  }
  state.view.fit = fit;
  state.view.w = rect.width;
  state.view.h = rect.height;
  if (!starfield) buildStarfield();
}

const scaleOf = () => state.view.fit * state.view.zoom;

function toScreen(x, y) {
  const v = state.view;
  const s = scaleOf();
  return [v.w / 2 + (x - v.cx) * s, v.h / 2 + (y - v.cy) * s];
}

function toMap(px, py) {
  const v = state.view;
  const s = scaleOf();
  return [v.cx + (px - v.w / 2) / s, v.cy + (py - v.h / 2) / s];
}

function clampView() {
  const v = state.view;
  const m = state.universe.mapSize;
  v.zoom = Math.min(9, Math.max(0.55, v.zoom));
  v.cx = Math.min(m * 1.05, Math.max(-m * 0.05, v.cx));
  v.cy = Math.min(m * 1.05, Math.max(-m * 0.05, v.cy));
}

// Horloge interpolée : tick + fraction écoulée (resynchronisée à chaque
// /state). Tout ce qui vole glisse au lieu de sauter de tick en tick.
function tickNow() {
  const sync = state.tickSync;
  if (!sync || state.speed === 0) return state.tick ?? 0;
  const elapsed = (performance.now() - sync.at) / sync.periodMs;
  return state.tick + Math.min(0.999, sync.progress + elapsed);
}

// Toute couleur CSS → rgba avec alpha (les couleurs de faction sont en
// hexa, les couleurs thermiques en hsl ; les dégradés veulent du rgba).
const colorProbe = document.createElement('canvas').getContext('2d');
const rgbCache = new Map();
function withAlpha(color, alpha) {
  let rgb = rgbCache.get(color);
  if (!rgb) {
    colorProbe.fillStyle = color;
    const c = colorProbe.fillStyle; // normalisé en #rrggbb
    rgb = [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    rgbCache.set(color, rgb);
  }
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

// — Fond étoilé ——————————————————————————————————————————————
// Poussière d'étoiles (2 couches) et nébuleuses, en coordonnées écran
// normalisées, décalées par un facteur de parallaxe : le fond glisse
// moins vite que les systèmes et l'espace prend de la profondeur.

let starfield = null;

// PRNG local (mulberry32) : le même ciel à chaque session.
function mulberry(seed) {
  let a = seed || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildStarfield() {
  const rng = mulberry((state.universe.seed >>> 0) || 1);
  const layer = (count, par) => {
    const stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        nx: rng(), ny: rng(),
        r: 0.5 + rng() * 1.2,
        a: 0.2 + rng() * 0.5,
        tw: rng() < 0.2 ? 1.5 + rng() * 2.5 : 0, // vitesse de scintillement
        ph: rng() * Math.PI * 2,
      });
    }
    return { stars, par };
  };
  const hues = [210, 265, 180, 320];
  const nebulae = [];
  for (let i = 0; i < 4; i++) {
    nebulae.push({
      nx: rng(), ny: rng(),
      r: 180 + rng() * 260, // rayon écran (px)
      hue: hues[i] + rng() * 25,
      a: 0.045 + rng() * 0.035,
    });
  }
  starfield = { layers: [layer(170, 0.1), layer(110, 0.25)], nebulae };
}

// Décalage de parallaxe : la caméra éloignée du centre déplace le fond
// d'une fraction `par` du déplacement réel.
function parallaxOffset(par) {
  const v = state.view;
  const s = scaleOf();
  const m = state.universe.mapSize;
  return [(m / 2 - v.cx) * s * par, (m / 2 - v.cy) * s * par];
}

function drawStarfield(t) {
  const v = state.view;
  for (const n of starfield.nebulae) {
    const W = v.w + n.r * 2;
    const H = v.h + n.r * 2;
    const [ox, oy] = parallaxOffset(0.06);
    const x = ((n.nx * W + ox) % W + W) % W - n.r;
    const y = ((n.ny * H + oy) % H + H) % H - n.r;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, n.r);
    grad.addColorStop(0, `hsla(${n.hue}, 55%, 55%, ${n.a})`);
    grad.addColorStop(1, `hsla(${n.hue}, 55%, 55%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, n.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#cfd8ea';
  for (const { stars, par } of starfield.layers) {
    const W = v.w + 60;
    const H = v.h + 60;
    const [ox, oy] = parallaxOffset(par);
    for (const st of stars) {
      const x = ((st.nx * W + ox) % W + W) % W - 30;
      const y = ((st.ny * H + oy) % H + H) % H - 30;
      ctx.globalAlpha = st.tw ? st.a * (0.65 + 0.35 * Math.sin(t * st.tw + st.ph)) : st.a;
      ctx.fillRect(x, y, st.r, st.r);
    }
  }
  ctx.globalAlpha = 1;
  drawComets(t);
}

// Comètes : de loin en loin, une traînée file en travers du ciel. Pur
// décor — quelques-unes à la fois, en coordonnées écran (indépendantes
// de la caméra), pour donner vie au vide sans distraire.
const comets = [];
let nextCometAt = 2;
function drawComets(t) {
  const v = state.view;
  if (t > nextCometAt && comets.length < 2) {
    const edge = Math.random();
    comets.push({
      x: edge * v.w, y: -20,
      vx: (Math.random() - 0.5) * 80 + 40,
      vy: 70 + Math.random() * 90,
      born: t, life: 2.6 + Math.random() * 1.5,
    });
    nextCometAt = t + 7 + Math.random() * 16;
  }
  for (let i = comets.length - 1; i >= 0; i--) {
    const c = comets[i];
    const age = t - c.born;
    if (age > c.life) { comets.splice(i, 1); continue; }
    const x = c.x + c.vx * age;
    const y = c.y + c.vy * age;
    const fade = Math.sin((age / c.life) * Math.PI); // apparaît puis s'efface
    const len = 38;
    const dx = c.vx, dy = c.vy;
    const d = Math.hypot(dx, dy) || 1;
    const grad = ctx.createLinearGradient(x - dx / d * len, y - dy / d * len, x, y);
    grad.addColorStop(0, 'rgba(180, 220, 255, 0)');
    grad.addColorStop(1, `rgba(210, 235, 255, ${0.5 * fade})`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x - dx / d * len, y - dy / d * len);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = `rgba(235, 245, 255, ${0.85 * fade})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// — Territoires ——————————————————————————————————————————————
// Halos doux aux couleurs des royaumes, pré-rendus en espace carte sur
// un calque (recalculé seulement aux conquêtes) puis plaqués d'un seul
// drawImage par image — les taches voisines d'un même royaume fusionnent.

const territoryCanvas = document.createElement('canvas');

function renderTerritoryLayer() {
  if (!state.universe) return;
  const T = 1100;
  const k = T / state.universe.mapSize;
  territoryCanvas.width = territoryCanvas.height = T;
  const g = territoryCanvas.getContext('2d');
  for (const sys of state.universe.systems) {
    if (sys.faction_id === null) continue;
    const f = state.factionById.get(sys.faction_id);
    if (!f) continue;
    for (const [rad, alpha] of [[105, 0.085], [55, 0.1]]) {
      const r = rad * k;
      const grad = g.createRadialGradient(sys.x * k, sys.y * k, 0, sys.x * k, sys.y * k, r);
      grad.addColorStop(0, withAlpha(f.color, alpha));
      grad.addColorStop(1, withAlpha(f.color, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(sys.x * k, sys.y * k, r, 0, Math.PI * 2);
      g.fill();
    }
  }
}

function drawTerritory() {
  const [x0, y0] = toScreen(0, 0);
  const side = state.universe.mapSize * scaleOf();
  ctx.globalAlpha = state.heatmap ? 0.3 : 1; // en mode thermique, on s'efface
  ctx.drawImage(territoryCanvas, x0, y0, side, side);
  ctx.globalAlpha = 1;
}

// — Étoiles ———————————————————————————————————————————————————
// Chaque système est un sprite « cœur blanc → couleur → halo » pré-rendu
// (bien plus net et rapide que shadowBlur recalculé à chaque image).

const spriteCache = new Map();

function glowSprite(color, r) {
  const key = `${color}|${r}`;
  let c = spriteCache.get(key);
  if (c) return c;
  const size = Math.max(10, Math.ceil(r * 7));
  c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.2, color);
  grad.addColorStop(0.45, withAlpha(color, 0.32));
  grad.addColorStop(1, withAlpha(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  spriteCache.set(key, c);
  return c;
}

// Rayon écran du cœur d'une étoile (le halo s'étend bien au-delà). Une base
// un peu plus généreuse donne aux systèmes une présence lumineuse même au
// dézoom, sans grossir exagérément une fois rapproché.
function starRadius(system) {
  return (2.8 + system.planets.length * 0.5) * Math.pow(state.view.zoom, 0.55);
}

// Opacité selon la fraîcheur de la connaissance du système :
// inconnu = presque éteint, connu mais périmé = grisé, frais = plein.
function knowledgeAlpha(systemId) {
  const age = state.knowledge.get(systemId);
  if (age === undefined) return 0.32;
  if (age > 60) return 0.6;
  if (age > 15) return 0.8;
  return 1;
}

function shipMapPosition(ship, tk = tickNow()) {
  if (!ship) return null;
  if (ship.planet_id !== null) {
    const entry = state.planetIndex.get(ship.planet_id);
    return { x: entry.system.x, y: entry.system.y, docked: true };
  }
  const from = state.universe.systems.find((s) => s.id === ship.origin_system_id);
  const to = state.universe.systems.find((s) => s.id === ship.dest_system_id);
  const t = Math.min(1, Math.max(0,
    (tk - ship.departure_tick) / (ship.arrival_tick - ship.departure_tick)));
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    docked: false, from, to,
  };
}

// Couleur thermique : ratio prix/base ∈ [~0,7 ; ~1,3] → vert (bon marché)
// au rouge (cher), via le jaune (prix de base).
function heatColor(ratio) {
  const t = Math.min(1, Math.max(0, (ratio - 0.7) / 0.6));
  return `hsl(${Math.round(130 * (1 - t))}, 72%, 53%)`;
}

// — Trafic ———————————————————————————————————————————————————
// Le monde en mouvement : convois de factions (couleur du royaume) et
// marchands indépendants (points clairs), interpolés entre les ticks.

function setTraffic(data) {
  state.traffic = data;
  const lanes = new Map(); // voies : une ligne par paire de systèmes
  const add = (o, color) => {
    const key = o.fromSystem < o.toSystem
      ? `${o.fromSystem}|${o.toSystem}` : `${o.toSystem}|${o.fromSystem}`;
    let lane = lanes.get(key);
    if (!lane) lanes.set(key, lane = { fx: o.fx, fy: o.fy, tx: o.tx, ty: o.ty, n: 0, color });
    lane.n++;
  };
  for (const c of data.convoys) add(c, c.color ?? '#7da7c9');
  for (const m of data.traders) add(m, '#9ab1c6');
  state.lanes = [...lanes.values()];
}

function transitPoint(o, tk) {
  const dur = Math.max(1, o.arr - o.dep);
  const t = Math.min(1, Math.max(0, (tk - (o.dep ?? o.arr - 1)) / dur));
  const dx = o.tx - o.fx;
  const dy = o.ty - o.fy;
  const d = Math.hypot(dx, dy) || 1;
  return { x: o.fx + dx * t, y: o.fy + dy * t, dx: dx / d, dy: dy / d };
}

function drawLanes() {
  if (!state.showTraffic) return;
  for (const lane of state.lanes) {
    const [x1, y1] = toScreen(lane.fx, lane.fy);
    const [x2, y2] = toScreen(lane.tx, lane.ty);
    // Arc doux (carte de routes aériennes) dont l'éclat et l'épaisseur
    // croissent avec le trafic : les grandes artères commerciales se
    // détachent, dessinant le réseau vivant de la galaxie d'un coup d'œil.
    const intensity = Math.min(1, lane.n / 5);
    const dx = x2 - x1, dy = y2 - y1;
    const d = Math.hypot(dx, dy) || 1;
    const bow = Math.min(26, d * 0.12);
    const cx = (x1 + x2) / 2 - dy / d * bow;
    const cy = (y1 + y2) / 2 + dx / d * bow;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(cx, cy, x2, y2);
    ctx.strokeStyle = withAlpha(lane.color, 0.06 + intensity * 0.20);
    ctx.lineWidth = 0.8 + intensity * 1.1;
    ctx.stroke();
  }
}

function drawTraffic() {
  if (!state.showTraffic || !state.traffic) return;
  const v = state.view;
  const tk = tickNow();
  const z = Math.sqrt(v.zoom);
  const visible = (sx, sy) => sx > -20 && sy > -20 && sx < v.w + 20 && sy < v.h + 20;

  for (const c of state.traffic.convoys) {
    const p = transitPoint(c, tk);
    const [sx, sy] = toScreen(p.x, p.y);
    if (!visible(sx, sy)) continue;
    const color = c.color ?? '#7da7c9';
    const len = 7 * z;
    ctx.strokeStyle = withAlpha(color, 0.28); // traînée
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx - p.dx * len, sy - p.dy * len);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    ctx.fillStyle = withAlpha(color, 0.95);
    ctx.fillRect(sx - 1.4 * z, sy - 1.4 * z, 2.8 * z, 2.8 * z);
  }

  ctx.fillStyle = 'rgba(195,214,232,0.65)';
  for (const m of state.traffic.traders) {
    const p = transitPoint(m, tk);
    const [sx, sy] = toScreen(p.x, p.y);
    if (!visible(sx, sy)) continue;
    ctx.beginPath();
    ctx.arc(sx, sy, 1.2 * z, 0, Math.PI * 2);
    ctx.fill();
  }
}

// — Systèmes —————————————————————————————————————————————————

function drawSystems(t) {
  const v = state.view;
  // Les noms apparaissent en zoomant (fondus), toujours pour les capitales.
  const labelAlpha = Math.min(1, Math.max(0, (v.zoom - 1.3) / 0.7));
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';

  for (const sys of state.universe.systems) {
    const [sx, sy] = toScreen(sys.x, sys.y);
    if (sx < -70 || sy < -70 || sx > v.w + 70 || sy > v.h + 70) continue;
    const r = starRadius(sys);
    const isSelected = state.selectedSystem?.id === sys.id;
    const isHover = state.hoverSystem?.id === sys.id;
    const capital = state.capitalSystems.get(sys.id);

    // Mode thermique : la couleur dit le prix connu (vert → rouge),
    // gris éteint quand on n'a aucune donnée.
    let color;
    let alpha;
    if (state.geoMap) {
      // Carte des filons : qualité sondée (gris = pas encore sondé).
      const q = state.geoBySystem?.get(sys.id);
      color = q === undefined ? '#3a4150'
        : q >= 1.7 ? '#e8b35a' : q >= 1.3 ? '#5fd68b' : q >= 0.8 ? '#9ab1c6' : '#f07861';
      alpha = q === undefined ? 0.45 : 1;
    } else if (state.heatmap) {
      const ratio = state.heatmap.bySystem.get(sys.id);
      color = ratio === undefined ? '#3a4150' : heatColor(Math.round(ratio * 20) / 20);
      alpha = ratio === undefined ? 0.55 : 1;
    } else {
      color = STAR_COLORS[sys.id % STAR_COLORS.length];
      alpha = knowledgeAlpha(sys.id);
    }
    if (isHover || isSelected) alpha = 1;

    const sprite = glowSprite(color, Math.round(r * 2) / 2);
    // Respiration discrète, déphasée par système (le ciel n'est pas figé).
    const pulse = isHover || isSelected ? 1 : 0.9 + 0.1 * Math.sin(t * 0.8 + sys.id * 1.3);
    ctx.globalAlpha = alpha * pulse;
    ctx.drawImage(sprite, sx - sprite.width / 2, sy - sprite.height / 2);
    ctx.globalAlpha = 1;

    // Capitale : losange fin aux couleurs du royaume.
    if (capital) {
      const d = r + 6;
      ctx.beginPath();
      ctx.moveTo(sx, sy - d);
      ctx.lineTo(sx + d, sy);
      ctx.lineTo(sx, sy + d);
      ctx.lineTo(sx - d, sy);
      ctx.closePath();
      ctx.strokeStyle = withAlpha(capital.color, 0.85);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Front de guerre : anneau rouge qui pulse.
    if (state.fronts.has(sys.id)) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 3.2 + sys.id);
      ctx.beginPath();
      ctx.arc(sx, sy, r + 4 + pulse * 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(240,69,69,${0.4 + 0.4 * pulse})`;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Sélection : anneau pointillé en rotation lente.
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + 6, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(83,199,240,0.9)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([7, 5]);
      ctx.lineDashOffset = -t * 14;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }

    if (capital || isHover || isSelected || labelAlpha > 0) {
      ctx.globalAlpha = capital || isHover || isSelected
        ? 0.95 : labelAlpha * 0.7 * knowledgeAlpha(sys.id);
      ctx.fillStyle = capital ? capital.color : '#8fa1b8';
      // La Frange porte son avertissement : zone pirate.
      const label = sys.faction_id === null ? `☠ ${sys.name}` : sys.name;
      ctx.fillText(label, sx + r + 6, sy + 3);
      ctx.globalAlpha = 1;
    }
  }
}

// — Planètes en orbite (au zoom) ——————————————————————————————
// En zoomant, chaque système prend vie : ses planètes tournent autour de
// l'étoile, anneaux d'orbite et couleurs de biome. Donne une raison de
// zoomer et un ancrage spatial (la planète sélectionnée est mise en
// avant). Les positions dessinées sont mises en cache pour rendre les
// planètes directement cliquables/survolables sur la carte.
let planetHits = [];
function drawPlanetOrbits(t) {
  const v = state.view;
  planetHits = [];
  if (v.zoom < 2.2 || state.heatmap || state.geoMap) return;
  const fade = Math.min(1, (v.zoom - 2.2) / 1.2); // apparition progressive
  const zr = Math.pow(v.zoom, 0.6);

  for (const sys of state.universe.systems) {
    const [sx, sy] = toScreen(sys.x, sys.y);
    if (sx < -120 || sy < -120 || sx > v.w + 120 || sy > v.h + 120) continue;
    const r0 = starRadius(sys);
    sys.planets.forEach((p, i) => {
      const orbit = r0 + (10 + i * 8) * zr;
      const ang = t * (0.18 / (i + 1.2)) + i * 2.39996 + sys.id * 0.7;
      const px = sx + Math.cos(ang) * orbit;
      const py = sy + Math.sin(ang) * orbit * 0.62; // ellipse vue de biais
      const isSel = state.selectedPlanet === p.id;
      const pr = (isSel ? 3.6 : 2.4) * Math.min(2.4, zr);
      planetHits.push({ planetId: p.id, systemId: sys.id, x: px, y: py, r: pr + 4 });

      // Anneau d'orbite, très discret.
      ctx.globalAlpha = fade * (isSel ? 0.35 : 0.13);
      ctx.strokeStyle = isSel ? '#9fd8f4' : '#5b6b85';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(sx, sy, orbit, orbit * 0.62, 0, 0, Math.PI * 2);
      ctx.stroke();

      // La planète : pastille de biome avec petit halo.
      const col = BIOME_COLORS[p.biome] ?? '#9ab1c6';
      ctx.globalAlpha = fade;
      const grad = ctx.createRadialGradient(px, py, 0, px, py, pr * 2.2);
      grad.addColorStop(0, col);
      grad.addColorStop(0.5, withAlpha(col, 0.5));
      grad.addColorStop(1, withAlpha(col, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, pr * 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#eef4fb';
      ctx.beginPath();
      ctx.arc(px, py, pr * 0.6, 0, Math.PI * 2);
      ctx.fill();

      if (isSel) {
        ctx.globalAlpha = fade;
        ctx.strokeStyle = '#9fd8f4';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(px, py, pr + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  }
  ctx.globalAlpha = 1;
}

// — Vos installations : coins autour des systèmes où vous êtes établi —
// ambre = concession (industrie), vert = comptoir (commerce).

function drawCorners(sx, sy, d, color) {
  const l = 3.5;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(sx - d + l, sy - d); ctx.lineTo(sx - d, sy - d); ctx.lineTo(sx - d, sy - d + l);
  ctx.moveTo(sx + d - l, sy - d); ctx.lineTo(sx + d, sy - d); ctx.lineTo(sx + d, sy - d + l);
  ctx.moveTo(sx - d + l, sy + d); ctx.lineTo(sx - d, sy + d); ctx.lineTo(sx - d, sy + d - l);
  ctx.moveTo(sx + d - l, sy + d); ctx.lineTo(sx + d, sy + d); ctx.lineTo(sx + d, sy + d - l);
  ctx.stroke();
}

function drawPlayerAssets() {
  // Repaires pirates : double anneau rouge sombre, qui s'épaissit avec la force.
  for (const lair of state.lairs) {
    const sys = state.universe.systems.find((x) => x.id === lair.system_id);
    if (!sys) continue;
    const [sx, sy] = toScreen(sys.x, sys.y);
    const r = starRadius(sys) + 7;
    ctx.strokeStyle = 'rgba(200,40,40,0.7)';
    ctx.lineWidth = 0.8 + lair.strength * 0.5;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // La course aux filons : les concessions rivales, aux couleurs de leur maison.
  for (const claim of state.rivalClaims) {
    const sys = state.universe.systems.find((x) => x.id === claim.system_id);
    if (!sys) continue;
    const [sx, sy] = toScreen(sys.x, sys.y);
    drawCorners(sx, sy, starRadius(sys) + 5, withAlpha(claim.color, 0.85));
  }
  for (const c of state.player?.concessions ?? []) {
    const entry = state.planetIndex.get(c.planet_id);
    if (!entry) continue;
    const [sx, sy] = toScreen(entry.system.x, entry.system.y);
    drawCorners(sx, sy, starRadius(entry.system) + 5, 'rgba(232,179,90,0.85)');
  }
  for (const p of state.player?.posts ?? []) {
    const entry = state.planetIndex.get(p.planet_id);
    if (!entry) continue;
    const [sx, sy] = toScreen(entry.system.x, entry.system.y);
    drawCorners(sx, sy, starRadius(entry.system) + 8, 'rgba(95,214,139,0.85)');
  }
  // Quartier général : losange plein aux couleurs du blason, couronné.
  const hq = state.house?.hq;
  if (hq?.systemId != null) {
    const entry = state.planetIndex.get(hq.planetId);
    const sys = entry?.system ?? state.universe.systems.find((s) => s.id === hq.systemId);
    if (sys) {
      const [sx, sy] = toScreen(sys.x, sys.y);
      const d = starRadius(sys) + 11;
      ctx.fillStyle = state.house.color;
      ctx.strokeStyle = state.house.color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(sx, sy - d); ctx.lineTo(sx + d, sy);
      ctx.lineTo(sx, sy + d); ctx.lineTo(sx - d, sy);
      ctx.closePath();
      ctx.stroke();
      ctx.globalAlpha = 0.25;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

// — Flotte ———————————————————————————————————————————————————
// Triangles orientés : traînée moteur en transit, orbite lente à quai.

function drawShipTriangle(sx, sy, angle, size, selected) {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.7, size * 0.6);
  ctx.lineTo(-size * 0.4, 0);
  ctx.lineTo(-size * 0.7, -size * 0.6);
  ctx.closePath();
  if (selected) {
    ctx.fillStyle = '#53c7f0';
    ctx.fill();
  } else {
    ctx.strokeStyle = 'rgba(83,199,240,0.85)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }
  ctx.restore();
}

function drawFleet(t) {
  const tk = tickNow();
  const z = Math.sqrt(state.view.zoom);
  for (const ship of state.player?.ships ?? []) {
    const pos = shipMapPosition(ship, tk);
    if (!pos) continue;
    const isSelected = ship.id === selectedShip()?.id;
    const size = (isSelected ? 6.5 : 5) * z;

    if (!pos.docked) {
      const [x1, y1] = toScreen(pos.from.x, pos.from.y);
      const [x2, y2] = toScreen(pos.to.x, pos.to.y);
      const [sx, sy] = toScreen(pos.x, pos.y);
      const ang = Math.atan2(y2 - y1, x2 - x1);

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = isSelected ? 'rgba(83,199,240,0.45)' : 'rgba(83,199,240,0.18)';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Traînée moteur derrière le vaisseau.
      const trail = 16 * z;
      const grad = ctx.createLinearGradient(
        sx - Math.cos(ang) * trail, sy - Math.sin(ang) * trail, sx, sy);
      grad.addColorStop(0, 'rgba(83,199,240,0)');
      grad.addColorStop(1, 'rgba(83,199,240,0.55)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx - Math.cos(ang) * trail, sy - Math.sin(ang) * trail);
      ctx.lineTo(sx, sy);
      ctx.stroke();

      drawShipTriangle(sx, sy, ang, size, isSelected);
    } else {
      // À quai : le vaisseau orbite lentement autour de l'étoile.
      const entry = state.planetIndex.get(ship.planet_id);
      const [cxs, cys] = toScreen(entry.system.x, entry.system.y);
      const orbit = starRadius(entry.system) + (9 + (ship.id % 4) * 4.5) * z * 0.8;
      const ang = t * 0.35 + ship.id * 1.7;
      const sx = cxs + Math.cos(ang) * orbit;
      const sy = cys + Math.sin(ang) * orbit;
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(cxs, cys, orbit, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(83,199,240,0.16)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      drawShipTriangle(sx, sy, ang + Math.PI / 2, size, isSelected);
    }
  }
}

// — Boussole : flèche vers le vaisseau piloté quand il est hors-champ —
// On clique « ◎ » pour le recentrer ; la flèche cliquable fait pareil.
let compassHit = null;
function drawCompass(t) {
  compassHit = null;
  const pos = shipMapPosition(selectedShip());
  if (!pos) return;
  const v = state.view;
  const [sx, sy] = toScreen(pos.x, pos.y);
  const margin = 26;
  if (sx >= margin && sy >= margin && sx <= v.w - margin && sy <= v.h - margin) return;

  // Point d'ancrage : intersection du bord avec la direction du vaisseau.
  const cx = v.w / 2;
  const cy = v.h / 2;
  const ang = Math.atan2(sy - cy, sx - cx);
  const ex = Math.max(margin, Math.min(v.w - margin, sx));
  const ey = Math.max(margin, Math.min(v.h - margin, sy));
  compassHit = { x: ex, y: ey, r: 20 };

  const pulse = 0.7 + 0.3 * Math.sin(t * 3);
  ctx.save();
  ctx.translate(ex, ey);
  // Pastille + flèche cyan vers le vaisseau.
  ctx.fillStyle = `rgba(13,17,25,0.85)`;
  ctx.strokeStyle = `rgba(92,205,245,${0.5 + 0.4 * pulse})`;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(0, 0, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.rotate(ang);
  ctx.fillStyle = '#5ccdf5';
  ctx.beginPath();
  ctx.moveTo(9, 0);
  ctx.lineTo(1, 5);
  ctx.lineTo(1, -5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// — Mini-carte : vue d'ensemble en coin avec rectangle de visée ——
// Apparaît dès qu'on zoome (sinon redondante). Cliquable : on saute la
// caméra à l'endroit pointé. Coordonnées écran fixes (bas-gauche).
let minimapRect = null;
function drawMinimap() {
  minimapRect = null;
  const v = state.view;
  if (v.zoom < 1.35) return;
  const m = state.universe.mapSize;
  const size = Math.min(150, v.w * 0.16);
  const pad = 12;
  const box = { x: pad, y: v.h - size - 34, w: size, h: size };
  minimapRect = box;
  const k = size / m;
  const mx = (x) => box.x + x * k;
  const my = (y) => box.y + y * k;

  // Cadre.
  ctx.fillStyle = 'rgba(9,12,18,0.78)';
  ctx.strokeStyle = 'rgba(60,72,92,0.8)';
  ctx.lineWidth = 1;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);

  // Systèmes : points teintés par faction.
  for (const sys of state.universe.systems) {
    const f = sys.faction_id !== null ? state.factionById.get(sys.faction_id) : null;
    ctx.fillStyle = f ? withAlpha(f.color, 0.85) : 'rgba(150,170,195,0.6)';
    ctx.fillRect(mx(sys.x) - 0.5, my(sys.y) - 0.5, 1.6, 1.6);
  }
  // Vos installations en ambre.
  ctx.fillStyle = 'rgba(236,184,95,0.95)';
  for (const c of state.player?.concessions ?? []) {
    const e = state.planetIndex.get(c.planet_id);
    if (e) ctx.fillRect(mx(e.system.x) - 1, my(e.system.y) - 1, 2.4, 2.4);
  }
  // Vaisseau piloté : pastille cyan.
  const pos = shipMapPosition(selectedShip());
  if (pos) {
    ctx.fillStyle = '#5ccdf5';
    ctx.beginPath();
    ctx.arc(mx(pos.x), my(pos.y), 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Rectangle de visée : la portion de galaxie actuellement à l'écran.
  const [tlx, tly] = toMap(0, 0);
  const [brx, bry] = toMap(v.w, v.h);
  const rx = Math.max(box.x, mx(Math.max(0, tlx)));
  const ry = Math.max(box.y, my(Math.max(0, tly)));
  const rw = Math.min(box.x + box.w, mx(Math.min(m, brx))) - rx;
  const rh = Math.min(box.y + box.h, my(Math.min(m, bry))) - ry;
  ctx.strokeStyle = 'rgba(92,205,245,0.9)';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(rx, ry, Math.max(2, rw), Math.max(2, rh));
}

// Clic dans la mini-carte → coordonnées carte (ou null).
function minimapAt(px, py) {
  if (!minimapRect) return null;
  const b = minimapRect;
  if (px < b.x || py < b.y || px > b.x + b.w || py > b.y + b.h) return null;
  const m = state.universe.mapSize;
  return [(px - b.x) / b.w * m, (py - b.y) / b.h * m];
}

// — Image complète ————————————————————————————————————————————

function drawMap(t = performance.now() / 1000) {
  if (!state.universe || !state.view) return;
  ctx.clearRect(0, 0, state.view.w, state.view.h);
  drawStarfield(t);
  drawTerritory();
  drawLanes();
  drawTraffic();
  drawSystems(t);
  drawPlanetOrbits(t);
  drawPlayerAssets();
  drawFleet(t);
  drawFloaters();
  drawCompass(t);
  drawMinimap();
}

let renderLoopStarted = false;
function startRenderLoop() {
  if (renderLoopStarted) return;
  renderLoopStarted = true;
  const frame = (now) => {
    drawMap(now / 1000);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ── Barre de flotte ──────────────────────────────────────────────

function renderFleetBar() {
  const bar = $('#fleet-bar');
  bar.innerHTML = '';
  for (const ship of state.player?.ships ?? []) {
    const chip = document.createElement('div');
    chip.className = `fleet-chip ${ship.id === selectedShip()?.id ? 'selected' : ''}`;
    const where = ship.planet_id !== null
      ? state.planetIndex.get(ship.planet_id).planet.name
      : `→ ${state.planetIndex.get(ship.dest_planet_id).planet.name} (arr. ${dateShort(ship.arrival_tick)})${ship.escorted ? ' 🛡' : ''}`;
    chip.innerHTML = `
      <span class="ship-name">${ship.false_flag ? '⚑ ' : ''}${ship.name}</span>
      <span>${ship.classLabel}</span>
      <span>${where}</span>
      <span>${fmtQty(ship.cargoUsed)}/${fmtQty(ship.cargo_capacity)}</span>
      <button class="mode-toggle ${ship.mode !== 'manual' ? 'auto' : ''}"
        title="Basculer le mode (route ou mission en cours = retour au manuel)">${
          ship.mode === 'route' ? 'ROUTE' : ship.mode === 'auto' ? 'AUTO'
            : ship.mode === 'mission' ? 'MISSION' : 'MAN'}</button>
    `;
    chip.addEventListener('click', () => {
      state.selectedShipId = ship.id;
      renderFleetBar();
      renderHudPlayer();
      drawMap();
      refreshPlanetPanel();
    });
    chip.querySelector('.mode-toggle').addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = await apiPost(`/ships/${ship.id}/mode`, {
        mode: ship.mode === 'manual' ? 'auto' : 'manual',
      });
      if (r.ok) log(`${r.name} passe en mode ${r.mode === 'auto' ? 'automatique' : 'manuel'}`);
      await refreshPlayerAndKnowledge();
      renderFleetBar();
    });
    bar.appendChild(chip);
  }
}

function systemAt(mx, my) {
  let best = null;
  let bestDist = 12;
  for (const sys of state.universe.systems) {
    const [sx, sy] = toScreen(sys.x, sys.y);
    const d = Math.hypot(mx - sx, my - sy) - starRadius(sys);
    if (d < bestDist) {
      bestDist = d;
      best = sys;
    }
  }
  return best;
}

// Une planète en orbite sous le curseur (au zoom) — d'après le cache des
// positions dessinées au dernier rendu.
function planetAt(mx, my) {
  let best = null;
  let bestDist = Infinity;
  for (const h of planetHits) {
    const d = Math.hypot(mx - h.x, my - h.y);
    if (d <= h.r + 4 && d < bestDist) { bestDist = d; best = h; }
  }
  return best;
}

// — Caméra : glisser pour déplacer, molette pour zoomer, clic = choisir —

let drag = null; // { x, y, cx, cy, moved }

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, cx: state.view.cx, cy: state.view.cy, moved: false };
});

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
    drag.moved = true;
    canvas.style.cursor = 'grabbing';
    tooltip.hidden = true;
  }
  if (drag.moved) {
    const s = scaleOf();
    state.view.cx = drag.cx - dx / s;
    state.view.cy = drag.cy - dy / s;
    clampView();
  }
});

window.addEventListener('mouseup', (e) => {
  if (!drag) return;
  const wasDrag = drag.moved;
  drag = null;
  canvas.style.cursor = 'grab';
  if (!wasDrag && e.target === canvas) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Mini-carte : saut de caméra à l'endroit pointé.
    const jump = minimapAt(mx, my);
    if (jump) {
      state.view.cx = jump[0];
      state.view.cy = jump[1];
      clampView();
      return;
    }
    // La boussole hors-champ : un clic recentre sur le vaisseau.
    if (compassHit && Math.hypot(mx - compassHit.x, my - compassHit.y) <= compassHit.r) {
      centerOnShip();
      return;
    }
    // Une planète en orbite a la priorité (on est zoomé sur le système).
    const hit = planetAt(mx, my);
    if (hit) {
      const entry = state.planetIndex.get(hit.planetId);
      selectSystem(entry.system);
      selectPlanet(hit.planetId);
      return;
    }
    const sys = systemAt(mx, my);
    if (sys) selectSystem(sys);
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const [wx, wy] = toMap(mx, my);
  const v = state.view;
  v.zoom = Math.min(9, Math.max(0.55, v.zoom * Math.exp(-e.deltaY * 0.0013)));
  // Le point sous le curseur reste sous le curseur.
  const s = scaleOf();
  v.cx = wx - (mx - v.w / 2) / s;
  v.cy = wy - (my - v.h / 2) / s;
  clampView();
}, { passive: false });

canvas.addEventListener('mousemove', (e) => {
  if (drag?.moved) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  // Au-dessus de la mini-carte : pointeur, pas d'infobulle système.
  if (minimapAt(mx, my)) {
    state.hoverSystem = null;
    canvas.style.cursor = 'pointer';
    tooltip.hidden = true;
    return;
  }

  // Une planète en orbite sous le curseur : étiquette dédiée (biome,
  // population, tier), priorité sur l'étoile.
  const hit = planetAt(mx, my);
  if (hit) {
    const entry = state.planetIndex.get(hit.planetId);
    const p = entry.planet;
    state.hoverSystem = null;
    canvas.style.cursor = 'pointer';
    tooltip.hidden = false;
    tooltip.innerHTML = `<span class="biome-dot" style="display:inline-block;background:${BIOME_COLORS[p.biome]}"></span> `
      + `<strong>${p.name}</strong> ${tierBadge(p.tier)}<br>`
      + `${p.biomeLabel} · ${formatPop(p.population)}`;
    tooltip.style.left = `${mx + 14}px`;
    tooltip.style.top = `${my - 8}px`;
    return;
  }

  const sys = systemAt(mx, my);
  state.hoverSystem = sys;
  canvas.style.cursor = sys ? 'pointer' : 'grab';
  if (sys) {
    const age = state.knowledge.get(sys.id);
    const info = age === undefined ? 'marchés inconnus'
      : age === 0 ? 'données fraîches' : `données : il y a ${age} j`;
    const danger = state.fronts.has(sys.id)
      ? '<br><span style="color:#f04545">⚔ FRONT DE GUERRE — risque pirate extrême</span>'
      : sys.faction_id === null
        ? '<br><span style="color:#e8b35a">☠ zone pirate (Frange) — escorte conseillée</span>' : '';
    const f = sys.faction_id !== null ? state.factionById.get(sys.faction_id) : null;
    const pop = sys.planets.reduce((sum, p) => sum + p.population, 0);
    tooltip.hidden = false;
    tooltip.innerHTML = `<strong>${sys.name}</strong> — ${sys.planets.length} planètes · ${formatPop(pop)}<br>`
      + (f ? `<span style="color:${f.color}">◆ ${f.name}</span>` : '<span style="color:#6b7689">◇ Frange indépendante</span>')
      + ` · ${info}${danger}`;
    tooltip.style.left = `${e.clientX - rect.left + 14}px`;
    tooltip.style.top = `${e.clientY - rect.top - 8}px`;
  } else {
    tooltip.hidden = true;
  }
});

canvas.addEventListener('mouseleave', () => {
  state.hoverSystem = null;
  tooltip.hidden = true;
});

// — Boutons de la carte (zoom, recadrage, trafic) ————————————————

$('#zoom-in').addEventListener('click', () => {
  state.view.zoom *= 1.45;
  clampView();
});
$('#zoom-out').addEventListener('click', () => {
  state.view.zoom /= 1.45;
  clampView();
});
$('#zoom-fit').addEventListener('click', () => {
  const v = state.view;
  v.zoom = 1;
  v.cx = state.universe.mapSize / 2;
  v.cy = state.universe.mapSize / 2;
});
function centerOnShip() {
  const pos = shipMapPosition(selectedShip());
  if (!pos) return;
  const v = state.view;
  v.cx = pos.x;
  v.cy = pos.y;
  if (v.zoom < 2.2) v.zoom = 2.2;
  clampView();
}
$('#zoom-ship').addEventListener('click', centerOnShip);
$('#traffic-toggle').addEventListener('click', (e) => {
  state.showTraffic = !state.showTraffic;
  e.currentTarget.classList.toggle('off', !state.showTraffic);
});
// Mode « filons » : la géologie sondée, en couleurs (ambre = exceptionnel).
async function refreshSurveys() {
  const surveys = await api('/surveys');
  state.surveys = surveys;
  const by = new Map();
  for (const sv of surveys) {
    if (!by.has(sv.systemId) || sv.quality > by.get(sv.systemId)) by.set(sv.systemId, sv.quality);
  }
  state.geoBySystem = by;
}

$('#geo-toggle').addEventListener('click', async (e) => {
  const btn = e.currentTarget; // capturé avant l'await (currentTarget s'efface après)
  state.geoMap = !state.geoMap;
  if (state.geoMap) {
    await refreshSurveys();
    state.heatmap = null;
    updateHeatLegend();
  }
  btn.classList.toggle('off', !state.geoMap);
});

$('#mute-toggle').addEventListener('click', (e) => {
  muted = !muted;
  try { localStorage.setItem('nx-muted', muted ? '1' : '0'); } catch { /* privé */ }
  e.currentTarget.classList.toggle('off', muted);
  if (!muted) playSound('buy');
});
if (muted) $('#mute-toggle').classList.add('off');

// ── Panneau : système ────────────────────────────────────────────

function selectSystem(sys) {
  state.selectedSystem = sys;
  state.selectedPlanet = null;
  state.tradeSel = null;
  animatePanelOnce();
  renderSystemPanel(sys);
}

function tierBadge(tier) {
  const t = state.player?.tiers?.[tier];
  const locked = tier > 1 && t && !t.unlocked;
  return `<span class="badge ${locked ? 'locked' : ''}">T${tier}${locked ? ' ⚿' : ''}</span>`;
}

function factionChip(factionId) {
  if (factionId === null || factionId === undefined) return '<span class="badge">Frange indépendante</span>';
  const f = state.factionById.get(factionId);
  return `<button class="faction-chip" data-faction="${f.id}" style="color:${f.color};border-color:${f.color}">${f.name}</button>`;
}

function bindFactionChips() {
  for (const chip of panel.querySelectorAll('.faction-chip')) {
    chip.addEventListener('click', () => renderFactionPanel(Number(chip.dataset.faction)));
  }
}

async function renderSystemPanel(sys) {
  const age = state.knowledge.get(sys.id);
  panel.innerHTML = `
    <h2 class="panel-title">${sys.name}</h2>
    <p class="panel-sub">Système — position (${Math.round(sys.x)}, ${Math.round(sys.y)})
      — ${age === undefined ? 'marchés inconnus' : `données : il y a ${age} j`}</p>
    <div style="margin:4px 0 8px">${factionChip(sys.faction_id)}</div>
    <div class="section-label">Planètes (${sys.planets.length})</div>
    <div id="system-planets"></div>
    <div id="system-actions"></div>
  `;
  enhancePanel();
  bindFactionChips();
  const wrap = $('#system-planets');
  for (const p of sys.planets) {
    const row = document.createElement('button');
    row.className = 'planet-row';
    row.innerHTML = `
      <span class="biome-dot" style="background:${BIOME_COLORS[p.biome]}"></span>
      <span>${p.name} ${tierBadge(p.tier)}</span>
      <span class="meta">${p.biomeLabel}<br>${formatPop(p.population)}</span>
    `;
    row.addEventListener('click', () => selectPlanet(p.id));
    wrap.appendChild(row);
  }

  // Sonder la géologie du système (vaisseau à quai dans CE système).
  const shipHereSys = (() => {
    const sh = selectedShip();
    if (sh?.planet_id == null) return false;
    return state.planetIndex.get(sh.planet_id)?.system.id === sys.id;
  })();
  if (shipHereSys) {
    const btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.textContent = `⛏ Sonder les gisements du système`;
    btn.title = 'Révèle la qualité géologique de chaque planète (mode « filons » de la carte)';
    btn.addEventListener('click', async () => {
      const r = await apiPost('/surveys', { systemId: sys.id, shipId: selectedShip()?.id });
      if (r.ok) {
        log(`Sondage : ${r.surveyed} planètes relevées (−${fmtInt.format(r.cost)} cr) — meilleur filon ×${r.bestQuality}`);
        toast(`Sondage de ${sys.name} : meilleur filon ×${r.bestQuality}`, r.bestQuality >= 1.3 ? 'good' : 'info');
        await refreshSurveys();
        renderSystemPanel(sys);
      } else {
        log(`Sondage impossible : ${r.error}`);
      }
    });
    $('#system-actions').appendChild(btn);
  }

  // Relevé de marché à distance (si à quai quelque part).
  if (selectedShip()?.planet_id != null) {
    const preview = await api(`/intel/preview?systemId=${sys.id}&shipId=${selectedShip().id}`);
    if (preview.ok && state.selectedSystem === sys && !state.selectedPlanet) {
      const btn = document.createElement('button');
      btn.className = 'action-btn';
      btn.textContent = `Acheter un relevé de marché (${fmtInt.format(preview.cost)} cr)`;
      btn.addEventListener('click', async () => {
        const r = await apiPost('/intel', { systemId: sys.id, shipId: selectedShip()?.id });
        if (r.ok) {
          log(`Relevé de ${sys.name} acheté (−${fmtInt.format(r.cost)} cr)`);
          await refreshPlayerAndKnowledge();
          renderSystemPanel(sys);
        } else {
          log(`Relevé refusé : ${r.error}`);
        }
      });
      $('#system-actions').appendChild(btn);
    }
  }
}

// ── Panneau : planète ────────────────────────────────────────────

async function selectPlanet(planetId) {
  state.selectedPlanet = planetId;
  state.tradeSel = null;
  animatePanelOnce();
  await refreshPlanetPanel();
}

async function refreshPlanetPanel() {
  const id = state.selectedPlanet;
  if (id === null) return;
  // Ne pas écraser le formulaire pendant une saisie ou un choix.
  if (document.activeElement && panel.contains(document.activeElement)
    && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;

  const [planet, market] = await Promise.all([api(`/planet/${id}`), api(`/market/${id}`)]);
  if (state.selectedPlanet !== id) return;

  const scroll = panel.scrollTop;
  if (planet.docked) renderDockedPanel(planet, market);
  else await renderRemotePanel(planet, market);
  panel.scrollTop = scroll;
}

// Mini-graphe de prix (60 derniers ticks) dans le formulaire d'ordre.
// Masqué quand l'historique est trop court (pas de trou vide).
function drawSparkline(points) {
  const c = $('#spark');
  if (!c) return;
  c.hidden = points.length < 2;
  if (c.hidden) return;
  const g = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  g.clearRect(0, 0, w, h);
  const values = points.map((p) => p.price);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  g.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * (w - 4) + 2;
    const y = h - 4 - ((v - min) / span) * (h - 8);
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  });
  g.strokeStyle = '#53c7f0';
  g.lineWidth = 1.2;
  g.stroke();
  g.fillStyle = '#6b7689';
  g.font = '9px ui-monospace, monospace';
  g.fillText(max.toFixed(1), 2, 9);
  g.fillText(min.toFixed(1), 2, h - 1);
}

function panelHeader(planet, extra = '') {
  const supply = planet.supply !== undefined && planet.supply < 0.85
    ? ` · <span class="price-high">approvisionnement ${Math.round(planet.supply * 100)} %</span>` : '';
  if (planet.colonyBoom) extra += ' <span class="badge age" title="Population en plein boom : tout manque, les pionniers paient moitié prix (concessions, comptoirs)">COLONIE EN BOOM</span>';
  return `
    <button class="back-link" id="back-to-system">← ${planet.system_name}</button>
    <h2 class="panel-title">${planet.name} ${tierBadge(planet.tier)} ${extra}</h2>
    <p class="panel-sub">
      <span class="biome-dot" style="display:inline-block;background:${BIOME_COLORS[planet.biome]}"></span>
      ${planet.biomeLabel} — ${formatPop(planet.population)}${supply}
    </p>
    <div style="margin:0 0 8px">${factionChip(planet.faction_id)}</div>
  `;
}

function bindBackLink() {
  $('#back-to-system').addEventListener('click', () => selectSystem(state.selectedSystem));
}

// Bouton licence quand le tier de la planète est verrouillé.
function licenceBlock(planet) {
  const t = state.player.tiers[planet.tier];
  if (planet.tier <= 1 || t.unlocked) return '';
  return `
    <div class="info-block">
      Marché de tier ${planet.tier} : prestige ${fmtInt.format(t.prestigeRequired)} requis
      (vous : ${fmtInt.format(state.player.prestige)})
      <button class="action-btn" id="btn-licence" data-tier="${planet.tier}">
        Acheter la licence T${planet.tier} (${fmtInt.format(t.licenceCost)} cr)
      </button>
    </div>
  `;
}

function bindLicenceButton() {
  $('#btn-licence')?.addEventListener('click', async (e) => {
    const r = await apiPost('/licence', { tier: Number(e.target.dataset.tier) });
    if (r.ok) log(`Licence T${r.tier} acquise (−${fmtInt.format(r.cost)} cr)`);
    else log(`Licence refusée : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanel();
  });
}

// — Vue à quai : marché en direct + commerce ———————————————

function renderDockedPanel(planet, market) {
  const ship = selectedShip();
  const shipHere = ship && ship.planet_id === planet.id;
  const trends = computeTrends(market);
  const cargoByRes = new Map((ship?.cargo ?? []).map((c) => [c.resource_id, c]));

  let html = panelHeader(planet, '<span class="badge live">FLOTTE À QUAI</span>');
  html += licenceBlock(planet);
  if (!shipHere) {
    html += `<div class="info-block">Données en direct (un de vos vaisseaux est à quai).
      Sélectionnez un vaisseau amarré ici pour commercer.</div>`;
  }
  // Suggestion de débouché (remplie en asynchrone) : où vendre la soute,
  // et la navette automatique en un clic depuis une concession.
  html += '<div id="best-outlet"></div>';

  // Relier ce marché à une concession par une navette permanente.
  html += linkRouteHtml(planet);

  // Clients : offres d'approvisionnement et contrats signés ici.
  html += clientsSectionHtml(planet);

  // Grand chantier à cette capitale : livraison au prix garanti.
  for (const mp of planet.megaprojects ?? []) {
    html += `<div class="section-label">★ Grand chantier — ${mp.name}</div>
      <div class="info-block" style="border-left:3px solid ${mp.faction_color}">`;
    for (const n of mp.needs) {
      const held = (selectedShip()?.cargo ?? []).find((l) => l.resource_id === n.resource_id)?.quantity ?? 0;
      const full = n.delivered >= n.required;
      html += `<div class="row"><span>${resChip(n.resource_id, n.resourceName)} ${full ? '✓' : ''}</span>
        <span>${fmtQty(n.delivered)}/${fmtQty(n.required)} ·
          <span class="price-low">${fmtPrice.format(n.unit_price)} cr/u</span>
          ${shipHere && !full && held > 0
            ? `<button class="action-btn mini mp-deliver" data-mp="${mp.id}" data-res="${n.resource_id}">livrer (${fmtQty(held)})</button>`
            : ''}</span></div>`;
    }
    html += `<div style="color:var(--dim);font-size:11px;margin-top:4px">Prix garanti, volumes
      massifs — le débouché des Léviathans. Le plus gros fournisseur entre dans la légende.</div></div>`;
  }

  // Industrie : votre concession sur cette planète (ou son achat).
  const c = state.player.concessions.find((x) => x.planet_id === planet.id);
  if (c) {
    const pct = Math.round((c.used / c.cap) * 100);
    const qCls = c.quality >= 1.3 ? 'price-low' : c.quality < 0.8 ? 'price-high' : '';
    html += `
      <div class="section-label">Concession — ${resChip(c.resource_id, c.resourceName)} (niv. ${c.level})</div>
      <div class="info-block">
        <div class="row"><span>Gisement</span>
          <span class="${qCls}">${c.qualityLabel} ×${fmtNum.format(c.quality)}</span></div>
        <div class="row"><span>Extraction</span><span>+${fmtNum.format(c.rate)}/j</span></div>
        <div class="row"><span>Entrepôt</span><span>${fmtQty(c.used)} / ${fmtQty(c.cap)} (${pct} %)</span></div>
        <div class="gauge"><div style="width:${pct}%"></div></div>
    `;
    for (const s of c.storage) {
      html += `<div class="row"><span>${resChip(s.resource_id, s.name)}</span>
        <span>${fmtQty(s.quantity)}
        ${shipHere ? `<button class="action-btn collect-btn" data-res="${s.resource_id}">→ soute</button>` : ''}
        </span></div>`;
    }
    if (shipHere && c.storage.length > 0) {
      html += `<div style="margin-top:4px"><button class="action-btn mini" id="btn-collect-all"
        title="Remplit la soute avec tout l'entrepôt (par quantités décroissantes)">tout charger → soute</button></div>`;
    }
    const shipCargo = selectedShip()?.cargo ?? [];
    if (shipHere && shipCargo.length > 0) {
      html += `<div class="row" style="margin-top:6px"><span>Déposer</span><span>
        <select id="deposit-res">${shipCargo.map((x) =>
          `<option value="${x.resource_id}">${(resCats[resById.get(x.resource_id)?.cat]?.glyph ?? '')} ${x.name} (${fmtQty(x.quantity)})</option>`).join('')}</select>
        <button class="action-btn" id="btn-deposit">→ entrepôt</button></span></div>`;
    }
    html += `
        ${c.nextLevelCost !== null
          ? `<button class="action-btn" id="btn-upgrade" data-cid="${c.id}">Améliorer (${fmtInt.format(c.nextLevelCost)} cr)</button>`
          : '<span class="badge">niveau max</span>'}
      </div>
    `;

    // Le commerce en trois choix : ressource, quantité, destination.
    html += missionSectionHtml(planet, c);

    // Ateliers : installés, puis installables selon vos technologies.
    html += `<div class="section-label">Ateliers (×${c.workshops.length})</div>`;
    for (const w of c.workshops) {
      const inputs = Object.entries(w.inputs)
        .map(([rid, q]) => `${q} ${state.player.workshopCatalog.find((x) => x.recipe_id === rid)?.name ?? rid}`)
        .join(' + ');
      html += `<div class="industry">${w.name}
        <span class="io">— ${inputs} → ${w.output} (×${w.rate}/j)</span></div>`;
    }
    if (shipHere) {
      const installed = new Set(c.workshops.map((w) => w.recipe_id));
      const installable = state.player.workshopCatalog
        .filter((w) => w.unlocked && !installed.has(w.recipe_id));
      if (installable.length > 0) {
        html += `<div>`;
        for (const w of installable) {
          html += `<button class="action-btn install-btn" data-cid="${c.id}" data-recipe="${w.recipe_id}"
            ${state.player.credits < w.cost ? 'disabled' : ''}>
            + ${w.name} (${fmtQty(w.cost)} cr)</button>`;
        }
        html += `</div>`;
      } else if (c.workshops.length === 0) {
        html += `<div class="industry io">Recherchez des filières (bouton TECH) pour installer des ateliers</div>`;
      }
    }
  } else if (shipHere && state.player.concessions.length < state.player.maxConcessions) {
    html += `<div class="section-label">Industrie</div>`;
    if (planet.rivalClaim) {
      html += `<div class="industry"><span style="color:${planet.rivalClaim.color}">⛏ ${planet.rivalClaim.name}</span>
        <span class="io">exploite déjà ce filon — la course aux filons ne pardonne pas</span></div>`;
    } else {
      const dq = planet.depositQuality;
      const dqCls = dq >= 1.3 ? 'price-low' : dq !== null && dq < 0.8 ? 'price-high' : '';
      html += dq === null
        ? `<div class="industry io">Géologie inconnue — sondez le système (vue système, ⛏)</div>`
        : `<div class="industry">Gisement local :
            <span class="${dqCls}">${planet.depositLabel} ×${fmtNum.format(dq)}</span>
            <span class="io">— les filons riches sont rares, et les rivaux rôdent</span></div>`;
      html += `<button class="action-btn" id="btn-buy-concession">
          Acheter une concession ici (${fmtQty(state.player.nextConcessionPrice)} cr — Prospection requise)
        </button>`;
    }
  }

  // Comptoir commercial : entrepôt + ordres permanents qui pèsent sur
  // les prix locaux (acheter sous une limite, vendre au-dessus d'un
  // plancher) — l'outil d'accaparement.
  const post = (state.player.posts ?? []).find((x) => x.planet_id === planet.id);
  if (post) {
    const pct = Math.round((post.used / post.cap) * 100);
    html += `
      <div class="section-label">Comptoir commercial (niv. ${post.level}) — débit ${fmtQty(post.flow)}/j</div>
      <div class="info-block">
        <div class="row"><span>Entrepôt</span><span>${fmtQty(post.used)} / ${fmtQty(post.cap)} (${pct} %)</span></div>
        <div class="gauge"><div style="width:${pct}%"></div></div>
    `;
    for (const s of post.storage) {
      html += `<div class="row"><span>${resChip(s.resource_id, s.name)}
        <span style="color:var(--dim)">(coût moy. ${fmtPrice.format(s.avg_cost)})</span></span>
        <span>${fmtQty(s.quantity)}
        ${shipHere ? `<button class="action-btn post-withdraw" data-res="${s.resource_id}">→ soute</button>` : ''}
        </span></div>`;
    }
    const postCargo = selectedShip()?.cargo ?? [];
    if (shipHere && postCargo.length > 0) {
      html += `<div class="row" style="margin-top:6px"><span>Déposer</span><span>
        <select id="post-deposit-res">${postCargo.map((x) =>
          `<option value="${x.resource_id}">${(resCats[resById.get(x.resource_id)?.cat]?.glyph ?? '')} ${x.name} (${fmtQty(x.quantity)})</option>`).join('')}</select>
        <button class="action-btn" id="btn-post-deposit">→ comptoir</button></span></div>`;
    }
    html += `
        ${post.nextLevelCost !== null
          ? `<button class="action-btn" id="btn-post-upgrade" data-pid="${post.id}">Agrandir (${fmtQty(post.nextLevelCost)} cr)</button>`
          : '<span class="badge">niveau max</span>'}
      </div>
    `;

    html += `<div class="section-label">Ordres permanents (${post.orders.length}/${state.player.maxPostOrders})</div>`;
    for (const o of post.orders) {
      const live = o.last_qty > 0
        ? `<span class="${o.side === 'buy' ? 'price-low' : 'price-high'}">${
            o.side === 'buy' ? '+' : '−'}${fmtQty(o.last_qty)} à ${fmtPrice.format(o.last_price)}</span>`
        : '<span class="io">en veille</span>';
      html += `<div class="industry">${o.side === 'buy' ? 'ACHAT' : 'VENTE'} ${o.name}
        <span class="io">— ${o.side === 'buy' ? 'tant que ≤' : 'tant que ≥'} ${fmtPrice.format(o.limit_price)} cr
        · ${fmtQty(o.flow)}/j</span> · ${live}
        ${shipHere ? `<button class="action-btn post-del-order" data-pid="${post.id}" data-oid="${o.id}">✕</button>` : ''}</div>`;
    }
    if (shipHere) {
      const inputStyle = 'background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:inherit;padding:3px 5px';
      html += `<div class="info-block">
        <div class="row"><span>
          <select id="post-order-side">
            <option value="buy">Acheter tant que prix ≤</option>
            <option value="sell">Vendre tant que prix ≥</option>
          </select>
          <select id="post-order-res">${market.prices.map((r) =>
            `<option value="${r.resource_id}">${r.name}</option>`).join('')}</select>
        </span></div>
        <div class="row" style="margin-top:5px"><span>
          <input type="number" id="post-order-limit" placeholder="limite cr" min="0.1" step="0.1" style="width:110px;${inputStyle}">
          <input type="number" id="post-order-flow" placeholder="u/jour" min="1" max="${post.flow}" value="${post.flow}" style="width:78px;${inputStyle}">
          <button class="action-btn" id="btn-post-order">Poser l'ordre</button>
        </span></div>
        <div style="color:var(--dim);font-size:11px;margin-top:5px">Un ordre d'achat draine le
          marché — le prix MONTE (accaparement). Un ordre de vente l'inonde — le prix BAISSE.
          Reposer le même couple ressource + sens remplace l'ordre.</div>
      </div>`;
    }
  } else if (shipHere && (state.player.posts ?? []).length < state.player.maxPosts) {
    html += `
      <div class="section-label">Commerce permanent</div>
      <button class="action-btn" id="btn-buy-post"
        title="Entrepôt sur place, marché télégraphié en continu (relevés toujours frais), ordres permanents d'achat/vente qui pèsent sur les prix">
        Ouvrir un comptoir ici (${fmtQty(state.player.nextPostPrice)} cr)
      </button>
    `;
  }

  // La Frange vend des pavillons de complaisance (anonymat commercial).
  if (shipHere && planet.faction_id === null && !ship.false_flag) {
    html += `
      <div class="section-label">Bas-fonds de la Frange</div>
      <button class="action-btn" id="btn-flag"
        title="Anonymat : listes noires ouvertes, douanes passées, ventes de guerre sans réputation — jusqu'à la détection">
        Pavillon de complaisance pour ${ship.name} (${fmtQty(8000)} cr)
      </button>
    `;
  }

  // Chantier civil : acheter des vaisseaux sur les mondes établis. Les
  // géants (Grand Vraquier, Léviathan) sortent des chantiers T3.
  if (shipHere && planet.tier >= 2) {
    html += `<div class="section-label">Chantier civil — flotte ${state.player.ships.length}/${state.player.maxFleet}</div><div>`;
    for (const [classId, cls] of Object.entries(state.player.shipClasses)) {
      const tierLocked = planet.tier < (cls.minTier ?? 2);
      const disabled = tierLocked || state.player.credits < cls.price
        || state.player.ships.length >= state.player.maxFleet;
      html += `<button class="action-btn buy-ship" data-class="${classId}" ${disabled ? 'disabled' : ''}
        title="${tierLocked ? `chantier de tier ${cls.minTier} requis — les géants sortent des grands mondes`
          : `soute ${fmtQty(cls.cargo)} · vitesse ${cls.speed} · réservoir ${fmtQty(cls.fuel)} · entretien ${cls.upkeep} cr/j`}">
        ${cls.label} (${fmtQty(cls.price)} cr · ${cls.upkeep}/j)${tierLocked ? ' 🔒T3' : ''}</button>`;
    }
    html += `</div>`;
  }

  html += `<div class="section-label">Industries (investissables)</div>`;
  if (planet.industries.length === 0) html += `<div class="industry io">Aucune industrie locale</div>`;
  for (const ind of planet.industries) {
    const inputs = Object.entries(ind.inputs)
      .map(([rid, qty]) => `${qty} ${market.prices.find((r) => r.resource_id === rid)?.name ?? rid}`)
      .join(' + ');
    const stakeCost = Math.round(ind.valuation * 0.1);
    const canBuyMore = ind.playerShare < ind.maxShare - 1e-9;
    html += `<div class="industry">${ind.name}
      <span class="io">— ${inputs} → ${ind.output} (×${fmtNum.format(ind.rate)}/j)</span>
      ${ind.playerShare > 0 ? `<span class="badge live">${Math.round(ind.playerShare * 100)} %</span>` : ''}
      ${shipHere && canBuyMore
        ? `<button class="action-btn invest-btn" data-recipe="${ind.recipe_id}"
            ${state.player.credits < stakeCost ? 'disabled' : ''}>+10 % (${fmtQty(stakeCost)} cr)</button>` : ''}
      ${shipHere && ind.playerShare > 0
        ? `<button class="action-btn divest-btn" data-recipe="${ind.recipe_id}">Revendre</button>` : ''}
      </div>`;
  }

  // Charte industrielle : fonder une nouvelle industrie sur cette planète.
  if (shipHere && planet.foundable?.length > 0) {
    html += `<div class="row" style="margin:6px 0"><span>Fonder une industrie</span><span>
      <select id="found-recipe">${planet.foundable.map((f) =>
        `<option value="${f.recipe_id}">${f.name} (${fmtQty(f.cost)} cr)</option>`).join('')}</select>
      <button class="action-btn" id="btn-found">Fonder (49 %)</button></span></div>`;
  }

  html += `
    <div class="section-label">Marché en direct</div>
    <table>
      <tr><th>Ressource</th><th>Stock</th><th>Soute</th><th>Prix</th></tr>
  `;
  for (const tier of ['raw', 'intermediate', 'finished']) {
    html += `<tr class="tier-row"><td colspan="4">${TIER_LABELS[tier]}</td></tr>`;
    for (const r of market.prices.filter((r) => r.tier === tier)) {
      const ratio = r.price / r.basePrice;
      const priceCls = ratio >= 1.25 ? 'price-high' : ratio <= 0.8 ? 'price-low' : '';
      const trend = trends[r.resource_id] ?? 'flat';
      const arrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '·';
      const held = cargoByRes.get(r.resource_id)?.quantity ?? 0;
      const sel = state.tradeSel === r.resource_id ? 'selected' : '';
      html += `
        <tr class="res-row ${sel}" data-res="${r.resource_id}">
          <td class="res-name">${resChip(r.resource_id, r.name)}</td>
          <td>${fmtQty(r.stock)}</td>
          <td>${held > 0 ? fmtQty(held) : '·'}</td>
          <td class="${priceCls}" title="base : ${fmtPrice.format(r.basePrice)}">
            ${fmtPrice.format(r.price)} <span class="trend ${trend}">${arrow}</span>
          </td>
        </tr>
      `;
    }
  }
  html += `</table>`;

  // Formulaire d'ordre (ressource sélectionnée + vaisseau piloté à quai ici)
  if (shipHere) {
    html += `
      <div id="trade-form" ${state.tradeSel ? '' : 'hidden'}>
        <div class="selected-res" id="trade-res-name"></div>
        <canvas id="spark" width="330" height="46"></canvas>
        <div style="margin:6px 0">
          <input type="number" id="trade-qty" min="1" step="1" value="10">
          <button class="action-btn buy" id="btn-buy">Acheter</button>
          <button class="action-btn sell" id="btn-sell">Vendre</button>
        </div>
        <div style="margin:0 0 6px">
          <button class="action-btn mini" id="btn-max-buy" title="Quantité max achetable (soute, stock, crédits)">max achat</button>
          <button class="action-btn mini" id="btn-max-sell" title="Tout ce que la soute contient">max vente</button>
          <button class="action-btn mini" id="btn-refuel" title="Remplir le réservoir au prix du marché local">⛽ plein</button>
        </div>
        <div id="trade-preview"></div>
      </div>
    `;
  }

  panel.innerHTML = html;
  enhancePanel();
  bindBackLink();
  bindLicenceButton();
  const shipId = ship?.id;

  for (const btn of panel.querySelectorAll('.buy-ship')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost('/ships/buy', { classId: btn.dataset.class });
      if (r.ok) log(`${r.classLabel} « ${r.name} » livré au chantier (−${fmtQty(r.price)} cr)`);
      else log(`Achat impossible : ${r.error}`);
      await refreshPlayerAndKnowledge();
      refreshPlanetPanelForce();
    });
  }

  for (const btn of panel.querySelectorAll('.collect-btn')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost('/concession/collect', { shipId, resourceId: btn.dataset.res });
      if (r.ok) log(`${fmtQty(r.moved)} ${r.name} chargés en soute`);
      else log(`Chargement impossible : ${r.error}`);
      await refreshPlayerAndKnowledge();
      refreshPlanetPanelForce();
    });
  }

  // Tout charger : on remplit la soute lot par lot (gros lots d'abord).
  $('#btn-collect-all')?.addEventListener('click', async () => {
    const lots = [...c.storage].sort((a, b) => b.quantity - a.quantity);
    let moved = 0;
    for (const lot of lots) {
      const r = await apiPost('/concession/collect', { shipId, resourceId: lot.resource_id });
      if (!r.ok) break; // soute pleine
      moved += r.moved;
    }
    log(moved > 0 ? `${fmtQty(moved)} unités chargées en soute` : 'Soute déjà pleine');
    await refreshPlayerAndKnowledge();
    refreshPlanetPanelForce();
  });

  $('#btn-deposit')?.addEventListener('click', async () => {
    const r = await apiPost('/concession/deposit', { shipId, resourceId: $('#deposit-res').value });
    if (r.ok) log(`${fmtQty(r.moved)} ${r.name} déposés à l'entrepôt`);
    else log(`Dépôt impossible : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanelForce();
  });

  $('#btn-upgrade')?.addEventListener('click', async (e) => {
    const r = await apiPost('/concession/upgrade', { concessionId: Number(e.target.dataset.cid) });
    if (r.ok) log(`Concession niveau ${r.level} — extraction ${fmtNum.format(r.rate)}/j (−${fmtInt.format(r.cost)} cr)`);
    else log(`Amélioration impossible : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanel();
  });

  for (const btn of panel.querySelectorAll('.install-btn')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost(`/concessions/${btn.dataset.cid}/workshops`, { recipeId: btn.dataset.recipe });
      if (r.ok) log(`Atelier ${r.name} installé (−${fmtQty(r.cost)} cr)`);
      else log(`Installation impossible : ${r.error}`);
      await refreshPlayerAndKnowledge();
      refreshPlanetPanelForce();
    });
  }

  for (const btn of panel.querySelectorAll('.invest-btn')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost('/industry/invest', { recipeId: btn.dataset.recipe, share: 0.1, shipId });
      if (r.ok) log(`Parts acquises : ${Math.round(r.share * 100)} % de ${r.name} sur ${r.planetName} (−${fmtQty(r.cost)} cr)`);
      else log(`Investissement refusé : ${r.error}`);
      await refreshPlayerAndKnowledge();
      refreshPlanetPanelForce();
    });
  }
  $('#btn-found')?.addEventListener('click', async () => {
    const r = await apiPost('/industry/found', { recipeId: $('#found-recipe').value, shipId });
    if (r.ok) log(`Industrie fondée : ${r.name} sur ${r.planetName} (×${fmtNum.format(r.rate)}/j, 49 % fondateur, −${fmtQty(r.cost)} cr)`);
    else log(`Fondation impossible : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanelForce();
  });

  for (const btn of panel.querySelectorAll('.divest-btn')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost('/industry/divest', { recipeId: btn.dataset.recipe, shipId });
      if (r.ok) log(`Parts de ${r.name} revendues (+${fmtQty(r.refund)} cr, décote appliquée)`);
      else log(`Revente refusée : ${r.error}`);
      await refreshPlayerAndKnowledge();
      refreshPlanetPanelForce();
    });
  }

  if ($('#btn-flag')) {
    $('#btn-flag').addEventListener('click', async () => {
      const r = await apiPost(`/ships/${shipId}/flag`);
      if (r.ok) log(`${r.shipName} navigue désormais sous pavillon de complaisance (−${fmtQty(r.cost)} cr)`);
      else log(`Pavillon refusé : ${r.error}`);
      await refreshPlayerAndKnowledge();
      refreshPlanetPanelForce();
    });
    // Découverte : la contrebande, expliquée la première fois qu'elle est
    // accessible (un vaisseau à quai dans la Frange).
    discoverOnce('disc-flag',
      `Contrebande : sous pavillon de complaisance, vos ventes deviennent `
      + `anonymes — vous fournissez les DEUX camps d'une guerre sans que votre `
      + `réputation n'en pâtisse, et vous forcez les blocus. L'arme du profiteur.`,
      '#btn-flag');
  }

  $('#btn-buy-concession')?.addEventListener('click', async () => {
    const r = await apiPost('/concessions/buy', { shipId });
    if (r.ok) log(`Concession acquise sur ${r.planetName} — extraction de ${r.resourceName} (−${fmtQty(r.price)} cr)`);
    else log(`Achat impossible : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanelForce();
  });

  // — Comptoir : achat, agrandissement, transferts, ordres ————————
  for (const btn of panel.querySelectorAll('.mp-deliver')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost(`/megaprojects/${btn.dataset.mp}/deliver`, {
        shipId, resourceId: btn.dataset.res,
      });
      if (r.ok) {
        toast(`Chantier « ${r.projectName} » : ${fmtQty(r.delivered)} ${r.resourceName} livrés (+${fmtQty(r.paid)} cr)`, 'good');
        playSound('sell');
        const pos = shipMapPosition(selectedShip());
        if (pos) addFloater(pos.x, pos.y, `+${fmtQty(r.paid)} cr`, '#5fd68b');
      } else {
        log(`Livraison chantier : ${r.error}`);
      }
      await refreshPlayerAndKnowledge();
      refreshPlanetPanelForce();
    });
  }

  $('#btn-buy-post')?.addEventListener('click', async () => {
    const r = await apiPost('/posts/buy', { shipId });
    if (r.ok) log(`Comptoir ouvert sur ${r.planetName} (−${fmtQty(r.price)} cr) — son marché vous est télégraphié`);
    else log(`Comptoir refusé : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanelForce();
  });

  $('#btn-post-upgrade')?.addEventListener('click', async (e) => {
    const r = await apiPost(`/posts/${e.target.dataset.pid}/upgrade`);
    if (r.ok) log(`Comptoir niveau ${r.level} — entrepôt ${fmtQty(r.cap)}, débit ${fmtQty(r.flow)}/j (−${fmtQty(r.cost)} cr)`);
    else log(`Agrandissement impossible : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanelForce();
  });

  for (const btn of panel.querySelectorAll('.post-withdraw')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost('/posts/transfer', { shipId, resourceId: btn.dataset.res, direction: 'withdraw' });
      if (r.ok) log(`${fmtQty(r.moved)} ${r.name} chargés depuis le comptoir`);
      else log(`Chargement impossible : ${r.error}`);
      await refreshPlayerAndKnowledge();
      refreshPlanetPanelForce();
    });
  }

  $('#btn-post-deposit')?.addEventListener('click', async () => {
    const r = await apiPost('/posts/transfer', {
      shipId, resourceId: $('#post-deposit-res').value, direction: 'deposit',
    });
    if (r.ok) log(`${fmtQty(r.moved)} ${r.name} déposés au comptoir`);
    else log(`Dépôt impossible : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanelForce();
  });

  $('#btn-post-order')?.addEventListener('click', async () => {
    const r = await apiPost(`/posts/${post.id}/orders`, {
      resourceId: $('#post-order-res').value,
      side: $('#post-order-side').value,
      limitPrice: Number($('#post-order-limit').value),
      flow: Number($('#post-order-flow').value),
    });
    if (r.ok) {
      log(`Ordre ${r.replaced ? 'remplacé' : 'posé'} : ${r.side === 'buy' ? 'ACHAT' : 'VENTE'} ${r.name} `
        + `${r.side === 'buy' ? '≤' : '≥'} ${fmtPrice.format(r.limitPrice)} cr (${fmtQty(r.flow)}/j)`);
    } else {
      log(`Ordre refusé : ${r.error}`);
    }
    await refreshPlayerAndKnowledge();
    refreshPlanetPanelForce();
  });

  for (const btn of panel.querySelectorAll('.post-del-order')) {
    btn.addEventListener('click', async () => {
      await fetch(`/api/posts/${btn.dataset.pid}/orders/${btn.dataset.oid}`, { method: 'DELETE' });
      log('Ordre permanent retiré');
      await refreshPlayerAndKnowledge();
      refreshPlanetPanelForce();
    });
  }

  $('#btn-refuel')?.addEventListener('click', async () => {
    const r = await apiPost('/refuel', { shipId });
    if (r.ok) log(`Plein : +${fmtInt.format(r.quantity)} carburant à ${fmtPrice.format(r.unitPrice)} (−${fmtPrice.format(r.total)} cr)`);
    else log(`Ravitaillement impossible : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanel();
  });

  if (shipHere) {
    for (const row of panel.querySelectorAll('.res-row')) {
      row.addEventListener('click', () => {
        state.tradeSel = row.dataset.res;
        refreshPlanetPanelForce();
      });
    }
  }
  bindResTips(market); // infobulles enrichies au survol des ressources

  if (shipHere && state.tradeSel) {
    const res = market.prices.find((r) => r.resource_id === state.tradeSel);
    const held = cargoByRes.get(state.tradeSel)?.quantity ?? 0;
    const space = Math.max(0, ship.cargo_capacity - ship.cargoUsed);
    $('#trade-res-name').textContent =
      `${res.name} — ${fmtPrice.format(res.price)} cr · stock ${fmtQty(res.stock)}`
      + ` · soute ${fmtQty(held)} · ${fmtQty(state.player.credits)} cr en caisse`;
    drawSparkline(market.history?.[state.tradeSel] ?? []);
    const qtyInput = $('#trade-qty');
    qtyInput.addEventListener('input', () => updateTradePreview());
    $('#btn-buy').addEventListener('click', () => doTrade('buy'));
    $('#btn-sell').addEventListener('click', () => doTrade('sell'));
    // MAX : borné par la soute, le stock du marché et la trésorerie
    // (marge de 5 % contre le glissement de prix).
    $('#btn-max-buy').addEventListener('click', () => {
      const maxBuy = Math.floor(Math.min(space, res.stock,
        state.player.credits / (res.price * 1.05)));
      qtyInput.value = Math.max(1, maxBuy);
      updateTradePreview();
    });
    $('#btn-max-sell').addEventListener('click', () => {
      qtyInput.value = Math.max(1, Math.floor(held));
      updateTradePreview();
    });
    updateTradePreview();
  }

  fillBestOutlet(planet, market); // suggestion de débouché (asynchrone)
  bindMissionSection(planet); // formulaire « vendre la production »
  bindClientsSection(); // offres et livraisons clients
  bindLinkRoute(planet); // navette vers ce marché
}

// Le conseiller commercial : pour la plus grosse cargaison en soute, le
// meilleur marché CONNU et accessible (tier) — avec le gain estimé, un
// lien direct, et la navette automatique en un clic depuis une
// concession (charger tout ici → vendre tout là-bas, en boucle).
async function fillBestOutlet(planet, market) {
  const slot = $('#best-outlet');
  const ship = selectedShip();
  if (!slot || !ship || ship.planet_id !== planet.id) return;
  const cargo = [...(ship.cargo ?? [])].sort((a, b) => b.quantity - a.quantity)[0];
  if (!cargo) { slot.innerHTML = ''; return; }

  const scan = await api(`/market-scan/${cargo.resource_id}`);
  if (state.selectedPlanet !== planet.id || !$('#best-outlet')) return;

  const localPrice = market.prices.find((r) => r.resource_id === cargo.resource_id)?.price ?? 0;
  const unlocked = new Set([1]);
  for (const [t, info] of Object.entries(state.player.tiers ?? {})) {
    if (info.unlocked) unlocked.add(Number(t));
  }
  const best = scan.markets
    .filter((m) => m.planetId !== planet.id && unlocked.has(m.tier))
    .sort((a, b) => b.price - a.price)[0];
  if (!best || best.price <= localPrice * 1.05) { slot.innerHTML = ''; return; }

  const gain = Math.round((best.price - localPrice) * cargo.quantity);
  const isMyConcession = state.player.concessions.some((x) => x.planet_id === planet.id);
  slot.innerHTML = `
    <div class="info-block outlet">
      💡 Meilleur débouché connu pour vos ${fmtQty(cargo.quantity)} ${resChip(cargo.resource_id, cargo.name)} :
      <span class="goto-link" id="outlet-link">${best.planetName}</span>
      — ${fmtPrice.format(best.price)} cr (ici ${fmtPrice.format(localPrice)})
      ≈ <span class="price-low">+${fmtQty(gain)} cr</span>
      ${best.ageTicks > 0 ? `<span class="badge age">vu il y a ${best.ageTicks} j</span>` : '<span class="badge live">live</span>'}
      <div style="margin-top:6px">
        <button class="action-btn mini" id="outlet-go">y aller</button>
        ${isMyConcession ? `<button class="action-btn mini" id="outlet-shuttle"
          title="Crée une route en boucle (charger tout ici → vendre tout là-bas) et y assigne ce vaisseau — votre premier revenu automatique">🔁 navette auto</button>` : ''}
      </div>
    </div>`;

  const goTo = () => {
    const sys = state.universe.systems.find((s) => s.id === best.systemId);
    if (sys) { selectSystem(sys); selectPlanet(best.planetId); }
  };
  $('#outlet-link').addEventListener('click', goTo);
  $('#outlet-go').addEventListener('click', goTo);
  $('#outlet-shuttle')?.addEventListener('click', () => {
    createShuttle(planet.id, best.planetId, best.planetName);
  });
}

// — Missions de vente : « vendre N de X à tel marché » ——————————
// Le commerce en trois choix : ressource, quantité, destination — un
// vaisseau disponible (à quai, manuel) fait tout le trajet seul, avec
// rotations si la quantité dépasse sa soute. Le formulaire vit sur la
// planète de la concession, vaisseau présent ou non.

function missionSectionHtml(planet, c) {
  const missions = (state.player.missions ?? []).filter((m) => m.from_planet_id === planet.id);
  const inputStyle = 'background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:inherit;padding:3px 5px';
  let html = `<div class="section-label">Vendre la production</div>
    <div class="info-block outlet" id="mission-block">`;
  if (c.storage.length === 0 && missions.length === 0) {
    html += `<div style="color:var(--dim)">L'entrepôt se remplit tout seul
      (extraction ${fmtNum.format(c.rate)}/j) — revenez quand il y a de quoi vendre.</div>`;
  }
  if (c.storage.length > 0) {
    const first = c.storage[0];
    html += `
      <div class="row"><span>Vendre</span><span>
        <select id="mission-res">${c.storage.map((s) =>
          `<option value="${s.resource_id}" data-qty="${Math.floor(s.quantity)}">${(resCats[resById.get(s.resource_id)?.cat]?.glyph ?? '')} ${s.name} (${fmtQty(s.quantity)})</option>`).join('')}</select>
        <input type="number" id="mission-qty" min="1" value="${Math.max(1, Math.floor(first.quantity))}" style="width:80px;${inputStyle}">
      </span></div>
      <div class="row" style="margin-top:5px"><span>à</span><span>
        <select id="mission-dest" style="max-width:235px"><option value="">recherche des marchés connus…</option></select>
      </span></div>
      <div style="margin-top:7px">
        <button class="action-btn primary" id="btn-mission">Envoyer un vaisseau disponible</button>
        <label class="escort-opt" style="display:inline;margin-left:6px"
          title="La mission se réarme toute seule à chaque rotation accomplie — l'ordre permanent de l'empire">
          <input type="checkbox" id="mission-recurring"> ♻ récurrente</label>
      </div>
      <div style="color:var(--dim);font-size:11px;margin-top:5px">Le vaisseau charge ici, vend
        là-bas et revient — rotations automatiques si la quantité dépasse sa soute.
        Escorte payée d'elle-même en zone risquée.</div>`;
  }
  for (const m of missions) {
    html += `<div class="row" style="margin-top:6px">
      <span>🚀 ${m.ship_name} · ${resChip(m.resource_id, m.resourceName)} → ${m.to_name}${m.recurring ? ' ♻' : ''}</span>
      <span>reste ${fmtQty(m.quantity)}${m.carrying > 0 ? ` <span style="color:var(--dim)">(soute ${fmtQty(m.carrying)})</span>` : ''}
      <button class="action-btn mini cancel-mission" data-id="${m.id}" title="Annuler la mission (le vaisseau garde sa cargaison)">✕</button></span></div>`;
  }
  html += `</div>`;
  return html;
}

async function bindMissionSection(planet) {
  for (const btn of panel.querySelectorAll('.cancel-mission')) {
    btn.addEventListener('click', async () => {
      const r = await fetch(`/api/missions/${btn.dataset.id}`, { method: 'DELETE' })
        .then((x) => x.json());
      log(r.ok ? `Mission annulée — ${r.shipName} repasse en manuel` : `Annulation impossible : ${r.error}`);
      await refreshPlayerAndKnowledge();
      refreshPlanetPanelForce();
    });
  }
  const resSel = $('#mission-res');
  if (!resSel) return;

  const unlocked = new Set([1]);
  for (const [t, info] of Object.entries(state.player.tiers ?? {})) {
    if (info.unlocked) unlocked.add(Number(t));
  }

  // Destinations : les marchés CONNUS de la ressource, les mieux
  // offrants d'abord, limités aux tiers accessibles.
  const fillDest = async () => {
    const scan = await api(`/market-scan/${resSel.value}`);
    const destSel = $('#mission-dest');
    if (!destSel) return;
    const markets = scan.markets
      .filter((m) => m.planetId !== planet.id && unlocked.has(m.tier))
      .sort((a, b) => b.price - a.price)
      .slice(0, 10);
    destSel.innerHTML = markets.length
      ? markets.map((m) => `<option value="${m.planetId}">${m.planetName} — ${fmtPrice.format(m.price)} cr${
          m.ageTicks > 0 ? ` · vu ${m.ageTicks} j` : ''}</option>`).join('')
      : '<option value="">aucun marché connu — voyagez ou achetez des relevés</option>';
  };
  resSel.addEventListener('change', () => {
    const opt = resSel.selectedOptions[0];
    $('#mission-qty').value = Math.max(1, Number(opt?.dataset.qty ?? 1));
    fillDest();
  });
  await fillDest();

  $('#btn-mission')?.addEventListener('click', async () => {
    const toPlanetId = Number($('#mission-dest').value);
    if (!toPlanetId) { log('Choisissez une destination (marché connu)'); return; }
    const r = await apiPost('/missions', {
      resourceId: resSel.value,
      quantity: Number($('#mission-qty').value),
      fromPlanetId: planet.id,
      toPlanetId,
      recurring: Boolean($('#mission-recurring')?.checked),
    });
    if (r.ok) {
      toast(`${r.shipName} part vendre ${fmtQty(r.quantity)} ${r.resourceName} à ${r.destName}`, 'good');
      playSound('sell');
      log(`Mission : ${r.shipName} — ${fmtQty(r.quantity)} ${r.resourceName} → ${r.destName}`);
      state.guideFlags.missionCount = (state.guideFlags.missionCount ?? 0) + 1;
    } else {
      log(`Mission refusée : ${r.error}`);
    }
    await refreshPlayerAndKnowledge();
    refreshPlanetPanelForce();
  });
}

// — Clients réguliers : offres et contrats d'approvisionnement ————
// Une planète en pénurie durable propose un contrat à prix FIXÉ à la
// signature ; l'honorer fidélise le client (volumes et primes croissants).

function clientsSectionHtml(planet) {
  const clients = planet.clients ?? [];
  if (clients.length === 0) return '';
  let html = `<div class="section-label">Clients — approvisionnement</div>`;
  for (const sc of clients) {
    if (sc.status === 'open') {
      html += `<div class="info-block">
        <div class="row"><span>📦 Demande : ${fmtQty(sc.quantity)} ${resChip(sc.resource_id, sc.resourceName)}</span>
          <span class="price-low">${fmtPrice.format(sc.unit_price)} cr/u fixé</span></div>
        <div class="row"><span style="color:var(--dim)">offre valable jusqu'au ${dateOf(sc.expires_tick)}${
          sc.loyalty > 0 ? ` · client fidèle (niv. ${sc.loyalty})` : ''}</span>
          <span><button class="action-btn primary accept-client" data-id="${sc.id}">Signer</button></span></div>
        <div style="color:var(--dim);font-size:11px;margin-top:4px">Prix garanti à la signature —
          vos livraisons ne l'écrasent pas. Un client honoré revient, plus gros.</div>
      </div>`;
    } else {
      const ship = selectedShip();
      const here = ship?.planet_id === planet.id;
      const held = (ship?.cargo ?? []).find((l) => l.resource_id === sc.resource_id)?.quantity ?? 0;
      html += `<div class="info-block" style="border-left:3px solid var(--green)">
        <div class="row"><span>📦 Contrat signé : ${resChip(sc.resource_id, sc.resourceName)}</span>
          <span>${fmtQty(sc.remaining)}/${fmtQty(sc.quantity)} restants</span></div>
        <div class="row"><span style="color:var(--dim)">à ${fmtPrice.format(sc.unit_price)} cr/u ·
          avant le ${dateOf(sc.expires_tick)}</span>
          <span><button class="action-btn deliver-client" data-id="${sc.id}"
            ${here && held > 0 ? '' : 'disabled'}
            title="${here ? (held > 0 ? '' : 'rien de tel en soute') : 'amarrez un vaisseau ici'}">
            Livrer depuis la soute</button></span></div>
      </div>`;
    }
  }
  return html;
}

function bindClientsSection() {
  for (const btn of panel.querySelectorAll('.accept-client')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost(`/clients/${btn.dataset.id}/accept`);
      if (r.ok) {
        toast(`Contrat signé : ${fmtQty(r.quantity)} ${r.resourceName} pour ${r.planetName}`, 'good');
        log(`Client : ${r.planetName} — ${fmtQty(r.quantity)} ${r.resourceName} à ${fmtPrice.format(r.unitPrice)} cr/u (avant le ${dateOf(r.deadline)})`);
      } else {
        log(`Signature impossible : ${r.error}`);
      }
      await refreshPlayerAndKnowledge();
      refreshPlanetPanelForce();
    });
  }
  for (const btn of panel.querySelectorAll('.deliver-client')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost(`/clients/${btn.dataset.id}/deliver`, { shipId: selectedShip()?.id });
      if (r.ok) {
        log(`Livraison : ${fmtQty(r.delivered)} ${r.resourceName} à ${r.planetName} (+${fmtPrice.format(r.paid)} cr)`
          + (r.done ? ` · client honoré, fidélité ${r.loyalty}` : ''));
        if (r.done) { toast(`Client honoré : ${r.planetName} (fidélité ${r.loyalty})`, 'good'); playSound('objective'); }
        else playSound('sell');
      } else {
        log(`Livraison impossible : ${r.error}`);
      }
      await refreshPlayerAndKnowledge();
      refreshPlanetPanelForce();
    });
  }
}

// Depuis la fiche d'un marché : « je vois les prix → navette vers ici ».
// Visible dès que vous avez une concession ailleurs.
function linkRouteHtml(planet) {
  const sources = (state.player.concessions ?? []).filter((c) => c.planet_id !== planet.id);
  if (sources.length === 0) return '';
  // Marché verrouillé (tier) : la navette tournerait à vide — on prévient.
  if (planet.tier > 1 && !state.player.tiers?.[planet.tier]?.unlocked) {
    return `<div class="info-block" id="link-route-block">
      <div class="row"><span>🔁 Navette vers ici</span>
        <span class="badge locked">marché T${planet.tier} verrouillé</span></div>
      <div style="color:var(--dim);font-size:11px;margin-top:4px">Prestige ou licence d'abord —
        sinon le vaisseau ferait la boucle sans pouvoir vendre.</div>
    </div>`;
  }
  return `<div class="info-block" id="link-route-block">
    <div class="row"><span>🔁 Navette vers ici</span><span>
      ${sources.length > 1
        ? `<select id="link-route-src">${sources.map((c) =>
            `<option value="${c.planet_id}">${c.planetName} (${c.resourceName})</option>`).join('')}</select>`
        : `<span style="color:var(--dim)">${sources[0].planetName}</span>`}
      <button class="action-btn" id="btn-link-route">Créer</button></span></div>
    <div style="color:var(--dim);font-size:11px;margin-top:4px">Boucle permanente :
      charger tout à la concession → vendre tout ici. Un vaisseau libre est assigné d'office.</div>
  </div>`;
}

function bindLinkRoute(planet) {
  $('#btn-link-route')?.addEventListener('click', () => {
    const sources = (state.player.concessions ?? []).filter((c) => c.planet_id !== planet.id);
    const fromId = $('#link-route-src') ? Number($('#link-route-src').value) : sources[0]?.planet_id;
    if (fromId) createShuttle(fromId, planet.id, planet.name);
  });
}

// — Navette en un geste : la route « charger tout chez moi → vendre tout
// là-bas », créée et confiée à un vaisseau libre s'il y en a un.
async function createShuttle(fromPlanetId, toPlanetId, toName) {
  const fromEntry = state.planetIndex.get(fromPlanetId);
  const r = await apiPost('/routes', {
    name: `Navette ${fromEntry.planet.name} → ${toName}`,
    stops: [
      { planetId: fromPlanetId, actions: [{ type: 'load', resourceId: null, quantity: null }] },
      { planetId: toPlanetId, actions: [{ type: 'sell', resourceId: null, quantity: null }] },
    ],
  });
  if (!r.ok) { log(`Navette refusée : ${r.error}`); return; }

  const missionShips = new Set((state.player.missions ?? []).map((m) => m.ship_id));
  const free = (state.player.ships ?? []).find((sh) =>
    sh.mode === 'manual' && sh.planet_id !== null && !missionShips.has(sh.id));
  if (free) {
    const a = await apiPost(`/ships/${free.id}/route`, { routeId: r.id });
    if (a.ok) {
      toast(`Navette créée — ${free.name} fait la boucle ${fromEntry.planet.name} → ${toName}`, 'good');
      playSound('objective');
      log(`Navette « ${r.name} » assignée à ${free.name} (gérable via ROUTES)`);
    }
  } else {
    toast(`Navette « ${r.name} » créée — aucun vaisseau libre, assignez-en un via ROUTES`, 'warn');
    log(`Navette « ${r.name} » créée sans équipage (ROUTES → Assigner)`);
  }
  await refreshPlayerAndKnowledge();
  refreshPlanetPanelForce();
}

// Re-rendu forcé (ignore le garde-fou « input actif »).
async function refreshPlanetPanelForce() {
  const active = document.activeElement;
  if (active && panel.contains(active)) active.blur();
  await refreshPlanetPanel();
}

let previewTimer = null;
function updateTradePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const qty = Number($('#trade-qty')?.value);
    const out = $('#trade-preview');
    if (!out || !state.tradeSel) return;
    if (!(qty > 0)) { out.textContent = ''; return; }
    const shipId = selectedShip()?.id;
    const [buy, sell] = await Promise.all([
      api(`/trade/preview?side=buy&resource=${state.tradeSel}&qty=${qty}&shipId=${shipId}`),
      api(`/trade/preview?side=sell&resource=${state.tradeSel}&qty=${qty}&shipId=${shipId}`),
    ]);
    const line = (label, p) => p.ok
      ? `${label} : ${fmtPrice.format(p.unitPrice)}/u → ${fmtPrice.format(p.total)} cr`
        + (Math.abs(p.unitPrice - p.currentPrice) > 0.005
          ? ` (glissement depuis ${fmtPrice.format(p.currentPrice)})` : '')
      : `${label} : <span class="err">${p.error}</span>`;
    out.innerHTML = `${line('Achat', buy)}<br>${line('Vente', sell)}`;
  }, 200);
}

async function doTrade(side) {
  const quantity = Number($('#trade-qty').value);
  if (!(quantity > 0)) return;
  const r = await apiPost('/trade', {
    side, resourceId: state.tradeSel, quantity, shipId: selectedShip()?.id,
  });
  if (r.ok) {
    const verb = side === 'buy' ? 'Achat' : 'Vente';
    log(`${verb} : ${fmtQty(r.quantity)} × ${fmtPrice.format(r.unitPrice)} = ${fmtPrice.format(r.total)} cr`
      + (r.prestigeGained > 0 ? ` · +${fmtNum.format(r.prestigeGained)} prestige` : ''));
    // Le jus : la transaction se voit et s'entend.
    const pos = shipMapPosition(selectedShip());
    if (pos) {
      addFloater(pos.x, pos.y,
        side === 'sell' ? `+${fmtQty(r.total)} cr` : `−${fmtQty(r.total)} cr`,
        side === 'sell' ? '#5fd68b' : '#8fa1b8');
    }
    playSound(side === 'sell' ? 'sell' : 'buy');
    if (side === 'sell') {
      state.guideFlags.soldOnce = true;
      if (r.prestigeGained >= 15) {
        toast(`Belle affaire : +${fmtQty(r.total)} cr · +${fmtNum.format(r.prestigeGained)} prestige`, 'good');
      }
    }
  } else {
    log(`Ordre refusé : ${r.error}`);
  }
  await refreshPlayerAndKnowledge();
  refreshPlanetPanelForce();
}

// — Vue à distance : dernières données connues + voyage ————————

async function renderRemotePanel(planet, market) {
  let html = panelHeader(planet);
  html += `<div id="travel-slot"></div>`;
  html += licenceBlock(planet);

  // Votre concession ici, vue de loin : l'entrepôt se remplit tout seul,
  // les missions de vente se lancent sans vaisseau sur place.
  const myConcession = state.player.concessions.find((x) => x.planet_id === planet.id);
  if (myConcession) html += missionSectionHtml(planet, myConcession);

  // Offres clients de cette planète (visibles aussi de loin).
  html += clientsSectionHtml(planet);

  // « Je vois ce marché, je veux une navette vers ici » — aussi de loin.
  html += linkRouteHtml(planet);

  if (!market.known) {
    html += `<p class="hint">Marché inconnu — aucune donnée. Rapprochez-vous,
      ou achetez un relevé depuis la vue système.</p>`;
  } else {
    html += `
      <div class="section-label">Dernières données connues
        <span class="badge age">il y a ${market.ageTicks} j</span></div>
      <table>
        <tr><th>Ressource</th><th>Stock</th><th>Prix vu</th></tr>
    `;
    for (const tier of ['raw', 'intermediate', 'finished']) {
      html += `<tr class="tier-row"><td colspan="3">${TIER_LABELS[tier]}</td></tr>`;
      for (const r of market.prices.filter((r) => r.tier === tier)) {
        const ratio = r.price / r.basePrice;
        const priceCls = ratio >= 1.25 ? 'price-high' : ratio <= 0.8 ? 'price-low' : '';
        html += `
          <tr data-res="${r.resource_id}">
            <td class="res-name">${resChip(r.resource_id, r.name)}</td>
            <td>${r.stock === null ? '?' : fmtQty(r.stock)}</td>
            <td class="${priceCls}" title="base : ${fmtPrice.format(r.basePrice)}">${fmtPrice.format(r.price)}</td>
          </tr>
        `;
      }
    }
    html += `</table>`;
  }

  panel.innerHTML = html;
  enhancePanel();
  bindBackLink();
  bindLicenceButton();
  if (myConcession) bindMissionSection(planet);
  bindClientsSection();
  bindLinkRoute(planet);
  bindResTips(market); // infobulles enrichies (prix vs base, stock)

  // Bouton voyage (préparé en asynchrone) — pour le vaisseau piloté.
  const ship = selectedShip();
  const preview = await api(`/travel/preview?planetId=${planet.id}&shipId=${ship?.id}`);
  const slot = $('#travel-slot');
  if (!slot || state.selectedPlanet !== planet.id) return;
  if (preview.ok) {
    // Risque pirate du trajet : visible, et annulable par une escorte.
    const dangerous = preview.dangerLabel !== 'faible';
    const riskLine = dangerous
      ? `<label class="escort-opt" title="L'escorte annule tout risque d'abordage sur ce trajet">
           <input type="checkbox" id="travel-escort" checked>
           escorte ${fmtInt.format(preview.escortCost)} cr
           <span class="danger ${preview.dangerLabel === 'extrême' ? 'crit' : ''}">☠ risque ${preview.dangerLabel} sans escorte</span>
         </label>`
      : `<div class="escort-opt dim" title="Espace policé — une attaque reste improbable">trajet en espace sûr</div>`;
    slot.innerHTML = `
      <button class="action-btn primary" id="btn-travel">
        ${ship.name} : voyager — ${preview.ticks} jour${preview.ticks > 1 ? 's' : ''} ·
        ${preview.fuelCost > 0 ? `${fmtInt.format(preview.fuelCost)} carburant` : 'saut local'}
      </button>
      ${riskLine}
    `;
    $('#btn-travel').addEventListener('click', async () => {
      const escort = Boolean($('#travel-escort')?.checked);
      const r = await apiPost('/travel', { planetId: planet.id, shipId: ship.id, escort });
      if (r.ok) {
        log(`En route vers ${planet.name} — arrivée le ${dateOf(r.arrivalTick)}`
          + (r.escorted ? ` · sous escorte (−${fmtInt.format(r.escortCost)} cr)` : ''));
        await refreshPlayerAndKnowledge();
        renderHudPlayer();
        refreshPlanetPanelForce();
      } else {
        log(`Départ impossible : ${r.error}`);
      }
    });
  } else {
    slot.innerHTML = `<div class="info-block">Voyage impossible : ${preview.error}</div>`;
  }
}

// ── Panneau : comparateur de marchés (arbitrage + carte thermique) ─

// Agrège un scan en heatmap par système : meilleur prix connu (le plus
// bas = la meilleure occasion d'achat) rapporté au prix de base.
function buildHeatmap(scan) {
  const best = new Map(); // systemId → meilleur (plus bas) prix
  for (const m of scan.markets) {
    if (!best.has(m.systemId) || m.price < best.get(m.systemId)) best.set(m.systemId, m.price);
  }
  const bySystem = new Map();
  for (const [sysId, price] of best) bySystem.set(sysId, price / scan.basePrice);
  return { resourceId: scan.resourceId, name: scan.name, basePrice: scan.basePrice, bySystem };
}

function updateHeatLegend() {
  const el = $('#heat-legend');
  if (state.heatmap) {
    el.hidden = false;
    $('#heat-label').textContent = state.heatmap.name;
  } else {
    el.hidden = true;
  }
}

$('#heat-off').addEventListener('click', () => {
  state.heatmap = null;
  updateHeatLegend();
  drawMap();
});

async function renderMarketsPanel() {
  animatePanelOnce();
  state.selectedPlanet = null;
  state.guideFlags.sawMarkets = true;
  const scan = await api(`/market-scan/${state.marketSel}`);
  const ship = selectedShip();
  const origin = ship?.planet_id != null ? state.planetIndex.get(ship.planet_id)?.system : null;
  const distOf = (m) => origin ? Math.round(Math.hypot(m.x - origin.x, m.y - origin.y)) : null;

  const resources = state.universe.resources;
  const optGlyph = (r) => `${resCats[r.cat]?.glyph ?? ''} `;
  let html = `
    <button class="back-link" id="back-to-system">← retour</button>
    <h2 class="panel-title">Marchés — ${resChip(scan.resourceId, scan.name)}</h2>
    <p class="panel-sub">Comparateur d'arbitrage sur vos marchés connus
      (prix de base ${fmtPrice.format(scan.basePrice)} cr).</p>
    <div class="cat-legend">${Object.values(resCats).map((c) =>
      `<span><span class="rc-glyph" style="color:${c.color}">${c.glyph}</span>${c.label}</span>`).join('')}</div>
    <div style="margin-bottom:8px">
      <select id="market-res">
        ${['raw', 'intermediate', 'finished'].map((t) => `<optgroup label="${TIER_LABELS[t]}">${
          resources.filter((r) => r.tier === t)
            .map((r) => `<option value="${r.id}" ${r.id === state.marketSel ? 'selected' : ''}>${optGlyph(r)}${r.name}</option>`).join('')
        }</optgroup>`).join('')}
      </select>
      <button class="action-btn" id="market-heat">${
        state.heatmap?.resourceId === scan.resourceId ? 'Masquer la carte' : 'Voir sur la carte'}</button>
    </div>
  `;

  if (scan.markets.length === 0) {
    html += `<p class="hint">Aucun marché connu pour cette ressource. Voyagez,
      ou achetez des relevés, pour peupler votre carte.</p>`;
  } else {
    const sorted = [...scan.markets].sort((a, b) => a.price - b.price);
    const cheapest = sorted[0].price;
    const dearest = sorted[sorted.length - 1].price;
    html += `<table>
      <tr><th>Marché</th><th>Prix</th><th>Stock</th><th>Vu</th><th>Dist.</th></tr>`;
    // Fraîcheur de la donnée : en direct (vert), récente, datée (ambre),
    // périmée (rouge) — un prix vieux de 500 ticks ne vaut plus grand-chose.
    const ageCell = (t) => {
      if (t === 0) return '<td class="age-live">live</td>';
      if (t <= 30) return `<td>${t} j</td>`;
      if (t <= 120) return `<td class="age-mid" title="donnée datée">${t} j</td>`;
      return `<td class="age-old" title="donnée périmée — à revérifier">${t} j</td>`;
    };
    for (const m of sorted) {
      const cls = m.price === cheapest ? 'buy' : m.price === dearest ? 'sell' : '';
      html += `<tr class="market-row ${cls}">
        <td><span class="goto-link" data-planet="${m.planetId}" data-system="${m.systemId}">${m.planetName}</span></td>
        <td title="base ${fmtPrice.format(scan.basePrice)}">${fmtPrice.format(m.price)}</td>
        <td>${m.stock === null ? '?' : fmtQty(m.stock)}</td>
        ${ageCell(m.ageTicks)}
        <td>${distOf(m) === null ? '—' : fmtQty(distOf(m)) + 'u'}</td>
      </tr>`;
    }
    html += `</table>
      <p class="panel-sub" style="margin-top:8px">Marge brute repérée :
        <span class="price-low">${fmtPrice.format(cheapest)}</span> →
        <span class="price-high">${fmtPrice.format(dearest)}</span>
        (${fmtPrice.format(dearest - cheapest)} cr/u, hors glissement et transport)</p>`;
  }

  panel.innerHTML = html;
  enhancePanel();
  $('#back-to-system').addEventListener('click', () => {
    if (state.selectedSystem) renderSystemPanel(state.selectedSystem);
    else panel.innerHTML = '<p class="hint">Cliquez sur un système de la carte.</p>';
  });
  $('#market-res').addEventListener('change', (e) => {
    state.marketSel = e.target.value;
    renderMarketsPanel();
  });
  $('#market-heat').addEventListener('click', () => {
    state.heatmap = state.heatmap?.resourceId === scan.resourceId ? null : buildHeatmap(scan);
    updateHeatLegend();
    drawMap();
    renderMarketsPanel();
  });
  for (const link of panel.querySelectorAll('.goto-link')) {
    link.addEventListener('click', () => {
      const sys = state.universe.systems.find((s) => s.id === Number(link.dataset.system));
      if (sys) { selectSystem(sys); selectPlanet(Number(link.dataset.planet)); }
    });
  }
}

$('#btn-markets').addEventListener('click', renderMarketsPanel);

// ── Panneau : objectifs / fin de partie ──────────────────────────

async function renderObjectivesPanel() {
  animatePanelOnce();
  const objectives = await api('/objectives');
  state.selectedPlanet = null;
  state.guideFlags.sawObjectives = true;

  const doneCount = objectives.filter((o) => o.done).length;
  let html = `
    <button class="back-link" id="back-to-system">← retour</button>
    <h2 class="panel-title">Objectifs — ${doneCount}/${objectives.length}</h2>
    <p class="panel-sub">La route du Nexus : du colporteur à LA puissance
      commerciale de la galaxie. Chaque jalon rapporte du prestige.</p>
  `;
  for (const o of objectives) {
    html += `<div class="info-block ${o.done ? 'objective-done' : ''} ${o.victory ? 'objective-victory' : ''}">
      <div class="row"><span><strong>${o.victory ? '★ ' : ''}${o.name}</strong></span>
        <span>${o.done
          ? `<span class="badge live">ATTEINT · ${dateShort(o.completedTick)}</span>`
          : `<span class="badge">+${fmtInt.format(o.reward)} prestige</span>`}</span></div>
      <div style="color:var(--dim);margin-top:3px">${o.desc}</div>`;
    if (!o.done) {
      for (const p of o.progress) {
        const pctObj = Math.min(100, Math.round((p.value / p.goal) * 100));
        html += `<div class="row" style="margin-top:5px"><span>${p.label}</span>
          <span>${fmtQty(p.value)} / ${fmtQty(p.goal)}</span></div>
          <div class="gauge"><div style="width:${pctObj}%"></div></div>`;
      }
    }
    html += `</div>`;
  }

  panel.innerHTML = html;
  enhancePanel();
  $('#back-to-system').addEventListener('click', () => {
    if (state.selectedSystem) renderSystemPanel(state.selectedSystem);
    else panel.innerHTML = '<p class="hint">Cliquez sur un système de la carte.</p>';
  });
}

$('#btn-objectives').addEventListener('click', renderObjectivesPanel);

// ── Panneau : guerres — le tableau de bord du profiteur ──────────

async function renderWarsPanel() {
  animatePanelOnce();
  const data = await api('/wars');
  state.selectedPlanet = null;

  let html = `
    <button class="back-link" id="back-to-system">← retour</button>
    <h2 class="panel-title">⚔ Guerres</h2>
    <p class="panel-sub">Revenus de guerre cumulés :
      <span class="price-low">${fmtQty(data.warProfit)} cr</span>
      — ventes stratégiques aux belligérants, contrats et intérêts de prêts.</p>
  `;

  if (data.wars.length === 0) {
    html += `<div class="info-block">La galaxie est en paix. Ça ne durera pas —
      surveillez la diplomatie (panneaux de faction) : une guerre est le
      meilleur client d'un marchand.</div>`;
  } else {
    html += `<div class="info-block" style="border-color:var(--amber)">
      <strong>L'art du profiteur</strong> : chaque camp paie ses pénuries au
      prix fort à sa capitale. Vendez aux DEUX — l'acheteur vous adore,
      son ennemi finit par l'apprendre (réputation). Prêtez au futur
      vainqueur, livrez les contrats, et que la guerre dure.</div>`;
  }

  for (const war of data.wars) {
    html += `<div class="section-label">⚔ ${war.attacker.name} contre ${war.defender.name}
      — depuis le ${dateShort(war.since)}</div>`;

    // Votre main sur la balance : qui armez-vous le plus ?
    const sa = war.attacker.support ?? 0;
    const sd = war.defender.support ?? 0;
    if (sa + sd >= 10) {
      const lean = sa > sd * 1.2 ? war.attacker : sd > sa * 1.2 ? war.defender : null;
      html += `<div class="info-block" style="border-color:var(--accent)">
        <strong>Votre influence</strong> — ${lean
          ? `vous penchez la balance vers <span style="color:${lean.color}">${lean.name}</span>`
          : 'vous armez les deux camps (le profiteur idéal)'}
        <div class="row" style="margin-top:5px"><span style="color:${war.attacker.color}">${war.attacker.name}</span>
          <span style="color:${war.defender.color}">${war.defender.name}</span></div>
        <div class="balance-bar"><div style="width:${Math.round(sa / (sa + sd) * 100)}%;background:${war.attacker.color}"></div><div style="background:${war.defender.color};flex:1"></div></div>
        <div class="row"><span class="io">${Math.round(sa)} soutien</span><span class="io">${Math.round(sd)} soutien</span></div>
      </div>`;
    }

    for (const side of [war.attacker, war.defender]) {
      const fleetPct = Math.max(0, Math.min(100, Math.round((side.fleet / (side.fleet0 || 1)) * 100)));
      const standingCls = side.standing > 5 ? 'price-low' : side.standing < -5 ? 'price-high' : '';
      html += `
        <div class="info-block" style="border-left:3px solid ${side.color}">
          <div class="row"><span><strong style="color:${side.color}">${side.name}</strong></span>
            <span><button class="action-btn mini goto-faction" data-faction="${side.id}">fiche</button></span></div>
          <div class="row"><span>Flotte</span><span>${fmtInt.format(side.fleet)} / ${fmtInt.format(side.fleet0)} (${fleetPct} %) · dispo ${Math.round(side.readiness * 100)} %</span></div>
          <div class="gauge"><div style="width:${fleetPct}%;background:${side.color}"></div></div>
          ${side.support > 0 ? `<div class="row"><span>Votre soutien</span><span class="price-low">${side.support}</span></div>` : ''}
          <div class="row"><span>Votre réputation</span><span class="${standingCls}">${side.standing > 0 ? '+' : ''}${side.standing}</span></div>
          ${side.openLoans > 0 ? `<div class="row"><span>Vos créances</span><span>${fmtQty(side.openLoans)} cr (×1,3 si victoire)</span></div>` : ''}
          ${side.contracts > 0 ? `<div class="row"><span>Appels d'offres ouverts</span><span class="price-low">${side.contracts}</span></div>` : ''}
          <div class="row" style="margin-top:5px"><span>Pénuries — <span class="goto-link" data-planet="${side.capitalPlanetId}" data-system="${side.capitalSystemId}">${side.capitalName}</span></span><span></span></div>
          ${side.shortages.slice(0, 3).map((s) => `
            <div class="row"><span>${s.name}</span>
              <span class="${s.ratio >= 1.5 ? 'price-high' : ''}">${fmtPrice.format(s.price)} cr
                <span class="badge ${s.ratio >= 1.5 ? 'age' : ''}">×${s.ratio.toFixed(1)}</span></span></div>`).join('')}
        </div>
      `;
    }
    if (war.fronts.length > 0) {
      html += `<div class="industry io">Fronts : ${war.fronts.map((f) =>
        `<span class="goto-sys" data-system="${f.system_id}">${f.name}</span>`).join(' · ')}
        — douanes nerveuses, saisies de matériel stratégique si vous êtes mal vu</div>`;
    }
  }

  panel.innerHTML = html;
  enhancePanel();
  $('#back-to-system').addEventListener('click', () => {
    if (state.selectedSystem) renderSystemPanel(state.selectedSystem);
    else panel.innerHTML = '<p class="hint">Cliquez sur un système de la carte.</p>';
  });
  for (const btn of panel.querySelectorAll('.goto-faction')) {
    btn.addEventListener('click', () => renderFactionPanel(Number(btn.dataset.faction)));
  }
  for (const link of panel.querySelectorAll('.goto-link')) {
    link.addEventListener('click', () => {
      const sys = state.universe.systems.find((s) => s.id === Number(link.dataset.system));
      if (sys) { selectSystem(sys); selectPlanet(Number(link.dataset.planet)); }
    });
  }
  for (const link of panel.querySelectorAll('.goto-sys')) {
    link.addEventListener('click', () => {
      const sys = state.universe.systems.find((s) => s.id === Number(link.dataset.system));
      if (sys) {
        selectSystem(sys);
        state.view.cx = sys.x;
        state.view.cy = sys.y;
        if (state.view.zoom < 2) state.view.zoom = 2;
        clampView();
      }
    });
  }
}

$('#btn-wars').addEventListener('click', renderWarsPanel);

// ── Panneau : tableau de bord de la flotte ────────────────────────
// Le cockpit de l'empire : chaque vaisseau (où, quoi, plein, équipé),
// les missions en cours, les routes et leurs recettes, les clients.

function shipWhereabouts(ship) {
  if (ship.planet_id !== null) {
    const entry = state.planetIndex.get(ship.planet_id);
    return { label: `à quai — ${entry.planet.name}`, free: ship.mode === 'manual' };
  }
  const dest = state.planetIndex.get(ship.dest_planet_id);
  return {
    label: `en vol → ${dest.planet.name} (arr. ${dateShort(ship.arrival_tick)})${ship.escorted ? ' 🛡' : ''}`,
    free: false,
  };
}

async function renderFleetPanel() {
  animatePanelOnce();
  const routes = await api('/routes');
  state.selectedPlanet = null;
  const p = state.player;
  const ships = p.ships ?? [];
  const freeCount = ships.filter((s) => s.mode === 'manual' && s.planet_id !== null).length;
  const catalog = p.equipmentCatalog ?? {};

  let html = `
    <button class="back-link" id="back-to-system">← retour</button>
    <h2 class="panel-title">Flotte — ${ships.length}/${p.maxFleet}</h2>
    <p class="panel-sub">${freeCount} disponible${freeCount > 1 ? 's' : ''} ·
      entretien ${fmtNum.format(p.fleetUpkeep)} cr/j</p>
  `;

  // Santé de la flotte : ce qui réclame l'attention, et de quoi y répondre
  // d'un clic — l'essentiel quand on pilote des dizaines de vaisseaux.
  const lowFuel = ships.filter((s) => s.planet_id !== null && s.fuel / s.fuel_capacity < 0.25);
  const needRefuel = ships.some((s) => s.planet_id !== null && s.fuel < s.fuel_capacity);
  const grounded = (p.credits ?? 0) < 0;
  const totalProfit = ships.reduce((a, s) => a + (s.lifetime_profit ?? 0), 0);
  const chips = [];
  if (grounded) chips.push(`<span class="fh-chip bad">⛔ flotte clouée (découvert)</span>`);
  if (freeCount > 0) chips.push(`<span class="fh-chip warn">⚠ ${freeCount} disponible${freeCount > 1 ? 's' : ''}</span>`);
  if (lowFuel.length > 0) chips.push(`<span class="fh-chip warn">⛽ ${lowFuel.length} carburant bas</span>`);
  if (chips.length === 0) chips.push(`<span class="fh-chip ok">✓ toute la flotte au travail</span>`);
  html += `<div class="fleet-health">
    <div class="fleet-chips">${chips.join('')}</div>
    <div class="fleet-bulk">
      ${freeCount > 0 ? `<button class="action-btn mini" id="bulk-auto" title="Met tous les vaisseaux disponibles en mode automatique (sauf celui que vous pilotez)">⚡ disponibles → auto</button>` : ''}
      ${needRefuel ? `<button class="action-btn mini" id="bulk-refuel" title="Ravitaille tous les vaisseaux à quai">⛽ ravitailler la flotte</button>` : ''}
    </div>
    <div class="fleet-profit">Profit net cumulé de la flotte : <strong class="${totalProfit >= 0 ? 'price-low' : 'price-high'}">${totalProfit >= 0 ? '+' : ''}${fmtQty(Math.round(totalProfit))} cr</strong></div>
  </div>`;

  html += `<div class="section-label">Vaisseaux (${ships.length})</div>`;
  for (const ship of ships) {
    const where = shipWhereabouts(ship);
    const cargoPct = Math.round((ship.cargoUsed / ship.cargo_capacity) * 100);
    const fuelPct = Math.round((ship.fuel / ship.fuel_capacity) * 100);
    const modeBadge = ship.mode === 'route' ? '<span class="badge live">ROUTE</span>'
      : ship.mode === 'auto' ? '<span class="badge live">AUTO</span>'
        : ship.mode === 'mission' ? '<span class="badge age">MISSION</span>'
          : where.free ? '<span class="badge">disponible</span>' : '<span class="badge">MAN</span>';
    const isPiloted = ship.id === selectedShip()?.id;
    const topCargo = (ship.cargo ?? [])[0];
    const idleShip = ship.mode === 'manual' && ship.planet_id !== null;
    const lowFuelShip = ship.planet_id !== null && ship.fuel / ship.fuel_capacity < 0.25;
    const attn = idleShip || lowFuelShip ? ' needs-attention' : '';
    const prof = ship.lifetime_profit ?? 0;

    html += `<div class="info-block ship-card ${isPiloted ? 'piloted' : ''}${attn}">
      <div class="row"><span><strong>${ship.false_flag ? '⚑ ' : ''}${ship.name}</strong>
        <span style="color:var(--dim)">· ${ship.classLabel}</span> ${modeBadge}</span>
        <span>${isPiloted ? '<span class="badge live">PILOTÉ</span>'
          : `<button class="action-btn mini pilot-btn" data-ship="${ship.id}">piloter</button>`}</span></div>
      <div class="row"><span>${where.label}</span>
        <span title="Profit net réalisé par ce vaisseau depuis sa mise en service" class="${prof >= 0 ? 'price-low' : 'price-high'}">${prof >= 0 ? '+' : ''}${fmtQty(Math.round(prof))} cr</span></div>
      <div class="row"><span>Soute ${fmtQty(ship.cargoUsed)}/${fmtQty(ship.cargo_capacity)}${
        topCargo ? ` <span style="color:var(--dim)">(${topCargo.name}…)</span>` : ''}</span>
        <span>⛽ ${fuelPct} %</span></div>
      <div class="gauge"><div style="width:${cargoPct}%"></div></div>
      <div style="margin-top:5px">`;
    for (const [modId, mod] of Object.entries(catalog)) {
      const installed = (ship.equipment ?? []).includes(modId);
      html += installed
        ? `<span class="badge live" title="${mod.label}">${mod.desc}</span> `
        : `<button class="action-btn mini equip-btn" data-ship="${ship.id}" data-mod="${modId}"
            title="${mod.label} — installation aux chantiers civils (T2+), vaisseau à quai"
            ${p.credits < mod.price ? 'disabled' : ''}>+ ${mod.desc} (${fmtQty(mod.price)} cr)</button> `;
    }
    if (ships.length > 1 && ship.planet_id !== null) {
      html += ` <button class="action-btn mini sell-ship" data-ship="${ship.id}" data-name="${ship.name.replace(/"/g, '&quot;')}"
        title="Revendre ce vaisseau au chantier (remboursement partiel)">revendre</button>`;
    }
    html += `</div></div>`;
  }

  // Missions en cours (toutes concessions confondues).
  const missions = p.missions ?? [];
  html += `<div class="section-label">Missions de vente (${missions.length})</div>`;
  if (missions.length === 0) {
    html += `<div class="industry io">Aucune — lancez-en depuis vos concessions (« Vendre la production »)</div>`;
  }
  for (const m of missions) {
    html += `<div class="industry">🚀 ${m.ship_name} : ${resChip(m.resource_id, m.resourceName)} → ${m.to_name}
      <span class="io">— reste ${fmtQty(m.quantity)}${m.carrying > 0 ? `, soute ${fmtQty(m.carrying)}` : ''}</span>
      <button class="action-btn mini cancel-mission" data-id="${m.id}">✕</button></div>`;
  }

  // Routes et leurs recettes cumulées.
  html += `<div class="section-label">Routes (${routes.length})</div>`;
  if (routes.length === 0) {
    html += `<div class="industry io">Aucune — « 🔁 navette auto » depuis une concession, ou le bouton ROUTES</div>`;
  }
  for (const r of routes) {
    html += `<div class="industry">${r.name}
      <span class="io">— ${r.ships.map((s) => s.name).join(', ') || 'aucun vaisseau'} ·
      ${r.stops.length} étapes</span>
      <span class="price-low">+${fmtQty(Math.round(r.earned ?? 0))} cr</span>
      <button class="action-btn mini clone-route" data-route="${r.id}"
        title="Dupliquer cette route (mêmes étapes) pour l'assigner à un autre vaisseau">⧉ cloner</button></div>`;
  }

  // Contrats clients signés.
  const clients = p.supplyContracts ?? [];
  html += `<div class="section-label">Clients à servir (${clients.length})</div>`;
  if (clients.length === 0) {
    html += `<div class="industry io">Aucun contrat signé — les offres apparaissent sur les
      planètes en pénurie (et vos fidèles vous préviennent)</div>`;
  }
  for (const sc of clients) {
    html += `<div class="industry">📦 <span class="goto-link" data-planet="${sc.planet_id}"
        data-system="${sc.systemId}">${sc.planetName}</span> :
      ${fmtQty(sc.remaining)}/${fmtQty(sc.quantity)} ${resChip(sc.resource_id, sc.resourceName)}
      <span class="io">— ${fmtPrice.format(sc.unit_price)} cr/u fixé · avant le ${dateShort(sc.expires_tick)}${
        sc.loyalty > 0 ? ` · fidélité ${sc.loyalty}` : ''}</span></div>`;
  }

  panel.innerHTML = html;
  enhancePanel();
  $('#back-to-system').addEventListener('click', () => {
    if (state.selectedSystem) renderSystemPanel(state.selectedSystem);
    else panel.innerHTML = '<p class="hint">Cliquez sur un système de la carte.</p>';
  });
  $('#bulk-auto')?.addEventListener('click', async () => {
    const r = await apiPost('/fleet/auto-idle', { exceptShipId: selectedShip()?.id ?? 0 });
    if (r.ok) { toast(`${r.count} vaisseau${r.count > 1 ? 'x' : ''} mis en automatique`, 'good'); log(`${r.count} vaisseau(x) disponible(s) remis au travail (auto)`); }
    await refreshPlayerAndKnowledge();
    renderFleetPanel();
  });
  $('#bulk-refuel')?.addEventListener('click', async () => {
    const r = await apiPost('/fleet/refuel');
    if (r.ok) { toast(r.count ? `${r.count} vaisseau${r.count > 1 ? 'x' : ''} ravitaillé${r.count > 1 ? 's' : ''} (−${fmtQty(r.total)} cr)` : 'Rien à ravitailler', r.count ? 'good' : 'info'); if (r.count) log(`Flotte ravitaillée : ${r.count} vaisseau(x) (−${fmtQty(r.total)} cr)`); }
    await refreshPlayerAndKnowledge();
    renderFleetPanel();
  });
  for (const btn of panel.querySelectorAll('.clone-route')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost(`/routes/${btn.dataset.route}/clone`);
      if (r.ok) { toast(`Route clonée : « ${r.name} »`, 'good'); log(`Route dupliquée : « ${r.name} » (${r.stops} étapes) — assignez-lui un vaisseau`); }
      else log(`Clonage impossible : ${r.error}`);
      await refreshPlayerAndKnowledge();
      renderFleetPanel();
    });
  }
  for (const btn of panel.querySelectorAll('.pilot-btn')) {
    btn.addEventListener('click', () => {
      state.selectedShipId = Number(btn.dataset.ship);
      renderFleetBar();
      renderHudPlayer();
      renderFleetPanel();
    });
  }
  for (const btn of panel.querySelectorAll('.equip-btn')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost(`/ships/${btn.dataset.ship}/equip`, { moduleId: btn.dataset.mod });
      if (r.ok) {
        toast(`${r.shipName} : ${r.label} installé (${r.desc})`, 'good');
        playSound('objective');
        log(`${r.shipName} équipé — ${r.label} (−${fmtQty(r.price)} cr)`);
      } else {
        log(`Installation impossible : ${r.error}`);
      }
      await refreshPlayerAndKnowledge();
      renderFleetPanel();
    });
  }
  for (const btn of panel.querySelectorAll('.cancel-mission')) {
    btn.addEventListener('click', async () => {
      const r = await fetch(`/api/missions/${btn.dataset.id}`, { method: 'DELETE' })
        .then((x) => x.json());
      log(r.ok ? `Mission annulée — ${r.shipName} repasse en manuel` : `Annulation : ${r.error}`);
      await refreshPlayerAndKnowledge();
      renderFleetPanel();
    });
  }
  for (const btn of panel.querySelectorAll('.sell-ship')) {
    btn.addEventListener('click', () => confirmAction(btn,
      `Revendre ${btn.dataset.name} ?`, async () => {
        const r = await apiPost(`/ships/${btn.dataset.ship}/sell`);
        if (r.ok) { toast(`${r.name} revendu (+${fmtQty(r.refund)} cr)`, 'good'); log(`${r.name} revendu au chantier (+${fmtQty(r.refund)} cr)`); }
        else log(`Revente impossible : ${r.error}`);
        await refreshPlayerAndKnowledge();
        renderFleetPanel();
      }));
  }
  for (const link of panel.querySelectorAll('.goto-link')) {
    link.addEventListener('click', () => {
      const sys = state.universe.systems.find((s) => s.id === Number(link.dataset.system));
      if (sys) { selectSystem(sys); selectPlanet(Number(link.dataset.planet)); }
    });
  }
}

// Confirmation inline : un bouton se transforme en « Confirmer ? » pendant
// 3 s avant d'exécuter l'action destructrice (pas de popup natif moche).
function confirmAction(btn, label, action) {
  if (btn.dataset.confirming === '1') return;
  btn.dataset.confirming = '1';
  const original = btn.textContent;
  const originalTitle = btn.title;
  btn.textContent = '⚠ confirmer ?';
  if (label) btn.title = label;
  btn.classList.add('confirming');
  const reset = () => { btn.textContent = original; btn.title = originalTitle; btn.classList.remove('confirming'); btn.dataset.confirming = '0'; clearTimeout(timer); btn.removeEventListener('click', onConfirm); };
  const onConfirm = (e) => { e.stopPropagation(); reset(); action(); };
  const timer = setTimeout(reset, 3000);
  setTimeout(() => btn.addEventListener('click', onConfirm, { once: true }), 0);
}

$('#btn-fleet').addEventListener('click', renderFleetPanel);

// ── Panneau : observatoire économique (ÉCO) ──────────────────────
// Les courbes de l'empire (CA/tick, volumes, trésorerie), la rentabilité
// des routes, les grands chantiers à fournir, les repaires à raser.

function lineSpark(points, color, w = 350, h = 56) {
  if (points.length < 2) return '<div class="hint">pas encore assez d\'historique</div>';
  const min = Math.min(...points.map((p) => p.v));
  const max = Math.max(...points.map((p) => p.v));
  const span = max - min || 1;
  const x = (i) => 2 + (i / (points.length - 1)) * (w - 4);
  const y = (v) => h - 4 - ((v - min) / span) * (h - 14);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  return `<svg width="${w}" height="${h}" class="nw-spark">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/>
    <text x="2" y="10" fill="#6b7689" font-size="9">${fmtQty(max)}</text>
    <text x="2" y="${h - 2}" fill="#6b7689" font-size="9">${fmtQty(min)}</text>
  </svg>`;
}

// Carte de métrique (observatoire) : titre, valeur courante en gros, et
// la courbe avec aire remplie en dégradé — un vrai mini tableau de bord.
let sparkSeq = 0;
function metricCard(label, points, color, unit) {
  const cur = points.length ? points[points.length - 1].v : 0;
  let chart;
  if (points.length < 2) {
    chart = '<div class="hint" style="font-size:11px">historique en cours d\'accumulation…</div>';
  } else {
    const w = 340; const h = 46;
    const max = Math.max(...points.map((p) => p.v));
    const min = Math.min(0, ...points.map((p) => p.v));
    const span = max - min || 1;
    const x = (i) => (i / (points.length - 1)) * w;
    const y = (v) => h - 3 - ((v - min) / span) * (h - 8);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
    const area = `M0 ${h} L${line.slice(1)} L${w} ${h} Z`;
    const id = `sg${sparkSeq++}`;
    chart = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="metric-spark">
      <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity="0.32"/>
        <stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      <path d="${area}" fill="url(#${id})"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }
  return `<div class="metric-card">
    <div class="metric-head"><span>${label}</span>
      <strong style="color:${color}">${fmtQty(cur)}${unit ? ' ' + unit : ''}</strong></div>
    ${chart}
  </div>`;
}

async function renderObservatoryPanel() {
  animatePanelOnce();
  const obs = await api('/observatory');
  state.selectedPlanet = null;

  // Dérivées : CA et volume par tick, entre points d'échantillonnage.
  const hist = obs.history;
  const deltas = (key) => hist.slice(1).map((p, i) => ({
    v: Math.max(0, (p[key] - hist[i][key]) / Math.max(1, p.tick - hist[i].tick)),
  }));

  let html = `
    <button class="back-link" id="back-to-system">← retour</button>
    <h2 class="panel-title">Observatoire économique</h2>
    <p class="panel-sub">Les courbes de l'empire, ses chantiers et ses menaces.</p>
    <div class="section-label">Activité de l'empire</div>
    ${metricCard('Chiffre d\'affaires / jour', deltas('revenue'), '#62db90', 'cr')}
    ${metricCard('Unités vendues / jour', deltas('units_sold'), '#5ccdf5', '')}
    ${metricCard('Trésorerie', hist.map((p) => ({ v: p.credits })), '#ecb85f', 'cr')}
  `;

  html += `<div class="section-label">Routes par recettes (${obs.routes.length})</div>`;
  if (obs.routes.length === 0) html += `<div class="industry io">Aucune route encore</div>`;
  for (const r of obs.routes) {
    html += `<div class="industry">${r.name}
      <span class="price-low">+${fmtQty(Math.round(r.earned ?? 0))} cr</span>
      <button class="action-btn mini route-escort" data-id="${r.id}" data-on="${r.always_escort ? 0 : 1}"
        title="Couloir sécurisé : escorte payée sur CHAQUE trajet de cette route">
        ${r.always_escort ? '🛡 sécurisé' : 'sécuriser'}</button></div>`;
  }

  html += `<div class="section-label">Grands chantiers (${obs.megaprojects.length})</div>`;
  if (obs.megaprojects.length === 0) {
    html += `<div class="industry io">Aucun chantier en cours — quand une faction en lance un,
      c'est le plus gros client de la galaxie</div>`;
  }
  for (const mp of obs.megaprojects) {
    const total = mp.needs.reduce((a, n) => a + n.required, 0);
    const done = mp.needs.reduce((a, n) => a + n.delivered, 0);
    const pct = Math.round((done / total) * 100);
    html += `<div class="info-block" style="border-left:3px solid ${mp.faction_color}">
      <div class="row"><span><strong>${mp.name}</strong> — ${mp.faction_name}</span>
        <span>${pct} % · ${dateShort(mp.expires_tick)}</span></div>
      <div class="gauge"><div style="width:${pct}%;background:${mp.faction_color}"></div></div>
      <div class="row"><span>Livraison : <span class="goto-link" data-planet="${mp.capital_planet_id}"
        data-system="${mp.capital_system_id}">${mp.capital_name}</span></span><span></span></div>
      ${mp.needs.map((n) => `<div class="row"><span>${resChip(n.resource_id, n.resourceName)}</span>
        <span>${fmtQty(n.delivered)}/${fmtQty(n.required)}
        <span class="price-low">à ${fmtPrice.format(n.unit_price)} cr</span></span></div>`).join('')}
    </div>`;
  }

  html += `<div class="section-label">Repaires pirates (${obs.lairs.length})</div>`;
  if (obs.lairs.length === 0) html += `<div class="industry io">Aucun repaire connu — les couloirs respirent</div>`;
  for (const l of obs.lairs) {
    html += `<div class="industry">☠ ${l.system_name}
      <span class="io">— force ${l.strength} (le danger des couloirs voisins grimpe)</span>
      <button class="action-btn mini clear-lair" data-sys="${l.system_id}">
        raser (${fmtQty(l.clearCost)} cr)</button></div>`;
  }

  panel.innerHTML = html;
  enhancePanel();
  $('#back-to-system').addEventListener('click', () => {
    if (state.selectedSystem) renderSystemPanel(state.selectedSystem);
    else panel.innerHTML = '<p class="hint">Cliquez sur un système de la carte.</p>';
  });
  for (const btn of panel.querySelectorAll('.route-escort')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost(`/routes/${btn.dataset.id}/escort`, { escorted: btn.dataset.on === '1' });
      if (r.ok) log(r.escorted ? 'Couloir sécurisé : escorte sur chaque trajet' : 'Escorte systématique levée');
      renderObservatoryPanel();
    });
  }
  for (const btn of panel.querySelectorAll('.clear-lair')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost(`/lairs/${btn.dataset.sys}/clear`);
      if (r.ok) { toast(`Repaire de ${r.systemName} rasé (−${fmtQty(r.cost)} cr)`, 'good'); playSound('objective'); }
      else log(`Mercenaires : ${r.error}`);
      await refreshPlayerAndKnowledge();
      renderObservatoryPanel();
    });
  }
  for (const link of panel.querySelectorAll('.goto-link')) {
    link.addEventListener('click', () => {
      const sys = state.universe.systems.find((x) => x.id === Number(link.dataset.system));
      if (sys) { selectSystem(sys); selectPlanet(Number(link.dataset.planet)); }
    });
  }
}

$('#btn-eco').addEventListener('click', renderObservatoryPanel);

// ── Panneau : Codex — comprendre l'économie ──────────────────────
// Référence : familles de ressources, chaînes de production (qui fait
// quoi, qui consomme quoi) et fiches de vaisseaux. Le « pourquoi » derrière
// les prix — maîtriser la chaîne, c'est maîtriser les marges.
function renderCodexPanel() {
  animatePanelOnce();
  state.selectedPlanet = null;
  const u = state.universe;
  const recipes = u.recipes ?? [];
  const byOutput = new Map(); // ressource produite → recettes
  const usedIn = new Map();   // ressource consommée → produits
  for (const r of recipes) {
    if (!byOutput.has(r.output)) byOutput.set(r.output, []);
    byOutput.get(r.output).push(r);
    for (const inp of Object.keys(r.inputs)) {
      if (!usedIn.has(inp)) usedIn.set(inp, new Set());
      usedIn.get(inp).add(r.output);
    }
  }

  let html = `
    <button class="back-link" id="back-to-system">← retour</button>
    <h2 class="panel-title">Codex</h2>
    <p class="panel-sub">L'économie expliquée : familles, chaînes de
      production, vaisseaux. Survolez un marché pour le prix en direct.</p>
    <div class="cat-legend">${Object.values(resCats).map((c) =>
      `<span><span class="rc-glyph" style="color:${c.color}">${c.glyph}</span>${c.label}</span>`).join('')}</div>`;

  // Ressources par tier, avec leur chaîne (intrants → ressource → débouchés).
  for (const tier of ['raw', 'intermediate', 'finished']) {
    const list = u.resources.filter((r) => r.tier === tier);
    html += `<div class="section-label">${TIER_LABELS[tier]} (${list.length})</div>`;
    for (const r of list) {
      const made = byOutput.get(r.id) ?? [];
      const uses = [...(usedIn.get(r.id) ?? [])];
      let chain = '';
      if (made.length > 0) {
        const inp = Object.entries(made[0].inputs)
          .map(([id, q]) => `${q}× ${resGlyph(id)}${resName(id)}`).join(' + ');
        chain += `<div class="codex-chain">⟵ ${inp}${made.length > 1 ? ` <span class="badge">${made.length} filières</span>` : ''}</div>`;
      }
      if (uses.length > 0) {
        chain += `<div class="codex-chain io">⟶ ${uses.map((o) => `${resGlyph(o)}${resName(o)}`).join(', ')}</div>`;
      }
      if (made.length === 0 && uses.length === 0) chain = '<div class="codex-chain io">ressource de consommation</div>';
      html += `<div class="codex-res">
        <div class="codex-res-head">
          <span>${resChip(r.id, r.name)}</span>
          <span class="codex-base">${fmtPrice.format(r.basePrice)} cr</span>
        </div>${chain}</div>`;
    }
  }

  // Vaisseaux.
  html += `<div class="section-label">Vaisseaux</div>`;
  for (const [, c] of Object.entries(state.player?.shipClasses ?? {})) {
    html += `<div class="info-block">
      <div class="row"><span><strong>${c.label}</strong>${c.minTier ? ` <span class="badge locked">chantier T${c.minTier}</span>` : ''}</span>
        <span>${fmtQty(c.price)} cr</span></div>
      <div class="row"><span>Soute · vitesse · réservoir</span>
        <span>${fmtQty(c.cargo)} · ${c.speed} · ${fmtQty(c.fuel)}</span></div>
      <div class="row"><span>Entretien</span><span>${c.upkeep} cr/j</span></div>
    </div>`;
  }

  panel.innerHTML = html;
  enhancePanel();
  $('#back-to-system').addEventListener('click', () => {
    if (state.selectedSystem) renderSystemPanel(state.selectedSystem);
    else panel.innerHTML = '<p class="hint">Cliquez sur un système de la carte.</p>';
  });
}

$('#btn-codex').addEventListener('click', renderCodexPanel);

// ── Maison de commerce : identité, QG, classement, statistiques ───

function renderHouseHeader() {
  const h = state.house;
  if (!h) return;
  $('#house-crest').style.background = h.color;
  $('#house-name').textContent = h.name;
  $('#house-rank').textContent = h.renown.title;
}

async function refreshHouse() {
  state.house = await api('/house');
  renderHouseHeader();
}

function netWorthSpark(history, color, w = 320, h = 44) {
  // Petit graphe multi-séries (vous + rivaux) sur l'historique de valeur nette.
  const series = Object.entries(history);
  if (series.length === 0) return '';
  let min = Infinity; let max = -Infinity; let tmin = Infinity; let tmax = -Infinity;
  for (const [, pts] of series) for (const p of pts) {
    min = Math.min(min, p.value); max = Math.max(max, p.value);
    tmin = Math.min(tmin, p.tick); tmax = Math.max(tmax, p.tick);
  }
  const span = max - min || 1; const tspan = tmax - tmin || 1;
  const x = (t) => 2 + (t - tmin) / tspan * (w - 4);
  const y = (v) => h - 3 - (v - min) / span * (h - 6);
  let svg = `<svg width="${w}" height="${h}" class="nw-spark">`;
  for (const [subject, pts] of series) {
    if (pts.length < 2) continue;
    const isMe = subject === 'player';
    const stroke = isMe ? color : 'rgba(120,134,154,0.5)';
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.tick).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
    svg += `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${isMe ? 1.8 : 1}"/>`;
  }
  return svg + '</svg>';
}

async function renderHousePanel() {
  animatePanelOnce();
  state.selectedPlanet = null;
  const [house, stats] = await Promise.all([api('/house'), api('/stats')]);
  state.house = house;
  renderHouseHeader();
  const ship = selectedShip();
  const shipDocked = ship?.planet_id != null;

  const nw = stats.netWorth;
  const partRow = (label, val) => `<div class="row"><span>${label}</span><span>${fmtQty(val)} cr</span></div>`;

  let html = `
    <button class="back-link" id="back-to-system">← retour</button>
    <h2 class="panel-title" style="color:${house.color}">${house.name}</h2>
    <p class="panel-sub">${house.renown.title}${house.renown.next
      ? ` · prochain rang « ${house.renown.next.title} » à ${fmtQty(house.renown.next.at)} prestige` : ' · rang suprême'}</p>

    <div class="section-label">Identité</div>
    <div class="info-block">
      <div class="row"><span>Nom de la maison</span><span>
        <input type="text" id="house-rename" value="${house.name.replace(/"/g, '&quot;')}" maxlength="40"
          style="width:150px;background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:inherit;padding:3px 5px">
        <button class="action-btn" id="btn-rename">OK</button></span></div>
      <div class="row" style="margin-top:6px"><span>Blason</span><span id="crest-swatches"></span></div>
    </div>

    <div class="section-label">Quartier général</div>`;

  if (house.hq.level === 0) {
    html += `<div class="info-block">
      <div style="color:var(--dim);margin-bottom:6px">Le siège de votre maison : allège l'entretien
        de la flotte, élargit le plafond de vaisseaux, remise les relevés de marché.</div>
      <button class="action-btn" id="btn-hq-build" ${shipDocked ? '' : 'disabled'}>
        ${shipDocked ? `Bâtir le QG ici (${fmtQty(house.hq.nextCost)} cr)` : 'Amarrez-vous pour bâtir'}
      </button></div>`;
  } else {
    const b = house.hq.bonuses;
    html += `<div class="info-block">
      <div class="row"><span>Siège</span><span>${house.hq.planetName} · niv. ${house.hq.level}/${house.hq.maxLevel}</span></div>
      <div class="row"><span>Entretien flotte</span><span class="price-low">−${Math.round(b.upkeepReduction * 100)} %</span></div>
      <div class="row"><span>Plafond de flotte</span><span class="price-low">+${b.maxFleetBonus}</span></div>
      <div class="row"><span>Relevés de marché</span><span class="price-low">−${Math.round(b.intelDiscount * 100)} %</span></div>
      ${house.hq.nextCost !== null
        ? `<button class="action-btn" id="btn-hq-upgrade">Agrandir (${fmtQty(house.hq.nextCost)} cr)</button>`
        : '<span class="badge">niveau max</span>'}
    </div>`;
  }

  html += `<div class="section-label">Classement des maisons</div>`;
  for (const e of stats.leaderboard) {
    const max = stats.leaderboard[0].netWorth || 1;
    const pct = Math.max(2, Math.round((e.netWorth / max) * 100));
    html += `<div class="leader-row ${e.isPlayer ? 'me' : ''}">
      <div class="leader-head">
        <span><span class="lead-dot" style="background:${e.color}"></span>${e.rank}. ${e.name}${e.isPlayer ? ' (vous)' : ''}</span>
        <span>${fmtQty(e.netWorth)} cr</span>
      </div>
      <div class="gauge"><div style="width:${pct}%;background:${e.color}"></div></div>
    </div>`;
  }
  html += `<div style="margin-top:8px">${netWorthSpark(stats.history, house.color)}</div>`;

  html += `<div class="section-label">Patrimoine — ${fmtQty(nw.total)} cr</div>
    <div class="info-block">
      ${partRow('Trésorerie', nw.parts.credits)}
      ${partRow('Cargaisons', nw.parts.cargo)}
      ${partRow('Entrepôts', nw.parts.storage)}
      ${partRow('Industries', nw.parts.industry)}
      ${partRow('Quartier général', nw.parts.hq)}
      ${stats.warProfit > 0 ? `<div class="row"><span>dont revenus de guerre (cumul)</span>
        <span class="price-low">${fmtQty(stats.warProfit)} cr</span></div>` : ''}
    </div>
    <div class="section-label">En chiffres</div>
    <div class="info-block">
      <div class="row"><span>Flotte</span><span>${stats.counts.fleet}</span></div>
      <div class="row"><span>Concessions · comptoirs</span><span>${stats.counts.concessions} · ${stats.counts.posts}</span></div>
      <div class="row"><span>Industries</span><span>${stats.counts.industries}</span></div>
      <div class="row"><span>Partenaires commerciaux</span><span>${stats.counts.partners}</span></div>
      <div class="row"><span>Technologies</span><span>${stats.counts.techs}</span></div>
    </div>
    <div class="section-label">Depuis la fondation</div>
    <div class="info-block">
      <div class="row"><span>Unités vendues</span><span class="price-low">${fmtQty(stats.lifetime?.unitsSold ?? 0)}</span></div>
      <div class="row"><span>Unités achetées</span><span>${fmtQty(stats.lifetime?.unitsBought ?? 0)}</span></div>
      <div class="row"><span>Chiffre d'affaires cumulé</span><span class="price-low">${fmtQty(stats.lifetime?.revenue ?? 0)} cr</span></div>
    </div>`;

  panel.innerHTML = html;
  enhancePanel();
  $('#back-to-system').addEventListener('click', () => {
    if (state.selectedSystem) renderSystemPanel(state.selectedSystem);
    else panel.innerHTML = '<p class="hint">Cliquez sur un système de la carte.</p>';
  });

  // Nuancier de blason.
  const swatches = $('#crest-swatches');
  for (const c of ['#53c7f0', '#e8b35a', '#5fd68b', '#c77dff', '#f07861', '#56c4c4', '#b85d8e']) {
    const b = document.createElement('button');
    b.className = 'crest-swatch';
    b.style.background = c;
    if (c.toLowerCase() === house.color.toLowerCase()) b.classList.add('sel');
    b.addEventListener('click', async () => {
      const r = await apiPost('/house/color', { color: c });
      if (r.ok) { await refreshHouse(); renderHousePanel(); }
    });
    swatches.appendChild(b);
  }

  $('#btn-rename').addEventListener('click', async () => {
    const r = await apiPost('/house/rename', { name: $('#house-rename').value });
    if (r.ok) { log(`Maison renommée « ${r.name} »`); await refreshHouse(); renderHousePanel(); }
    else log(`Renommage refusé : ${r.error}`);
  });
  $('#btn-hq-build')?.addEventListener('click', async () => {
    const r = await apiPost('/hq/build', { shipId: selectedShip()?.id });
    if (r.ok) log(`Quartier général bâti sur ${r.planetName} (−${fmtQty(r.cost)} cr)`);
    else log(`Construction refusée : ${r.error}`);
    await refreshPlayerAndKnowledge(); await refreshHouse(); renderHousePanel();
  });
  $('#btn-hq-upgrade')?.addEventListener('click', async () => {
    const r = await apiPost('/hq/upgrade');
    if (r.ok) log(`QG agrandi au niveau ${r.level} (−${fmtQty(r.cost)} cr)`);
    else log(`Agrandissement refusé : ${r.error}`);
    await refreshPlayerAndKnowledge(); await refreshHouse(); renderHousePanel();
  });
}

$('#btn-house').addEventListener('click', renderHousePanel);
$('#house-badge').addEventListener('click', renderHousePanel);

// Aide : restaure le panneau d'accueil (légende de la carte, premiers pas).
$('#btn-help').addEventListener('click', () => {
  state.selectedPlanet = null;
  panel.innerHTML = initialPanelHTML;
});

// ── Guide des premiers pas ────────────────────────────────────────
// La main tendue des 5 premières minutes : une barre qui dit QUOI faire
// maintenant, étape par étape, en lisant l'état réel de la partie. Chaque
// étape valide la précédente ; le bouton visé pulse quand il est visible.
// Progression mémorisée par partie (seed) ; « passer » l'éteint pour de bon.

const GUIDE_STEPS = [
  {
    text: 'Votre concession mine toute seule dans son entrepôt. Dans « Vendre la '
      + 'production », choisissez quantité et destination : un vaisseau disponible '
      + 'fera tout le trajet seul.',
    target: '#btn-mission',
    done: () => (state.player?.missions ?? []).length > 0
      || (state.guideFlags.missionCount ?? 0) > 0 || state.guideFlags.soldOnce,
  },
  {
    text: 'Pendant que ça vole : MARCHÉS compare les prix connus de chaque '
      + 'ressource (avec leur fraîcheur) — c\'est là que se trouvent les vraies marges.',
    target: '#btn-markets',
    done: () => state.guideFlags.sawMarkets,
  },
  {
    text: 'Pour un flux permanent : chargez votre soute à la concession et cliquez '
      + '« 🔁 navette auto » — la boucle charger → vendre tournera sans vous.',
    target: '#outlet-shuttle',
    done: () => (state.player?.ships ?? []).some((s) => s.mode === 'route')
      || (state.guideFlags.missionCount ?? 0) >= 3, // ou vous préférez les missions
  },
  {
    text: 'L\'empire s\'étend : 2e vaisseau, concession, comptoir — l\'entrepôt '
      + 's\'agrandit via « Améliorer ». Suivez vos OBJECTIFS, la route du Nexus.',
    target: '#btn-objectives',
    done: () => state.guideFlags.sawObjectives,
  },
];

state.guideFlags = { sawMarkets: false, soldOnce: false, sawObjectives: false };

function guideKey() {
  return `nx-guide-${state.universe?.seed ?? 0}`;
}

function loadGuide() {
  try { return JSON.parse(localStorage.getItem(guideKey()) ?? '{"step":0,"off":false}'); }
  catch { return { step: 0, off: false }; }
}

function saveGuide(g) {
  try { localStorage.setItem(guideKey(), JSON.stringify(g)); } catch { /* privé */ }
}

function updateGuide() {
  const bar = $('#guide-bar');
  if (!state.universe || !state.player) return;
  const g = loadGuide();
  // Les drapeaux (panneaux visités, missions lancées…) suivent la
  // sauvegarde — fusion qui ne perd jamais le progrès de la session.
  for (const [k, v] of Object.entries(g.flags ?? {})) {
    state.guideFlags[k] = typeof v === 'number'
      ? Math.max(v, state.guideFlags[k] ?? 0)
      : (state.guideFlags[k] || v);
  }
  if (g.off || g.step >= GUIDE_STEPS.length) {
    bar.hidden = true;
    clearGuidePulse();
    return;
  }
  // Les étapes déjà satisfaites se valident en cascade (un joueur qui va
  // plus vite que le guide ne reste pas bloqué dessus).
  while (g.step < GUIDE_STEPS.length && GUIDE_STEPS[g.step].done()) {
    g.step++;
  }
  g.flags = state.guideFlags;
  saveGuide(g);
  if (g.step >= GUIDE_STEPS.length) {
    bar.hidden = true;
    clearGuidePulse();
    return;
  }
  const step = GUIDE_STEPS[g.step];
  bar.hidden = false;
  $('#guide-text').textContent = step.text;
  $('#guide-step').textContent = `${g.step + 1}/${GUIDE_STEPS.length}`;
  clearGuidePulse();
  if (step.target) {
    for (const el of document.querySelectorAll(step.target)) el.classList.add('guide-pulse');
  }
}

function clearGuidePulse() {
  for (const el of document.querySelectorAll('.guide-pulse')) el.classList.remove('guide-pulse');
}

$('#guide-skip').addEventListener('click', () => {
  saveGuide({ ...loadGuide(), off: true });
  $('#guide-bar').hidden = true;
  clearGuidePulse();
  log('Guide masqué — le bouton ? garde l\'aide à portée');
});

// ── Parties / sauvegardes ─────────────────────────────────────────

async function openSavesOverlay() {
  const data = await api('/saves');
  const scenarios = await api('/scenarios');
  const list = $('#saves-list');
  list.innerHTML = '';
  for (const s of data.saves) {
    const row = document.createElement('div');
    row.className = `save-row ${s.active ? 'active' : ''}`;
    row.innerHTML = `
      <div class="save-meta">
        <div><strong>${s.saveName}</strong>${s.active ? ' <span class="badge live">EN COURS</span>' : ''}</div>
        <div class="save-sub">${dateOf(s.tick)} · ${s.credits != null ? fmtQty(s.credits) + ' cr' : '—'}
          · seed ${s.seed}${s.scenario ? ' · ' + s.scenario : ''}</div>
      </div>
      <div class="save-actions">
        ${s.active ? '' : `<button class="action-btn load-save" data-file="${s.file}">Charger</button>`}
        ${s.active ? '' : `<button class="action-btn del-save" data-file="${s.file}">✕</button>`}
      </div>`;
    list.appendChild(row);
  }
  for (const btn of list.querySelectorAll('.load-save')) {
    btn.addEventListener('click', async () => {
      await apiPost('/saves/load', { file: btn.dataset.file });
      try { sessionStorage.setItem('nx-entered', '1'); } catch { /* privé */ }
      location.reload(); // on repart sur la partie chargée
    });
  }
  for (const btn of list.querySelectorAll('.del-save')) {
    btn.addEventListener('click', async () => {
      await fetch(`/api/saves/${btn.dataset.file}`, { method: 'DELETE' });
      openSavesOverlay();
    });
  }

  // Sélecteur de scénario.
  const scnList = $('#scenario-list');
  scnList.innerHTML = '';
  for (const scn of scenarios) {
    const opt = document.createElement('button');
    opt.className = `scenario-opt ${scn.id === state.newSaveScenario ? 'sel' : ''}`;
    opt.innerHTML = `<div class="scn-head"><strong>${scn.name}</strong>
      <span class="badge">${scn.difficulty}</span></div>
      <div class="scn-desc">${scn.desc}</div>`;
    opt.addEventListener('click', () => {
      state.newSaveScenario = scn.id;
      openSavesOverlay();
    });
    scnList.appendChild(opt);
  }

  $('#saves-overlay').hidden = false;
}

$('#btn-saves').addEventListener('click', openSavesOverlay);
$('#saves-close').addEventListener('click', () => { $('#saves-overlay').hidden = true; });
$('#new-save-go').addEventListener('click', async () => {
  const name = $('#new-save-name').value.trim() || 'Nouvelle partie';
  const seedRaw = $('#new-save-seed').value;
  const body = {
    name,
    scenario: state.newSaveScenario,
    settings: {
      rivals: Number($('#set-rivals').value),
      piracy: $('#set-piracy').value,
      universe: $('#set-universe').value,
    },
  };
  if (seedRaw) body.seed = Number(seedRaw);
  const r = await apiPost('/saves/new', body);
  if (r.ok) {
    try { sessionStorage.setItem('nx-entered', '1'); } catch { /* privé */ }
    location.reload();
  }
  else log(`Création refusée : ${r.error}`);
});

// Victoire : l'événement « victory » déclenche la bannière (une fois).
function showVictory(message) {
  $('#victory-text').textContent = message;
  $('#victory').hidden = false;
}
$('#victory-close').addEventListener('click', () => { $('#victory').hidden = true; });

// ── Panneau : technologies ───────────────────────────────────────

async function renderTechPanel() {
  animatePanelOnce();
  const techs = await api('/tech');
  state.selectedPlanet = null;

  let html = `
    <button class="back-link" id="back-to-system">← retour</button>
    <h2 class="panel-title">Technologies</h2>
    <p class="panel-sub">La recherche débloque des filières d'atelier pour vos
      concessions et des améliorations permanentes.</p>
  `;
  for (const t of techs) {
    const status = t.owned ? '<span class="badge live">ACQUISE</span>'
      : t.available ? `<button class="action-btn research-btn" data-tech="${t.id}"
          ${state.player.credits < t.cost ? 'disabled' : ''}>Rechercher (${fmtQty(t.cost)} cr)</button>`
        : `<span class="badge locked">requiert ${t.requiresName}</span>`;
    const detail = t.desc ?? `Ateliers : ${t.unlocks
      .map((r) => state.player.workshopCatalog.find((w) => w.recipe_id === r)?.name ?? r).join(', ')}`;
    html += `
      <div class="info-block">
        <div class="row"><span><strong>${t.name}</strong></span><span>${status}</span></div>
        <div style="color:var(--dim);margin-top:3px">${detail}</div>
      </div>
    `;
  }

  panel.innerHTML = html;
  enhancePanel();
  $('#back-to-system').addEventListener('click', () => {
    if (state.selectedSystem) renderSystemPanel(state.selectedSystem);
    else panel.innerHTML = '<p class="hint">Cliquez sur un système de la carte.</p>';
  });
  for (const btn of panel.querySelectorAll('.research-btn')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost('/tech/research', { techId: btn.dataset.tech });
      if (r.ok) log(`Recherche aboutie : ${r.name} (−${fmtQty(r.cost)} cr)`);
      else log(`Recherche impossible : ${r.error}`);
      await refreshPlayerAndKnowledge();
      renderHudPlayer();
      renderTechPanel();
    });
  }
}

$('#btn-tech').addEventListener('click', renderTechPanel);

// ── Panneau : routes logistiques ─────────────────────────────────
// Brouillon de route côté client ; les étapes s'ajoutent depuis la
// planète sélectionnée sur la carte ou vos concessions.

const routeDraft = { name: '', stops: [] };

const ACTION_LABELS = {
  load: 'Charger (entrepôt → soute)',
  unload: 'Déposer (soute → entrepôt)',
  buy: 'Acheter au marché',
  sell: 'Vendre au marché',
};

function actionSummary(a) {
  const res = a.resourceId
    ? (state.universe.resources.find((r) => r.id === a.resourceId)?.name ?? a.resourceId)
    : 'tout';
  return `${ACTION_LABELS[a.type].split(' ')[0].toLowerCase()} ${res}${a.quantity ? ` ×${a.quantity}` : ''}`;
}

async function renderRoutesPanel() {
  animatePanelOnce();
  const routes = await api('/routes');
  state.selectedPlanet = null;

  let html = `
    <button class="back-link" id="back-to-system">← retour</button>
    <h2 class="panel-title">Routes logistiques</h2>
    <p class="panel-sub">Un circuit d'étapes parcouru en boucle par les
      vaisseaux assignés — la navette régulière de vos concessions.</p>
  `;

  // Assistant : la navette simple en deux choix (de → vers), destinations
  // triées par le meilleur prix connu pour la ressource de la concession.
  if (state.player.concessions.length > 0) {
    html += `<div class="section-label">Navette simple</div>
      <div class="info-block outlet">
        <div class="row"><span>De</span><span>
          <select id="wiz-from">${state.player.concessions.map((c) =>
            `<option value="${c.planet_id}">${c.planetName} (${c.resourceName})</option>`).join('')}</select></span></div>
        <div class="row" style="margin-top:5px"><span>vers</span><span>
          <select id="wiz-to" style="max-width:230px"><option value="">recherche des marchés…</option></select></span></div>
        <div style="margin-top:7px">
          <button class="action-btn primary" id="wiz-create">Créer la navette + assigner</button>
        </div>
        <div style="color:var(--dim);font-size:11px;margin-top:4px">Charger tout là-bas,
          vendre tout ici, en boucle — le constructeur complet reste en dessous pour les circuits.</div>
      </div>`;
  }

  for (const r of routes) {
    html += `<div class="info-block">
      <div class="row"><span><strong>${r.name}</strong></span>
        <span><button class="action-btn del-route" data-id="${r.id}">Supprimer</button></span></div>`;
    for (const s of r.stops) {
      html += `<div style="color:var(--dim)">${s.position + 1}. ${s.planet_name} —
        ${s.actions.map(actionSummary).join(' · ') || 'simple passage'}</div>`;
    }
    html += `<div class="row" style="margin-top:5px">
      <span>${r.ships.map((sh) => sh.name).join(', ') || 'aucun vaisseau'}</span>
      <span><select class="assign-ship" data-route="${r.id}">
        ${state.player.ships.map((sh) => `<option value="${sh.id}">${sh.name}</option>`).join('')}
      </select>
      <button class="action-btn assign-btn" data-route="${r.id}">Assigner</button></span></div>
    </div>`;
  }

  // Constructeur de route.
  html += `<div class="section-label">Nouvelle route</div>
    <div class="info-block">
      <input type="text" id="route-name" placeholder="Nom de la route"
        value="${routeDraft.name}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:inherit;padding:5px 7px">`;
  routeDraft.stops.forEach((stop, i) => {
    const entry = state.planetIndex.get(stop.planetId);
    html += `<div class="row" style="margin-top:5px"><span>${i + 1}. ${entry.planet.name}
      — ${stop.actions.map(actionSummary).join(' · ') || 'aucune action'}</span>
      <span><button class="action-btn del-stop" data-i="${i}">✕</button></span></div>
      <div style="margin:3px 0 6px">
        <select class="act-type" data-i="${i}">
          ${Object.entries(ACTION_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <select class="act-res" data-i="${i}">
          <option value="">(tout / max)</option>
          ${state.universe.resources.map((r) => `<option value="${r.id}">${r.name}</option>`).join('')}
        </select>
        <input type="number" class="act-qty" data-i="${i}" placeholder="qté" min="1"
          style="width:64px;background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:inherit;padding:3px 5px">
        <button class="action-btn add-action" data-i="${i}">+ action</button>
      </div>`;
  });

  const addable = [];
  for (const c of state.player.concessions) {
    addable.push({ id: c.planet_id, label: `${c.planetName} (votre concession)` });
  }
  if (state.selectedSystem) {
    for (const p of state.selectedSystem.planets) {
      if (!addable.some((a) => a.id === p.id)) addable.push({ id: p.id, label: p.name });
    }
  }
  html += `<div class="row" style="margin-top:6px"><span>Ajouter une étape</span><span>
      <select id="new-stop">${addable.map((a) => `<option value="${a.id}">${a.label}</option>`).join('')}</select>
      <button class="action-btn" id="add-stop">+</button></span></div>
    <div style="color:var(--dim);font-size:11px;margin-top:4px">Astuce : sélectionnez un
      système sur la carte pour proposer ses planètes ici.</div>
    <button class="action-btn" id="create-route" style="margin-top:8px"
      ${routeDraft.stops.length < 2 ? 'disabled' : ''}>Créer la route</button>
  </div>`;

  panel.innerHTML = html;
  enhancePanel();
  $('#back-to-system').addEventListener('click', () => {
    if (state.selectedSystem) renderSystemPanel(state.selectedSystem);
    else panel.innerHTML = '<p class="hint">Cliquez sur un système de la carte.</p>';
  });

  // Assistant navette : destinations = marchés connus de la ressource de
  // la concession choisie, les mieux offrants d'abord.
  const wizFrom = $('#wiz-from');
  if (wizFrom) {
    const unlockedW = new Set([1]);
    for (const [t, info] of Object.entries(state.player.tiers ?? {})) {
      if (info.unlocked) unlockedW.add(Number(t));
    }
    const fillWizTo = async () => {
      const c = state.player.concessions.find((x) => x.planet_id === Number(wizFrom.value));
      const scan = await api(`/market-scan/${c.resource_id}`);
      const toSel = $('#wiz-to');
      if (!toSel) return;
      const markets = scan.markets
        .filter((m) => m.planetId !== c.planet_id && unlockedW.has(m.tier))
        .sort((a, b) => b.price - a.price)
        .slice(0, 10);
      toSel.innerHTML = markets.length
        ? markets.map((m) => `<option value="${m.planetId}" data-name="${m.planetName}">${m.planetName} — ${fmtPrice.format(m.price)} cr${
            m.ageTicks > 0 ? ` · vu ${m.ageTicks} j` : ''}</option>`).join('')
        : '<option value="">aucun marché connu — voyagez ou sondez</option>';
    };
    wizFrom.addEventListener('change', fillWizTo);
    fillWizTo();
    $('#wiz-create').addEventListener('click', async () => {
      const toSel = $('#wiz-to');
      const toId = Number(toSel.value);
      if (!toId) { log('Choisissez une destination connue'); return; }
      await createShuttle(Number(wizFrom.value), toId, toSel.selectedOptions[0].dataset.name);
      renderRoutesPanel();
    });
  }

  $('#route-name').addEventListener('input', (e) => { routeDraft.name = e.target.value; });

  $('#add-stop').addEventListener('click', () => {
    const planetId = Number($('#new-stop').value);
    if (planetId) routeDraft.stops.push({ planetId, actions: [] });
    renderRoutesPanel();
  });
  for (const btn of panel.querySelectorAll('.del-stop')) {
    btn.addEventListener('click', () => {
      routeDraft.stops.splice(Number(btn.dataset.i), 1);
      renderRoutesPanel();
    });
  }
  for (const btn of panel.querySelectorAll('.add-action')) {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      const type = panel.querySelector(`.act-type[data-i="${i}"]`).value;
      const resourceId = panel.querySelector(`.act-res[data-i="${i}"]`).value || null;
      const qtyRaw = panel.querySelector(`.act-qty[data-i="${i}"]`).value;
      const quantity = qtyRaw ? Number(qtyRaw) : null;
      routeDraft.stops[i].actions.push({ type, resourceId, quantity });
      renderRoutesPanel();
    });
  }
  $('#create-route').addEventListener('click', async () => {
    const r = await apiPost('/routes', { name: routeDraft.name, stops: routeDraft.stops });
    if (r.ok) {
      log(`Route « ${r.name} » créée (${r.stops} étapes)`);
      routeDraft.name = '';
      routeDraft.stops = [];
    } else {
      log(`Route refusée : ${r.error}`);
    }
    renderRoutesPanel();
  });
  for (const btn of panel.querySelectorAll('.del-route')) {
    btn.addEventListener('click', async () => {
      await fetch(`/api/routes/${btn.dataset.id}`, { method: 'DELETE' });
      log('Route supprimée — vaisseaux repassés en manuel');
      await refreshPlayerAndKnowledge();
      renderRoutesPanel();
    });
  }
  for (const btn of panel.querySelectorAll('.assign-btn')) {
    btn.addEventListener('click', async () => {
      const shipId = Number(panel.querySelector(`.assign-ship[data-route="${btn.dataset.route}"]`).value);
      const r = await apiPost(`/ships/${shipId}/route`, { routeId: Number(btn.dataset.route) });
      if (r.ok) log(`${r.name} assigné à la route`);
      else log(`Assignation impossible : ${r.error}`);
      await refreshPlayerAndKnowledge();
      renderRoutesPanel();
    });
  }
}

$('#btn-routes').addEventListener('click', renderRoutesPanel);

// ── Panneau : faction ────────────────────────────────────────────

async function renderFactionPanel(factionId) {
  animatePanelOnce();
  const f = await api(`/faction/${factionId}`);
  state.selectedPlanet = null;

  const standingCls = f.standing > 5 ? 'price-low' : f.standing < -5 ? 'price-high' : '';
  let html = `
    <button class="back-link" id="back-to-system">← carte</button>
    <h2 class="panel-title" style="color:${f.color}">${f.name}</h2>
    <p class="panel-sub">${f.systems} systèmes · ${f.planets} planètes —
      capitale : ${f.capital_name}</p>
    <div class="info-block">
      <div class="row"><span>Flotte</span><span>${fmtInt.format(f.fleet)} vaisseaux</span></div>
      <div class="row"><span>Disponibilité</span><span>${Math.round(f.readiness * 100)} %</span></div>
      <div class="row"><span>Chantier naval</span><span>${fmtNum.format(f.fleet_progress)} / 25</span></div>
      <div class="row"><span>Votre réputation</span><span class="${standingCls}">${f.standing > 0 ? '+' : ''}${f.standing}</span></div>
    </div>
  `;

  // Accord commercial : la loyauté qui paie.
  html += `<div class="section-label">Accord commercial</div>`;
  if (f.pact) {
    html += `<div class="info-block" style="border-left:3px solid ${f.color}">
      <strong>Accord en vigueur</strong>
      <div style="color:var(--dim);margin-top:4px;line-height:1.5">Douanes ouvertes sur leurs
        fronts (aucune saisie) · relevés gratuits dans leur territoire · appels d'offres
        assouplis (seuils ÷2). Rompu si votre réputation tombe sous 10.</div>
    </div>`;
  } else {
    html += `<div class="info-block">
      <div class="row"><span>Réputation ${f.pactStandingRequired} requise</span>
        <span><button class="action-btn" id="btn-pact"
          ${f.standing >= f.pactStandingRequired ? '' : 'disabled'}
          title="Douanes ouvertes, relevés gratuits chez eux, appels d'offres assouplis — rompu si la réputation retombe">
          Signer (${fmtQty(f.pactCost)} cr)</button></span></div>
      <div style="color:var(--dim);font-size:11px;margin-top:4px">Vendez-leur, honorez leurs
        contrats — la réputation monte, l'accord s'ouvre.</div>
    </div>`;
  }

  if (f.war) {
    const myLoans = (state.player.loans ?? [])
      .filter((l) => l.faction_id === f.id && l.status === 'open');
    html += `
      <div class="section-label">⚔ En guerre</div>
      <div class="info-block" style="border-color:#f04545">
        <div class="row"><span>Contre</span><span>${f.war.enemy}</span></div>
        <div class="row"><span>Depuis</span><span>${dateOf(f.war.since)}</span></div>
        ${f.war.fronts.map((fr) => `<div class="row"><span>Front : ${fr.name}</span>
          <span>${fr.pressure > 0 ? '◀ attaque' : fr.pressure < 0 ? 'défense ▶' : 'stable'}</span></div>`).join('')}
        <div class="row" style="margin-top:6px"><span>Prêt de guerre</span><span>
          <input type="number" id="loan-amount" min="5000" step="1000" value="10000"
            style="width:90px;background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:inherit;padding:3px 5px">
          <button class="action-btn" id="btn-loan">Prêter</button></span></div>
        ${myLoans.map((l) => `<div class="row"><span>Créance en cours</span>
          <span>${fmtQty(l.amount)} cr (×1,3 si victoire)</span></div>`).join('')}
      </div>
    `;
  }

  if (f.relations.length > 0) {
    html += `<div class="section-label">Diplomatie</div>`;
    for (const r of f.relations.slice(0, 4)) {
      const cls = r.atWar ? 'price-high' : r.relation < -30 ? 'price-high' : r.relation > 30 ? 'price-low' : '';
      html += `<div class="industry">${r.faction.name}
        <span class="io ${cls}">— ${r.atWar ? 'GUERRE' : fmtNum.format(r.relation)}</span></div>`;
    }
  }

  html += `<div class="section-label">Tensions stratégiques (capitale)</div>`;
  if (f.shortages.length === 0) {
    html += `<div class="industry io">Approvisionnement correct</div>`;
  }
  for (const s of f.shortages) {
    html += `<div class="industry">${s.name}
      <span class="io">— manque ${Math.round(s.pressure * 100)} % · ${fmtPrice.format(s.price)} cr</span></div>`;
  }

  html += `<div class="section-label">Contrats de la faction (tier 4)</div>`;
  if (!f.contractAccess) {
    html += `<div class="info-block">Accès fermé : ${f.contractAccessReason}</div>`;
  } else if (f.contracts.length === 0) {
    html += `<div class="industry io">Aucun appel d'offres en cours</div>`;
  }
  if (f.contractAccess) {
    for (const c of f.contracts) {
      const here = selectedShip()?.planet_id === c.deliver_planet_id;
      html += `
        <div class="info-block">
          <div class="row"><span>${resChip(c.resource_id, c.resourceName)}</span>
            <span>${fmtQty(c.remaining)} / ${fmtQty(c.quantity)} restants</span></div>
          <div class="row"><span>Prix contractuel</span>
            <span class="price-low">${fmtPrice.format(c.unit_price)} cr/u</span></div>
          <div class="row"><span>Livraison</span><span>${c.deliver_planet_name}</span></div>
          <div class="row"><span>Expire</span><span>${dateOf(c.expires_tick)}</span></div>
          <button class="action-btn deliver-btn" data-contract="${c.id}" ${here ? '' : 'disabled'}>
            ${here ? 'Livrer depuis la soute' : 'Livraison à ' + c.deliver_planet_name}
          </button>
        </div>
      `;
    }
  }

  panel.innerHTML = html;
  enhancePanel();
  $('#back-to-system').addEventListener('click', () => {
    if (state.selectedSystem) renderSystemPanel(state.selectedSystem);
  });
  $('#btn-pact')?.addEventListener('click', async () => {
    const r = await apiPost(`/factions/${f.id}/pact`);
    if (r.ok) {
      toast(`Accord commercial signé avec ${r.factionName}`, 'good');
      playSound('objective');
      log(`Accord commercial avec ${r.factionName} (−${fmtQty(r.cost)} cr) — douanes ouvertes, relevés gratuits`);
    } else {
      log(`Accord refusé : ${r.error}`);
    }
    await refreshPlayerAndKnowledge();
    renderFactionPanel(factionId);
  });
  $('#btn-loan')?.addEventListener('click', async () => {
    const amount = Number($('#loan-amount').value);
    const r = await apiPost('/loans', { factionId: f.id, amount });
    if (r.ok) log(`Prêt de guerre : ${fmtQty(r.amount)} cr à ${r.factionName} — remboursé ×1,3 s'ils gagnent`);
    else log(`Prêt refusé : ${r.error}`);
    await refreshPlayerAndKnowledge();
    renderHudPlayer();
    renderFactionPanel(factionId);
  });
  for (const btn of panel.querySelectorAll('.deliver-btn')) {
    btn.addEventListener('click', async () => {
      const r = await apiPost(`/contracts/${btn.dataset.contract}/deliver`, { shipId: selectedShip()?.id });
      if (r.ok) {
        log(`Contrat : ${fmtQty(r.delivered)} livrés, +${fmtPrice.format(r.paid)} cr`
          + (r.done ? ` · contrat honoré, +${r.prestigeGained} prestige` : ''));
      } else {
        log(`Livraison refusée : ${r.error}`);
      }
      await refreshPlayerAndKnowledge();
      renderHudPlayer();
      renderFactionPanel(factionId);
    });
  }
}

// Tendance de prix sur l'historique (~5 ticks).
// ── Infobulle de ressource (survol des marchés) ──────────────────
// Une carte flottante : identité (famille), prix vs base avec écart en %,
// stock, et un mini-graphe de l'historique de prix quand on le connaît.
const resTip = $('#res-tip');
panel.addEventListener('mouseleave', hideResTip); // filet : sortie du panneau

function priceSparkSvg(points, color, w = 150, h = 34) {
  if (!points || points.length < 2) return '';
  const vals = points.map((p) => p.price);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i) => (i / (vals.length - 1)) * w;
  const y = (v) => h - 2 - ((v - min) / span) * (h - 4);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return `<svg width="${w}" height="${h}" class="tip-spark">
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.4"/></svg>`;
}

function showResTip(rid, market, ev) {
  const r = market.prices.find((x) => x.resource_id === rid);
  if (!r) return;
  const cat = resCats[resById.get(rid)?.cat];
  const ratio = r.price / r.basePrice;
  const pct = Math.round((ratio - 1) * 100);
  const pCls = ratio >= 1.25 ? 'price-high' : ratio <= 0.8 ? 'price-low' : '';
  const verdict = ratio <= 0.8 ? '<span class="price-low">▼ bon marché — à charger</span>'
    : ratio >= 1.25 ? '<span class="price-high">▲ cher — à vendre ici</span>'
      : '<span style="color:var(--dim)">≈ proche du prix de base</span>';
  const hist = market.history?.[rid];
  resTip.innerHTML = `
    <div class="tip-name">${resGlyph(rid)}<strong>${r.name}</strong>
      ${cat ? `<span class="tip-cat" style="color:${cat.color}">${cat.label}</span>` : ''}</div>
    <div class="tip-row"><span>Prix</span><span class="${pCls}">${fmtPrice.format(r.price)} cr
      <span style="color:var(--dim)">(${pct >= 0 ? '+' : ''}${pct} % vs base)</span></span></div>
    ${r.stock != null ? `<div class="tip-row"><span>Stock</span><span>${fmtQty(r.stock)}</span></div>` : ''}
    ${hist ? `<div class="tip-spark-wrap">${priceSparkSvg(hist, cat?.color ?? '#5ccdf5')}</div>` : ''}
    <div class="tip-verdict">${verdict}</div>`;
  resTip.hidden = false;
  const pad = 14;
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  const box = resTip.getBoundingClientRect();
  if (x + box.width > window.innerWidth - 8) x = ev.clientX - box.width - pad;
  if (y + box.height > window.innerHeight - 8) y = ev.clientY - box.height - pad;
  resTip.style.left = `${Math.max(8, x)}px`;
  resTip.style.top = `${Math.max(8, y)}px`;
}

function hideResTip() { resTip.hidden = true; }

// Branche les infobulles sur toutes les lignes de marché (data-res) du
// panneau. Appelé après chaque rendu de table de marché.
function bindResTips(market) {
  for (const row of panel.querySelectorAll('tr[data-res]')) {
    const rid = row.dataset.res;
    row.addEventListener('mousemove', (ev) => showResTip(rid, market, ev));
    row.addEventListener('mouseleave', hideResTip);
  }
}

function computeTrends(market) {
  const trends = {};
  for (const [rid, points] of Object.entries(market.history ?? {})) {
    if (points.length < 2) continue;
    const current = points[points.length - 1].price;
    const past = points[Math.max(0, points.length - 6)].price;
    const delta = (current - past) / (past || 1);
    trends[rid] = delta > 0.005 ? 'up' : delta < -0.005 ? 'down' : 'flat';
  }
  return trends;
}

// ── HUD ──────────────────────────────────────────────────────────

function renderHudState(s) {
  $('#hud-tick').textContent = dateOf(s.tick);
  $('#hud-tick').title = `tick ${s.tick} — 1 jour par tick depuis le 01/01/3000`;
  $('#hud-seed').textContent = s.seed;
  $('#hud-counts').textContent = `${s.systems} systèmes · ${s.planets} planètes`;
  $('#btn-wars').classList.toggle('war-on', (s.wars?.length ?? 0) > 0);
  for (const btn of document.querySelectorAll('.time-btn[data-speed]')) {
    btn.classList.toggle('active', Number(btn.dataset.speed) === s.speed);
  }
}

// Compteur de crédits animé : il défile de l'ancienne à la nouvelle
// valeur en ~0,5 s (la satisfaction de voir l'argent rentrer). Saut
// direct si l'écart est énorme (chargement) ou négligeable.
let creditsShown = null;
let creditsAnim = null;
function animateCredits(target, suffix) {
  const el = $('#hud-credits');
  if (!el) return;
  if (creditsShown === null || Math.abs(target - creditsShown) < 1
      || Math.abs(target - creditsShown) > 5e8) {
    creditsShown = target;
    el.textContent = `${fmtQty(target)} cr${suffix}`;
    return;
  }
  cancelAnimationFrame(creditsAnim);
  const from = creditsShown;
  const start = performance.now();
  const dur = 500;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - t, 3); // ease-out cubique
    creditsShown = from + (target - from) * e;
    el.textContent = `${fmtQty(Math.round(creditsShown))} cr${suffix}`;
    if (t < 1) creditsAnim = requestAnimationFrame(step);
    else { creditsShown = target; el.textContent = `${fmtQty(target)} cr${suffix}`; }
  };
  creditsAnim = requestAnimationFrame(step);
}

function renderHudPlayer() {
  const p = state.player;
  const ship = selectedShip();
  if (!p || !ship) return;
  const dividends = (p.investments ?? []).reduce((s, i) => s + i.estimatedYield, 0);
  const flux = Math.round((dividends - p.fleetUpkeep) * 10) / 10;
  const fluxStr = (p.fleetUpkeep > 0 || dividends > 0)
    ? ` (${flux >= 0 ? '+' : ''}${fmtNum.format(flux)}/j)` : '';
  animateCredits(p.credits, fluxStr); // le compteur défile vers sa valeur
  $('#hud-credits').classList.toggle('price-high', p.credits < 0);
  const nextTier = !p.tiers[2].unlocked ? 2 : !p.tiers[3].unlocked ? 3 : null;
  $('#hud-prestige').textContent = fmtQty(p.prestige)
    + (nextTier ? ` / ${fmtQty(p.tiers[nextTier].prestigeRequired)} (T${nextTier})` : ' (T3 ✓)');
  $('#hud-cargo').textContent = `${fmtQty(ship.cargoUsed)} / ${fmtQty(ship.cargo_capacity)}`;
  $('#hud-fuel').textContent = `${fmtQty(ship.fuel)} / ${fmtQty(ship.fuel_capacity)}`;
  $('#btn-refuel-hud').disabled = ship.planet_id === null
    || ship.fuel >= ship.fuel_capacity - 0.5;

  const loc = $('#hud-location');
  if (ship.planet_id !== null) {
    const entry = state.planetIndex.get(ship.planet_id);
    loc.textContent = `${ship.name} — à quai : ${entry.planet.name}`;
    $('#btn-skip').hidden = true;
  } else {
    const dest = state.planetIndex.get(ship.dest_planet_id);
    loc.textContent = `${ship.name} — en transit vers ${dest.planet.name} (arr. ${dateShort(ship.arrival_tick)})`;
    $('#btn-skip').hidden = false;
  }
  renderGoalStrip();
  checkDiscoveries();
}

// ── Cap suivant : le prochain palier qu'on dangle en permanence ──
// La carotte de la courbe de progression : on calcule l'achat utile le
// plus proche que le joueur ne peut PAS encore s'offrir, et on montre la
// barre se remplir. Quand il devient accessible, on le célèbre.
let goalReachedKey = null;
function computeNextGoals() {
  const p = state.player;
  if (!p) return [];
  const g = [];
  for (const c of p.concessions ?? []) {
    if (c.nextLevelCost) g.push({ k: `up${c.id}`, cost: c.nextLevelCost,
      label: `Améliorer la concession de ${c.planetName}`, hint: 'extraction ×↑', panel: 'planet', planetId: c.planet_id });
  }
  if ((p.concessions ?? []).length < p.maxConcessions && p.nextConcessionPrice) {
    g.push({ k: 'conc', cost: p.nextConcessionPrice, label: 'Une nouvelle concession', hint: 'un site minier de plus' });
  }
  if ((p.ships ?? []).length < p.maxFleet) {
    for (const [, c] of Object.entries(p.shipClasses ?? {})) {
      g.push({ k: `ship${c.label}`, cost: c.price, label: `Un ${c.label}`, hint: `soute ${fmtQty(c.cargo)}` });
    }
  }
  if ((p.posts ?? []).length < p.maxPosts && p.nextPostPrice) {
    g.push({ k: 'post', cost: p.nextPostPrice, label: 'Un comptoir commercial', hint: 'ordres permanents' });
  }
  const hq = state.house?.hq;
  if (hq?.nextCost) g.push({ k: 'hq', cost: hq.nextCost,
    label: hq.level === 0 ? 'Bâtir votre quartier général' : 'Agrandir le quartier général', hint: 'bonus de flotte', panel: 'house' });
  for (const t of [2, 3]) {
    const ti = p.tiers?.[t];
    if (ti && !ti.unlocked) g.push({ k: `lic${t}`, cost: ti.licenceCost, label: `Licence de marché T${t}`, hint: 'accès aux grands mondes' });
  }
  return g.sort((a, b) => a.cost - b.cost);
}

function renderGoalStrip() {
  const el = $('#goal-strip');
  const p = state.player;
  if (!p) { el.hidden = true; return; }
  const credits = p.credits ?? 0;
  const goals = computeNextGoals();
  // Le cap d'épargne = le moins cher qu'on ne peut PAS encore s'offrir.
  const saving = goals.find((x) => x.cost > credits);
  const st = p.standing;

  let view;
  if (saving) {
    // Début/milieu de partie : réunir la somme, c'est ça l'objectif.
    view = {
      cap: '▸ Cap suivant', label: saving.label, hint: saving.hint, ready: false,
      pct: Math.min(100, Math.round((credits / saving.cost) * 100)),
      num: `${fmtQty(credits)} / ${fmtQty(saving.cost)} cr`,
      panel: saving.panel ?? '', planet: saving.planetId ?? '', key: saving.k,
    };
  } else if (st?.ahead) {
    // Tout est à portée → le vrai objectif devient le CLASSEMENT : rattraper
    // la maison juste devant à la valeur nette.
    const a = st.ahead;
    view = {
      cap: `▸ ${st.rank}ᵉ sur ${st.field} au classement`, label: `Dépasser ${a.name}`,
      hint: 'à la valeur nette', ready: false,
      pct: Math.min(99, Math.round((st.netWorth / a.netWorth) * 100)),
      num: `${fmtQty(st.netWorth)} / ${fmtQty(a.netWorth)} cr`,
      panel: 'house', planet: '', key: 'race',
    };
  } else if (st?.rank === 1) {
    // En tête du Nexus : on défend son avance sur le poursuivant.
    const c = st.chaser;
    const close = c ? Math.min(100, Math.round((c.netWorth / st.netWorth) * 100)) : 0;
    view = {
      cap: '★ En tête du Nexus', ready: true, pct: close,
      label: c ? `${c.name} vous talonne` : 'Maison dominante, sans rivale',
      hint: c ? `à ${close} % de votre valeur nette` : '—',
      num: c ? `poursuivant : ${fmtQty(c.netWorth)} cr` : `${fmtQty(st.netWorth)} cr`,
      panel: 'house', planet: '', key: 'lead',
    };
  } else {
    // Repli (rare : pas de classement) — le plus gros achat à portée.
    const big = [...goals].reverse().find((x) => x.cost <= credits);
    if (!big) { el.hidden = true; return; }
    view = {
      cap: '✓ À votre portée', label: big.label, hint: big.hint, ready: true, pct: 100,
      num: `${fmtQty(big.cost)} cr`, panel: big.panel ?? '', planet: big.planetId ?? '', key: big.k,
    };
  }

  el.hidden = false;
  el.classList.toggle('ready', view.ready);
  el.classList.toggle('lead', view.key === 'lead');
  el.innerHTML = `<span class="goal-cap">${view.cap}</span>
    <span class="goal-label">${view.label} <span class="goal-hint">· ${view.hint}</span></span>
    <span class="goal-bar"><span style="width:${view.pct}%"></span></span>
    <span class="goal-num">${view.num}</span>`;
  el.dataset.panel = view.panel;
  el.dataset.planet = view.planet;

  // Célébration unique : prise de tête au classement, ou cap d'épargne franchi.
  const celebrateKey = view.ready ? view.key : null;
  if (celebrateKey && goalReachedKey !== celebrateKey) {
    goalReachedKey = celebrateKey;
    toast(view.key === 'lead' ? 'Vous prenez la tête du Nexus !'
      : `Objectif atteint : ${view.label} est à votre portée`, 'good');
    playSound('objective');
  } else if (!celebrateKey) {
    goalReachedKey = null;
  }
}

$('#goal-strip').addEventListener('click', () => {
  const el = $('#goal-strip');
  if (el.dataset.panel === 'house') renderHousePanel();
  else if (el.dataset.panel === 'planet' && el.dataset.planet) {
    const entry = state.planetIndex.get(Number(el.dataset.planet));
    if (entry) { selectSystem(entry.system); selectPlanet(entry.planet.id); }
  } else renderObjectivesPanel();
});

// ── Contrôles du temps ───────────────────────────────────────────

for (const btn of document.querySelectorAll('.time-btn[data-speed]')) {
  btn.addEventListener('click', async () => {
    const r = await apiPost('/time', { speed: Number(btn.dataset.speed) });
    if (r.ok) {
      log(r.speed === 0 ? 'Simulation en pause' : `Vitesse ×${r.speed}`);
      poll();
    }
  });
}

// Le plein, toujours à portée de main quand le vaisseau est à quai.
$('#btn-refuel-hud').addEventListener('click', async () => {
  const r = await apiPost('/refuel', { shipId: selectedShip()?.id });
  if (r.ok) log(`Plein : +${fmtInt.format(r.quantity)} carburant à ${fmtPrice.format(r.unitPrice)} (−${fmtPrice.format(r.total)} cr)`);
  else log(`Ravitaillement impossible : ${r.error}`);
  await refreshPlayerAndKnowledge();
  renderHudPlayer();
  refreshPlanetPanel();
});

$('#btn-skip').addEventListener('click', async () => {
  const r = await apiPost('/time/skip', { shipId: selectedShip()?.id });
  if (r.ok) {
    log(`${r.ticksPlayed} jours écoulés — nous sommes le ${dateOf(r.tick)}`);
    await fullRefresh();
  } else {
    log(`Saut impossible : ${r.error}`);
  }
});

// ── Polling ──────────────────────────────────────────────────────

async function refreshPlayerAndKnowledge() {
  const [player, knowledge] = await Promise.all([api('/player'), api('/knowledge')]);
  state.player = player;
  state.knowledge = new Map(knowledge.map((k) => [k.systemId, k.ageTicks]));
  if (!player.ships.some((s) => s.id === state.selectedShipId)) {
    state.selectedShipId = player.ships[0]?.id ?? null;
  }

  // Arrivées : journal pour toute la flotte, recentrage seulement pour
  // le vaisseau piloté (les automatiques ne volent pas la caméra).
  for (const ship of player.ships) {
    const prev = state.prevShips.get(ship.id);
    if (prev && prev.planetId === null && ship.planet_id !== null) {
      const entry = state.planetIndex.get(ship.planet_id);
      log(`${ship.name} arrivé à ${entry.planet.name}`);
      if (ship.id === state.selectedShipId && ship.mode === 'manual') {
        selectSystem(entry.system);
        selectPlanet(entry.planet.id);
      }
    }
  }
  state.prevShips = new Map(player.ships.map((s) => [s.id, { planetId: s.planet_id }]));
  renderFleetBar();
}

async function fullRefresh() {
  const s = await api('/state');
  state.tick = s.tick;
  state.speed = s.speed;
  renderHudState(s);
  await refreshPlayerAndKnowledge();
  renderHudPlayer();
  drawMap();
  await refreshPlanetPanel();
}

// Fil d'événements du monde : guerres, conquêtes, saisies… Les
// changements territoriaux déclenchent un rechargement de la carte.
async function pollEvents() {
  const events = await api(`/events?since=${state.lastEventId}`);
  let territoryChanged = false;
  let toasted = 0;
  for (const e of events) {
    state.lastEventId = Math.max(state.lastEventId, e.id);
    log(e.message, EVENT_CAT[e.type] ?? 'monde');
    if (e.type === 'victory') showVictory(e.message);
    if (['war', 'peace', 'conquest'].includes(e.type)) territoryChanged = true;

    // Les grands moments montent en toast (avec le son qui va avec) —
    // le journal garde tout, les toasts ne gardent que ce qui compte.
    if (toasted < 3) {
      if (e.type === 'objective') { toast(e.message, 'good'); playSound('objective'); toasted++; }
      else if (e.type === 'war') {
        // La première guerre de la partie : on explique l'opportunité (le
        // cœur du jeu) au lieu d'une simple alerte. Le bouton ⚔ GUERRES
        // brille déjà en rouge — on lui donne enfin son sens. Une seule fois.
        if (!gameFlag('firstwar')) {
          setGameFlag('firstwar');
          toast('⚔ Première guerre ! Vous ne la combattez pas, vous la ravitaillez. '
            + 'Ouvrez ⚔ GUERRES : pénuries payées au prix fort, prêts au vainqueur (×1,3), '
            + 'contrats. Une guerre est votre meilleur client.', 'warn', 9000);
        } else {
          toast(e.message, 'bad');
        }
        playSound('war'); toasted++;
      }
      else if (e.type === 'piracy' || e.type === 'seizure') { toast(e.message, 'bad'); playSound('alert'); toasted++; }
      else if (e.type === 'rival') { toast(e.message, 'warn'); toasted++; }
      else if (e.type === 'peace') { toast(e.message, 'info'); toasted++; }
      else if (e.type === 'client') { toast(e.message, 'good'); toasted++; }
      else if (e.type === 'profiteer') { toast(e.message, 'good'); playSound('objective'); toasted++; }
      else if (e.type === 'megaproject') { toast(e.message, e.message.includes('ABANDONNÉ') ? 'warn' : 'good'); toasted++; }
      else if (e.type === 'colony') { toast(e.message, 'good'); toasted++; }
      else if (e.type === 'lair') {
        toast(e.message, e.message.includes('rasé') ? 'good' : 'bad');
        if (!e.message.includes('rasé')) playSound('alert');
        toasted++;
      }
      else if (e.type === 'pact' && e.message.includes('DÉNONCÉ')) {
        toast(e.message, 'bad'); playSound('alert'); toasted++;
      }
      else if (e.type === 'loan' && e.message.includes('rembourse')) {
        toast(e.message, 'good'); playSound('sell'); toasted++;
      }
    }
  }
  if (territoryChanged) {
    const universe = await api('/universe');
    state.universe = universe;
    indexResources(universe);
    state.planetIndex.clear();
    state.capitalSystems.clear();
    for (const sys of universe.systems) {
      for (const p of sys.planets) state.planetIndex.set(p.id, { planet: p, system: sys });
    }
    for (const f of universe.factions) {
      state.factionById.set(f.id, f);
      state.capitalSystems.set(state.planetIndex.get(f.capital_planet_id).system.id, f);
    }
    renderTerritoryLayer(); // les frontières ont bougé
  }
}

// Alertes : ce qui réclame l'attention. Cliquer une alerte localisée
// ouvre la planète concernée.
async function refreshAlerts() {
  const alerts = await api('/alerts');
  const bar = $('#alerts-bar');
  bar.innerHTML = '';
  bar.hidden = alerts.length === 0;
  for (const a of alerts) {
    const el = document.createElement('span');
    el.className = `alert ${a.level}`;
    el.textContent = (a.level === 'crit' ? '⚠ ' : '') + a.message;
    if (a.planetId) {
      el.dataset.planet = a.planetId;
      el.addEventListener('click', () => {
        const entry = state.planetIndex.get(a.planetId);
        if (entry) { selectSystem(entry.system); selectPlanet(a.planetId); }
      });
    }
    bar.appendChild(el);
  }
}

// Rafraîchit la carte thermique active avec les dernières données connues.
async function refreshHeatmap() {
  if (!state.heatmap) return;
  const scan = await api(`/market-scan/${state.heatmap.resourceId}`);
  state.heatmap = buildHeatmap(scan);
}

async function refreshTraffic() {
  setTraffic(await api('/traffic'));
}

// Recale l'horloge interpolée sur le serveur (tick + fraction écoulée).
function syncClock(s) {
  state.tickSync = {
    at: performance.now(),
    progress: s.progress ?? 0,
    periodMs: (s.tickMs ?? 5000) / (s.speed || 1),
  };
}

async function poll() {
  try {
    const s = await api('/state');
    const tickChanged = s.tick !== state.tick;
    state.tick = s.tick;
    state.speed = s.speed;
    state.wars = s.wars;
    state.fronts = new Set(s.wars.flatMap((w) => w.fronts));
    state.lairs = s.lairs ?? [];
    state.rivalClaims = s.rivalClaims ?? [];
    syncClock(s);
    renderHudState(s);
    if (tickChanged) {
      await Promise.all([
        refreshPlayerAndKnowledge(), pollEvents(), refreshAlerts(), refreshHeatmap(),
        refreshTraffic(), refreshHouse(),
      ]);
      renderHudPlayer();
      await refreshPlanetPanel();
      updateGuide();
    }
  } catch {
    // serveur indisponible : on retentera au prochain poll
  }
}

// ── Démarrage ────────────────────────────────────────────────────

async function init() {
  const [universe, s] = await Promise.all([api('/universe'), api('/state')]);
  state.universe = universe;
  indexResources(universe);
  state.tick = s.tick;
  state.speed = s.speed;
  state.wars = s.wars ?? [];
  state.fronts = new Set(state.wars.flatMap((w) => w.fronts));
  state.lairs = s.lairs ?? [];
  state.rivalClaims = s.rivalClaims ?? [];
  syncClock(s);

  // On reprend le fil des événements sans rejouer tout l'historique.
  const oldEvents = await api('/events?since=0');
  state.lastEventId = oldEvents.reduce((m, e) => Math.max(m, e.id), 0);
  for (const e of oldEvents.slice(-3)) log(e.message);

  for (const sys of universe.systems) {
    for (const p of sys.planets) state.planetIndex.set(p.id, { planet: p, system: sys });
  }
  for (const f of universe.factions) {
    state.factionById.set(f.id, f);
    state.capitalSystems.set(state.planetIndex.get(f.capital_planet_id).system.id, f);
  }

  renderHudState(s);
  // La maison est chargée AVANT le premier rendu du HUD : sinon le bandeau
  // d'objectif manque le cap « quartier général » à la première frame.
  await Promise.all([refreshPlayerAndKnowledge(), refreshHouse().catch(() => {})]);
  renderHudPlayer();
  resizeCanvas();
  renderTerritoryLayer();
  canvas.style.cursor = 'grab';
  window.addEventListener('resize', resizeCanvas);

  // On ouvre la partie là où est le vaisseau, caméra sur lui.
  const shipPlanet = selectedShip()?.planet_id;
  if (shipPlanet != null) {
    const entry = state.planetIndex.get(shipPlanet);
    selectSystem(entry.system);
    state.view.cx = entry.system.x;
    state.view.cy = entry.system.y;
    state.view.zoom = 1.8;
    await selectPlanet(entry.planet.id);
  }

  await Promise.all([refreshAlerts(), refreshTraffic().catch(() => {})]);
  startRenderLoop();
  log('Bienvenue à bord. Votre concession produit — chargez, voyagez, vendez plus cher.');
  updateGuide();
  setInterval(poll, POLL_MS);
}

// ── Écran-titre : le premier contact ─────────────────────────────
// Affiché à chaque nouvel onglet ; « Continuer » se fond dans la partie
// en cours, « Nouvelle partie » ouvre le menu. Une fois entré, on n'y
// revient pas (les rechargements liés au changement de partie le sautent).
// Fond vivant de l'écran-titre : starfield en parallaxe qui dérive, halos
// de nébuleuses, et de loin en loin une comète qui file. Tourne seulement
// tant que le titre est affiché (coupé à l'entrée pour ne rien gâcher).
let titleAnim = null;
function startTitleBackdrop() {
  const cv = $('#title-bg');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0, H = 0;
  const resize = () => {
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  const rnd = (a, b) => a + Math.random() * (b - a);
  // Trois couches de profondeur (lointain → proche) à vitesses croissantes.
  const layers = [
    { n: 90, sp: 3, r: [0.4, 0.9], a: [0.18, 0.4] },
    { n: 60, sp: 7, r: [0.6, 1.3], a: [0.3, 0.6] },
    { n: 28, sp: 14, r: [0.9, 1.8], a: [0.5, 0.95] },
  ].map((L) => ({
    sp: L.sp,
    stars: Array.from({ length: L.n }, () => ({
      x: Math.random(), y: Math.random(), r: rnd(...L.r),
      a: rnd(...L.a), tw: rnd(0, Math.PI * 2), ts: rnd(0.5, 1.6),
    })),
  }));
  const nebulae = [
    { x: 0.30, y: 0.40, r: 360, c: '92,205,245', a: 0.10 },
    { x: 0.70, y: 0.62, r: 420, c: '150,120,230', a: 0.09 },
    { x: 0.52, y: 0.28, r: 300, c: '86,196,196', a: 0.07 },
  ];
  let comet = null, nextComet = rnd(1.5, 4);

  const t0 = performance.now();
  let last = t0;
  const draw = (now) => {
    const t = (now - t0) / 1000;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    ctx.clearRect(0, 0, W, H);

    // Nébuleuses qui respirent et dérivent très lentement.
    for (const nb of nebulae) {
      const cx = (nb.x + Math.sin(t * 0.05 + nb.y * 7) * 0.015) * W;
      const cy = (nb.y + Math.cos(t * 0.04 + nb.x * 7) * 0.015) * H;
      const pulse = 1 + Math.sin(t * 0.3 + nb.x * 10) * 0.06;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, nb.r * pulse);
      g.addColorStop(0, `rgba(${nb.c},${nb.a})`);
      g.addColorStop(1, `rgba(${nb.c},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    // Étoiles : dérive diagonale + scintillement.
    for (const L of layers) {
      for (const st of L.stars) {
        const x = (st.x * W + (t * L.sp)) % (W + 4) - 2;
        const y = (st.y * H + (t * L.sp * 0.35)) % (H + 4) - 2;
        const tw = 0.65 + 0.35 * Math.sin(st.tw + t * st.ts);
        ctx.globalAlpha = st.a * tw;
        ctx.fillStyle = '#dfeafc';
        ctx.beginPath();
        ctx.arc(x, y, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Comète occasionnelle : un trait lumineux qui traverse.
    nextComet -= dt;
    if (!comet && nextComet <= 0) {
      const fromLeft = Math.random() < 0.5;
      comet = {
        x: fromLeft ? -0.05 * W : 1.05 * W, y: rnd(0.1, 0.55) * H,
        vx: (fromLeft ? 1 : -1) * rnd(420, 620), vy: rnd(120, 200), life: 0,
      };
      nextComet = rnd(4, 8);
    }
    if (comet) {
      comet.life += dt;
      comet.x += comet.vx * dt; comet.y += comet.vy * dt;
      const len = 90;
      const tx = comet.x - comet.vx * 0.13, ty = comet.y - comet.vy * 0.13;
      const g = ctx.createLinearGradient(tx, ty, comet.x, comet.y);
      g.addColorStop(0, 'rgba(150,210,255,0)');
      g.addColorStop(1, 'rgba(200,235,255,0.9)');
      ctx.strokeStyle = g; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(comet.x, comet.y); ctx.stroke();
      ctx.globalAlpha = 0.9; ctx.fillStyle = '#eaf6ff';
      ctx.beginPath(); ctx.arc(comet.x, comet.y, 1.7, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      if (comet.x < -0.1 * W || comet.x > 1.1 * W || comet.y > 1.1 * H) comet = null;
      void len;
    }

    titleAnim = requestAnimationFrame(draw);
  };
  titleAnim = requestAnimationFrame(draw);
  startTitleBackdrop.cleanup = () => window.removeEventListener('resize', resize);
}

function stopTitleBackdrop() {
  if (titleAnim) { cancelAnimationFrame(titleAnim); titleAnim = null; }
  startTitleBackdrop.cleanup?.();
}

function dismissTitle() {
  try { sessionStorage.setItem('nx-entered', '1'); } catch { /* privé */ }
  stopTitleBackdrop();
  const t = $('#title-screen');
  t.classList.add('fade');
  setTimeout(() => { t.hidden = true; }, 750);
}

function setupTitle() {
  const entered = (() => {
    try { return sessionStorage.getItem('nx-entered') === '1'; } catch { return false; }
  })();
  if (entered) { $('#title-screen').hidden = true; return; }
  startTitleBackdrop();
  $('#title-continue').addEventListener('click', dismissTitle);
  $('#title-new').addEventListener('click', () => { dismissTitle(); openSavesOverlay(); });
}

setupTitle();
init();
