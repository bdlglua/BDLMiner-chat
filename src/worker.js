// Entry point: the request handler and the Durable Object of the room, which
// holds the WebSockets with the hibernation API (an idle room costs nothing).

import { DurableObject } from "cloudflare:workers";
import { Hub } from "./hub.js";
import { HISTORY, Room } from "./room.js";

export { default } from "./index.js";

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = new Room(ctx.storage.sql);
    this.hub = new Hub(this.room, {
      sockets: () => ctx.getWebSockets(),
      attachment: (ws) => ws.deserializeAttachment() ?? { sender: "", admin: false },
      setAttachment: (ws, value) => ws.serializeAttachment(value),
      adminKey: env.CHAT_ADMIN_KEY,
    });
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sender: request.headers.get("X-Sender") ?? "", admin: false });
    this.hub.joined(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  recent() {
    return this.room.history(HISTORY);
  }

  webSocketMessage(ws, message) {
    this.hub.receive(ws, message);
  }

  webSocketClose(ws, code) {
    this.hub.left(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, "bye");
    } catch {
      // already closed
    }
  }

  webSocketError(ws) {
    this.hub.left(ws);
  }
}
