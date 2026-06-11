// Besoins des populations.
//
// Trois mécanismes :
//   1. Élasticité (compressionFactor, utilisée par le moteur) : quand un
//      bien est hors de prix on se rationne, quand il est bradé on consomme
//      un peu plus. La demande civile n'est plus une constante.
//   2. Indice d'approvisionnement (mis à jour par le moteur) : la part des
//      besoins VITAUX réellement servis, lissée dans planets.supply.
//   3. Démographie (tickNeeds) : une population bien servie croît, une
//      population affamée décline ou émigre — et sa consommation est
//      recalculée en conséquence. Les pénuries ont des conséquences.

import { CONFIG } from '../config.js';

const N = CONFIG.NEEDS;

export const VITAL_SET = new Set(N.VITAL);

// Facteur multiplicatif sur la demande civile selon le prix relatif.
export function compressionFactor(price, basePrice) {
  const factor = Math.pow(basePrice / Math.max(price, 0.01), N.COMPRESSION_ELASTICITY);
  return Math.min(N.COMPRESSION_MAX, Math.max(N.COMPRESSION_MIN, factor));
}

// Démographie + recalcul de la consommation civile, tous les RECALC_EVERY
// ticks (la dérive est lente, inutile de payer ce coût à chaque tick).
export function tickNeeds(db, tick) {
  if (tick % N.RECALC_EVERY !== 0) return;

  const planets = db.prepare('SELECT id, population, supply FROM planets').all();
  const updatePop = db.prepare('UPDATE planets SET population = ? WHERE id = ?');
  const updateConso = db.prepare(
    'UPDATE planet_resources SET consumption = ? WHERE planet_id = ? AND resource_id = ?'
  );

  db.transaction(() => {
    for (const p of planets) {
      // supply ∈ [0,1] ; à 0.5 la population stagne, au-dessus elle croît.
      const drift = N.POP_DRIFT * (p.supply - 0.5) * 2 * N.RECALC_EVERY;
      const newPop = Math.max(0.05, Math.round(p.population * (1 + drift) * 100) / 100);
      if (newPop === p.population) continue;

      updatePop.run(newPop, p.id);
      for (const [resourceId, perM] of Object.entries(CONFIG.ECONOMY.POP_CONSUMPTION_PER_M)) {
        updateConso.run(Math.round(perM * newPop * 100) / 100, p.id, resourceId);
      }
    }
  })();
}
