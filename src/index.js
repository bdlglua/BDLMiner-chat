// BDLMiner chat: the live chat of the BDLMiner site. /ws is the room's
// WebSocket, /api/messages its last messages.

const SITES = [/^https:\/\/bdlglua\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

export function allowedOrigin(origin) {
  return !!origin && SITES.some((re) => re.test(origin));
}

// Who wrote a message, for the rate limits and bans: a keyed hash of the
// network address, never the address itself.
export async function senderOf(request, secret) {
  const address = request.headers.get("CF-Connecting-IP") ?? "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret || "bdlminer-chat"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(address)));
  return [...mac.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function room(env) {
  return env.ROOM.get(env.ROOM.idFromName("site"));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket only", { status: 426 });
      // Only the site's pages: another site cannot open the chat in its visitors' name.
      if (!allowedOrigin(origin)) return new Response("Forbidden", { status: 403 });
      const headers = new Headers(request.headers);
      headers.set("X-Sender", await senderOf(request, env.CHAT_SECRET));
      return room(env).fetch(new Request(request, { headers }));
    }

    if (url.pathname === "/api/messages") {
      if (request.method !== "GET") return new Response("GET only", { status: 405 });
      const messages = await room(env).recent();
      return Response.json({ messages }, {
        headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": allowedOrigin(origin) ? origin : "https://bdlglua.github.io", Vary: "Origin" },
      });
    }

    if (url.pathname === "/") return new Response("BDLMiner chat: OK\n");
    return new Response("Not found", { status: 404 });
  },
};
