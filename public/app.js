// Client Nexus Trade : carte des systèmes (canvas), panneau d'inspection
// et de commerce, HUD joueur, contrôles du temps. Données via l'API REST,
// rafraîchies par polling.

const $ = (sel) => document.querySelector(sel);
const canvas = $('#map');
const ctx = canvas.getContext('2d');
const tooltip = $('#tooltip');
const panel = $('#panel-content');

const POLL_MS = 1500;

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
  tick: null,
  speed: 1,
  player: null,
  knowledge: new Map(), // systemId → ageTicks
  selectedSystem: null,
  selectedPlanet: null,
  hoverSystem: null,
  view: null,
  tradeSel: null, // ressource sélectionnée dans le marché local
};

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

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

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

// Opacité selon la fraîcheur de la connaissance du système :
// inconnu = presque éteint, connu mais périmé = grisé, frais = plein.
function knowledgeAlpha(systemId) {
  const age = state.knowledge.get(systemId);
  if (age === undefined) return 0.3;
  if (age > 60) return 0.55;
  if (age > 15) return 0.75;
  return 1;
}

function shipMapPosition() {
  const ship = state.player?.ship;
  if (!ship) return null;
  if (ship.planet_id !== null) {
    const entry = state.planetIndex.get(ship.planet_id);
    return { x: entry.system.x, y: entry.system.y, docked: true };
  }
  const from = state.universe.systems.find((s) => s.id === ship.origin_system_id);
  const to = state.universe.systems.find((s) => s.id === ship.dest_system_id);
  const t = Math.min(1, Math.max(0,
    (state.tick - ship.departure_tick) / (ship.arrival_tick - ship.departure_tick)));
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    docked: false, from, to,
  };
}

