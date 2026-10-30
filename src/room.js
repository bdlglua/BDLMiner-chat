// The chat room's state, in the SQLite database of its Durable Object: the
// last messages and the bans. Rate limits are kept in memory.

import { cleanName, cleanText, MAX_NAME, refuse, reservedName } from "./moderation.js";

const SECOND = 1000;
const KEEP_COUNT = 200;
const KEEP_TIME = 7 * 24 * 3600 * SECOND;
export const HISTORY = 50;  // sent to a newcomer
const GAP = 3 * SECOND;  // between two messages of one sender
const BURST = 20;  // messages per sender per 10 minutes
const BURST_SPAN = 10 * 60 * SECOND;

export class Room {
  constructor(sql) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL,
              name TEXT NOT NULL, text TEXT NOT NULL, team INTEGER NOT NULL DEFAULT 0, sender TEXT NOT NULL)`);
    sql.exec("CREATE TABLE IF NOT EXISTS bans (sender TEXT PRIMARY KEY, t INTEGER NOT NULL)");
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

  // {message} once stored, or {error}: a key the page translates.
  post({ name, text }, { sender, admin = false, now = Date.now() }) {
    if (this.banned(sender)) return { error: "banned" };
    const n = cleanName(name);
    if (!n) return { error: "name" };
    if (!admin && reservedName(n)) return { error: "reserved" };
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
