// Influence de guerre : faire le roi sans tirer un coup de feu. Votre
// soutien matériel à un belligérant — ventes stratégiques, contrats de
// guerre, prêts — s'accumule en un « soutien » qui décroît avec le temps
// (il reflète l'aide RÉCENTE). Quand un camp que vous armez prend du
// terrain ou gagne la guerre, votre maison s'en voit attribuer le mérite :
// prestige, réputation, et un événement qui le dit. Le fantasme de
// profiteur, rendu actif et visible.

import { CONFIG } from '../config.js';
import { getMeta, setMeta } from '../db.js';
import { addPrestige } from '../player/state.js';
import { adjustStanding } from './standing.js';
import { logEvent } from '../events.js';

const I = CONFIG.INFLUENCE;

export function addSupport(db, factionId, amount) {
  if (factionId == null || !(amount > 0)) return;
  db.prepare(
    `INSERT INTO war_support (faction_id, support) VALUES (?, ?)
     ON CONFLICT(faction_id) DO UPDATE SET support = ROUND(support + ?, 3)`
  ).run(factionId, Math.round(amount * 1000) / 1000, Math.round(amount * 1000) / 1000);
}

export function supportOf(db, factionId) {
  return db.prepare('SELECT support FROM war_support WHERE faction_id = ?')
    .get(factionId)?.support ?? 0;
}

// Solde le soutien accumulé envers des factions (à la fin d'une guerre) :
// il ne doit pas se reporter sur une guerre future sans rapport, sinon on
// vous crédite « faiseur de rois » pour un conflit que vous n'avez pas armé.
export function clearWarSupport(db, factionIds) {
  const ids = factionIds.filter((id) => id != null);
  if (ids.length === 0) return;
  db.prepare(
    `DELETE FROM war_support WHERE faction_id IN (${ids.map(() => '?').join(',')})`
  ).run(...ids);
}

// Décroissance lente, chaque tick — le soutien s'efface si on n'aide plus.
export function tickInfluence(db) {
  db.prepare('UPDATE war_support SET support = ROUND(support * ?, 3)').run(I.DECAY);
  db.prepare('DELETE FROM war_support WHERE support < 0.1').run();
}

// Conquête d'un système par `winnerId` (l'autre camp = `loserId`). Si vous
// armez nettement le vainqueur, le mérite vous revient (anti-spam temporel).
export function attributeConquest(db, tick, winnerId, loserId, systemName) {
  const sw = supportOf(db, winnerId);
  if (sw < I.ATTRIBUTION_MIN || sw <= supportOf(db, loserId) * I.DOMINANCE) return;
  // Anti-spam PAR GUERRE (paire de factions), pas global : sinon une
  // conquête dans une guerre étouffe le crédit d'une conquête simultanée
  // dans une autre guerre que vous armez aussi.
  const key = `last_profiteer_${Math.min(winnerId, loserId)}_${Math.max(winnerId, loserId)}`;
  const last = Number(getMeta(db, key) ?? -999);
  if (tick - last < I.GAP_TICKS) return;
  setMeta(db, key, tick);

  addPrestige(db, I.CONQUEST_PRESTIGE);
  const w = db.prepare('SELECT name FROM factions WHERE id = ?').get(winnerId);
  logEvent(db, tick, 'profiteer',
    `★ PROFITEUR — vos livraisons à ${w.name} pèsent dans la balance : ${systemName} tombe`
    + ` (+${I.CONQUEST_PRESTIGE} prestige)`);
}

// Fin de guerre : si vous avez lourdement armé le vainqueur, vous êtes le
// faiseur de rois.
export function attributeWarEnd(db, tick, winnerId) {
  if (winnerId == null) return;
  if (supportOf(db, winnerId) < I.WAREND_MIN) return;
  addPrestige(db, I.WAREND_PRESTIGE);
  adjustStanding(db, winnerId, I.WAREND_STANDING);
  const w = db.prepare('SELECT name FROM factions WHERE id = ?').get(winnerId);
  logEvent(db, tick, 'profiteer',
    `★★ FAISEUR DE ROIS — ${w.name} l'emporte, et votre maison y est pour beaucoup`
    + ` (+${I.WAREND_PRESTIGE} prestige, réputation renforcée)`);
}
