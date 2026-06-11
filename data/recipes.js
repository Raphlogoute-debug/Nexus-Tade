import { RESOURCES } from './resources.js';

// Chaînes de production : chaque recette est indexée par la ressource
// qu'elle produit (ou par un identifiant d'industrie pour les filières
// alternatives, avec `produces`). `inputs` = quantités consommées par
// run, `output` = quantité produite par run.
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
  antimatter: { inputs: { helium3: 3, energy_crystals: 2 }, output: 1 },
  quantum_chips: { inputs: { silicon: 2, precious_metals: 1 }, output: 1 },
  hull_plates: { inputs: { titanium_ore: 2, steel: 1 }, output: 1 },
  nuclear_fuel: { inputs: { uranium: 2, water: 1 }, output: 1 },
  fertilizer: { inputs: { biomass: 3 }, output: 2 },
  fusion_cells: { inputs: { deuterium: 2, helium3: 1 }, output: 1 },

  // ── Finis (à partir d'intermédiaires) ──────────────────────────
  mech_parts: { inputs: { steel: 2, alloys: 1 }, output: 1 },
  ship_modules: { inputs: { alloys: 1, electronics: 2 }, output: 1 },
  consumer_goods: { inputs: { steel: 1, electronics: 1 }, output: 2 },
  luxury_goods: { inputs: { precious_metals: 1, polymers: 1 }, output: 1 },
  adv_components: { inputs: { ceramics: 1, electronics: 1 }, output: 1 },
  jump_drives: { inputs: { antimatter: 1, quantum_chips: 1, alloys: 2 }, output: 1 },
  sensors: { inputs: { rare_earths: 1, electronics: 1 }, output: 1 },

  // ── Industries alternatives ────────────────────────────────────
  // Un même produit, plusieurs filières : intrants et rendements
  // différents. La clé est un identifiant d'industrie ; `produces`
  // désigne la ressource réellement produite, `name` le nom d'usine.
  steel_titanium: {
    name: 'Aciérie composite', produces: 'steel',
    inputs: { titanium_ore: 1, iron_ore: 1 }, output: 2,
  },
  fuel_deuterium: {
    name: 'Raffinerie au deutérium', produces: 'fuel',
    inputs: { deuterium: 2 }, output: 2,
  },
  electronics_rare: {
    name: 'Électronique aux terres rares', produces: 'electronics',
    inputs: { rare_earths: 1, silicon: 1 }, output: 2,
  },
  synth_food_biomass: {
    name: 'Bioréacteurs', produces: 'synth_food',
    inputs: { biomass: 2, water: 1 }, output: 4,
  },
  meds_bio: {
    name: 'Biopharma', produces: 'meds',
    inputs: { biomass: 2, spices: 1 }, output: 2,
  },
  gem_cutting: {
    name: 'Taillerie de gemmes', produces: 'luxury_goods',
    inputs: { gemstones: 2 }, output: 1,
  },
};

// Ressource produite par une recette (la clé elle-même par défaut).
export const recipeOutput = (recipeId) => RECIPES[recipeId].produces ?? recipeId;

// Nom d'affichage : nom d'usine pour les filières alternatives, nom de
// la ressource pour les recettes classiques.
export const recipeName = (recipeId) =>
  RECIPES[recipeId].name ?? RESOURCES[recipeOutput(recipeId)].name;

export const RECIPE_IDS = Object.keys(RECIPES);
