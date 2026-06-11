// Client Nexus Trade : carte des systèmes (canvas) + panneau d'inspection.
// Données via l'API REST, rafraîchies par polling à chaque tick serveur.

const $ = (sel) => document.querySelector(sel);
const canvas = $('#map');
const ctx = canvas.getContext('2d');
const tooltip = $('#tooltip');
const panel = $('#panel-content');

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
const fmtPrice = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const state = {
  universe: null,
  tick: null,
  tickMs: 5000,
  selectedSystem: null, // objet système
  selectedPlanet: null, // id de planète
  hoverSystem: null,
  view: null, // transforme carte → écran
};

async function api(path) {
  const res = await fetch('/api' + path);
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}

// ── Carte ────────────────────────────────────────────────────────

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Transformation carte → écran : on inscrit le carré de l'univers dans
  // le canvas avec une marge, en conservant les proportions.
  const pad = 30;
  const scale = Math.min(rect.width - 2 * pad, rect.height - 2 * pad) / state.universe.mapSize;
  state.view = {
    scale,
    ox: (rect.width - state.universe.mapSize * scale) / 2,
    oy: (rect.height - state.universe.mapSize * scale) / 2,
  };
  drawMap();
}

const toScreen = (x, y) => [x * state.view.scale + state.view.ox, y * state.view.scale + state.view.oy];

function starRadius(system) {
  return 1.5 + system.planets.length * 0.5;
}

function drawMap() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);

  for (const sys of state.universe.systems) {
    const [sx, sy] = toScreen(sys.x, sys.y);
    const r = starRadius(sys);
    const isSelected = state.selectedSystem?.id === sys.id;
    const isHover = state.hoverSystem?.id === sys.id;

    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = STAR_COLORS[sys.id % STAR_COLORS.length];
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = isHover || isSelected ? 14 : 6;
    ctx.fill();
    ctx.shadowBlur = 0;

    if (isSelected) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#53c7f0';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }
}

function systemAt(mx, my) {
  let best = null;
  let bestDist = 12; // rayon de capture en px
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

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sys = systemAt(e.clientX - rect.left, e.clientY - rect.top);
  if (sys !== state.hoverSystem) {
    state.hoverSystem = sys;
    drawMap();
  }
  canvas.style.cursor = sys ? 'pointer' : 'crosshair';
  if (sys) {
    tooltip.hidden = false;
    tooltip.textContent = `${sys.name} — ${sys.planets.length} planètes`;
    tooltip.style.left = `${e.clientX - rect.left + 14}px`;
    tooltip.style.top = `${e.clientY - rect.top - 8}px`;
  } else {
    tooltip.hidden = true;
  }
});

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sys = systemAt(e.clientX - rect.left, e.clientY - rect.top);
  if (sys) selectSystem(sys);
});

// ── Panneau gauche ───────────────────────────────────────────────

function selectSystem(sys) {
  state.selectedSystem = sys;
  state.selectedPlanet = null;
  drawMap();
  renderSystemPanel(sys);
}

function renderSystemPanel(sys) {
  panel.innerHTML = `
    <h2 class="panel-title">${sys.name}</h2>
    <p class="panel-sub">Système — position (${Math.round(sys.x)}, ${Math.round(sys.y)})</p>
    <div class="section-label">Planètes (${sys.planets.length})</div>
  `;
  for (const p of sys.planets) {
    const row = document.createElement('button');
    row.className = 'planet-row';
    row.innerHTML = `
      <span class="biome-dot" style="background:${BIOME_COLORS[p.biome]}"></span>
      <span>${p.name}</span>
      <span class="meta">${p.biomeLabel}<br>${formatPop(p.population)}</span>
    `;
    row.addEventListener('click', () => selectPlanet(p.id));
    panel.appendChild(row);
  }
}

async function selectPlanet(planetId) {
  state.selectedPlanet = planetId;
  await refreshPlanetPanel();
}

async function refreshPlanetPanel() {
  const id = state.selectedPlanet;
  const [planet, market] = await Promise.all([api(`/planet/${id}`), api(`/market/${id}`)]);
  if (state.selectedPlanet !== id) return; // sélection changée entre-temps

  const scroll = $('#panel').scrollTop;
  renderPlanetPanel(planet, market);
  $('#panel').scrollTop = scroll;
}

