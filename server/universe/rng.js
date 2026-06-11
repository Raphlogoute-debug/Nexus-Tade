// Générateur pseudo-aléatoire déterministe (mulberry32) : la même seed
// produit toujours le même univers. Math.random est banni de la génération.

export function createRng(seed) {
  let state = seed >>> 0;

  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next, // ∈ [0, 1)
    float: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)), // bornes incluses
    pick: (arr) => arr[Math.floor(next() * arr.length)],

    // Tirage log-uniforme : favorise les petites valeurs (beaucoup de
    // colonies modestes, rares mondes-ruches).
    logUniform: (min, max) => Math.exp(Math.log(min) + next() * (Math.log(max) - Math.log(min))),

    // Tirage pondéré parmi { clé: { weight } } ou [{ key, weight }].
    pickWeighted(entries) {
      const total = entries.reduce((s, e) => s + e.weight, 0);
      let roll = next() * total;
      for (const e of entries) {
        roll -= e.weight;
        if (roll <= 0) return e;
      }
      return entries[entries.length - 1];
    },
  };
}

// Seed aléatoire pour un nouvel univers (entier 32 bits non signé).
export function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
