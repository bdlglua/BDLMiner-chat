// What the chat room does with each WebSocket message, apart from the
// Workers runtime so that it can be tested: `sockets()` lists the open
// connections, each with `send(text)` and its attachment {sender, admin, id}
// (id: the hash of the browser's secret code, once it identified itself).

import { HISTORY } from "./room.js";

export async function hashCode(code) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("bdlminer-chat:" + code));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sameKey(given, key) {
  if (typeof given !== "string" || !key) return false;
  let diff = given.length ^ key.length;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  return diff === 0;
}

export class Hub {
  constructor(room, { sockets, attachment, setAttachment, adminKey }) {
    this.room = room;
    this.sockets = sockets;
    this.attachment = attachment;
    this.setAttachment = setAttachment;
    this.adminKey = adminKey;
  }

  send(ws, value) {
    try {
      ws.send(JSON.stringify(value));
    } catch {
      // closing: the runtime drops it
    }
  }

  broadcast(value) {
    for (const ws of this.sockets()) this.send(ws, value);
  }

  // A message as one page sees it: `own` when that page wrote it; the
  // owner's id never leaves the server.
  view(message, ws) {
    const { owner, ...rest } = message;
    return { ...rest, own: !!owner && owner === this.attachment(ws).id };
  }

  // A new or edited message, to every page with its own `own` flag.
  share(type, message) {
    for (const ws of this.sockets()) this.send(ws, { type, message: this.view(message, ws) });
  }

  // Who is here: the registered names of the open pages (one per person,
  // however many tabs), the team first, and how many visitors have no name yet.
  presence(closing = null) {
    const members = new Map();
    let guests = 0;
    for (const ws of this.sockets()) {
      if (ws === closing) continue;
      const who = this.attachment(ws);
      const name = who.id ? this.room.nameOf(who.id)?.name : null;
      if (!name) guests++;
      else members.set(who.id, { name, team: !!who.admin || !!members.get(who.id)?.team });
    }
    const list = [...members.values()].sort((a, b) => b.team - a.team || a.name.localeCompare(b.name));
    return { type: "presence", members: list, guests };
  }

  shareThePresence(closing = null) {
    this.broadcast(this.presence(closing));
  }

  joined(ws) {
    this.send(ws, { type: "hello", messages: this.room.history(HISTORY).map((m) => this.view(m, ws)), online: this.sockets().length });
    this.broadcast({ type: "online", count: this.sockets().length });
    this.shareThePresence();
  }

  left(closing) {
    this.broadcast({ type: "online", count: this.sockets().filter((ws) => ws !== closing).length });
    this.shareThePresence(closing);
  }

  you(ws, id) {
    const mine = this.room.nameOf(id);
    this.send(ws, { type: "you", name: mine?.name ?? null, changeAt: mine?.changeAt ?? null });
  }

  async receive(ws, raw, now = Date.now()) {
    let m;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(ws, { type: "error", error: "invalid" });
    }
    if (!m || typeof m !== "object" || typeof raw === "string" && raw.length > 4096) return this.send(ws, { type: "error", error: "invalid" });
    const who = this.attachment(ws);
    switch (m.type) {
      case "identify": {
        if (typeof m.code !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(m.code)) return this.send(ws, { type: "error", error: "invalid" });
        const id = await hashCode(m.code);
        this.setAttachment(ws, { ...this.attachment(ws), id });
        this.you(ws, id);
        // Which of the messages already shown are this page's own.
        this.send(ws, { type: "mine", ids: this.room.history(HISTORY).filter((x) => x.owner === id).map((x) => x.id) });
        return this.shareThePresence();
      }
      case "register": {
        if (!who.id) return this.send(ws, { type: "error", error: "invalid" });
        const r = this.room.register(who.id, m.name, { sender: who.sender, admin: who.admin, now });
        if (r.error) return this.send(ws, { type: "error", error: r.error, until: r.until });
        this.send(ws, { type: "you", name: r.name, changeAt: r.changeAt });
        return this.shareThePresence();
      }
      case "say": {
        const name = this.room.nameOf(who.id)?.name;
        const r = this.room.post({ text: m.text, media: m.media }, { sender: who.sender, name, owner: who.id ?? null, admin: who.admin, now });
        if (r.error) return this.send(ws, { type: "error", error: r.error });
        return this.share("message", r.message);
      }
      case "edit": {
        const id = Number(m.id);
        if (!Number.isInteger(id)) return this.send(ws, { type: "error", error: "invalid" });
        const r = this.room.edit(id, m.text, { owner: who.id, admin: who.admin });
        if (r.error) return this.send(ws, { type: "error", error: r.error });
        return this.share("edited", r.message);
      }
      case "delete": {
        const id = Number(m.id);
        if (!Number.isInteger(id)) return this.send(ws, { type: "error", error: "invalid" });
        if (!this.room.remove(id, { owner: who.id, admin: who.admin })) return this.send(ws, { type: "error", error: "forbidden" });
        return this.broadcast({ type: "removed", ids: [id] });
      }
      case "auth": {
        const ok = sameKey(m.key, this.adminKey);
        if (ok) this.setAttachment(ws, { ...who, admin: true });
        this.send(ws, { type: "auth", ok });
        return ok ? this.shareThePresence() : undefined;
      }
      case "ban":
      case "unbanall": {
        if (!who.admin) return this.send(ws, { type: "error", error: "forbidden" });
        if (m.type === "unbanall") {
          this.room.unbanAll();
          return this.send(ws, { type: "done", what: "unbanall" });
        }
        const id = Number(m.id);
        if (!Number.isInteger(id)) return this.send(ws, { type: "error", error: "invalid" });
        return this.broadcast({ type: "removed", ids: this.room.ban(id, now) });
      }
      case "ping":
        return this.send(ws, { type: "pong" });
      default:
        return this.send(ws, { type: "error", error: "invalid" });
    }
  }
}
