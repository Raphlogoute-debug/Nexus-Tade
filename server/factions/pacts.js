// Accords commerciaux : un pacte signé avec une faction amie. La loyauté
// paie — douanes ouvertes sur ses fronts (plus de saisies), relevés de
// marché gratuits dans son territoire, accès assoupli à ses appels
// d'offres. Et la loyauté se garde : si votre réputation retombe sous le
// plancher (en armant son ennemi, par exemple), le pacte est dénoncé.

import { CONFIG } from '../config.js';
import { getCurrentTick } from '../db.js';
import { getPlayer, adjustCredits } from '../player/state.js';
import { getStanding } from './standing.js';
import { logEvent } from '../events.js';

const P = CONFIG.PACTS;

export function pactActive(db, factionId) {
  if (factionId === null || factionId === undefined) return false;
  return Boolean(db.prepare('SELECT 1 FROM faction_pacts WHERE faction_id = ?').get(factionId));
}

export function listPacts(db) {
  return db.prepare(
    `SELECT fp.*, f.name, f.color FROM faction_pacts fp
     JOIN factions f ON f.id = fp.faction_id ORDER BY fp.signed_tick`
  ).all().map((p) => ({ ...p, standing: Math.round(getStanding(db, p.faction_id)) }));
}

export function signPact(db, factionId) {
  const faction = db.prepare('SELECT * FROM factions WHERE id = ?').get(factionId);
  if (!faction) return { ok: false, error: 'faction inconnue' };
  if (pactActive(db, factionId)) return { ok: false, error: 'accord déjà en vigueur' };
  const standing = getStanding(db, factionId);
  if (standing < P.STANDING_REQUIRED) {
    return {
      ok: false,
      error: `réputation ${P.STANDING_REQUIRED} requise (vous : ${Math.round(standing)}) — vendez-leur, honorez leurs contrats`,
    };
  }
  if (getPlayer(db).credits < P.COST) {
    return { ok: false, error: `crédits insuffisants (${P.COST} cr)` };
  }

  const tick = getCurrentTick(db);
  db.transaction(() => {
    adjustCredits(db, -P.COST);
    db.prepare('INSERT INTO faction_pacts (faction_id, signed_tick) VALUES (?, ?)')
      .run(factionId, tick);
  })();
  logEvent(db, tick, 'pact',
    `ACCORD — votre maison signe un accord commercial avec ${faction.name} :`
    + ' douanes ouvertes, relevés gratuits chez eux, appels d\'offres assouplis');
  return { ok: true, factionName: faction.name, cost: P.COST };
}

// Vérification périodique : la réputation tombée sous le plancher dénonce
// le pacte (les amitiés commerciales ne survivent pas aux trahisons).
export function tickPacts(db, tick) {
  for (const pact of db.prepare('SELECT * FROM faction_pacts').all()) {
    if (getStanding(db, pact.faction_id) >= P.STANDING_FLOOR) continue;
    db.prepare('DELETE FROM faction_pacts WHERE faction_id = ?').run(pact.faction_id);
    const f = db.prepare('SELECT name FROM factions WHERE id = ?').get(pact.faction_id);
    logEvent(db, tick, 'pact',
      `ACCORD DÉNONCÉ — ${f.name} déchire votre accord commercial : votre réputation a trop baissé`);
  }
}
