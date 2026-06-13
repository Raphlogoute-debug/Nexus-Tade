// Prêts de guerre : financer un camp sans tirer un coup de feu.
// L'argent prêté part immédiatement en matériel (stocks stratégiques de
// la capitale) — le prêt renforce réellement l'emprunteur, ses fronts
// tiennent mieux, et vos chances de remboursement avec. S'il capitule,
// vous perdez tout : le risque du banquier de guerre.

import { CONFIG } from '../config.js';
import { RESOURCES } from '../../data/resources.js';
import { getCurrentTick } from '../db.js';
import { getPlayer, adjustCredits } from '../player/state.js';
import { adjustStanding } from './standing.js';
import { addSupport } from './influence.js';
import { logEvent } from '../events.js';

const L = CONFIG.LOANS;

export function issueLoan(db, factionId, amount) {
  if (!Number.isFinite(amount) || amount < L.MIN) {
    return { ok: false, error: `prêt minimum : ${L.MIN} cr` };
  }
  const faction = db.prepare('SELECT * FROM factions WHERE id = ?').get(factionId);
  if (!faction) return { ok: false, error: 'faction inconnue' };

  const war = db.prepare(
    'SELECT * FROM wars WHERE ended_tick IS NULL AND (attacker_id = ? OR defender_id = ?)'
  ).get(factionId, factionId);
  if (!war) return { ok: false, error: 'cette faction n\'est pas en guerre — personne n\'emprunte en temps de paix' };

  if (getPlayer(db).credits < amount) return { ok: false, error: 'crédits insuffisants' };

  const tick = getCurrentTick(db);
  const enemyId = war.attacker_id === factionId ? war.defender_id : war.attacker_id;

  db.transaction(() => {
    adjustCredits(db, -amount);
    db.prepare(
      'INSERT INTO loans (faction_id, war_id, amount, issued_tick) VALUES (?, ?, ?, ?)'
    ).run(factionId, war.id, amount, tick);

    // L'emprunteur convertit aussitôt : matériel de guerre aux prix de
    // base, réparti entre les intrants du chantier.
    const inputs = Object.keys(CONFIG.FLEET.BUILD);
    const budgetPer = (amount * L.SPEND_RATIO) / inputs.length;
    const addStock = db.prepare(
      'UPDATE planet_resources SET stock = ROUND(stock + ?, 2) WHERE planet_id = ? AND resource_id = ?'
    );
    for (const resourceId of inputs) {
      addStock.run(
        Math.round((budgetPer / RESOURCES[resourceId].basePrice) * 100) / 100,
        faction.capital_planet_id, resourceId);
    }

    // Le créancier d'un camp est connu — des deux camps.
    const gain = (amount / 1000) * L.STANDING_PER_1000;
    adjustStanding(db, factionId, gain);
    adjustStanding(db, enemyId, -gain * CONFIG.STANDING.ENEMY_LEAK);
    addSupport(db, factionId, (amount / 1000) * CONFIG.INFLUENCE.LOAN_PER_1000);

    logEvent(db, tick, 'loan',
      `FINANCE — vous prêtez ${Math.round(amount)} cr à ${faction.name} pour son effort de guerre`,
      factionId);
  })();

  return { ok: true, amount, factionName: faction.name, warId: war.id };
}

// Appelé par war.endWar : l'heure des comptes.
export function resolveWarLoans(db, war, result, tick) {
  const loans = db.prepare(
    "SELECT * FROM loans WHERE war_id = ? AND status = 'open'"
  ).all(war.id);

  for (const loan of loans) {
    const wonByBorrower = (result === 'attacker' && loan.faction_id === war.attacker_id)
      || (result === 'defender' && loan.faction_id === war.defender_id);
    const mult = wonByBorrower ? L.VICTORY_MULT : result === 'peace' ? L.PEACE_MULT : 0;
    const payout = Math.round(loan.amount * mult * 100) / 100;
    const faction = db.prepare('SELECT name FROM factions WHERE id = ?').get(loan.faction_id);

    db.prepare('UPDATE loans SET status = ?, payout = ? WHERE id = ?')
      .run(payout > 0 ? 'repaid' : 'defaulted', payout, loan.id);
    if (payout > 0) {
      adjustCredits(db, payout);
      // Les intérêts perçus sont du pur profit de guerre.
      db.prepare('UPDATE player SET war_profit = ROUND(war_profit + ?, 2) WHERE id = 1')
        .run(Math.max(0, payout - loan.amount));
      logEvent(db, tick, 'loan',
        `FINANCE — ${faction.name} rembourse votre prêt de guerre : +${payout} cr`,
        loan.faction_id);
    } else {
      logEvent(db, tick, 'loan',
        `FINANCE — ${faction.name} a capitulé : votre prêt de ${Math.round(loan.amount)} cr part en fumée`,
        loan.faction_id);
    }
  }
}

export function listLoans(db) {
  return db.prepare(
    `SELECT l.*, f.name AS faction_name FROM loans l
     JOIN factions f ON f.id = l.faction_id
     ORDER BY l.id DESC LIMIT 20`
  ).all();
}
