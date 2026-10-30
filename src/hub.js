// What the chat room does with each WebSocket message, apart from the
// Workers runtime so that it can be tested: `sockets()` lists the open
// connections, each with `send(text)` and its attachment {sender, admin}.

import { HISTORY } from "./room.js";

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

  receive(ws, raw, now = Date.now()) {
    let m;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(ws, { type: "error", error: "invalid" });
    }
    if (!m || typeof m !== "object" || typeof raw === "string" && raw.length > 4096) return this.send(ws, { type: "error", error: "invalid" });
    const who = this.attachment(ws);
    switch (m.type) {
      case "say": {
        const r = this.room.post({ name: m.name, text: m.text }, { sender: who.sender, admin: who.admin, now });
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
