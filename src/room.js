// The chat room's state, in the SQLite database of its Durable Object: the
// last messages, the registered names and the bans. Rate limits are kept in
// memory.
//
// A browser keeps a random secret code; its hash (the "id") owns the name
// registered with it. A name belongs to one id, and an id may change its
// name once every 30 days; the team may take any name at any time.

import { cleanName, cleanText, MAX_NAME, refuse, reservedName } from "./moderation.js";

const SECOND = 1000;
const KEEP_COUNT = 200;
const KEEP_TIME = 7 * 24 * 3600 * SECOND;
export const HISTORY = 50;  // sent to a newcomer
const GAP = 3 * SECOND;  // between two messages of one sender
const BURST = 20;  // messages per sender per 10 minutes
const BURST_SPAN = 10 * 60 * SECOND;
const DAY = 24 * 3600 * SECOND;
export const CHANGE_AFTER = 30 * DAY;
const NEW_NAMES_PER_DAY = 3;  // per sender, so that clearing the browser does not dodge the 30 days

// "Bob", "bob", "B.o.b" and "Böb" are one name.
export function fold(name) {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\s._-]/g, "");
}

export class Room {
  constructor(sql) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL,
              name TEXT NOT NULL, text TEXT NOT NULL, team INTEGER NOT NULL DEFAULT 0, sender TEXT NOT NULL)`);
    sql.exec("CREATE TABLE IF NOT EXISTS bans (sender TEXT PRIMARY KEY, t INTEGER NOT NULL)");
    sql.exec(`CREATE TABLE IF NOT EXISTS names (id TEXT PRIMARY KEY, name TEXT NOT NULL, folded TEXT NOT NULL UNIQUE,
              t INTEGER NOT NULL, sender TEXT NOT NULL)`);
    this.senders = new Map();  // sender -> {last, times[]}
  }

  // The messages a page shows, oldest first; the sender stays on the server.
  history(limit = HISTORY) {
    return this.sql.exec("SELECT id, t, name, text, team FROM messages ORDER BY id DESC LIMIT ?", limit).toArray()
      .reverse().map((m) => ({ ...m, team: !!m.team }));
  }

  banned(sender) {
    return this.sql.exec("SELECT 1 FROM bans WHERE sender = ?", sender).toArray().length > 0;
  }

  // The name registered by `id`: {name, changeAt}, or null.
  nameOf(id) {
    const row = id && this.sql.exec("SELECT name, t FROM names WHERE id = ?", id).toArray()[0];
    return row ? { name: row.name, changeAt: row.t + CHANGE_AFTER } : null;
  }

  // {name, changeAt} once registered, or {error} (with `until` for "wait").
  register(id, name, { sender, admin = false, now = Date.now() }) {
    if (this.banned(sender)) return { error: "banned" };
    const n = cleanName(name);
    if (!n) return { error: "name" };
    if (!admin && reservedName(n)) return { error: "reserved" };
    const folded = fold(n);
    if (!folded) return { error: "name" };
    const mine = this.sql.exec("SELECT name, t FROM names WHERE id = ?", id).toArray()[0];
    if (mine && mine.name === n) return { name: n, changeAt: mine.t + CHANGE_AFTER };
    const owner = this.sql.exec("SELECT id FROM names WHERE folded = ?", folded).toArray()[0];
    if (owner && owner.id !== id && !admin) return { error: "taken" };
    if (!admin) {
      // A new spelling of one's own name ("bob" -> "Bob") is not a change.
      if (mine && fold(mine.name) !== folded && now < mine.t + CHANGE_AFTER) return { error: "wait", until: mine.t + CHANGE_AFTER };
      if (!mine && this.sql.exec("SELECT COUNT(*) AS n FROM names WHERE sender = ? AND t > ?", sender, now - DAY).toArray()[0].n >= NEW_NAMES_PER_DAY)
        return { error: "too_many" };
    }
    if (owner && owner.id !== id) this.sql.exec("DELETE FROM names WHERE id = ?", owner.id);  // the team takes it over
    const t = mine && fold(mine.name) === folded ? mine.t : now;
    this.sql.exec(`INSERT INTO names (id, name, folded, t, sender) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET name = excluded.name, folded = excluded.folded, t = excluded.t, sender = excluded.sender`,
      id, n, folded, t, sender);
    return { name: n, changeAt: t + CHANGE_AFTER };
  }

  // {message} once stored, or {error}: a key the page translates. `name` is
  // the sender's registered name.
  post({ text }, { sender, name, admin = false, now = Date.now() }) {
    if (this.banned(sender)) return { error: "banned" };
    const n = cleanName(name);
    if (!n) return { error: "name" };
    const t = cleanText(text);
    const why = refuse(t, { admin });
    if (why) return { error: why };
    if (!admin) {
      const s = this.senders.get(sender) ?? { last: 0, times: [] };
      if (now - s.last < GAP) return { error: "slow" };
      s.times = s.times.filter((x) => now - x < BURST_SPAN);
      if (s.times.length >= BURST) return { error: "slow" };
      s.last = now;
      s.times.push(now);
      this.senders.set(sender, s);
      if (this.senders.size > 5000) for (const [k, v] of this.senders) if (now - v.last > BURST_SPAN) this.senders.delete(k);
    }
    const row = this.sql.exec("INSERT INTO messages (t, name, text, team, sender) VALUES (?, ?, ?, ?, ?) RETURNING id",
      now, n.slice(0, MAX_NAME), t, admin ? 1 : 0, sender).toArray()[0];
    this.sql.exec("DELETE FROM messages WHERE id <= ? OR t < ?", row.id - KEEP_COUNT, now - KEEP_TIME);
    return { message: { id: row.id, t: now, name: n, text: t, team: admin } };
  }

  remove(id) {
    this.sql.exec("DELETE FROM messages WHERE id = ?", id);
  }

  // Bans whoever wrote message `id` and removes all their messages; the ids
  // removed, for the pages to drop.
  ban(id, now = Date.now()) {
    const row = this.sql.exec("SELECT sender FROM messages WHERE id = ?", id).toArray()[0];
    if (!row) return [];
    this.sql.exec("INSERT OR IGNORE INTO bans (sender, t) VALUES (?, ?)", row.sender, now);
    const ids = this.sql.exec("SELECT id FROM messages WHERE sender = ?", row.sender).toArray().map((r) => r.id);
    this.sql.exec("DELETE FROM messages WHERE sender = ?", row.sender);
    return ids;
  }

  unbanAll() {
    this.sql.exec("DELETE FROM bans");
  }
}
