// BDLMiner chat: the live chat of the BDLMiner site. /ws is the room's
// WebSocket, /api/messages its last messages, /api/media takes a photo, voice
// message or video and /media/<id> serves it.

import { MEDIA_MAX } from "./room.js";

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

// A stored file, with byte ranges (Safari plays videos only with them). The
// type comes from the file's own bytes; nothing in it can run as a page.
export function serve(request, mime, data) {
  const headers = {
    "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=604800, immutable",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin", "Content-Disposition": "inline",
    // Public files: the site reads voice messages to draw their waveform.
    "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Length, Content-Range",
  };
  const range = request.headers.get("Range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : data.length - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : data.length - 1;
    start = Math.max(0, start);
    end = Math.min(end, data.length - 1);
    if (start > end) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${data.length}` } });
    return new Response(request.method === "HEAD" ? null : data.slice(start, end + 1), {
      status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${data.length}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(request.method === "HEAD" ? null : data, { headers: { ...headers, "Content-Length": String(data.length) } });
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

    if (url.pathname === "/api/media") {
      const cors = { "Access-Control-Allow-Origin": allowedOrigin(origin) ? origin : "https://bdlglua.github.io", Vary: "Origin" };
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type, X-Chat-Code", "Access-Control-Max-Age": "86400" } });
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      if (!allowedOrigin(origin)) return new Response("Forbidden", { status: 403 });
      const kind = url.searchParams.get("kind");
      if (!Object.hasOwn(MEDIA_MAX, kind ?? "")) return Response.json({ error: "media_type" }, { status: 400, headers: cors });
      const length = Number(request.headers.get("Content-Length") ?? 0);
      if (length > MEDIA_MAX[kind]) return Response.json({ error: "media_size" }, { status: 413, headers: cors });
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > MEDIA_MAX[kind]) return Response.json({ error: "media_size" }, { status: 413, headers: cors });
      const r = await room(env).upload(bytes, { kind, code: request.headers.get("X-Chat-Code"), sender: await senderOf(request, env.CHAT_SECRET) });
      return Response.json(r, { status: r.error ? 400 : 200, headers: cors });
    }

    const file = url.pathname.match(/^\/media\/([0-9a-f]{24})$/);
    if (file) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("GET only", { status: 405 });
      const f = await room(env).file(file[1]);
      if (!f) return new Response("Not found", { status: 404 });
      return serve(request, f.mime, f.data);
    }

    if (url.pathname === "/") return new Response("BDLMiner chat: OK\n");
    return new Response("Not found", { status: 404 });
  },
};
