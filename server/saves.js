// Gestion des sauvegardes : plusieurs parties, chacune dans son fichier
// SQLite sous saves/. La liste se lit en ouvrant chaque fichier en lecture
// (méta + nom de la maison + tick). Le serveur garde une partie active et
// peut basculer de l'une à l'autre à chaud (server/index.js).

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createGame } from './game.js';
import { randomSeed } from './universe/rng.js';
import { SCENARIO_BY_ID, DEFAULT_SCENARIO } from '../data/scenarios.js';

export function ensureSavesDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

const slug = (name) => String(name).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'partie';

// Lecture sans risque d'un fichier de sauvegarde (read-only) pour la liste.
function readSaveMeta(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const meta = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value;
    // SELECT * : les vieilles parties n'ont pas encore la colonne house_name
    // (les migrations ne tournent qu'à l'ouverture en écriture).
    const player = db.prepare('SELECT * FROM player WHERE id = 1').get();
    const tick = Number(meta('current_tick') ?? 0);
    return {
      file: path.basename(file),
      saveName: meta('save_name') ?? player?.house_name ?? 'Partie',
      houseName: player?.house_name ?? null,
      scenario: meta('scenario') ?? null,
      seed: Number(meta('seed') ?? 0),
      tick,
      credits: player ? Math.round(player.credits) : null,
      prestige: player ? Math.round(player.prestige) : null,
      mtime: fs.statSync(file).mtimeMs,
    };
  } catch {
    return null; // fichier en cours d'écriture, corrompu, ou verrouillé
  } finally {
    db?.close();
  }
}

// Liste des sauvegardes, la plus récemment jouée en tête. La partie
// active est lue depuis sa propre instance (passée par le serveur) pour
// éviter le verrou WAL.
export function listSaves(dir, activeFile = null, activeDb = null) {
  ensureSavesDir(dir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    if (activeFile && f === activeFile && activeDb) {
      const meta = (k) => activeDb.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value;
      const player = activeDb.prepare('SELECT house_name, credits, prestige FROM player WHERE id = 1').get();
      out.push({
        file: f,
        saveName: meta('save_name') ?? player?.house_name ?? 'Partie',
        houseName: player?.house_name ?? null,
        scenario: meta('scenario') ?? null,
        seed: Number(meta('seed') ?? 0),
        tick: Number(meta('current_tick') ?? 0),
        credits: player ? Math.round(player.credits) : null,
        prestige: player ? Math.round(player.prestige) : null,
        mtime: fs.statSync(full).mtimeMs,
        active: true,
      });
    } else {
      const m = readSaveMeta(full);
      if (m) out.push({ ...m, active: false });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Crée une nouvelle sauvegarde et renvoie son nom de fichier.
export function newSave(dir, { name, scenario, seed } = {}) {
  ensureSavesDir(dir);
  const scn = SCENARIO_BY_ID[scenario] ? scenario : DEFAULT_SCENARIO;
  const saveName = String(name ?? '').trim().slice(0, 40) || 'Nouvelle partie';
  const usedSeed = Number.isFinite(Number(seed)) && Number(seed) > 0 ? Number(seed) >>> 0 : randomSeed();

  // Nom de fichier unique.
  let file = `${slug(saveName)}.db`;
  let n = 2;
  while (fs.existsSync(path.join(dir, file))) file = `${slug(saveName)}-${n++}.db`;

  const full = path.join(dir, file);
  const { db } = createGame(full, { seed: usedSeed, scenario: scn, houseName: saveName });
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('save_name', saveName);
  db.close();
  return { file, saveName, scenario: scn, seed: usedSeed };
}

export function deleteSave(dir, file, activeFile) {
  if (file === activeFile) return { ok: false, error: 'impossible de supprimer la partie active' };
  const full = path.join(dir, path.basename(file));
  if (!full.startsWith(dir) || !fs.existsSync(full)) return { ok: false, error: 'sauvegarde introuvable' };
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(full + suffix); } catch { /* peut ne pas exister */ }
  }
  return { ok: true, file };
}

// Migration : une ancienne partie au format mono-fichier (à la racine)
// devient la première sauvegarde du dossier saves/.
export function migrateLegacy(dir, legacyPath) {
  ensureSavesDir(dir);
  if (fs.readdirSync(dir).some((f) => f.endsWith('.db'))) return null;
  if (!fs.existsSync(legacyPath)) return null;
  const file = 'partie-heritee.db';
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(legacyPath + suffix)) {
      fs.renameSync(legacyPath + suffix, path.join(dir, file + suffix));
    }
  }
  // Baptiser la partie héritée.
  try {
    const db = new Database(path.join(dir, file));
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('save_name', 'Partie héritée');
    db.close();
  } catch { /* tant pis pour le nom */ }
  return file;
}
