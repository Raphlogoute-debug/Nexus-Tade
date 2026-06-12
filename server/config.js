// Réglages centralisés de la simulation. Tout ce qui se « tune » est ici ;
// ce qui définit le contenu du jeu (ressources, recettes, biomes) est dans data/.

export const CONFIG = {
  // Intervalle du tick serveur (ms). Surchargé par la variable d'env TICK_MS.
  TICK_MS: Number(process.env.TICK_MS) || 5000,

  // Port HTTP. Surchargé par PORT.
  PORT: Number(process.env.PORT) || 3000,

  // Chemin du fichier SQLite. Surchargé par NEXUS_DB_PATH.
  DB_PATH: process.env.NEXUS_DB_PATH || 'nexus-trade.db',

  // Historique de prix : profondeur conservée (ticks) et cadence
  // d'échantillonnage (1 point tous les N ticks — avec le lissage des
  // prix, un point sur deux suffit aux graphes et divise les écritures).
  HISTORY_TICKS: 120,
  HISTORY_EVERY: 2,

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
      meds: 0.03,
      luxury_goods: 0.012,
      adv_components: 0.008, // infrastructures
      antimatter: 0.004,     // réacteurs des grands mondes
      jump_drives: 0.002,    // flottes civiles haut de gamme
      fertilizer: 0.05,      // agriculture planétaire
      nuclear_fuel: 0.008,   // centrales
      fusion_cells: 0.006,
      hull_plates: 0.01,     // chantiers civils
      sensors: 0.004,
      gemstones: 0.006,      // luxe brut, consommé tel quel
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

    // Parts d'industries planétaires (Phase 8) : investir dans les
    // industries des autres mondes et toucher des dividendes sur leur
    // production RÉELLE (une industrie étranglée par les pénuries ne
    // rapporte rien — le risque est dans le prix).
    INVEST: {
      DIVIDEND_MARGIN: 0.2, // part du chiffre d'affaires versée en dividendes
      PAYBACK_TICKS: 450,   // valorisation : amortissement à plein régime
      MAX_SHARE: 0.49,      // la planète garde le contrôle
      RESALE: 0.9,          // décote à la revente
    },

    // Industrie joueur (Phase 6) : ateliers de transformation sur site.
    FACILITIES: {
      WORKSHOP_RATE: 4,        // runs de recette par tick et par atelier
      WORKSHOP_COST: { intermediate: 6000, finished: 15000 },
      WORKSHOP_COST_OVERRIDE: { antimatter: 30000, quantum_chips: 30000, jump_drives: 50000 },
      CONCESSION_BASE_PRICE: 25000, // 2e concession ; double à chaque suivante
      MAX_CONCESSIONS: 5,
      MAX_CONCESSIONS_2: 10,   // tech Prospection profonde
      DEEP_MINING_MULT: 1.5,   // tech Forage profond
      DEEP_MINING_2_MULT: 2.5, // tech Foreuses quantiques
      WAREHOUSE_TECH_MULT: 2,  // tech Entrepôts automatisés
      WAREHOUSE_TECH_2_MULT: 4, // tech Stockage orbital
      WORKSHOP_ENG_MULT: 2,    // tech Ingénierie d'ateliers
      WORKSHOP_AUTO_MULT: 4,   // tech Ateliers automatisés
      FOUND_MULT: 1.2,         // fonder une industrie coûte sa valorisation ×1.2
      HOLDS_MULT: 1.25,        // tech Soutes modulaires
      FUEL_SAVING_MULT: 0.7,   // tech Moteurs économes
      NETWORK_RADIUS_MULT: 1.5, // tech Réseau de courtage (rumeurs)
      NETWORK_INTEL_MULT: 0.5, // tech Réseau de courtage (relevés)
    },

    // Comptoirs commerciaux (Phase 10) : une présence marchande permanente
    // sur n'importe quelle planète accessible. Le comptoir stocke,
    // télégraphie son marché (connaissance toujours fraîche) et exécute
    // des ORDRES PERMANENTS chaque tick — acheter sous une limite, vendre
    // au-dessus d'un plancher — via les mêmes primitives de marché que
    // tout le monde : c'est l'outil d'influence des prix (accaparer un
    // stock, inonder un marché, encaisser l'écart sans bouger un vaisseau).
    POSTS: {
      BASE_PRICE: 40000, // 1er comptoir ; double à chaque suivant
      MAX_POSTS: 4,
      MAX_POSTS_NETWORK: 8, // avec la tech Réseau de courtage
      // cap = entrepôt, flow = unités max échangées par tick et par ordre.
      LEVELS: [
        { cap: 3000, flow: 40, cost: 0 },
        { cap: 8000, flow: 100, cost: 35000 },
        { cap: 20000, flow: 250, cost: 120000 },
      ],
      MAX_ORDERS: 6, // ordres permanents par comptoir
    },

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

    // Maison de commerce (Phase 11) : votre identité. Le rang de renom
    // découle du prestige (purement cosmétique, mais c'est le fil rouge).
    HOUSE: {
      DEFAULT_NAMES: ['Comptoir Vasari', 'Guilde Orhane', 'Maison Téra',
        'Consortium Lyre', 'Compagnie Solenne', 'Frères Aldenn'],
      CREST_COLORS: ['#53c7f0', '#e8b35a', '#5fd68b', '#c77dff', '#f07861', '#56c4c4'],
      RENOWN: [
        { at: 0, title: 'Colporteur' },
        { at: 200, title: 'Négociant' },
        { at: 1000, title: 'Marchand établi' },
        { at: 3000, title: 'Armateur notable' },
        { at: 8000, title: 'Prince marchand' },
        { at: 20000, title: 'Magnat du Nexus' },
      ],
    },

    // Quartier général (Phase 11) : le siège de votre maison. Construit
    // une fois, amélioré ensuite ; chaque niveau allège l'entretien de la
    // flotte, élargit le plafond technique de vaisseaux et remise les
    // relevés de marché. Marqueur sur la carte aux couleurs du blason.
    HQ: {
      BUILD_COST: 60000,
      LEVELS: [
        { upkeepReduction: 0.15, maxFleetBonus: 3, intelDiscount: 0.2 },
        { upkeepReduction: 0.30, maxFleetBonus: 6, intelDiscount: 0.4 },
        { upkeepReduction: 0.50, maxFleetBonus: 10, intelDiscount: 0.6 },
      ],
      UPGRADE_COST: [120000, 350000], // pour passer au niveau 2 puis 3
    },
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
  // Maisons de commerce rivales (Phase 11) : des concurrents nommés, qui
  // jouent au même jeu que vous — arbitrer sur les vrais marchés (impact
  // prix partagé) et accaparer des ressources. Vous les affrontez au
  // classement par valeur nette. Modélisation légère : flux statistiques
  // datés d'identité, pas des flottes pleines.
  RIVALS: {
    COUNT: 4,
    START_CREDITS: 80000,
    NAMES: ['Maison Karkadann', 'Consortium Vol', 'Guilde des Sept Vents',
      'Compagnie Sidérale', 'Comptoir Ravn', 'Cartel Mensh', 'Banque Oltari'],
    COLORS: ['#d98c5f', '#7d9ee0', '#5fb0a0', '#c77dff', '#d8a23f', '#56c4c4', '#b85d8e'],
    ACT_EVERY: 3,            // chaque rival délibère un tick sur ACT_EVERY
    SCAN_PLANETS: 14,        // planètes échantillonnées par délibération
    MARGIN: 0.18,            // marge relative minimale pour un coup
    DEAL_CAPACITY: 220,      // volume max par opération d'arbitrage
    CORNER_CHANCE: 0.04,     // proba de lancer un accaparement (quand riche)
    CORNER_TICKS: 14,        // durée d'un accaparement avant écoulement
    CORNER_FLOW: 60,         // unités drainées par tick pendant l'accaparement
    CORNER_MIN_CREDITS: 120000, // il faut les reins solides pour accaparer
    HISTORY_EVERY: 10,       // échantillonnage de la valeur nette (ticks)
    HISTORY_KEEP: 120,       // points conservés par sujet
  },

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

  // ── Phase 5 : la flotte du joueur ────────────────────────────

  SHIPS: {
    // upkeep : crédits par tick (équipage, maintenance). C'est l'entretien
    // qui limite la taille de la flotte, pas un plafond arbitraire — en
    // découvert, les équipages refusent de repartir.
    CLASSES: {
      courier: { label: 'Navette', cargo: 100, speed: 220, fuel: 300, price: 8000, upkeep: 2 },
      freighter: { label: 'Cargo', cargo: 250, speed: 150, fuel: 400, price: 20000, upkeep: 4 },
      hauler: { label: 'Vraquier', cargo: 700, speed: 100, fuel: 600, price: 60000, upkeep: 10 },
    },
    BUY_MIN_TIER: 2, // les chantiers civils sont sur les mondes établis
    MAX_FLEET: 100,  // garde-fou purement technique
    NAMES: ['Le Colporteur', 'La Fortune', 'Le Tenace', "L'Opportun", 'Le Frugal',
      'La Comète', "L'Habile", 'Le Discret'],
  },

  // Vaisseaux en mode automatique : même logique gloutonne que les
  // marchands PNJ, mais les profits (et le prestige) sont à vous.
  AUTOMATION: {
    SCAN_RADIUS: 450,
    MIN_MARGIN: 0.25,
    MAX_BUY_SHARE: 0.25,
    REFUEL_BELOW: 0.35, // plein automatique sous 35 % du réservoir
    WANDER_P: 0.25,     // probabilité d'aller voir ailleurs si rien à faire
  },

  // Contrebande : un pavillon de complaisance acheté dans la Frange rend
  // un vaisseau anonyme — les listes noires s'ouvrent, les douanes des
  // fronts le laissent passer, et les ventes de guerre n'engagent plus
  // votre nom. Mais chaque opération risquée peut percer la couverture.
  SMUGGLING: {
    FLAG_COST: 8000,
    DETECTION: 0.1,      // probabilité de détection par opération risquée
    STANDING_HIT: 15,    // colère de la faction qui vous démasque
  },

  // Prêts de guerre : financer un camp. L'argent part immédiatement en
  // matériel (stocks de la capitale) — votre prêt renforce VRAIMENT
  // l'emprunteur, ce qui améliore vos chances d'être remboursé.
  LOANS: {
    MIN: 5000,
    VICTORY_MULT: 1.3,   // remboursement si l'emprunteur gagne
    PEACE_MULT: 1.1,     // paix d'épuisement : remboursé sans gloire
    SPEND_RATIO: 0.6,    // part du prêt convertie en matériel de guerre
    STANDING_PER_1000: 1,
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
