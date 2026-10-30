// The chat room's state, in the SQLite database of its Durable Object: the
// last messages, the registered names, the bans and the media (photos, voice
// messages, videos). Message rate limits are kept in memory.
//
// A browser keeps a random secret code; its hash (the "id", or "owner" of a
// message) owns the name registered with it. A name belongs to one id, and an
// id may change its name once every 30 days; the team may take any name at
// any time. The owner of a message may edit or delete it.

import { cleanName, cleanText, MAX_NAME, refuse, reservedName } from "./moderation.js";

const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;
const KEEP_COUNT = 200;
const KEEP_TIME = 7 * DAY;
export const HISTORY = 50;  // sent to a newcomer
const GAP = 3 * SECOND;  // between two messages of one sender
const BURST = 20;  // messages per sender per 10 minutes
const BURST_SPAN = 10 * 60 * SECOND;
export const CHANGE_AFTER = 30 * DAY;
const NEW_NAMES_PER_DAY = 3;  // per sender, so that clearing the browser does not dodge the 30 days

// Media: the largest file per kind, uploads per sender and hour, and all of
// them together (well within the free plan's storage).
export const MEDIA_MAX = { image: 3 * 1024 * 1024, audio: 2 * 1024 * 1024, video: 8 * 1024 * 1024 };
const MEDIA_PER_HOUR = 10;
const MEDIA_TOTAL = 400 * 1024 * 1024;
const CHUNK = 1024 * 1024;  // a SQLite value holds at most 2 MB
const UNUSED = HOUR;  // an upload never attached to a message is dropped after this

// "Bob", "bob", "B.o.b" and "Böb" are one name.
export function fold(name) {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[\s._-]/g, "");
}

