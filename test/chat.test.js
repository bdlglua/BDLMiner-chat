import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, it } from "node:test";
import handler, { allowedOrigin, senderOf } from "../src/index.js";
import { Hub, sameKey } from "../src/hub.js";
import { cleanName, cleanText, refuse, reservedName } from "../src/moderation.js";
import { Room } from "../src/room.js";

// The Durable Object's SQL interface (ctx.storage.sql.exec) over node:sqlite.
function sqlite() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      const rows = /^\s*SELECT|RETURNING/i.test(query) ? statement.all(...bindings) : (statement.run(...bindings), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
}

const T = Date.UTC(2026, 9, 30, 21, 0, 0);

describe("moderation", () => {
  it("cleans names and text", () => {
    assert.equal(cleanName("  Bob\u200b  the\tminer "), "Bob the miner");
    assert.equal(cleanName("x".repeat(40)).length, 24);
    assert.equal(cleanText("a\r\n\n\n\nb\u202e"), "a\n\nb");
  });

  it("refuses scams, foreign links and overlong messages", () => {
    assert.equal(refuse("Send me your SEED PHRASE"), "blocked");
    assert.equal(refuse("free airdrop here"), "blocked");
    assert.equal(refuse("look at https://evil.example/x"), "link");
    assert.equal(refuse("go to scam.xyz now"), "link");
    assert.equal(refuse("x".repeat(501)), "too_long");
    assert.equal(refuse(""), "empty");
    for (const ok of ["Version 1.9.3 is out", "https://github.com/bdlglua/BDLMinerV1/releases", "join discord.gg/S8kSgD6Xe9",
      "see bdlglua.github.io/BDLMinerV1", "my Bitaxe.Gamma does 1.2 TH/s", "check mempool.space"])
      assert.equal(refuse(ok), null, ok);
    assert.equal(refuse("https://anything.example", { admin: true }), null);
  });

  it("reserves the team's names", () => {
    for (const n of ["Admin", "BDL", "bdlminer", "Modérateur", "Support", "équipe", "B.D.L"]) assert.equal(reservedName(n), true, n);
    for (const n of ["Bob", "minerfan", "Sophie"]) assert.equal(reservedName(n), false, n);
  });
});

describe("room", () => {
  let room;
  beforeEach(() => { room = new Room(sqlite()); });

  it("stores messages and gives them back oldest first, without the sender", () => {
    room.post({ name: "Bob", text: "hello" }, { sender: "s1", now: T });
    room.post({ name: "Ann", text: "hi Bob" }, { sender: "s2", now: T + 1000 });
    const h = room.history();
    assert.deepEqual(h.map((m) => [m.name, m.text, m.team]), [["Bob", "hello", false], ["Ann", "hi Bob", false]]);
    assert.equal("sender" in h[0], false);
  });

  it("slows down a sender, not the others", () => {
    assert.ok(room.post({ name: "Bob", text: "1" }, { sender: "s1", now: T }).message);
    assert.deepEqual(room.post({ name: "Bob", text: "2" }, { sender: "s1", now: T + 1000 }), { error: "slow" });
    assert.ok(room.post({ name: "Ann", text: "3" }, { sender: "s2", now: T + 1000 }).message);
    assert.ok(room.post({ name: "Bob", text: "4" }, { sender: "s1", now: T + 3000 }).message);
    // 20 messages per 10 minutes at most.
    for (let i = 0; i < 18; i++) assert.ok(room.post({ name: "Bob", text: `m${i}` }, { sender: "s1", now: T + 6000 + i * 4000 }).message);
    assert.deepEqual(room.post({ name: "Bob", text: "too many" }, { sender: "s1", now: T + 200000 }), { error: "slow" });
  });

  it("keeps the team's names and badge for the admin", () => {
    assert.deepEqual(room.post({ name: "Admin", text: "x" }, { sender: "s1", now: T }), { error: "reserved" });
    const m = room.post({ name: "BDL", text: "Release 1.9.3 is out" }, { sender: "a", admin: true, now: T }).message;
    assert.equal(m.team, true);
  });

  it("bans the author of a message and removes all their messages", () => {
    const a = room.post({ name: "Spam", text: "one" }, { sender: "bad", now: T }).message.id;
    const b = room.post({ name: "Spam", text: "two" }, { sender: "bad", now: T + 5000 }).message.id;
    room.post({ name: "Ann", text: "ok" }, { sender: "good", now: T + 6000 });
    assert.deepEqual(room.ban(a).sort(), [a, b].sort());
    assert.deepEqual(room.history().map((m) => m.name), ["Ann"]);
    assert.deepEqual(room.post({ name: "New name", text: "hi" }, { sender: "bad", now: T + 99999 }), { error: "banned" });
    room.unbanAll();
    assert.ok(room.post({ name: "New name", text: "sorry" }, { sender: "bad", now: T + 199999 }).message);
  });

  it("keeps the last 200 messages of the last 7 days", () => {
    for (let i = 0; i < 210; i++) room.post({ name: `u${i}`, text: "x" }, { sender: `s${i}`, now: T + i });
    assert.equal(room.sql.exec("SELECT COUNT(*) AS n FROM messages").toArray()[0].n, 200);
    room.post({ name: "late", text: "x" }, { sender: "z", now: T + 8 * 24 * 3600 * 1000 });
    assert.deepEqual(room.history().map((m) => m.name), ["late"]);
  });
});

