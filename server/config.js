// Réglages centralisés de la simulation. Tout ce qui se « tune » est ici ;
// ce qui définit le contenu du jeu (ressources, recettes, biomes) est dans data/.

export const CONFIG = {
  // Intervalle du tick serveur (ms). Surchargé par la variable d'env TICK_MS.
  TICK_MS: Number(process.env.TICK_MS) || 5000,

  // Port HTTP. Surchargé par PORT.
  PORT: Number(process.env.PORT) || 3000,

  // Chemin du fichier SQLite. Surchargé par NEXUS_DB_PATH.
  DB_PATH: process.env.NEXUS_DB_PATH || 'nexus-trade.db',

  // Nombre de ticks d'historique de prix conservés par planète/ressource.
  HISTORY_TICKS: 120,

  UNIVERSE: {
    MIN_SYSTEMS: 60,
    MAX_SYSTEMS: 100,
    MIN_PLANETS: 3,
    MAX_PLANETS: 6,
    MAP_SIZE: 2000, // la carte est un carré [0, MAP_SIZE]²
    MIN_SYSTEM_DIST: 70, // distance minimale entre deux systèmes
  },

  ECONOMY: {
    // Consommation par tick et par million d'habitants.
    // C'est la « demande civile » ; la demande industrielle vient des recettes.
    POP_CONSUMPTION_PER_M: {
      water: 0.2,
      synth_food: 0.15,
      consumer_goods: 0.05,
      fuel: 0.02,
      ship_modules: 0.005, // entretien de la flotte civile
    },

    // Production brute par tick = poids du biome × (BASE + COEF × √pop_M).
    // La racine carrée évite que les mondes-ruches écrasent tout.
    EXTRACTION_BASE: 4,
    EXTRACTION_POP_COEF: 2.2,

    // Cadence industrielle (runs de recette par tick) = BASE + COEF × pop_M,
    // modulée par un aléa à la génération.
    INDUSTRY_BASE_RATE: 0.5,
    INDUSTRY_POP_COEF: 0.035,
    MAX_INDUSTRIES_PER_PLANET: 3,
  },

  PRICING: {
    // Stock « confortable » visé : FLOOR + COVER × demande totale par tick.
    // En dessous → pénurie → prix monte ; au-dessus → surplus → prix baisse.
    TARGET_FLOOR: 40,
    TARGET_DEMAND_COVER: 25,

    // Sensibilité du prix à la rareté (exposant). 1 = proportionnel,
    // < 1 = amorti. Voir economy/pricing.js.
    ELASTICITY: 0.6,

    // Bornes du prix en multiples du prix de base.
    MIN_MULT: 0.2,
    MAX_MULT: 5,

    // Lissage : le prix se déplace de X % vers sa cible à chaque tick
    // (évite les sauts brutaux, donne des courbes lisibles).
    SMOOTHING: 0.25,
  },
};
