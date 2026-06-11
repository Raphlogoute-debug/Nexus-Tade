// Profils de biomes : ce que chaque type de planète extrait naturellement,
// et la fourchette de population qu'il peut accueillir.
//
// extraction : poids relatifs par ressource brute. La production réelle
//   par tick = poids × facteur de main-d'œuvre (dérivé de la population),
//   voir universe/generator.js.
// popRange : population en millions [min, max] (tirage log-uniforme,
//   les petites colonies sont plus fréquentes que les mondes-ruches).
// weight : probabilité relative d'apparition du biome à la génération.

export const BIOMES = {
  rocky: {
    label: 'Rocheuse',
    weight: 0.24,
    popRange: [20, 1200],
    extraction: { iron_ore: 3.0, copper_ore: 2.0, energy_crystals: 0.5 },
  },
  oceanic: {
    label: 'Océanique',
    weight: 0.18,
    popRange: [50, 1500],
    extraction: { water: 3.2, organics: 2.4 },
  },
  gas_giant: {
    label: 'Gazeuse',
    weight: 0.16,
    popRange: [1, 30], // stations orbitales uniquement
    extraction: { rare_gas: 3.5 },
  },
  desert: {
    label: 'Désertique',
    weight: 0.16,
    popRange: [5, 400],
    extraction: { energy_crystals: 2.2, copper_ore: 1.6, iron_ore: 0.8 },
  },
  ice: {
    label: 'Glaciaire',
    weight: 0.14,
    popRange: [2, 200],
    extraction: { water: 2.6, rare_gas: 1.2, organics: 0.5 },
  },
  volcanic: {
    label: 'Volcanique',
    weight: 0.12,
    popRange: [2, 150],
    extraction: { iron_ore: 1.8, energy_crystals: 2.0, rare_gas: 0.8 },
  },
};

export const BIOME_IDS = Object.keys(BIOMES);
