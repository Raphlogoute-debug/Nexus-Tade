// Orchestrateur d'un tick complet : économie des planètes, puis systèmes
// joueur (concession, arrivées de vaisseaux). Le moteur économique reste
// purement économique ; tout ce qui concerne le joueur vit dans player/.

import { runTick as runEconomyTick } from './economy/engine.js';
import { tickConcession } from './player/concession.js';
import { processArrivals } from './player/travel.js';

export function runTick(db) {
  const result = runEconomyTick(db);
  tickConcession(db);
  const events = processArrivals(db, result.tick);
  return { ...result, events };
}
