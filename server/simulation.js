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
import { tickPiracy } from './factions/piracy.js';
import { planShipments, processShipmentArrivals } from './factions/logistics.js';
import { tickFleets } from './factions/fleet.js';
import { tickContracts } from './factions/contracts.js';
import { tickClients } from './economy/clients.js';
import { tickPacts } from './factions/pacts.js';
import { tickInfluence } from './factions/influence.js';
import { tickMegaprojects } from './economy/megaprojects.js';
import { tickColonies, tickLairs } from './economy/frontier.js';
import { tickTraders } from './npc/traders.js';
import { tickRivals } from './economy/rivals.js';
import { tickConcessions } from './player/concession.js';
import { tickTradingPosts } from './player/posts.js';
import { checkObjectives } from './player/objectives.js';
import { tickAutoShips } from './player/automation.js';
import { tickRouteShips } from './player/routes.js';
import { tickMissions } from './player/missions.js';
import { tickFleetUpkeep } from './player/shipyard.js';
import { tickDividends } from './player/investments.js';
import { processArrivals } from './player/travel.js';
import { pruneEvents } from './events.js';

export function runTick(db) {
  const startedAt = Date.now();
  let result;
  let events;

  // Tout le tick dans UNE transaction : un seul commit (donc un seul
  // passage WAL) au lieu de dizaines — et un tick atomique. Les
  // transactions internes des sous-systèmes deviennent des savepoints.
  db.transaction(() => {
    result = runEconomyTick(db);
    const tick = result.tick;

    tickDividends(db, result.industryRuns);
    tickNeeds(db, tick);
    tickDiplomacy(db, tick);
    tickWars(db, tick);
    processShipmentArrivals(db, tick, warContext(db));
    planShipments(db, tick);
    tickFleets(db);
    tickTraders(db, tick);
    tickRivals(db, tick);
    tickContracts(db, tick);
    tickClients(db, tick);
    tickMegaprojects(db, tick);
    tickColonies(db, tick);
    tickLairs(db, tick);
    if (tick % 5 === 0) tickPacts(db, tick);
    tickInfluence(db);
    tickConcessions(db);
    tickTradingPosts(db, tick);
    tickFleetUpkeep(db);
    tickAutoShips(db, tick);
    tickRouteShips(db, tick);
    tickMissions(db, tick);
    tickPiracy(db, tick); // les abordages frappent avant l'amarrage
    events = processArrivals(db, tick);
    if (tick % 5 === 0) checkObjectives(db, tick);
    if (tick % 50 === 0) pruneEvents(db);
  })();

  return { ...result, events, durationMs: Date.now() - startedAt };
}
