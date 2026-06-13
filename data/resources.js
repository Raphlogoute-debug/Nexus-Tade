// Définition des ressources du jeu.
// Les ids sont en anglais (stables, utilisés en DB et dans le code),
// les noms affichés sont en français.
//
// basePrice : prix « neutre » en crédits quand offre et demande s'équilibrent.
// Les prix de base reflètent la valeur ajoutée de la chaîne de production :
// brut < intermédiaire < fini.
//
// cat : famille de la ressource (identité visuelle de l'UI — couleur +
// glyphe). metal, mineral, energy, gas, organic, tech, goods.

export const TIERS = {
  raw: 'Brut',
  intermediate: 'Intermédiaire',
  finished: 'Fini',
};

// Familles : couleur et glyphe, partagées par l'UI pour rendre les
// 37 ressources lisibles d'un coup d'œil.
export const CATEGORIES = {
  metal:   { label: 'Métaux',      color: '#8da2bd', glyph: '◼' },
  mineral: { label: 'Minéraux',    color: '#b98ce8', glyph: '◆' },
  energy:  { label: 'Énergie',     color: '#ecb85f', glyph: '✦' },
  gas:     { label: 'Gaz',         color: '#5fc8d6', glyph: '◯' },
  organic: { label: 'Organiques',  color: '#62db90', glyph: '✿' },
  tech:    { label: 'Technologie', color: '#5ccdf5', glyph: '⬡' },
  goods:   { label: 'Biens',       color: '#e88ab5', glyph: '★' },
};

export const RESOURCES = {
  // ── Ressources brutes ──────────────────────────────────────────
  iron_ore: { name: 'Minerai de fer', tier: 'raw', basePrice: 5, cat: 'metal' },
  copper_ore: { name: 'Minerai de cuivre', tier: 'raw', basePrice: 8, cat: 'metal' },
  rare_gas: { name: 'Gaz rare', tier: 'raw', basePrice: 12, cat: 'gas' },
  water: { name: 'Eau', tier: 'raw', basePrice: 4, cat: 'organic' },
  organics: { name: 'Composés organiques', tier: 'raw', basePrice: 6, cat: 'organic' },
  energy_crystals: { name: 'Cristaux énergétiques', tier: 'raw', basePrice: 14, cat: 'energy' },
  silicon: { name: 'Silicium', tier: 'raw', basePrice: 6, cat: 'mineral' },
  precious_metals: { name: 'Métaux précieux', tier: 'raw', basePrice: 26, cat: 'metal' },
  helium3: { name: 'Hélium-3', tier: 'raw', basePrice: 18, cat: 'energy' },
  spices: { name: 'Épices stellaires', tier: 'raw', basePrice: 22, cat: 'organic' },
  titanium_ore: { name: 'Minerai de titane', tier: 'raw', basePrice: 14, cat: 'metal' },
  uranium: { name: 'Uranium', tier: 'raw', basePrice: 30, cat: 'energy' },
  biomass: { name: 'Biomasse', tier: 'raw', basePrice: 3, cat: 'organic' },
  deuterium: { name: 'Deutérium', tier: 'raw', basePrice: 10, cat: 'energy' },
  rare_earths: { name: 'Terres rares', tier: 'raw', basePrice: 22, cat: 'mineral' },
  gemstones: { name: 'Gemmes', tier: 'raw', basePrice: 28, cat: 'mineral' },

  // ── Produits intermédiaires ────────────────────────────────────
  steel: { name: 'Acier', tier: 'intermediate', basePrice: 16, cat: 'metal' },
  alloys: { name: 'Alliages', tier: 'intermediate', basePrice: 24, cat: 'metal' },
  fuel: { name: 'Carburant', tier: 'intermediate', basePrice: 30, cat: 'energy' },
  electronics: { name: 'Composants électroniques', tier: 'intermediate', basePrice: 36, cat: 'tech' },
  synth_food: { name: 'Nourriture synthétique', tier: 'intermediate', basePrice: 15, cat: 'organic' },
  polymers: { name: 'Polymères', tier: 'intermediate', basePrice: 28, cat: 'mineral' },
  ceramics: { name: 'Céramiques', tier: 'intermediate', basePrice: 22, cat: 'mineral' },
  meds: { name: 'Médicaments', tier: 'intermediate', basePrice: 48, cat: 'organic' },
  antimatter: { name: 'Antimatière', tier: 'intermediate', basePrice: 130, cat: 'energy' },
  quantum_chips: { name: 'Puces quantiques', tier: 'intermediate', basePrice: 105, cat: 'tech' },
  hull_plates: { name: 'Plaques de coque', tier: 'intermediate', basePrice: 34, cat: 'metal' },
  nuclear_fuel: { name: 'Combustible nucléaire', tier: 'intermediate', basePrice: 62, cat: 'energy' },
  fertilizer: { name: 'Engrais', tier: 'intermediate', basePrice: 9, cat: 'organic' },
  fusion_cells: { name: 'Cellules à fusion', tier: 'intermediate', basePrice: 44, cat: 'energy' },

  // ── Produits finis ─────────────────────────────────────────────
  mech_parts: { name: 'Composants mécaniques', tier: 'finished', basePrice: 70, cat: 'metal' },
  ship_modules: { name: 'Modules de vaisseau', tier: 'finished', basePrice: 130, cat: 'tech' },
  consumer_goods: { name: 'Biens de consommation', tier: 'finished', basePrice: 60, cat: 'goods' },
  luxury_goods: { name: 'Biens de luxe', tier: 'finished', basePrice: 160, cat: 'goods' },
  adv_components: { name: 'Composants avancés', tier: 'finished', basePrice: 95, cat: 'tech' },
  jump_drives: { name: 'Moteurs à saut', tier: 'finished', basePrice: 480, cat: 'tech' },
  sensors: { name: 'Capteurs', tier: 'finished', basePrice: 120, cat: 'tech' },
};

export const RESOURCE_IDS = Object.keys(RESOURCES);
