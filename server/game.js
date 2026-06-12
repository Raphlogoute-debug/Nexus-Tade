// Amorçage d'une partie : créer un monde neuf, ou ouvrir un fichier de
// sauvegarde existant (en complétant les morceaux manquants pour les
// vieilles parties). Partagé par le serveur (server/index.js) et le
// gestionnaire de sauvegardes (server/saves.js).

import { CONFIG } from './config.js';
import { createDb, getMeta, setMeta, getCurrentTick } from './db.js';
import { createRng } from './universe/rng.js';
import { generateUniverse, ensureResourceRows } from './universe/generator.js';
import { generateFactions } from './factions/generate.js';
import { initTraders } from './npc/traders.js';
import { initRivals } from './economy/rivals.js';
import { initPlayer, getPlayer } from './player/state.js';
import { declareWar } from './factions/diplomacy.js';

// Crée une partie complète dans un fichier neuf : univers procédural,
// factions, marchands, maisons rivales, joueur selon le scénario.
export function createGame(path, { seed, scenario, houseName, houseColor } = {}) {
  const db = createDb(path);
  const gen = generateUniverse(db, seed >>> 0);
  generateFactions(db);
  initTraders(db);
  initRivals(db);
  const init = initPlayer(db, { scenarioId: scenario, houseName, houseColor });

  if (init.scenario.startWar) startInitialWar(db);
  setMeta(db, 'scenario', init.scenario.id);
  return { db, seed: gen.seed, scenario: init.scenario };
}

// Ouvre un fichier existant et complète ce qui manque (migration douce des
// parties d'avant telle ou telle phase). Ne touche pas à un monde déjà
// peuplé au-delà de l'ajout des lignes/tables neuves.
export function openGame(path) {
  const db = createDb(path);
  if (getMeta(db, 'seed') === null) {
    // Fichier vierge (ne devrait pas arriver via l'UI) : on en fait une
    // partie par défaut plutôt que de planter.
    generateUniverse(db, (Math.random() * 2 ** 32) >>> 0);
  }
  ensureResourceRows(db);
  if (!db.prepare('SELECT 1 FROM factions LIMIT 1').get()) generateFactions(db);
  if (!db.prepare('SELECT 1 FROM traders LIMIT 1').get()) initTraders(db);
  if (!db.prepare('SELECT 1 FROM rivals LIMIT 1').get()) initRivals(db);
  if (!getPlayer(db)) initPlayer(db);

  // Parties d'avant la Phase 11 : la maison n'a ni nom ni blason. On lui
  // en attribue (déterministe sur la seed) pour ne pas afficher « sans nom ».
  const player = getPlayer(db);
  if (player && !player.house_name) {
    const H = CONFIG.PLAYER.HOUSE;
    const rng = createRng((Number(getMeta(db, 'seed')) ^ 0x51ed270b) >>> 0);
    const name = H.DEFAULT_NAMES[Math.floor(rng.next() * H.DEFAULT_NAMES.length)];
    const color = H.CREST_COLORS[Math.floor(rng.next() * H.CREST_COLORS.length)];
    db.prepare('UPDATE player SET house_name = ?, house_color = ? WHERE id = 1').run(name, color);
  }
  return db;
}

// Deux factions voisines entrent en guerre tout de suite (scénario Profiteur).
function startInitialWar(db) {
  const factions = db.prepare('SELECT * FROM factions ORDER BY id').all();
  if (factions.length < 2) return;
  declareWar(db, getCurrentTick(db), factions[0], factions[1]);
}