describe("hub", () => {
  let room, hub, sockets;
  const socket = (sender) => ({ sent: [], att: { sender, admin: false }, send(t) { this.sent.push(JSON.parse(t)); } });
  beforeEach(() => {
    room = new Room(sqlite());
    sockets = [];
    hub = new Hub(room, {
      sockets: () => sockets, attachment: (ws) => ws.att, setAttachment: (ws, v) => { ws.att = v; }, adminKey: "k3y",
    });
  });

  it("greets a newcomer with the history and tells everyone how many are online", () => {
    room.post({ name: "Bob", text: "earlier" }, { sender: "s", now: T });
    const a = socket("a"); sockets.push(a); hub.joined(a);
    const b = socket("b"); sockets.push(b); hub.joined(b);
    assert.equal(b.sent[0].type, "hello");
    assert.deepEqual(b.sent[0].messages.map((m) => m.text), ["earlier"]);
    assert.deepEqual(a.sent.at(-1), { type: "online", count: 2 });
    hub.left(b);
    assert.deepEqual(a.sent.at(-1), { type: "online", count: 1 });
  });

  it("broadcasts messages and answers errors to the sender only", () => {
    const a = socket("a"), b = socket("b"); sockets.push(a, b);
    hub.receive(a, JSON.stringify({ type: "say", name: "Bob", text: "hello all" }), T);
    assert.equal(b.sent.at(-1).message.text, "hello all");
    hub.receive(a, JSON.stringify({ type: "say", name: "Bob", text: "free airdrop" }), T + 9000);
    assert.deepEqual(a.sent.at(-1), { type: "error", error: "blocked" });
    assert.equal(b.sent.length, 1);
    hub.receive(a, "not json", T);
    assert.deepEqual(a.sent.at(-1), { type: "error", error: "invalid" });
  });

  it("lets only the admin delete and ban", () => {
    const a = socket("a"), mod = socket("m"); sockets.push(a, mod);
    hub.receive(a, JSON.stringify({ type: "say", name: "Spam", text: "spam" }), T);
    const id = a.sent.at(-1).message.id;
    hub.receive(a, JSON.stringify({ type: "delete", id }), T);
    assert.deepEqual(a.sent.at(-1), { type: "error", error: "forbidden" });
    hub.receive(mod, JSON.stringify({ type: "auth", key: "wrong" }), T);
    assert.deepEqual(mod.sent.at(-1), { type: "auth", ok: false });
    hub.receive(mod, JSON.stringify({ type: "auth", key: "k3y" }), T);
    assert.deepEqual(mod.sent.at(-1), { type: "auth", ok: true });
    hub.receive(mod, JSON.stringify({ type: "ban", id }), T);
    assert.deepEqual(a.sent.at(-1), { type: "removed", ids: [id] });
    hub.receive(a, JSON.stringify({ type: "say", name: "Spam2", text: "again" }), T + 60000);
    assert.deepEqual(a.sent.at(-1), { type: "error", error: "banned" });
  });

  it("refuses the admin key when none is configured", () => {
    assert.equal(sameKey("", undefined), false);
    assert.equal(sameKey(undefined, "k"), false);
    assert.equal(sameKey("k", "k"), true);
  });
});

describe("worker", () => {
  it("opens the room only to the site's pages", async () => {
    assert.equal(allowedOrigin("https://bdlglua.github.io"), true);
    assert.equal(allowedOrigin("https://evil.example"), false);
    assert.equal(allowedOrigin(null), false);
    const env = { ROOM: { idFromName: () => "x", get: () => ({ fetch: async () => new Response("room") }) } };
    const ws = (origin) => new Request("https://chat.example/ws", { headers: { Upgrade: "websocket", ...(origin ? { Origin: origin } : {}) } });
    assert.equal((await handler.fetch(ws("https://evil.example"), env)).status, 403);
    assert.equal(await (await handler.fetch(ws("https://bdlglua.github.io"), env)).text(), "room");
    assert.equal((await handler.fetch(new Request("https://chat.example/ws"), env)).status, 426);
  });

  it("serves the last messages to the site", async () => {
    const env = { ROOM: { idFromName: () => "x", get: () => ({ recent: async () => [{ id: 1, name: "Bob", text: "hi" }] }) } };
    const res = await handler.fetch(new Request("https://chat.example/api/messages", { headers: { Origin: "https://bdlglua.github.io" } }), env);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://bdlglua.github.io");
    assert.deepEqual((await res.json()).messages[0].name, "Bob");
  });

  it("identifies senders by a keyed hash of their address", async () => {
    const req = (ip) => new Request("https://x/", { headers: { "CF-Connecting-IP": ip } });
    const a = await senderOf(req("1.2.3.4"), "secret");
    assert.match(a, /^[0-9a-f]{24}$/);
    assert.equal(a, await senderOf(req("1.2.3.4"), "secret"));
    assert.notEqual(a, await senderOf(req("1.2.3.5"), "secret"));
    assert.notEqual(a, await senderOf(req("1.2.3.4"), "other"));
  });
});