function drawMap() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);

  for (const sys of state.universe.systems) {
    const [sx, sy] = toScreen(sys.x, sys.y);
    const r = starRadius(sys);
    const isSelected = state.selectedSystem?.id === sys.id;
    const isHover = state.hoverSystem?.id === sys.id;

    ctx.globalAlpha = isHover || isSelected ? 1 : knowledgeAlpha(sys.id);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = STAR_COLORS[sys.id % STAR_COLORS.length];
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = isHover || isSelected ? 14 : 6;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    if (isSelected) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#53c7f0';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  // Vaisseau du joueur : triangle cyan (+ ligne de route en transit).
  const pos = shipMapPosition();
  if (pos) {
    if (!pos.docked) {
      const [x1, y1] = toScreen(pos.from.x, pos.from.y);
      const [x2, y2] = toScreen(pos.to.x, pos.to.y);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = 'rgba(83, 199, 240, 0.35)';
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const [sx, sy] = toScreen(pos.x, pos.y);
    const off = pos.docked ? 9 : 0;
    ctx.beginPath();
    ctx.moveTo(sx + off, sy - 5);
    ctx.lineTo(sx + off + 5, sy + 4);
    ctx.lineTo(sx + off - 5, sy + 4);
    ctx.closePath();
    ctx.fillStyle = '#53c7f0';
    ctx.fill();
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

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sys = systemAt(e.clientX - rect.left, e.clientY - rect.top);
  if (sys !== state.hoverSystem) {
    state.hoverSystem = sys;
    drawMap();
  }
  canvas.style.cursor = sys ? 'pointer' : 'crosshair';
  if (sys) {
    const age = state.knowledge.get(sys.id);
    const info = age === undefined ? 'marchés inconnus'
      : age === 0 ? 'données fraîches' : `données : il y a ${age} ticks`;
    tooltip.hidden = false;
    tooltip.textContent = `${sys.name} — ${sys.planets.length} planètes — ${info}`;
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

async function renderSystemPanel(sys) {
  const age = state.knowledge.get(sys.id);
  panel.innerHTML = `
    <h2 class="panel-title">${sys.name}</h2>
    <p class="panel-sub">Système — position (${Math.round(sys.x)}, ${Math.round(sys.y)})
      — ${age === undefined ? 'marchés inconnus' : `données : il y a ${age} ticks`}</p>
    <div class="section-label">Planètes (${sys.planets.length})</div>
    <div id="system-planets"></div>
    <div id="system-actions"></div>
  `;
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
  if (state.player?.ship?.planet_id !== null) {
    const preview = await api(`/intel/preview?systemId=${sys.id}`);
    if (preview.ok && state.selectedSystem === sys && !state.selectedPlanet) {
      const btn = document.createElement('button');
      btn.className = 'action-btn';
      btn.textContent = `Acheter un relevé de marché (${fmtInt.format(preview.cost)} cr)`;
      btn.addEventListener('click', async () => {
        const r = await apiPost('/intel', { systemId: sys.id });
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

function panelHeader(planet, extra = '') {
  return `
    <button class="back-link" id="back-to-system">← ${planet.system_name}</button>
    <h2 class="panel-title">${planet.name} ${tierBadge(planet.tier)} ${extra}</h2>
    <p class="panel-sub">
      <span class="biome-dot" style="display:inline-block;background:${BIOME_COLORS[planet.biome]}"></span>
      ${planet.biomeLabel} — ${formatPop(planet.population)}
    </p>
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
  const trends = computeTrends(market);
  const cargoByRes = new Map(state.player.ship.cargo.map((c) => [c.resource_id, c]));

  let html = panelHeader(planet, '<span class="badge live">À QUAI</span>');
  html += licenceBlock(planet);

  // Concession (si c'est ici qu'elle se trouve)
  const c = state.player.concession;
  if (c && c.planet_id === planet.id) {
    const pct = Math.round((c.stockpile / c.cap) * 100);
    html += `
      <div class="section-label">Concession — ${c.resourceName} (niv. ${c.level})</div>
      <div class="info-block">
        <div class="row"><span>Extraction</span><span>+${fmtNum.format(c.rate)}/tick</span></div>
        <div class="row"><span>Entrepôt</span><span>${fmtQty(c.stockpile)} / ${fmtQty(c.cap)} (${pct} %)</span></div>
        <div class="gauge"><div style="width:${pct}%"></div></div>
        <button class="action-btn" id="btn-collect">Charger la soute</button>
        ${c.nextLevelCost !== null
          ? `<button class="action-btn" id="btn-upgrade">Améliorer (${fmtInt.format(c.nextLevelCost)} cr)</button>`
          : '<span class="badge">niveau max</span>'}
      </div>
    `;
  }

  html += `<div class="section-label">Industries</div>`;
  if (planet.industries.length === 0) html += `<div class="industry io">Aucune industrie locale</div>`;
  for (const ind of planet.industries) {
    const inputs = Object.entries(ind.inputs)
      .map(([rid, qty]) => `${qty} ${market.prices.find((r) => r.resource_id === rid)?.name ?? rid}`)
      .join(' + ');
    html += `<div class="industry">${ind.name}
      <span class="io">— ${inputs} → ${ind.output} (×${fmtNum.format(ind.rate)}/tick)</span></div>`;
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

  // Formulaire d'ordre (apparaît quand une ressource est sélectionnée)
  html += `
    <div id="trade-form" ${state.tradeSel ? '' : 'hidden'}>
      <div class="selected-res" id="trade-res-name"></div>
      <div style="margin:6px 0">
        <input type="number" id="trade-qty" min="1" step="1" value="10">
        <button class="action-btn buy" id="btn-buy">Acheter</button>
        <button class="action-btn sell" id="btn-sell">Vendre</button>
        <button class="action-btn" id="btn-refuel" title="Remplir le réservoir au prix du marché local">Plein</button>
      </div>
      <div id="trade-preview"></div>
    </div>
  `;

  panel.innerHTML = html;
  bindBackLink();
  bindLicenceButton();

  $('#btn-collect')?.addEventListener('click', async () => {
    const r = await apiPost('/concession/collect');
    if (r.ok) log(`${fmtQty(r.moved)} ${c.resourceName} chargés en soute`);
    else log(`Chargement impossible : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanel();
  });

  $('#btn-upgrade')?.addEventListener('click', async () => {
    const r = await apiPost('/concession/upgrade');
    if (r.ok) log(`Concession niveau ${r.level} — extraction ${fmtNum.format(r.rate)}/tick (−${fmtInt.format(r.cost)} cr)`);
    else log(`Amélioration impossible : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanel();
  });

  $('#btn-refuel').addEventListener('click', async () => {
    const r = await apiPost('/refuel');
    if (r.ok) log(`Plein : +${fmtInt.format(r.quantity)} carburant à ${fmtPrice.format(r.unitPrice)} (−${fmtPrice.format(r.total)} cr)`);
    else log(`Ravitaillement impossible : ${r.error}`);
    await refreshPlayerAndKnowledge();
    refreshPlanetPanel();
  });

  for (const row of panel.querySelectorAll('.res-row')) {
    row.addEventListener('click', () => {
      state.tradeSel = row.dataset.res;
      refreshPlanetPanelForce();
    });
  }

  if (state.tradeSel) {
    const res = market.prices.find((r) => r.resource_id === state.tradeSel);
    $('#trade-res-name').textContent =
      `${res.name} — marché : ${fmtPrice.format(res.price)} cr · stock ${fmtQty(res.stock)}`;
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
    const [buy, sell] = await Promise.all([
      api(`/trade/preview?side=buy&resource=${state.tradeSel}&qty=${qty}`),
      api(`/trade/preview?side=sell&resource=${state.tradeSel}&qty=${qty}`),
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
  const r = await apiPost('/trade', { side, resourceId: state.tradeSel, quantity });
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

  // Bouton voyage (préparé en asynchrone).
  const preview = await api(`/travel/preview?planetId=${planet.id}`);
  const slot = $('#travel-slot');
  if (!slot || state.selectedPlanet !== planet.id) return;
  if (preview.ok) {
    slot.innerHTML = `
      <button class="action-btn" id="btn-travel">
        Voyager — ${preview.ticks} tick${preview.ticks > 1 ? 's' : ''} ·
        ${preview.fuelCost > 0 ? `${fmtInt.format(preview.fuelCost)} carburant` : 'saut local'}
      </button>
    `;
    $('#btn-travel').addEventListener('click', async () => {
      const r = await apiPost('/travel', { planetId: planet.id });
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
  if (!p) return;
  $('#hud-credits').textContent = `${fmtQty(p.credits)} cr`;
  const nextTier = !p.tiers[2].unlocked ? 2 : !p.tiers[3].unlocked ? 3 : null;
  $('#hud-prestige').textContent = fmtQty(p.prestige)
    + (nextTier ? ` / ${fmtQty(p.tiers[nextTier].prestigeRequired)} (T${nextTier})` : ' (T3 ✓)');
  $('#hud-cargo').textContent = `${fmtQty(p.ship.cargoUsed)} / ${fmtQty(p.ship.cargo_capacity)}`;
  $('#hud-fuel').textContent = `${fmtQty(p.ship.fuel)} / ${fmtQty(p.ship.fuel_capacity)}`;

  const loc = $('#hud-location');
  if (p.ship.planet_id !== null) {
    const entry = state.planetIndex.get(p.ship.planet_id);
    loc.textContent = `À quai : ${entry.planet.name}`;
    $('#btn-skip').hidden = true;
  } else {
    const dest = state.planetIndex.get(p.ship.dest_planet_id);
    loc.textContent = `En transit vers ${dest.planet.name} (arrivée t${p.ship.arrival_tick})`;
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
  const r = await apiPost('/time/skip');
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
  const wasInTransit = state.player?.ship?.planet_id === null;
  state.player = player;
  state.knowledge = new Map(knowledge.map((k) => [k.systemId, k.ageTicks]));

  if (wasInTransit && player.ship.planet_id !== null) {
    const entry = state.planetIndex.get(player.ship.planet_id);
    log(`Arrivé à ${entry.planet.name}`);
    selectSystem(entry.system);
    selectPlanet(entry.planet.id);
  }
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

async function poll() {
  try {
    const s = await api('/state');
    const tickChanged = s.tick !== state.tick;
    state.tick = s.tick;
    state.speed = s.speed;
    renderHudState(s);
    if (tickChanged) {
      await refreshPlayerAndKnowledge();
      renderHudPlayer();
      drawMap();
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

  for (const sys of universe.systems) {
    for (const p of sys.planets) state.planetIndex.set(p.id, { planet: p, system: sys });
  }

  renderHudState(s);
  await refreshPlayerAndKnowledge();
  renderHudPlayer();
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // On ouvre la partie là où est le vaisseau.
  const shipPlanet = state.player.ship.planet_id;
  if (shipPlanet !== null) {
    const entry = state.planetIndex.get(shipPlanet);
    selectSystem(entry.system);
    await selectPlanet(entry.planet.id);
  }

  log('Bienvenue à bord. Votre concession produit — chargez, voyagez, vendez plus cher.');
  setInterval(poll, POLL_MS);
}

init();
