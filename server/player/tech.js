// Recherche technologique du joueur : on investit des crédits, on
// débloque des filières d'atelier ou des effets permanents (voir
// data/technologies.js pour l'arbre).

import { TECHNOLOGIES } from '../../data/technologies.js';
import { getCurrentTick } from '../db.js';
import { getPlayer, adjustCredits } from './state.js';

export function ownedTechs(db) {
  return new Set(db.prepare('SELECT tech_id FROM player_tech').all().map((t) => t.tech_id));
}

export function hasTech(db, techId) {
  return Boolean(db.prepare('SELECT 1 FROM player_tech WHERE tech_id = ?').get(techId));
}

// Recettes installables en atelier, selon les filières recherchées.
export function unlockedRecipes(db) {
  const owned = ownedTechs(db);
  const recipes = new Set();
  for (const techId of owned) {
    for (const r of TECHNOLOGIES[techId].unlocks ?? []) recipes.add(r);
  }
  return recipes;
}

export function researchTech(db, techId) {
  const tech = TECHNOLOGIES[techId];
  if (!tech) return { ok: false, error: 'technologie inconnue' };
  if (hasTech(db, techId)) return { ok: false, error: 'déjà recherchée' };
  if (tech.requires && !hasTech(db, tech.requires)) {
    return { ok: false, error: `prérequis : ${TECHNOLOGIES[tech.requires].name}` };
  }
  if (getPlayer(db).credits < tech.cost) return { ok: false, error: 'crédits insuffisants' };

  db.transaction(() => {
    adjustCredits(db, -tech.cost);
    db.prepare('INSERT INTO player_tech (tech_id, acquired_tick) VALUES (?, ?)')
      .run(techId, getCurrentTick(db));
  })();
  return { ok: true, techId, name: tech.name, cost: tech.cost };
}

// Catalogue pour l'UI : état de chaque technologie.
export function techCatalog(db) {
  const owned = ownedTechs(db);
  return Object.entries(TECHNOLOGIES).map(([id, t]) => ({
    id,
    name: t.name,
    cost: t.cost,
    requires: t.requires,
    requiresName: t.requires ? TECHNOLOGIES[t.requires].name : null,
    unlocks: t.unlocks ?? [],
    desc: t.desc ?? null,
    owned: owned.has(id),
    available: !owned.has(id) && (!t.requires || owned.has(t.requires)),
  }));
}
