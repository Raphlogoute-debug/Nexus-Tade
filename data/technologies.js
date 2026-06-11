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
  deep_mining_2: {
    name: 'Foreuses quantiques',
    cost: 60000,
    requires: 'deep_mining',
    desc: 'Extraction des concessions ×2,5',
  },
  auto_warehouse: {
    name: 'Entrepôts automatisés',
    cost: 8000,
    requires: null,
    desc: "Capacité d'entrepôt des concessions ×2",
  },
  orbital_storage: {
    name: 'Stockage orbital',
    cost: 40000,
    requires: 'auto_warehouse',
    desc: "Capacité d'entrepôt des concessions ×4",
  },
  prospection: {
    name: 'Prospection planétaire',
    cost: 20000,
    requires: null,
    desc: 'Permet d’acheter des concessions sur d’autres mondes (5 max)',
  },
  prospection_2: {
    name: 'Prospection profonde',
    cost: 45000,
    requires: 'prospection',
    desc: 'Jusqu’à 10 concessions',
  },
  industrial_charter: {
    name: 'Charte industrielle',
    cost: 70000,
    requires: 'prospection',
    desc: 'Fonder de nouvelles industries planétaires (49 % fondateur, dividendes)',
  },
  workshop_engineering: {
    name: 'Ingénierie d’ateliers',
    cost: 35000,
    requires: 'smelting',
    desc: 'Cadence des ateliers ×2',
  },
  workshop_automation: {
    name: 'Ateliers automatisés',
    cost: 80000,
    requires: 'workshop_engineering',
    desc: 'Cadence des ateliers ×4',
  },
  efficient_drives: {
    name: 'Moteurs économes',
    cost: 25000,
    requires: null,
    desc: 'Consommation de carburant −30 % sur les trajets',
  },
  expanded_holds: {
    name: 'Soutes modulaires',
    cost: 40000,
    requires: null,
    desc: 'Soutes +25 % (flotte actuelle et constructions futures)',
  },
  trade_network: {
    name: 'Réseau de courtage',
    cost: 35000,
    requires: null,
    desc: 'Rumeurs de quai +50 % de portée, relevés de marché à moitié prix',
  },

  // ── Filières de transformation (recettes d'atelier) ────────────
  smelting: {
    name: 'Métallurgie',
    cost: 12000,
    requires: null,
    unlocks: ['steel', 'alloys', 'hull_plates', 'steel_titanium'],
  },
  chemistry: {
    name: 'Chimie industrielle',
    cost: 15000,
    requires: null,
    unlocks: ['fuel', 'polymers', 'ceramics', 'fertilizer', 'nuclear_fuel', 'fuel_deuterium'],
  },
  biotech: {
    name: 'Biosynthèse',
    cost: 15000,
    requires: null,
    unlocks: ['synth_food', 'meds', 'synth_food_biomass', 'meds_bio'],
  },
  microelectronics: {
    name: 'Microélectronique',
    cost: 25000,
    requires: 'smelting',
    unlocks: ['electronics', 'sensors', 'electronics_rare'],
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
    unlocks: ['ship_modules', 'luxury_goods', 'gem_cutting'],
  },
  quantum_industry: {
    name: 'Industrie quantique',
    cost: 90000,
    requires: 'precision',
    unlocks: ['antimatter', 'quantum_chips', 'jump_drives', 'fusion_cells'],
  },
};

export const TECH_IDS = Object.keys(TECHNOLOGIES);
