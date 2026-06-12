// Client Nexus Trade : carte des systèmes (canvas), panneau d'inspection
// et de commerce, HUD joueur, contrôles du temps. Données via l'API REST,
// rafraîchies par polling.

const $ = (sel) => document.querySelector(sel);
const canvas = $('#map');
const ctx = canvas.getContext('2d');
const tooltip = $('#tooltip');
const panel = $('#panel-content');

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

const fmtNum = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const fmtPrice = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

// ── Journal ──────────────────────────────────────────────────────

function log(message) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="tick-stamp">t${state.tick ?? 0}</span><strong>${message}</strong>`;
  const list = $('#journal-list');
  list.prepend(li);
  while (list.children.length > 60) list.lastChild.remove();
}

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

// Rayon écran du cœur d'une étoile (le halo s'étend bien au-delà).
function starRadius(system) {
  return (2.4 + system.planets.length * 0.5) * Math.pow(state.view.zoom, 0.55);
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
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = withAlpha(lane.color, Math.min(0.13, 0.03 + lane.n * 0.02));
    ctx.lineWidth = 1;
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
    if (state.heatmap) {
      const ratio = state.heatmap.bySystem.get(sys.id);
      color = ratio === undefined ? '#3a4150' : heatColor(Math.round(ratio * 20) / 20);
      alpha = ratio === undefined ? 0.55 : 1;
    } else {
      color = STAR_COLORS[sys.id % STAR_COLORS.length];
      alpha = knowledgeAlpha(sys.id);
    }
    if (isHover || isSelected) alpha = 1;

    const sprite = glowSprite(color, Math.round(r * 2) / 2);
    ctx.globalAlpha = alpha;
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
      ctx.fillText(sys.name, sx + r + 6, sy + 3);
      ctx.globalAlpha = 1;
    }
  }
}

// — Vos installations : coins ambre autour des systèmes à concession —

function drawPlayerAssets() {
  for (const c of state.player?.concessions ?? []) {
    const entry = state.planetIndex.get(c.planet_id);
    if (!entry) continue;
    const [sx, sy] = toScreen(entry.system.x, entry.system.y);
    const d = starRadius(entry.system) + 5;
    const l = 3.5;
    ctx.strokeStyle = 'rgba(232,179,90,0.85)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(sx - d + l, sy - d); ctx.lineTo(sx - d, sy - d); ctx.lineTo(sx - d, sy - d + l);
    ctx.moveTo(sx + d - l, sy - d); ctx.lineTo(sx + d, sy - d); ctx.lineTo(sx + d, sy - d + l);
    ctx.moveTo(sx - d + l, sy + d); ctx.lineTo(sx - d, sy + d); ctx.lineTo(sx - d, sy + d - l);
    ctx.moveTo(sx + d - l, sy + d); ctx.lineTo(sx + d, sy + d); ctx.lineTo(sx + d, sy + d - l);
    ctx.stroke();
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

// — Image complète ————————————————————————————————————————————

function drawMap(t = performance.now() / 1000) {
  if (!state.universe || !state.view) return;
  ctx.clearRect(0, 0, state.view.w, state.view.h);
  drawStarfield(t);
  drawTerritory();
  drawLanes();
  drawTraffic();
  drawSystems(t);
  drawPlayerAssets();
  drawFleet(t);
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
      : `→ ${state.planetIndex.get(ship.dest_planet_id).planet.name} (t${ship.arrival_tick})`;
    chip.innerHTML = `
      <span class="ship-name">${ship.false_flag ? '⚑ ' : ''}${ship.name}</span>
      <span>${ship.classLabel}</span>
      <span>${where}</span>
      <span>${fmtQty(ship.cargoUsed)}/${fmtQty(ship.cargo_capacity)}</span>
      <button class="mode-toggle ${ship.mode !== 'manual' ? 'auto' : ''}"
        title="Basculer le mode (une route assignée repasse en manuel)">${
          ship.mode === 'route' ? 'ROUTE' : ship.mode === 'auto' ? 'AUTO' : 'MAN'}</button>
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
    const sys = systemAt(e.clientX - rect.left, e.clientY - rect.top);
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
  const sys = systemAt(e.clientX - rect.left, e.clientY - rect.top);
  state.hoverSystem = sys;
  canvas.style.cursor = sys ? 'pointer' : 'grab';
  if (sys) {
    const age = state.knowledge.get(sys.id);
    const info = age === undefined ? 'marchés inconnus'
      : age === 0 ? 'données fraîches' : `données : il y a ${age} ticks`;
    const front = state.fronts.has(sys.id) ? '<br>⚔ FRONT DE GUERRE' : '';
    const f = sys.faction_id !== null ? state.factionById.get(sys.faction_id) : null;
    const pop = sys.planets.reduce((sum, p) => sum + p.population, 0);
    tooltip.hidden = false;
    tooltip.innerHTML = `<strong>${sys.name}</strong> — ${sys.planets.length} planètes · ${formatPop(pop)}<br>`
      + (f ? `<span style="color:${f.color}">◆ ${f.name}</span>` : '<span style="color:#6b7689">◇ Frange indépendante</span>')
      + ` · ${info}${front}`;
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
$('#zoom-ship').addEventListener('click', () => {
  const pos = shipMapPosition(selectedShip());
  if (!pos) return;
  const v = state.view;
  v.cx = pos.x;
  v.cy = pos.y;
  if (v.zoom < 2.2) v.zoom = 2.2;
  clampView();
});
$('#traffic-toggle').addEventListener('click', (e) => {
  state.showTraffic = !state.showTraffic;
  e.currentTarget.classList.toggle('off', !state.showTraffic);
});

// ── Panneau : système ────────────────────────────────────────────

function selectSystem(sys) {
  state.selectedSystem = sys;
  state.selectedPlanet = null;
  state.tradeSel = null;
  drawMap();
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
      — ${age === undefined ? 'marchés inconnus' : `données : il y a ${age} ticks`}</p>
    <div style="margin:4px 0 8px">${factionChip(sys.faction_id)}</div>
    <div class="section-label">Planètes (${sys.planets.length})</div>
    <div id="system-planets"></div>
    <div id="system-actions"></div>
  `;
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
  await refreshPlanetPanel();
}

async function refreshPlanetPanel() {
  const id = state.selectedPlanet;
  if (id === null) return;
  // Ne pas écraser le formulaire pendant une saisie.
  if (document.activeElement && panel.contains(document.activeElement)
    && document.activeElement.tagName === 'INPUT') return;

  const [planet, market] = await Promise.all([api(`/planet/${id}`), api(`/market/${id}`)]);
  if (state.selectedPlanet !== id) return;

  const scroll = panel.scrollTop;
  if (planet.docked) renderDockedPanel(planet, market);
  else await renderRemotePanel(planet, market);
  panel.scrollTop = scroll;
}

// Mini-graphe de prix (60 derniers ticks) dans le formulaire d'ordre.
function drawSparkline(points) {
  const c = $('#spark');
  if (!c || points.length < 2) return;
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

  // Industrie : votre concession sur cette planète (ou son achat).
  const c = state.player.concessions.find((x) => x.planet_id === planet.id);
  if (c) {
    const pct = Math.round((c.used / c.cap) * 100);
    html += `
      <div class="section-label">Concession — extraction ${c.resourceName} (niv. ${c.level})</div>
      <div class="info-block">
        <div class="row"><span>Extraction</span><span>+${fmtNum.format(c.rate)}/tick</span></div>
        <div class="row"><span>Entrepôt</span><span>${fmtQty(c.used)} / ${fmtQty(c.cap)} (${pct} %)</span></div>
        <div class="gauge"><div style="width:${pct}%"></div></div>
    `;
    for (const s of c.storage) {
      html += `<div class="row"><span>${s.name}</span>
        <span>${fmtQty(s.quantity)}
        ${shipHere ? `<button class="action-btn collect-btn" data-res="${s.resource_id}">→ soute</button>` : ''}
        </span></div>`;
    }
    const shipCargo = selectedShip()?.cargo ?? [];
    if (shipHere && shipCargo.length > 0) {
      html += `<div class="row" style="margin-top:6px"><span>Déposer</span><span>
        <select id="deposit-res">${shipCargo.map((x) =>
          `<option value="${x.resource_id}">${x.name} (${fmtQty(x.quantity)})</option>`).join('')}</select>
        <button class="action-btn" id="btn-deposit">→ entrepôt</button></span></div>`;
    }
    html += `
        ${c.nextLevelCost !== null
          ? `<button class="action-btn" id="btn-upgrade" data-cid="${c.id}">Améliorer (${fmtInt.format(c.nextLevelCost)} cr)</button>`
          : '<span class="badge">niveau max</span>'}
      </div>
    `;

    // Ateliers : installés, puis installables selon vos technologies.
    html += `<div class="section-label">Ateliers (×${c.workshops.length})</div>`;
    for (const w of c.workshops) {
      const inputs = Object.entries(w.inputs)
        .map(([rid, q]) => `${q} ${state.player.workshopCatalog.find((x) => x.recipe_id === rid)?.name ?? rid}`)
        .join(' + ');
      html += `<div class="industry">${w.name}
        <span class="io">— ${inputs} → ${w.output} (×${w.rate}/tick)</span></div>`;
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
    html += `
      <div class="section-label">Industrie</div>
      <button class="action-btn" id="btn-buy-concession">
        Acheter une concession ici (${fmtQty(state.player.nextConcessionPrice)} cr — Prospection requise)
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

  // Chantier civil : acheter des vaisseaux sur les mondes établis.
  if (shipHere && planet.tier >= 2) {
    html += `<div class="section-label">Chantier civil — flotte ${state.player.ships.length}/${state.player.maxFleet}</div><div>`;
    for (const [classId, cls] of Object.entries(state.player.shipClasses)) {
      const disabled = state.player.credits < cls.price
        || state.player.ships.length >= state.player.maxFleet;
      html += `<button class="action-btn buy-ship" data-class="${classId}" ${disabled ? 'disabled' : ''}
        title="soute ${cls.cargo} · vitesse ${cls.speed} · réservoir ${cls.fuel} · entretien ${cls.upkeep} cr/tick">
        ${cls.label} (${fmtQty(cls.price)} cr · ${cls.upkeep}/tick)</button>`;
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
      <span class="io">— ${inputs} → ${ind.output} (×${fmtNum.format(ind.rate)}/tick)</span>
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
    <div class="section-label">Marché en direct — tick ${market.tick}</div>
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
          <td>${r.name}</td>
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
          <button class="action-btn" id="btn-refuel" title="Remplir le réservoir au prix du marché local">Plein</button>
        </div>
        <div id="trade-preview"></div>
      </div>
    `;
  }

  panel.innerHTML = html;
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

  $('#btn-deposit')?.addEventListener('click', async () => {
    const r = await apiPost('/concession/deposit', { shipId, resourceId: $('#deposit-res').value });
    if (r.ok) log(`${fmtQty(r.moved)} ${r.name} déposés à l'entrepôt`);
    else log(`Dépôt impossible : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanelForce();
  });

  $('#btn-upgrade')?.addEventListener('click', async (e) => {
    const r = await apiPost('/concession/upgrade', { concessionId: Number(e.target.dataset.cid) });
    if (r.ok) log(`Concession niveau ${r.level} — extraction ${fmtNum.format(r.rate)}/tick (−${fmtInt.format(r.cost)} cr)`);
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
    if (r.ok) log(`Industrie fondée : ${r.name} sur ${r.planetName} (×${fmtNum.format(r.rate)}/tick, 49 % fondateur, −${fmtQty(r.cost)} cr)`);
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

  $('#btn-flag')?.addEventListener('click', async () => {
    const r = await apiPost(`/ships/${shipId}/flag`);
    if (r.ok) log(`${r.shipName} navigue désormais sous pavillon de complaisance (−${fmtQty(r.cost)} cr)`);
    else log(`Pavillon refusé : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanelForce();
  });

  $('#btn-buy-concession')?.addEventListener('click', async () => {
    const r = await apiPost('/concessions/buy', { shipId });
    if (r.ok) log(`Concession acquise sur ${r.planetName} — extraction de ${r.resourceName} (−${fmtQty(r.price)} cr)`);
    else log(`Achat impossible : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanelForce();
  });

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

  if (shipHere && state.tradeSel) {
    const res = market.prices.find((r) => r.resource_id === state.tradeSel);
    $('#trade-res-name').textContent =
      `${res.name} — marché : ${fmtPrice.format(res.price)} cr · stock ${fmtQty(res.stock)}`;
    drawSparkline(market.history?.[state.tradeSel] ?? []);
    const qtyInput = $('#trade-qty');
    qtyInput.addEventListener('input', () => updateTradePreview());
    $('#btn-buy').addEventListener('click', () => doTrade('buy'));
    $('#btn-sell').addEventListener('click', () => doTrade('sell'));
    updateTradePreview();
  }
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

  if (!market.known) {
    html += `<p class="hint">Marché inconnu — aucune donnée. Rapprochez-vous,
      ou achetez un relevé depuis la vue système.</p>`;
  } else {
    html += `
      <div class="section-label">Dernières données connues
        <span class="badge age">il y a ${market.ageTicks} ticks</span></div>
      <table>
        <tr><th>Ressource</th><th>Stock</th><th>Prix vu</th></tr>
    `;
    for (const tier of ['raw', 'intermediate', 'finished']) {
      html += `<tr class="tier-row"><td colspan="3">${TIER_LABELS[tier]}</td></tr>`;
      for (const r of market.prices.filter((r) => r.tier === tier)) {
        const ratio = r.price / r.basePrice;
        const priceCls = ratio >= 1.25 ? 'price-high' : ratio <= 0.8 ? 'price-low' : '';
        html += `
          <tr>
            <td>${r.name}</td>
            <td>${r.stock === null ? '?' : fmtQty(r.stock)}</td>
            <td class="${priceCls}" title="base : ${fmtPrice.format(r.basePrice)}">${fmtPrice.format(r.price)}</td>
          </tr>
        `;
      }
    }
    html += `</table>`;
  }

  panel.innerHTML = html;
  bindBackLink();
  bindLicenceButton();

  // Bouton voyage (préparé en asynchrone) — pour le vaisseau piloté.
  const ship = selectedShip();
  const preview = await api(`/travel/preview?planetId=${planet.id}&shipId=${ship?.id}`);
  const slot = $('#travel-slot');
  if (!slot || state.selectedPlanet !== planet.id) return;
  if (preview.ok) {
    slot.innerHTML = `
      <button class="action-btn" id="btn-travel">
        ${ship.name} : voyager — ${preview.ticks} tick${preview.ticks > 1 ? 's' : ''} ·
        ${preview.fuelCost > 0 ? `${fmtInt.format(preview.fuelCost)} carburant` : 'saut local'}
      </button>
    `;
    $('#btn-travel').addEventListener('click', async () => {
      const r = await apiPost('/travel', { planetId: planet.id, shipId: ship.id });
      if (r.ok) {
        log(`En route vers ${planet.name} — arrivée au tick ${r.arrivalTick}`);
        await refreshPlayerAndKnowledge();
        drawMap();
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
  state.selectedPlanet = null;
  const scan = await api(`/market-scan/${state.marketSel}`);
  const ship = selectedShip();
  const origin = ship?.planet_id != null ? state.planetIndex.get(ship.planet_id)?.system : null;
  const distOf = (m) => origin ? Math.round(Math.hypot(m.x - origin.x, m.y - origin.y)) : null;

  const resources = state.universe.resources;
  let html = `
    <button class="back-link" id="back-to-system">← retour</button>
    <h2 class="panel-title">Marchés — ${scan.name}</h2>
    <p class="panel-sub">Comparateur d'arbitrage sur vos marchés connus
      (prix de base ${fmtPrice.format(scan.basePrice)} cr).</p>
    <div style="margin-bottom:8px">
      <select id="market-res">
        ${['raw', 'intermediate', 'finished'].map((t) => `<optgroup label="${TIER_LABELS[t]}">${
          resources.filter((r) => r.tier === t)
            .map((r) => `<option value="${r.id}" ${r.id === state.marketSel ? 'selected' : ''}>${r.name}</option>`).join('')
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
    for (const m of sorted) {
      const cls = m.price === cheapest ? 'buy' : m.price === dearest ? 'sell' : '';
      html += `<tr class="market-row ${cls}">
        <td><span class="goto-link" data-planet="${m.planetId}" data-system="${m.systemId}">${m.planetName}</span></td>
        <td title="base ${fmtPrice.format(scan.basePrice)}">${fmtPrice.format(m.price)}</td>
        <td>${m.stock === null ? '?' : fmtQty(m.stock)}</td>
        <td>${m.ageTicks === 0 ? 'live' : `−${m.ageTicks}t`}</td>
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

// ── Panneau : technologies ───────────────────────────────────────

async function renderTechPanel() {
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
    ? (state.player.workshopCatalog.find((w) => w.recipe_id === a.resourceId)?.name ?? a.resourceId)
    : 'tout';
  return `${ACTION_LABELS[a.type].split(' ')[0].toLowerCase()} ${res}${a.quantity ? ` ×${a.quantity}` : ''}`;
}

async function renderRoutesPanel() {
  const routes = await api('/routes');
  state.selectedPlanet = null;

  let html = `
    <button class="back-link" id="back-to-system">← retour</button>
    <h2 class="panel-title">Routes logistiques</h2>
    <p class="panel-sub">Un circuit d'étapes parcouru en boucle par les
      vaisseaux assignés — la navette régulière de vos concessions.</p>
  `;

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
          ${state.player.workshopCatalog.map((w) => `<option value="${w.recipe_id}">${w.name}</option>`).join('')}
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
  $('#back-to-system').addEventListener('click', () => {
    if (state.selectedSystem) renderSystemPanel(state.selectedSystem);
    else panel.innerHTML = '<p class="hint">Cliquez sur un système de la carte.</p>';
  });
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

  if (f.war) {
    const myLoans = (state.player.loans ?? [])
      .filter((l) => l.faction_id === f.id && l.status === 'open');
    html += `
      <div class="section-label">⚔ En guerre</div>
      <div class="info-block" style="border-color:#f04545">
        <div class="row"><span>Contre</span><span>${f.war.enemy}</span></div>
        <div class="row"><span>Depuis</span><span>tick ${f.war.since}</span></div>
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
          <div class="row"><span>${c.resourceName}</span>
            <span>${fmtQty(c.remaining)} / ${fmtQty(c.quantity)} restants</span></div>
          <div class="row"><span>Prix contractuel</span>
            <span class="price-low">${fmtPrice.format(c.unit_price)} cr/u</span></div>
          <div class="row"><span>Livraison</span><span>${c.deliver_planet_name}</span></div>
          <div class="row"><span>Expire</span><span>tick ${c.expires_tick}</span></div>
          <button class="action-btn deliver-btn" data-contract="${c.id}" ${here ? '' : 'disabled'}>
            ${here ? 'Livrer depuis la soute' : 'Livraison à ' + c.deliver_planet_name}
          </button>
        </div>
      `;
    }
  }

  panel.innerHTML = html;
  $('#back-to-system').addEventListener('click', () => {
    if (state.selectedSystem) renderSystemPanel(state.selectedSystem);
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
  $('#hud-tick').textContent = s.tick;
  $('#hud-seed').textContent = s.seed;
  $('#hud-counts').textContent = `${s.systems} systèmes · ${s.planets} planètes`;
  for (const btn of document.querySelectorAll('.time-btn[data-speed]')) {
    btn.classList.toggle('active', Number(btn.dataset.speed) === s.speed);
  }
}

function renderHudPlayer() {
  const p = state.player;
  const ship = selectedShip();
  if (!p || !ship) return;
  const dividends = (p.investments ?? []).reduce((s, i) => s + i.estimatedYield, 0);
  const flux = Math.round((dividends - p.fleetUpkeep) * 10) / 10;
  $('#hud-credits').textContent = `${fmtQty(p.credits)} cr`
    + (p.fleetUpkeep > 0 || dividends > 0 ? ` (${flux >= 0 ? '+' : ''}${fmtNum.format(flux)}/tick)` : '');
  $('#hud-credits').classList.toggle('price-high', p.credits < 0);
  const nextTier = !p.tiers[2].unlocked ? 2 : !p.tiers[3].unlocked ? 3 : null;
  $('#hud-prestige').textContent = fmtQty(p.prestige)
    + (nextTier ? ` / ${fmtQty(p.tiers[nextTier].prestigeRequired)} (T${nextTier})` : ' (T3 ✓)');
  $('#hud-cargo').textContent = `${fmtQty(ship.cargoUsed)} / ${fmtQty(ship.cargo_capacity)}`;
  $('#hud-fuel').textContent = `${fmtQty(ship.fuel)} / ${fmtQty(ship.fuel_capacity)}`;

  const loc = $('#hud-location');
  if (ship.planet_id !== null) {
    const entry = state.planetIndex.get(ship.planet_id);
    loc.textContent = `${ship.name} — à quai : ${entry.planet.name}`;
    $('#btn-skip').hidden = true;
  } else {
    const dest = state.planetIndex.get(ship.dest_planet_id);
    loc.textContent = `${ship.name} — en transit vers ${dest.planet.name} (t${ship.arrival_tick})`;
    $('#btn-skip').hidden = false;
  }
}

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

$('#btn-skip').addEventListener('click', async () => {
  const r = await apiPost('/time/skip', { shipId: selectedShip()?.id });
  if (r.ok) {
    log(`${r.ticksPlayed} ticks écoulés — tick ${r.tick}`);
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
  for (const e of events) {
    state.lastEventId = Math.max(state.lastEventId, e.id);
    log(e.message);
    if (['war', 'peace', 'conquest'].includes(e.type)) territoryChanged = true;
  }
  if (territoryChanged) {
    const universe = await api('/universe');
    state.universe = universe;
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
    syncClock(s);
    renderHudState(s);
    if (tickChanged) {
      await Promise.all([
        refreshPlayerAndKnowledge(), pollEvents(), refreshAlerts(), refreshHeatmap(), refreshTraffic(),
      ]);
      renderHudPlayer();
      await refreshPlanetPanel();
    }
  } catch {
    // serveur indisponible : on retentera au prochain poll
  }
}

// ── Démarrage ────────────────────────────────────────────────────

async function init() {
  const [universe, s] = await Promise.all([api('/universe'), api('/state')]);
  state.universe = universe;
  state.tick = s.tick;
  state.speed = s.speed;
  state.wars = s.wars ?? [];
  state.fronts = new Set(state.wars.flatMap((w) => w.fronts));
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
  await refreshPlayerAndKnowledge();
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
  setInterval(poll, POLL_MS);
}

init();
