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

  PLAYER: {
    START_CREDITS: 2000,

    SHIP: {
      NAME: 'Le Colporteur',
      CARGO: 250,        // capacité de soute (unités)
      FUEL_CAP: 400,     // réservoir
      SPEED: 150,        // unités de carte par tick
      DIST_PER_FUEL: 25, // 1 carburant consommé tous les 25 unités de distance
    },

    // Niveaux de concession (index = niveau - 1). rate = extraction/tick,
    // cap = taille de l'entrepôt, cost = prix du passage À ce niveau.
    CONCESSION_LEVELS: [
      { rate: 25, cap: 1500, cost: 0 },
      { rate: 60, cap: 4000, cost: 8000 },
      { rate: 150, cap: 10000, cost: 30000 },
    ],

    // Prestige : 1 point par tranche de profit réalisé, bonus par nouveau
    // partenaire commercial (première transaction avec une planète).
    PRESTIGE: {
      PROFIT_PER_POINT: 100,
      NEW_PARTNER: 25,
    },

    // Tiers de marché : seuils de population (en M hab.), prestige requis
    // pour y commercer, et prix de la licence (raccourci payant).
    // T1 (en dessous de TIERS[2].minPop) est ouvert à tous.
    TIERS: {
      2: { minPop: 50, prestige: 200, licenceCost: 5000 },
      3: { minPop: 500, prestige: 1000, licenceCost: 25000 },
    },

    // Connaissance des marchés : à quai, les locaux donnent des relevés
    // (prix uniquement) des systèmes voisins, vieux de quelques ticks.
    GOSSIP_RADIUS: 250,
    GOSSIP_MAX_AGE: 15, // ancienneté max des rumeurs (ticks)
    INTEL: { BASE_COST: 50, COST_PER_DIST: 0.1, AGE: 3 },

    // Garde-fou du bouton « avancer jusqu'à l'arrivée ».
    SKIP_MAX_TICKS: 200,
  },
};
