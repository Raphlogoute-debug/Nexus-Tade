// Chaînes de production : chaque recette est indexée par la ressource
// qu'elle produit. `inputs` = quantités consommées par run,
// `output` = quantité produite par run.
//
// Une planète qui possède une industrie pour une recette tente de
// l'exécuter `rate` fois par tick — limité par les stocks d'entrée
// réellement disponibles (voir economy/engine.js).

export const RECIPES = {
  // ── Intermédiaires (à partir de ressources brutes) ─────────────
  steel: { inputs: { iron_ore: 2 }, output: 1 },
  alloys: { inputs: { iron_ore: 1, copper_ore: 1 }, output: 1 },
  fuel: { inputs: { rare_gas: 2, energy_crystals: 1 }, output: 2 },
  electronics: { inputs: { copper_ore: 1, energy_crystals: 1 }, output: 1 },
  synth_food: { inputs: { water: 1, organics: 1 }, output: 3 },
  polymers: { inputs: { organics: 2, rare_gas: 1 }, output: 2 },
  ceramics: { inputs: { silicon: 2, water: 1 }, output: 2 },
  meds: { inputs: { organics: 1, spices: 1 }, output: 1 },

  // ── Finis (à partir d'intermédiaires) ──────────────────────────
  mech_parts: { inputs: { steel: 2, alloys: 1 }, output: 1 },
  ship_modules: { inputs: { alloys: 1, electronics: 2 }, output: 1 },
  consumer_goods: { inputs: { steel: 1, electronics: 1 }, output: 2 },
  luxury_goods: { inputs: { precious_metals: 1, polymers: 1 }, output: 1 },
  adv_components: { inputs: { ceramics: 1, electronics: 1 }, output: 1 },
};

export const RECIPE_IDS = Object.keys(RECIPES);
