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

  joined(ws) {
    this.send(ws, { type: "hello", messages: this.room.history(HISTORY), online: this.sockets().length });
    this.broadcast({ type: "online", count: this.sockets().length });
  }

  left(closing) {
    this.broadcast({ type: "online", count: this.sockets().filter((ws) => ws !== closing).length });
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
        return this.you(ws, id);
      }
      case "register": {
        if (!who.id) return this.send(ws, { type: "error", error: "invalid" });
        const r = this.room.register(who.id, m.name, { sender: who.sender, admin: who.admin, now });
        if (r.error) return this.send(ws, { type: "error", error: r.error, until: r.until });
        return this.send(ws, { type: "you", name: r.name, changeAt: r.changeAt });
      }
      case "say": {
        const name = this.room.nameOf(who.id)?.name;
        const r = this.room.post({ text: m.text }, { sender: who.sender, name, admin: who.admin, now });
        if (r.error) return this.send(ws, { type: "error", error: r.error });
        return this.broadcast({ type: "message", message: r.message });
      }
      case "auth": {
        const ok = sameKey(m.key, this.adminKey);
        if (ok) this.setAttachment(ws, { ...who, admin: true });
        return this.send(ws, { type: "auth", ok });
      }
      case "delete":
      case "ban":
      case "unbanall": {
        if (!who.admin) return this.send(ws, { type: "error", error: "forbidden" });
        if (m.type === "unbanall") {
          this.room.unbanAll();
          return this.send(ws, { type: "done", what: "unbanall" });
        }
        const id = Number(m.id);
        if (!Number.isInteger(id)) return this.send(ws, { type: "error", error: "invalid" });
        const ids = m.type === "ban" ? this.room.ban(id, now) : (this.room.remove(id), [id]);
        return this.broadcast({ type: "removed", ids });
      }
      case "ping":
        return this.send(ws, { type: "pong" });
      default:
        return this.send(ws, { type: "error", error: "invalid" });
    }
  }
}
