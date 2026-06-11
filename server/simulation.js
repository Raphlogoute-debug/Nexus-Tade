// Orchestrateur d'un tick complet. Ordre :
//   1. économie planétaire (extraction, industrie, consommation, prix)
//   2. besoins (démographie, recalcul de la demande civile)
//   3. logistique des factions (convois) et chantiers navals
//   4. marchands indépendants
//   5. contrats de faction
//   6. systèmes joueur (concession, arrivée du vaisseau)
// Le moteur économique reste purement économique ; factions et PNJ vivent
// dans leurs modules et passent par les mêmes primitives de marché.

import { runTick as runEconomyTick } from './economy/engine.js';
import { tickNeeds } from './economy/needs.js';
import { tickDiplomacy } from './factions/diplomacy.js';
import { tickWars, warContext } from './factions/war.js';
import { planShipments, processShipmentArrivals } from './factions/logistics.js';
import { tickFleets } from './factions/fleet.js';
import { tickContracts } from './factions/contracts.js';
import { tickTraders } from './npc/traders.js';
import { tickConcessions } from './player/concession.js';
import { tickAutoShips } from './player/automation.js';
import { tickRouteShips } from './player/routes.js';
import { tickFleetUpkeep } from './player/shipyard.js';
import { processArrivals } from './player/travel.js';
import { pruneEvents } from './events.js';

export function runTick(db) {
  const startedAt = Date.now();
  const result = runEconomyTick(db);
  const tick = result.tick;

  tickNeeds(db, tick);
  tickDiplomacy(db, tick);
  tickWars(db, tick);
  processShipmentArrivals(db, tick, warContext(db));
  planShipments(db, tick);
  tickFleets(db);
  tickTraders(db, tick);
  tickContracts(db, tick);
  tickConcessions(db);
  tickFleetUpkeep(db);
  tickAutoShips(db, tick);
  tickRouteShips(db, tick);
  const events = processArrivals(db, tick);
  if (tick % 50 === 0) pruneEvents(db);

  return { ...result, events, durationMs: Date.now() - startedAt };
}
