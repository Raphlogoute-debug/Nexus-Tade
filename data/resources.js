// Définition des ressources du jeu.
// Les ids sont en anglais (stables, utilisés en DB et dans le code),
// les noms affichés sont en français.
//
// basePrice : prix « neutre » en crédits quand offre et demande s'équilibrent.
// Les prix de base reflètent la valeur ajoutée de la chaîne de production :
// brut < intermédiaire < fini.

export const TIERS = {
  raw: 'Brut',
  intermediate: 'Intermédiaire',
  finished: 'Fini',
};

export const RESOURCES = {
  // ── Ressources brutes ──────────────────────────────────────────
  iron_ore: { name: 'Minerai de fer', tier: 'raw', basePrice: 5 },
  copper_ore: { name: 'Minerai de cuivre', tier: 'raw', basePrice: 8 },
  rare_gas: { name: 'Gaz rare', tier: 'raw', basePrice: 12 },
  water: { name: 'Eau', tier: 'raw', basePrice: 4 },
  organics: { name: 'Composés organiques', tier: 'raw', basePrice: 6 },
  energy_crystals: { name: 'Cristaux énergétiques', tier: 'raw', basePrice: 14 },
  silicon: { name: 'Silicium', tier: 'raw', basePrice: 6 },
  precious_metals: { name: 'Métaux précieux', tier: 'raw', basePrice: 26 },
  helium3: { name: 'Hélium-3', tier: 'raw', basePrice: 18 },
  spices: { name: 'Épices stellaires', tier: 'raw', basePrice: 22 },

  // ── Produits intermédiaires ────────────────────────────────────
  steel: { name: 'Acier', tier: 'intermediate', basePrice: 16 },
  alloys: { name: 'Alliages', tier: 'intermediate', basePrice: 24 },
  fuel: { name: 'Carburant', tier: 'intermediate', basePrice: 30 },
  electronics: { name: 'Composants électroniques', tier: 'intermediate', basePrice: 36 },
  synth_food: { name: 'Nourriture synthétique', tier: 'intermediate', basePrice: 15 },
  polymers: { name: 'Polymères', tier: 'intermediate', basePrice: 28 },
  ceramics: { name: 'Céramiques', tier: 'intermediate', basePrice: 22 },
  meds: { name: 'Médicaments', tier: 'intermediate', basePrice: 48 },

  // ── Produits finis ─────────────────────────────────────────────
  mech_parts: { name: 'Composants mécaniques', tier: 'finished', basePrice: 70 },
  ship_modules: { name: 'Modules de vaisseau', tier: 'finished', basePrice: 130 },
  consumer_goods: { name: 'Biens de consommation', tier: 'finished', basePrice: 60 },
  luxury_goods: { name: 'Biens de luxe', tier: 'finished', basePrice: 160 },
  adv_components: { name: 'Composants avancés', tier: 'finished', basePrice: 95 },
};

export const RESOURCE_IDS = Object.keys(RESOURCES);
