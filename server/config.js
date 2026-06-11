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

  // ── Phase 3 : factions, flux, PNJ ────────────────────────────

  FACTIONS: {
    MIN_COUNT: 6,
    MAX_COUNT: 9,
    // Un système rejoint la capitale la plus proche si elle est à moins de
    // ce rayon ; au-delà, il reste indépendant (la Frange).
    TERRITORY_RADIUS: 650,
    MIN_CAPITAL_SPACING: 380, // distance min entre deux capitales
    COLORS: ['#e05d5d', '#5d9de0', '#5dc78f', '#d8a23f', '#a06de0',
      '#e07db8', '#56c4c4', '#9aab4a'],
    START_FLEET_BASE: 15,
    START_FLEET_PER_SYSTEM: 2,
  },

  // Besoins des populations : satisfaction, démographie, élasticité.
  NEEDS: {
    VITAL: ['water', 'synth_food'], // les besoins qui font vivre ou mourir
    SUPPLY_EMA: 0.08,               // lissage de l'indice d'approvisionnement
    POP_DRIFT: 0.0008,              // ±0,08 %/tick max selon la satisfaction
    RECALC_EVERY: 20,               // ticks entre recalculs de la conso (pop a bougé)
    // Élasticité de la demande civile : quand c'est hors de prix on se
    // rationne, quand c'est bradé on consomme un peu plus.
    COMPRESSION_ELASTICITY: 0.35,
    COMPRESSION_MIN: 0.6,
    COMPRESSION_MAX: 1.1,
  },

  // Logistique interne des factions : des convois (flux statistiques,
  // pas des vaisseaux simulés un à un) équilibrent les membres.
  FLOWS: {
    EVERY_TICKS: 2,        // fréquence de planification
    SPEED: 120,            // unités de carte par tick
    MAX_PER_PLANNING: 3,   // nouveaux convois max par faction et par planif
    DEFICIT_PRESSURE: 0.25,  // (cible-stock)/cible au-dessus → demandeur
    SURPLUS_PRESSURE: -0.25, // en dessous → fournisseur
    SHARE: 0.25,           // part du surplus embarquée par convoi
    MAX_QTY: 250,
  },

  // Programme naval des factions : le chantier de la capitale consomme de
  // vraies ressources du marché local — couper l'approvisionnement
  // paralyse la construction (loi du minimum, comme les industries).
  FLEET: {
    BUILD: { ship_modules: 2, mech_parts: 2, fuel: 3 }, // conso max/tick
    SHIP_COST: 25,          // ticks de chantier à plein régime par vaisseau
    UPKEEP_PER_SHIP: { fuel: 0.04, mech_parts: 0.008 },
    READINESS_EMA: 0.05,    // la disponibilité suit l'entretien réellement payé
  },

  // Marchands indépendants (agents pleins) : ils font le même métier que
  // le joueur, sur les mêmes marchés, avec les mêmes règles d'impact prix.
  TRADERS: {
    PER_SYSTEMS: 2,         // ~1 marchand pour 2 systèmes
    CAPACITY: 150,
    SPEED: 130,
    SCAN_RADIUS: 450,       // ils connaissent leur région, pas la galaxie
    MIN_MARGIN: 0.3,        // marge relative minimale pour se déplacer
    MOVE_COST_PER_DIST: 0.05, // carburant forfaitaire (crédits par unité)
    START_CREDITS: 3000,
    MAX_BUY_SHARE: 0.25,    // part max du stock local par achat
  },

  // Contrats de faction (tier 4) : traiter avec le royaume lui-même.
  CONTRACTS: {
    EVERY_TICKS: 25,
    EXPIRY: 90,
    PREMIUM: 1.35,          // prix payé vs prix du marché à l'émission
    MAX_OPEN_PER_FACTION: 2,
    PRESTIGE_REQUIRED: 1500,
    PARTNERS_REQUIRED: 2,   // partenaires commerciaux dans la faction
    COMPLETION_PRESTIGE: 60,
    // En guerre, le royaume achète plus, plus cher, plus souvent.
    WAR_PRESSURE: 0.2,      // seuil de pénurie déclencheur (0.4 en paix)
    WAR_PREMIUM: 1.6,
    WAR_MAX_OPEN: 4,
  },

  // ── Phase 4 : guerres ────────────────────────────────────────

  DIPLOMACY: {
    EVERY_TICKS: 5,
    START_RELATION: [-30, 40],  // relation initiale entre deux factions
    DRIFT: 1.6,                 // dérive aléatoire par cycle diplomatique
    NEIGHBOR_BIAS: -0.5,        // les voisins se frottent (dérive négative)
    NEIGHBOR_RADIUS: 800,       // capitales plus proches que ça = rivales
    WAR_THRESHOLD: -60,         // relation en dessous → déclaration de guerre
    PEACE_RELATION: -15,        // relation après un traité de paix
    MIN_FLEET_FOR_WAR: 20,
  },

  WAR: {
    ATTRITION: 0.004,    // pertes par tick ∝ force effective ennemie
    FRONT_RADIUS: 340,   // distance max entre systèmes pour former un front
    MAX_FRONTS: 5,
    FRONT_RATE: 0.04,    // vitesse de bascule d'un front selon le rapport de force
    RAID_CHANCE: 0.4,    // convois touchant un système de front : interceptés
    BUILD_MULT: 2,       // effort de guerre : le chantier tourne plus fort
    UPKEEP_MULT: 1.6,    // une flotte mobilisée coûte plus cher
    MIN_DURATION: 40,    // pas de paix avant (ticks)
    MAX_DURATION: 220,   // épuisement : paix blanche au-delà
    EXHAUSTION: 0.35,    // flotte sous 35 % de l'initiale → capitulation
  },

  // Réputation du joueur PAR FACTION : vendre du matériel stratégique à un
  // belligérant se sait — et son ennemi s'en souvient.
  STANDING: {
    STRATEGIC_PER_UNIT: 0.05, // réputation gagnée par unité stratégique vendue (en guerre)
    ENEMY_LEAK: 0.6,          // fraction que l'ennemi apprend (et vous reproche)
    CONTRACT_BONUS: 8,        // bonus de réputation par contrat honoré
    CONTRACT_MIN: -10,        // réputation min pour accéder aux contrats
    SEIZURE: -20,             // en dessous, cargaison stratégique saisie aux fronts
    BLACKLIST: -50,           // en dessous, les marchés de la faction vous refusent
  },
};