function renderPlanetPanel(planet, market) {
  const trends = computeTrends(market);

  let html = `
    <button class="back-link" id="back-to-system">← ${planet.system_name}</button>
    <h2 class="panel-title">${planet.name}</h2>
    <p class="panel-sub">
      <span class="biome-dot" style="display:inline-block;background:${BIOME_COLORS[planet.biome]}"></span>
      ${planet.biomeLabel} — ${formatPop(planet.population)}
    </p>
  `;

  html += `<div class="section-label">Industries</div>`;
  if (planet.industries.length === 0) {
    html += `<div class="industry io">Aucune industrie locale</div>`;
  }
  for (const ind of planet.industries) {
    const inputs = Object.entries(ind.inputs)
      .map(([rid, qty]) => `${qty} ${resourceName(planet, rid)}`).join(' + ');
    html += `<div class="industry">${ind.name}
      <span class="io">— ${inputs} → ${ind.output} (×${fmtNum.format(ind.rate)}/tick)</span></div>`;
  }

  html += `
    <div class="section-label">Marché — tick ${market.tick}</div>
    <table>
      <tr><th>Ressource</th><th>Stock</th><th>Δ/tick</th><th>Prix</th></tr>
  `;

  for (const tier of ['raw', 'intermediate', 'finished']) {
    html += `<tr class="tier-row"><td colspan="4">${TIER_LABELS[tier]}</td></tr>`;
    for (const r of planet.resources.filter((r) => r.tier === tier)) {
      const flow = r.production - r.consumption;
      const flowCls = flow > 0.005 ? 'flow-plus' : flow < -0.005 ? 'flow-minus' : 'flow-zero';
      const flowTxt = flow === 0 ? '·' : (flow > 0 ? '+' : '') + fmtNum.format(flow);
      const ratio = r.price / r.basePrice;
      const priceCls = ratio >= 1.25 ? 'price-high' : ratio <= 0.8 ? 'price-low' : '';
      const trend = trends[r.resource_id] ?? 'flat';
      const arrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '·';
      html += `
        <tr class="updated">
          <td>${r.name}</td>
          <td>${fmtNum.format(r.stock)}</td>
          <td class="${flowCls}">${flowTxt}</td>
          <td class="${priceCls}" title="base : ${fmtPrice.format(r.basePrice)}">
            ${fmtPrice.format(r.price)} <span class="trend ${trend}">${arrow}</span>
          </td>
        </tr>
      `;
    }
  }
  html += `</table>`;

  panel.innerHTML = html;
  $('#back-to-system').addEventListener('click', () => selectSystem(state.selectedSystem));
}

// Tendance de prix : comparaison avec le prix d'il y a ~5 ticks
// (l'historique vient de /api/market).
function computeTrends(market) {
  const trends = {};
  for (const [rid, points] of Object.entries(market.history)) {
    if (points.length < 2) continue;
    const current = points[points.length - 1].price;
    const past = points[Math.max(0, points.length - 6)].price;
    const delta = (current - past) / (past || 1);
    trends[rid] = delta > 0.005 ? 'up' : delta < -0.005 ? 'down' : 'flat';
  }
  return trends;
}

function resourceName(planet, resourceId) {
  return planet.resources.find((r) => r.resource_id === resourceId)?.name ?? resourceId;
}

function formatPop(popM) {
  return popM >= 1000
    ? `${fmtNum.format(popM / 1000)} Md hab.`
    : `${fmtNum.format(popM)} M hab.`;
}

// ── Header + polling ─────────────────────────────────────────────

function renderHud(s) {
  $('#hud-tick').textContent = s.tick;
  $('#hud-seed').textContent = s.seed;
  $('#hud-counts').textContent = `${s.systems} systèmes · ${s.planets} planètes`;
}

async function poll() {
  try {
    const s = await api('/state');
    const tickChanged = s.tick !== state.tick;
    state.tick = s.tick;
    renderHud(s);
    if (tickChanged && state.selectedPlanet !== null) await refreshPlanetPanel();
  } catch {
    // serveur indisponible : on retentera au prochain poll
  }
}

async function init() {
  const [universe, s] = await Promise.all([api('/universe'), api('/state')]);
  state.universe = universe;
  state.tick = s.tick;
  state.tickMs = s.tickMs;
  renderHud(s);
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  setInterval(poll, state.tickMs);
}

init();
