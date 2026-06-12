// Les jalons de la carrière marchande — du colporteur au Nexus.
// Chaque objectif est un ensemble de conditions { metric, goal } toutes
// requises ; les métriques sont calculées par server/player/objectives.js.
// reward = prestige versé à l'accomplissement. Le dernier (« nexus »)
// est la victoire : devenir LA puissance commerciale de la galaxie.

export const OBJECTIVES = [
  {
    id: 'first_partners',
    name: 'Routier des étoiles',
    desc: 'Commercer avec 10 planètes différentes',
    reward: 50,
    requires: [{ metric: 'partners', goal: 10 }],
  },
  {
    id: 'nest_egg',
    name: 'Premier magot',
    desc: 'Détenir 100 000 crédits',
    reward: 100,
    requires: [{ metric: 'credits', goal: 100000 }],
  },
  {
    id: 'shipowner',
    name: 'Armateur',
    desc: 'Posséder 4 vaisseaux',
    reward: 150,
    requires: [{ metric: 'fleet', goal: 4 }],
  },
  {
    id: 'industrialist',
    name: 'Industriel',
    desc: '6 unités de production (ateliers + parts d\'industries)',
    reward: 200,
    requires: [{ metric: 'industry', goal: 6 }],
  },
  {
    id: 'notable',
    name: 'Notable des marchés',
    desc: 'Accéder aux marchés de tier 3 (prestige ou licence)',
    reward: 200,
    requires: [{ metric: 'tier3', goal: 1 }],
  },
  {
    id: 'trading_house',
    name: 'Maison de commerce',
    desc: 'Ouvrir 2 comptoirs commerciaux',
    reward: 250,
    requires: [{ metric: 'posts', goal: 2 }],
  },
  {
    id: 'millionaire',
    name: 'Millionnaire',
    desc: 'Détenir 1 000 000 de crédits',
    reward: 300,
    requires: [{ metric: 'credits', goal: 1000000 }],
  },
  {
    id: 'network',
    name: 'Réseau marchand',
    desc: 'Une présence (concession ou comptoir) dans 5 systèmes',
    reward: 300,
    requires: [{ metric: 'presence', goal: 5 }],
  },
  {
    id: 'war_banker',
    name: 'Banquier de guerre',
    desc: 'Encaisser le remboursement d\'un prêt de guerre',
    reward: 400,
    requires: [{ metric: 'loansRepaid', goal: 1 }],
  },
  {
    id: 'visionary',
    name: 'Visionnaire',
    desc: 'Maîtriser 12 technologies',
    reward: 400,
    requires: [{ metric: 'techs', goal: 12 }],
  },
  {
    id: 'million_mover',
    name: 'Premier million',
    desc: 'Vendre 1 000 000 d\'unités (toutes ventes confondues)',
    reward: 500,
    requires: [{ metric: 'unitsSold', goal: 1000000 }],
  },
  {
    id: 'magnate',
    name: 'Magnat',
    desc: 'Détenir 10 000 000 de crédits',
    reward: 500,
    requires: [{ metric: 'credits', goal: 10000000 }],
  },
  {
    id: 'regional_giant',
    name: 'Géant régional',
    desc: 'Présence dans 10 systèmes et 40 partenaires commerciaux',
    reward: 600,
    requires: [
      { metric: 'presence', goal: 10 },
      { metric: 'partners', goal: 40 },
    ],
  },
  {
    id: 'volume_lord',
    name: 'Seigneur des volumes',
    desc: 'Vendre 100 000 000 d\'unités — vos convois irriguent la galaxie',
    reward: 1000,
    requires: [{ metric: 'unitsSold', goal: 100000000 }],
  },
  {
    id: 'nexus',
    name: 'LE NEXUS',
    desc: 'Devenir LA puissance commerciale : 100 M de crédits, '
      + 'tier 3, et une présence dans 8 systèmes',
    reward: 1000,
    victory: true,
    requires: [
      { metric: 'credits', goal: 100000000 },
      { metric: 'tier3', goal: 1 },
      { metric: 'presence', goal: 8 },
    ],
  },
];
