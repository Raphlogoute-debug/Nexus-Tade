// Scénarios de départ : comment commence une nouvelle partie. Chacun
// fixe le capital, la flotte, la présence industrielle de départ, et
// parfois l'état du monde (une guerre déjà allumée). Le reste de
// l'univers est toujours procédural.
//
//   credits      : trésorerie de départ
//   ships        : classes de vaisseaux livrés (au-delà du premier)
//   concession   : true = une concession sur le monde de départ
//   licenceTier  : tier de marché ouvert d'emblée (raccourci)
//   startWar     : true = deux factions entrent en guerre dès le tick 0
//   home         : 'mining' (monde minier T1) ou 'fringe' (Frange, sans
//                  faction) — influence l'environnement de départ

export const SCENARIOS = [
  {
    id: 'colporteur',
    name: 'Le Colporteur',
    desc: 'Le départ classique : une concession, un cargo, 2 000 crédits. '
      + 'Tout est à bâtir.',
    credits: 2000,
    ships: [],
    concession: true,
    licenceTier: 1,
    startWar: false,
    home: 'mining',
    difficulty: 'normale',
  },
  {
    id: 'heritier',
    name: "L'Héritier",
    desc: 'Vous reprenez une maison déjà debout : 60 000 crédits, un second '
      + 'vaisseau, l\'accès aux marchés de tier 2. Le confort, pas la gloire.',
    credits: 60000,
    ships: ['hauler'],
    concession: true,
    licenceTier: 2,
    startWar: false,
    home: 'mining',
    difficulty: 'facile',
  },
  {
    id: 'refugie',
    name: 'Le Réfugié',
    desc: 'Tout perdu. 500 crédits, un caboteur, aucune concession — il '
      + 'faudra prospecter et tout reconquérir. Pour les durs.',
    credits: 500,
    ships: [],
    concession: false,
    licenceTier: 1,
    startWar: false,
    home: 'fringe',
    difficulty: 'difficile',
  },
  {
    id: 'profiteur',
    name: 'Le Profiteur',
    desc: 'La galaxie s\'embrase à votre arrivée : une guerre éclate dès le '
      + 'premier tick. 15 000 crédits, une concession — à vous d\'en vivre.',
    credits: 15000,
    ships: [],
    concession: true,
    licenceTier: 1,
    startWar: true,
    home: 'mining',
    difficulty: 'normale',
  },
];

export const SCENARIO_BY_ID = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
export const DEFAULT_SCENARIO = 'colporteur';
