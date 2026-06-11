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

function shipMapPosition(ship) {
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

  // Territoires : halo aux couleurs de la faction derrière chaque système.
  for (const sys of state.universe.systems) {
    if (sys.faction_id === null) continue;
    const faction = state.factionById.get(sys.faction_id);
    const [sx, sy] = toScreen(sys.x, sys.y);
    ctx.beginPath();
    ctx.arc(sx, sy, 15, 0, Math.PI * 2);
    ctx.fillStyle = faction.color + '1d'; // alpha en hexa
    ctx.fill();
  }

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

    // Capitale de faction : un losange aux couleurs du royaume.
    const capital = state.capitalSystems.get(sys.id);
    if (capital) {
      ctx.beginPath();
      ctx.moveTo(sx, sy - r - 7);
      ctx.lineTo(sx + r + 7, sy);
      ctx.lineTo(sx, sy + r + 7);
      ctx.lineTo(sx - r - 7, sy);
      ctx.closePath();
      ctx.strokeStyle = capital.color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Système contesté : anneau rouge — le front passe ici.
    if (state.fronts.has(sys.id)) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#f04545';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // La flotte : un triangle cyan par vaisseau (le piloté en plein, les
  // autres en creux), ligne de route pointillée en transit.
  for (const ship of state.player?.ships ?? []) {
    const pos = shipMapPosition(ship);
    if (!pos) continue;
    const isSelected = ship.id === selectedShip()?.id;
    if (!pos.docked) {
      const [x1, y1] = toScreen(pos.from.x, pos.from.y);
      const [x2, y2] = toScreen(pos.to.x, pos.to.y);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = isSelected ? 'rgba(83,199,240,0.4)' : 'rgba(83,199,240,0.18)';
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
    if (isSelected) {
      ctx.fillStyle = '#53c7f0';
      ctx.fill();
    } else {
      ctx.strokeStyle = '#53c7f0';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
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
      <span class="ship-name">${ship.name}</span>
      <span>${ship.classLabel}</span>
      <span>${where}</span>
      <span>${fmtQty(ship.cargoUsed)}/${fmtQty(ship.cargo_capacity)}</span>
      <button class="mode-toggle ${ship.mode === 'auto' ? 'auto' : ''}"
        title="Basculer manuel/automatique">${ship.mode === 'auto' ? 'AUTO' : 'MAN'}</button>
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
        mode: ship.mode === 'auto' ? 'manual' : 'auto',
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
    const front = state.fronts.has(sys.id) ? ' — ⚔ FRONT' : '';
    tooltip.hidden = false;
    tooltip.textContent = `${sys.name} — ${sys.planets.length} planètes — ${info}${front}`;
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
    html += `
      <div class="section-label">⚔ En guerre</div>
      <div class="info-block" style="border-color:#f04545">
        <div class="row"><span>Contre</span><span>${f.war.enemy}</span></div>
        <div class="row"><span>Depuis</span><span>tick ${f.war.since}</span></div>
        ${f.war.fronts.map((fr) => `<div class="row"><span>Front : ${fr.name}</span>
          <span>${fr.pressure > 0 ? '◀ attaque' : fr.pressure < 0 ? 'défense ▶' : 'stable'}</span></div>`).join('')}
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
  $('#hud-credits').textContent = `${fmtQty(p.credits)} cr`
    + (p.fleetUpkeep > 0 ? ` (−${fmtNum.format(p.fleetUpkeep)}/tick)` : '');
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
  }
}

async function poll() {
  try {
    const s = await api('/state');
    const tickChanged = s.tick !== state.tick;
    state.tick = s.tick;
    state.speed = s.speed;
    state.wars = s.wars;
    state.fronts = new Set(s.wars.flatMap((w) => w.fronts));
    renderHudState(s);
    if (tickChanged) {
      await Promise.all([refreshPlayerAndKnowledge(), pollEvents()]);
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
  state.wars = s.wars ?? [];
  state.fronts = new Set(state.wars.flatMap((w) => w.fronts));

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
  window.addEventListener('resize', resizeCanvas);

  // On ouvre la partie là où est le vaisseau.
  const shipPlanet = selectedShip()?.planet_id;
  if (shipPlanet != null) {
    const entry = state.planetIndex.get(shipPlanet);
    selectSystem(entry.system);
    await selectPlanet(entry.planet.id);
  }

  log('Bienvenue à bord. Votre concession produit — chargez, voyagez, vendez plus cher.');
  setInterval(poll, POLL_MS);
}

init();