// The real type of a file, from its first bytes; `kind` is what the page says
// it sends, which only settles containers used for both sound and video.
export function sniff(bytes, kind) {
  const at = (offset, text) => [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
  if (at(0, "\x89PNG\r\n\x1a\n")) return { kind: "image", mime: "image/png" };
  if (at(0, "GIF87a") || at(0, "GIF89a")) return { kind: "image", mime: "image/gif" };
  if (at(0, "RIFF") && at(8, "WEBP")) return { kind: "image", mime: "image/webp" };
  if (at(4, "ftyp")) {
    if (kind === "audio" || at(8, "M4A ")) return { kind: "audio", mime: "audio/mp4" };
    return { kind: "video", mime: at(8, "qt  ") ? "video/quicktime" : "video/mp4" };
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return kind === "audio" ? { kind: "audio", mime: "audio/webm" } : { kind: "video", mime: "video/webm" };
  if (at(0, "OggS")) return { kind: "audio", mime: "audio/ogg" };
  if (at(0, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return { kind: "audio", mime: "audio/mpeg" };
  return null;
}

function randomId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class Room {
  constructor(sql) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL,
              name TEXT NOT NULL, text TEXT NOT NULL, team INTEGER NOT NULL DEFAULT 0, sender TEXT NOT NULL)`);
    // Added after the first version.
    const columns = sql.exec("PRAGMA table_info(messages)").toArray().map((c) => c.name);
    if (!columns.includes("owner")) sql.exec("ALTER TABLE messages ADD COLUMN owner TEXT");
    if (!columns.includes("media")) sql.exec("ALTER TABLE messages ADD COLUMN media TEXT");
    if (!columns.includes("edited")) sql.exec("ALTER TABLE messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0");
    sql.exec("CREATE TABLE IF NOT EXISTS bans (sender TEXT PRIMARY KEY, t INTEGER NOT NULL)");
    sql.exec(`CREATE TABLE IF NOT EXISTS names (id TEXT PRIMARY KEY, name TEXT NOT NULL, folded TEXT NOT NULL UNIQUE,
              t INTEGER NOT NULL, sender TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, t INTEGER NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL,
              size INTEGER NOT NULL, chunks INTEGER NOT NULL, owner TEXT NOT NULL, sender TEXT NOT NULL, attached INTEGER NOT NULL DEFAULT 0)`);
    sql.exec("CREATE TABLE IF NOT EXISTS media_chunks (id TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, n))");
    this.senders = new Map();  // sender -> {last, times[]}
  }

  row(m) {
    return { id: m.id, t: m.t, name: m.name, text: m.text, team: !!m.team, edited: !!m.edited,
      media: m.media ? JSON.parse(m.media) : null, owner: m.owner ?? null };
  }

  // The messages a page shows, oldest first, with their owner (the hub tells
  // each page which are its own and strips it); the sender stays here.
  history(limit = HISTORY) {
    return this.sql.exec("SELECT * FROM messages ORDER BY id DESC LIMIT ?", limit).toArray().reverse().map((m) => this.row(m));
  }

  message(id) {
    const m = this.sql.exec("SELECT * FROM messages WHERE id = ?", id).toArray()[0];
    return m ? this.row(m) : null;
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

  // Counts a message against the sender's limits; an error key, or null.
  pace(sender, now) {
    const s = this.senders.get(sender) ?? { last: 0, times: [] };
    if (now - s.last < GAP) return "slow";
    s.times = s.times.filter((x) => now - x < BURST_SPAN);
    if (s.times.length >= BURST) return "slow";
    s.last = now;
    s.times.push(now);
    this.senders.set(sender, s);
    if (this.senders.size > 5000) for (const [k, v] of this.senders) if (now - v.last > BURST_SPAN) this.senders.delete(k);
    return null;
  }

  // {message} once stored, or {error}: a key the page translates. `name` is
  // the sender's registered name, `owner` its id; `media` an upload of its own.
  post({ text, media }, { sender, name, owner = null, admin = false, now = Date.now() }) {
    if (this.banned(sender)) return { error: "banned" };
    const n = cleanName(name);
    if (!n) return { error: "name" };
    const t = cleanText(text);
    let file = null;
    if (media?.id !== undefined) {
      const m = this.sql.exec("SELECT id, kind, mime, size, owner, attached FROM media WHERE id = ?", String(media.id)).toArray()[0];
      if (!m || m.owner !== owner || m.attached) return { error: "media" };
      file = { id: m.id, kind: m.kind, mime: m.mime, size: m.size };
    }
    if (t || !file) {
      const why = refuse(t, { admin });
      if (why) return { error: why };
    }
    if (!admin) {
      const why = this.pace(sender, now);
      if (why) return { error: why };
    }
    const row = this.sql.exec("INSERT INTO messages (t, name, text, team, sender, owner, media) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      now, n.slice(0, MAX_NAME), t, admin ? 1 : 0, sender, owner, file ? JSON.stringify(file) : null).toArray()[0];
    if (file) this.sql.exec("UPDATE media SET attached = 1 WHERE id = ?", file.id);
    this.prune(row.id, now);
    return { message: this.message(row.id) };
  }

  // The owner, or the team, changes a message's text: {message} or {error}.
  edit(id, text, { owner, admin = false }) {
    const m = this.message(id);
    if (!m) return { error: "gone" };
    if (!admin && (!owner || m.owner !== owner)) return { error: "forbidden" };
    const t = cleanText(text);
    if (t || !m.media) {
      const why = refuse(t, { admin });
      if (why) return { error: why };
    }
    this.sql.exec("UPDATE messages SET text = ?, edited = 1 WHERE id = ?", t, id);
    return { message: this.message(id) };
  }

  // The owner, or the team, deletes a message (and its file): true if done.
  remove(id, { owner, admin = false } = {}) {
    const m = this.message(id);
    if (!m || (!admin && (!owner || m.owner !== owner))) return false;
    this.drop(`id = ?`, id);
    return true;
  }

  // Deletes the messages matching `where`, with their files.
  drop(where, ...bindings) {
    for (const m of this.sql.exec(`SELECT media FROM messages WHERE ${where}`, ...bindings).toArray())
      if (m.media) this.dropMedia(JSON.parse(m.media).id);
    this.sql.exec(`DELETE FROM messages WHERE ${where}`, ...bindings);
  }

  dropMedia(id) {
    this.sql.exec("DELETE FROM media_chunks WHERE id = ?", id);
    this.sql.exec("DELETE FROM media WHERE id = ?", id);
  }

  prune(lastId, now) {
    this.drop("id <= ? OR t < ?", lastId - KEEP_COUNT, now - KEEP_TIME);
    for (const m of this.sql.exec("SELECT id FROM media WHERE (attached = 0 AND t < ?) OR t < ?", now - UNUSED, now - KEEP_TIME).toArray())
      this.dropMedia(m.id);
  }

  // Bans whoever wrote message `id` and removes all their messages; the ids
  // removed, for the pages to drop.
  ban(id, now = Date.now()) {
    const row = this.sql.exec("SELECT sender FROM messages WHERE id = ?", id).toArray()[0];
    if (!row) return [];
    this.sql.exec("INSERT OR IGNORE INTO bans (sender, t) VALUES (?, ?)", row.sender, now);
    const ids = this.sql.exec("SELECT id FROM messages WHERE sender = ?", row.sender).toArray().map((r) => r.id);
    this.drop("sender = ?", row.sender);
    for (const m of this.sql.exec("SELECT id FROM media WHERE sender = ?", row.sender).toArray()) this.dropMedia(m.id);
    return ids;
  }

  unbanAll() {
    this.sql.exec("DELETE FROM bans");
  }

  // Stores an upload: {media: {id, kind, mime, size}} or {error}.
  saveMedia(bytes, { kind, owner, sender, now = Date.now() }) {
    if (this.banned(sender)) return { error: "banned" };
    if (!this.nameOf(owner)) return { error: "name" };
    const type = sniff(bytes, kind);
    if (!type || (kind && type.kind !== kind)) return { error: "media_type" };
    if (!bytes.length || bytes.length > MEDIA_MAX[type.kind]) return { error: "media_size" };
    if (this.sql.exec("SELECT COUNT(*) AS n FROM media WHERE sender = ? AND t > ?", sender, now - HOUR).toArray()[0].n >= MEDIA_PER_HOUR)
      return { error: "media_slow" };
    this.prune(0, now);
    const used = this.sql.exec("SELECT COALESCE(SUM(size), 0) AS n FROM media").toArray()[0].n;
    if (used + bytes.length > MEDIA_TOTAL) return { error: "media_full" };
    const id = randomId();
    const chunks = Math.ceil(bytes.length / CHUNK);
    for (let n = 0; n < chunks; n++)
      this.sql.exec("INSERT INTO media_chunks (id, n, data) VALUES (?, ?, ?)", id, n, bytes.subarray(n * CHUNK, (n + 1) * CHUNK));
    this.sql.exec("INSERT INTO media (id, t, kind, mime, size, chunks, owner, sender) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id, now, type.kind, type.mime, bytes.length, chunks, owner, sender);
    return { media: { id, kind: type.kind, mime: type.mime, size: bytes.length } };
  }

  // {mime, data} of a file attached to a message, or null.
  media(id) {
    const m = this.sql.exec("SELECT mime, size, attached FROM media WHERE id = ?", String(id)).toArray()[0];
    if (!m || !m.attached) return null;
    const data = new Uint8Array(m.size);
    let at = 0;
    for (const c of this.sql.exec("SELECT data FROM media_chunks WHERE id = ? ORDER BY n", String(id)).toArray()) {
      const part = new Uint8Array(c.data);
      data.set(part, at);
      at += part.length;
    }
    return { mime: m.mime, data };
  }
}
