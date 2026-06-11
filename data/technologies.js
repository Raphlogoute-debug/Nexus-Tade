// Arbre technologique du joueur. La recherche coûte des crédits ; chaque
// technologie débloque soit des recettes d'atelier installables sur vos
// concessions (unlocks), soit un effet permanent (décrit, appliqué dans
// player/concession.js et player/tech.js).

export const TECHNOLOGIES = {
  // ── Effets permanents ──────────────────────────────────────────
  deep_mining: {
    name: 'Forage profond',
    cost: 10000,
    requires: null,
    desc: 'Extraction des concessions +50 %',
  },
  auto_warehouse: {
    name: 'Entrepôts automatisés',
    cost: 8000,
    requires: null,
    desc: "Capacité d'entrepôt des concessions ×2",
  },
  prospection: {
    name: 'Prospection planétaire',
    cost: 20000,
    requires: null,
    desc: 'Permet d’acheter des concessions sur d’autres mondes (5 max)',
  },

  // ── Filières de transformation (recettes d'atelier) ────────────
  smelting: {
    name: 'Métallurgie',
    cost: 12000,
    requires: null,
    unlocks: ['steel', 'alloys'],
  },
  chemistry: {
    name: 'Chimie industrielle',
    cost: 15000,
    requires: null,
    unlocks: ['fuel', 'polymers', 'ceramics'],
  },
  biotech: {
    name: 'Biosynthèse',
    cost: 15000,
    requires: null,
    unlocks: ['synth_food', 'meds'],
  },
  microelectronics: {
    name: 'Microélectronique',
    cost: 25000,
    requires: 'smelting',
    unlocks: ['electronics'],
  },
  manufacturing: {
    name: 'Manufacture avancée',
    cost: 45000,
    requires: 'microelectronics',
    unlocks: ['mech_parts', 'consumer_goods', 'adv_components'],
  },
  precision: {
    name: 'Industrie de précision',
    cost: 60000,
    requires: 'manufacturing',
    unlocks: ['ship_modules', 'luxury_goods'],
  },
  quantum_industry: {
    name: 'Industrie quantique',
    cost: 90000,
    requires: 'precision',
    unlocks: ['antimatter', 'quantum_chips', 'jump_drives'],
  },
};

export const TECH_IDS = Object.keys(TECHNOLOGIES);
