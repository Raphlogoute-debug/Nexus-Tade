// Fil d'événements du monde : ce qui se passe sans le joueur (guerres,
// conquêtes, traités) et ce qui lui arrive (saisies). L'UI le déroule
// dans le journal de bord.

export function logEvent(db, tick, type, message, factionId = null) {
  db.prepare(
    'INSERT INTO world_events (tick, type, message, faction_id) VALUES (?, ?, ?, ?)'
  ).run(tick, type, message, factionId);
}

export function recentEvents(db, sinceId, limit = 50) {
  return db.prepare(
    'SELECT * FROM world_events WHERE id > ? ORDER BY id LIMIT ?'
  ).all(sinceId, limit);
}

export function pruneEvents(db, keep = 300) {
  db.prepare(
    'DELETE FROM world_events WHERE id <= (SELECT COALESCE(MAX(id), 0) - ? FROM world_events)'
  ).run(keep);
}
