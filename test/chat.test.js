import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, it } from "node:test";
import handler, { allowedOrigin, senderOf, serve } from "../src/index.js";
import { Hub, sameKey } from "../src/hub.js";
import { cleanName, cleanText, refuse, reservedName } from "../src/moderation.js";
import { CHANGE_AFTER, MEDIA_MAX, Room, sniff } from "../src/room.js";

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
  // A visitor: registers `name` for id `id` (sender = its address hash), then posts.
  const say = (id, name, text, now, { sender = id, admin = false } = {}) => {
    if (room.nameOf(id)?.name !== name) {
      const r = room.register(id, name, { sender, admin, now });
      if (r.error) return r;
    }
    return room.post({ text }, { sender, name: room.nameOf(id)?.name, admin, now });
  };

  it("stores messages and gives them back oldest first, without the sender", () => {
    say("s1", "Bob", "hello", T);
    say("s2", "Ann", "hi Bob", T + 1000);
    const h = room.history();
    assert.deepEqual(h.map((m) => [m.name, m.text, m.team]), [["Bob", "hello", false], ["Ann", "hi Bob", false]]);
    assert.equal("sender" in h[0], false);
  });

  it("needs a registered name to post", () => {
    assert.deepEqual(room.post({ text: "hi" }, { sender: "s", name: undefined, now: T }), { error: "name" });
  });

  it("keeps a name for its owner, changeable after 30 days", () => {
    assert.deepEqual(room.register("me", "Bob", { sender: "s1", now: T }), { name: "Bob", changeAt: T + CHANGE_AFTER });
    // Taken, whatever the case, accents or dots.
    for (const n of ["bob", "B.o.b", "Böb"]) assert.deepEqual(room.register("other", n, { sender: "s2", now: T }), { error: "taken" });
    // The owner may not take another name before 30 days, but may change its spelling.
    assert.deepEqual(room.register("me", "Robert", { sender: "s1", now: T + 1000 }), { error: "wait", until: T + CHANGE_AFTER });
    assert.deepEqual(room.register("me", "BOB", { sender: "s1", now: T + 2000 }), { name: "BOB", changeAt: T + CHANGE_AFTER });
    assert.deepEqual(room.register("me", "Robert", { sender: "s1", now: T + CHANGE_AFTER }), { name: "Robert", changeAt: T + 2 * CHANGE_AFTER });
    // The old name is free again.
    assert.equal(room.register("other", "Bob", { sender: "s2", now: T + CHANGE_AFTER + 1 }).name, "Bob");
  });

  it("limits new names per connection, so that clearing the browser does not dodge the wait", () => {
    for (const [i, n] of ["A1", "A2", "A3"].entries()) assert.equal(room.register(`id${i}`, n, { sender: "home", now: T + i }).name, n);
    assert.deepEqual(room.register("id9", "A4", { sender: "home", now: T + 10 }), { error: "too_many" });
    assert.equal(room.register("id9", "A4", { sender: "home", now: T + 25 * 3600 * 1000 }).name, "A4");
  });

  it("lets the team take any name, reserved or taken, at any time", () => {
    assert.deepEqual(room.register("u", "bdlglua", { sender: "s", now: T }), { error: "reserved" });
    room.register("u", "Satoshi", { sender: "s", now: T });
    assert.equal(room.register("team", "bdlglua", { sender: "a", admin: true, now: T }).name, "bdlglua");
    assert.equal(room.register("team", "Satoshi", { sender: "a", admin: true, now: T + 1 }).name, "Satoshi");
    assert.equal(room.nameOf("u"), null);  // taken over
    const m = room.post({ text: "Release 1.9.3 is out" }, { sender: "a", name: "Satoshi", admin: true, now: T + 2 }).message;
    assert.equal(m.team, true);
  });

  it("slows down a sender, not the others", () => {
    assert.ok(say("s1", "Bob", "1", T).message);
    assert.deepEqual(say("s1", "Bob", "2", T + 1000), { error: "slow" });
    assert.ok(say("s2", "Ann", "3", T + 1000).message);
    assert.ok(say("s1", "Bob", "4", T + 3000).message);
    for (let i = 0; i < 18; i++) assert.ok(say("s1", "Bob", `m${i}`, T + 6000 + i * 4000).message);
    assert.deepEqual(say("s1", "Bob", "too many", T + 200000), { error: "slow" });
  });

  it("bans the author of a message and removes all their messages", () => {
    const a = say("bad", "Spam", "one", T).message.id;
    const b = say("bad", "Spam", "two", T + 5000).message.id;
    say("good", "Ann", "ok", T + 6000);
    assert.deepEqual(room.ban(a).sort(), [a, b].sort());
    assert.deepEqual(room.history().map((m) => m.name), ["Ann"]);
    assert.deepEqual(say("bad2", "New name", "hi", T + 99999, { sender: "bad" }), { error: "banned" });
    room.unbanAll();
    assert.ok(say("bad2", "New name", "sorry", T + 199999, { sender: "bad" }).message);
  });

  it("keeps the last 200 messages of the last 7 days", () => {
    room.register("id", "Bob", { sender: "s", now: T });
    for (let i = 0; i < 210; i++) room.post({ text: "x" }, { sender: `s${i}`, name: "Bob", now: T + i });
    assert.equal(room.sql.exec("SELECT COUNT(*) AS n FROM messages").toArray()[0].n, 200);
    room.post({ text: "late" }, { sender: "z", name: "Bob", now: T + 8 * 24 * 3600 * 1000 });
    assert.deepEqual(room.history().map((m) => m.text), ["late"]);
  });
});

describe("hub", () => {
  let room, hub, sockets;
  // A fake page; presence lists go apart, so that `sent` holds the rest.
  const socket = (sender) => ({ sent: [], presence: [], att: { sender, admin: false },
    send(t) { const m = JSON.parse(t); (m.type === "presence" ? this.presence : this.sent).push(m); } });
  const msg = (ws, value, now = T) => hub.receive(ws, JSON.stringify(value), now);
  const CODE = "a".repeat(32), CODE2 = "b".repeat(32);
  beforeEach(() => {
    room = new Room(sqlite());
    sockets = [];
    hub = new Hub(room, {
      sockets: () => sockets, attachment: (ws) => ws.att, setAttachment: (ws, v) => { ws.att = v; }, adminKey: "k3y",
    });
  });

  it("greets a newcomer with the history and tells everyone how many are online", async () => {
    room.register("x", "Bob", { sender: "s", now: T });
    room.post({ text: "earlier" }, { sender: "s", name: "Bob", now: T });
    const a = socket("a"); sockets.push(a); hub.joined(a);
    const b = socket("b"); sockets.push(b); hub.joined(b);
    assert.equal(b.sent[0].type, "hello");
    assert.deepEqual(b.sent[0].messages.map((m) => m.text), ["earlier"]);
    assert.deepEqual(a.sent.at(-1), { type: "online", count: 2 });
    hub.left(b);
    assert.deepEqual(a.sent.at(-1), { type: "online", count: 1 });
  });

  it("identifies a browser by its code and remembers its name", async () => {
    const a = socket("a"); sockets.push(a);
    await msg(a, { type: "identify", code: CODE });
    assert.deepEqual(a.sent.slice(-2), [{ type: "you", name: null, changeAt: null }, { type: "mine", ids: [] }]);
    await msg(a, { type: "say", text: "hi" });
    assert.deepEqual(a.sent.at(-1), { type: "error", error: "name" });
    await msg(a, { type: "register", name: "Bob" });
    assert.deepEqual(a.sent.at(-1), { type: "you", name: "Bob", changeAt: T + CHANGE_AFTER });
    // Another device with the same code is the same person.
    const phone = socket("p"); sockets.push(phone);
    await msg(phone, { type: "identify", code: CODE });
    assert.equal(phone.sent.at(-2).name, "Bob");
    await msg(phone, { type: "say", text: "from my phone" });
    assert.equal(a.sent.at(-1).message.name, "Bob");
    // Someone else cannot take it.
    const c = socket("c"); sockets.push(c);
    await msg(c, { type: "identify", code: CODE2 });
    await msg(c, { type: "register", name: "bob" });
    assert.deepEqual(c.sent.at(-1), { type: "error", error: "taken" });
    await msg(c, { type: "identify", code: "short" });
    assert.deepEqual(c.sent.at(-1), { type: "error", error: "invalid" });
  });

  it("broadcasts messages and answers errors to the sender only", async () => {
    const a = socket("a"), b = socket("b"); sockets.push(a, b);
    await msg(a, { type: "identify", code: CODE });
    await msg(a, { type: "register", name: "Bob" });
    await msg(a, { type: "say", text: "hello all" });
    assert.equal(b.sent.at(-1).message.text, "hello all");
    await msg(a, { type: "say", text: "free airdrop" }, T + 9000);
    assert.deepEqual(a.sent.at(-1), { type: "error", error: "blocked" });
    assert.equal(b.sent.length, 1);
    await hub.receive(a, "not json", T);
    assert.deepEqual(a.sent.at(-1), { type: "error", error: "invalid" });
  });

  it("lets only the admin delete and ban, and take a team name", async () => {
    const a = socket("a"), mod = socket("m"); sockets.push(a, mod);
    await msg(a, { type: "identify", code: CODE });
    await msg(a, { type: "register", name: "Spam" });
    await msg(a, { type: "say", text: "spam" });
    const id = a.sent.at(-1).message.id;
    await msg(mod, { type: "identify", code: CODE2 });
    await msg(mod, { type: "delete", id });
    assert.deepEqual(mod.sent.at(-1), { type: "error", error: "forbidden" });
    await msg(mod, { type: "register", name: "bdlglua" });
    assert.deepEqual(mod.sent.at(-1), { type: "error", error: "reserved" });
    await msg(mod, { type: "auth", key: "wrong" });
    assert.deepEqual(mod.sent.at(-1), { type: "auth", ok: false });
    await msg(mod, { type: "auth", key: "k3y" });
    assert.deepEqual(mod.sent.at(-1), { type: "auth", ok: true });
    await msg(mod, { type: "register", name: "bdlglua" });
    assert.equal(mod.sent.at(-1).name, "bdlglua");
    await msg(mod, { type: "ban", id });
    assert.deepEqual(a.sent.at(-1), { type: "removed", ids: [id] });
    await msg(a, { type: "say", text: "again" }, T + 60000);
    assert.deepEqual(a.sent.at(-1), { type: "error", error: "banned" });
  });

  it("lets a member edit and delete their own messages, and tells each page which are its own", async () => {
    const a = socket("a"), b = socket("b"); sockets.push(a, b);
    await msg(a, { type: "identify", code: CODE });
    await msg(a, { type: "register", name: "Bob" });
    await msg(b, { type: "identify", code: CODE2 });
    await msg(b, { type: "register", name: "Ann" });
    await msg(a, { type: "say", text: "helo" });
    const id = a.sent.at(-1).message.id;
    assert.equal(a.sent.at(-1).message.own, true);
    assert.equal(b.sent.at(-1).message.own, false);
    assert.equal("owner" in b.sent.at(-1).message, false);
    await msg(b, { type: "edit", id, text: "hacked" });
    assert.deepEqual(b.sent.at(-1), { type: "error", error: "forbidden" });
    await msg(a, { type: "edit", id, text: "hello" });
    assert.deepEqual([b.sent.at(-1).type, b.sent.at(-1).message.text, b.sent.at(-1).message.edited], ["edited", "hello", true]);
    await msg(a, { type: "edit", id, text: "free airdrop" });
    assert.deepEqual(a.sent.at(-1), { type: "error", error: "blocked" });
    // A page that comes back learns which shown messages are its own.
    const again = socket("a2"); sockets.push(again); hub.joined(again);
    await msg(again, { type: "identify", code: CODE });
    assert.deepEqual(again.sent.at(-1), { type: "mine", ids: [id] });
    await msg(a, { type: "delete", id });
    assert.deepEqual(b.sent.at(-1), { type: "removed", ids: [id] });
  });

  it("lists the members online, one per person, the team first, and counts the visitors without a name", async () => {
    const a = socket("a"), a2 = socket("a"), b = socket("b"), guest = socket("g"), mod = socket("m");
    sockets.push(a, a2, b, guest, mod);
    for (const ws of sockets) hub.joined(ws);
    await msg(a, { type: "identify", code: CODE });
    await msg(a, { type: "register", name: "Zoé" });
    await msg(a2, { type: "identify", code: CODE });  // the same person, another tab
    await msg(b, { type: "identify", code: CODE2 });
    await msg(b, { type: "register", name: "Ann" });
    await msg(mod, { type: "identify", code: "c".repeat(32) });
    await msg(mod, { type: "auth", key: "k3y" });
    await msg(mod, { type: "register", name: "bdlglua" });
    const last = guest.presence.at(-1);
    assert.deepEqual(last, { type: "presence", guests: 1, members: [
      { name: "bdlglua", team: true }, { name: "Ann", team: false }, { name: "Zoé", team: false }] });
    hub.left(b);
    assert.deepEqual(guest.presence.at(-1).members.map((m) => m.name), ["bdlglua", "Zoé"]);
  });

  it("stops guessing the admin key after 5 wrong keys an hour, for that address only", async () => {
    const guess = socket("x"), other = socket("y");
    sockets.push(guess, other);
    for (let i = 0; i < 5; i++) {
      await msg(guess, { type: "auth", key: "wrong" + i }, T + i);
      assert.deepEqual(guess.sent.at(-1), { type: "auth", ok: false });
    }
    await msg(guess, { type: "auth", key: "k3y" }, T + 10);
    assert.deepEqual(guess.sent.at(-1), { type: "auth", ok: false, error: "slow" });
    assert.equal(guess.att.admin, false);
    await msg(other, { type: "auth", key: "k3y" }, T + 10);
    assert.deepEqual(other.sent.at(-1), { type: "auth", ok: true });
    await msg(guess, { type: "auth", key: "k3y" }, T + 3600 * 1000 + 5);
    assert.deepEqual(guess.sent.at(-1), { type: "auth", ok: true });
  });

  it("refuses the admin key when none is configured", () => {
    assert.equal(sameKey("", undefined), false);
    assert.equal(sameKey(undefined, "k"), false);
    assert.equal(sameKey("k", "k"), true);
  });
});

describe("media", () => {
  const jpeg = (size = 1000) => { const b = new Uint8Array(size); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
  const webm = (size = 1000) => { const b = new Uint8Array(size); b.set([0x1a, 0x45, 0xdf, 0xa3]); return b; };
  const mp4 = (brand = "isom") => { const b = new Uint8Array(500); b.set([...new TextEncoder().encode("\0\0\0\x18ftyp" + brand)]); return b; };
  let room;
  beforeEach(() => { room = new Room(sqlite()); room.register("me", "Bob", { sender: "s", now: T }); });

  it("knows files by their first bytes, not by what the page says", () => {
    assert.deepEqual(sniff(jpeg()), { kind: "image", mime: "image/jpeg" });
    assert.deepEqual(sniff(webm(), "audio"), { kind: "audio", mime: "audio/webm" });
    assert.deepEqual(sniff(webm(), "video"), { kind: "video", mime: "video/webm" });
    assert.deepEqual(sniff(mp4("M4A ")), { kind: "audio", mime: "audio/mp4" });
    assert.deepEqual(sniff(mp4("qt  ")), { kind: "video", mime: "video/quicktime" });
    assert.equal(sniff(new TextEncoder().encode("<svg onload=alert(1)>")), null);
    assert.equal(sniff(new TextEncoder().encode("<!doctype html><script>")), null);
  });

  it("stores an upload, attaches it to one message and serves it", () => {
    const big = jpeg(2.5 * 1024 * 1024);  // three chunks
    const up = room.saveMedia(big, { kind: "image", owner: "me", sender: "s", now: T });
    assert.equal(up.media.kind, "image");
    assert.equal(room.media(up.media.id), null);  // not served before it is in a message
    const m = room.post({ text: "", media: { id: up.media.id } }, { sender: "s", name: "Bob", owner: "me", now: T }).message;
    assert.deepEqual(m.media, up.media);
    assert.deepEqual(room.media(up.media.id).data, big);
    // Someone else's upload, or one already used, cannot be attached.
    assert.deepEqual(room.post({ text: "x", media: { id: up.media.id } }, { sender: "s", name: "Bob", owner: "me", now: T + 5000 }), { error: "media" });
    assert.ok(room.remove(m.id, { owner: "me" }));
    assert.equal(room.media(up.media.id), null);
  });

  it("refuses wrong types, files too large, too many uploads and senders without a name", () => {
    assert.deepEqual(room.saveMedia(new TextEncoder().encode("<html>"), { kind: "image", owner: "me", sender: "s", now: T }), { error: "media_type" });
    assert.deepEqual(room.saveMedia(jpeg(), { kind: "video", owner: "me", sender: "s", now: T }), { error: "media_type" });
    assert.deepEqual(room.saveMedia(jpeg(MEDIA_MAX.image + 1), { kind: "image", owner: "me", sender: "s", now: T }), { error: "media_size" });
    assert.deepEqual(room.saveMedia(jpeg(), { kind: "image", owner: "nobody", sender: "s", now: T }), { error: "name" });
    for (let i = 0; i < 10; i++) assert.ok(room.saveMedia(jpeg(), { kind: "image", owner: "me", sender: "s", now: T + i }).media);
    assert.deepEqual(room.saveMedia(jpeg(), { kind: "image", owner: "me", sender: "s", now: T + 20 }), { error: "media_slow" });
    // Uploads never attached are dropped after an hour.
    room.saveMedia(jpeg(), { kind: "image", owner: "me", sender: "other", now: T + 2 * 3600 * 1000 });
    assert.equal(room.sql.exec("SELECT COUNT(*) AS n FROM media").toArray()[0].n, 1);
  });

  it("serves byte ranges, as Safari needs for videos", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const full = serve(new Request("https://x/media/a"), "video/mp4", data);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("Content-Security-Policy"), "default-src 'none'; sandbox");
    assert.equal(full.headers.get("Access-Control-Allow-Origin"), "*");
    const part = serve(new Request("https://x/media/a", { headers: { Range: "bytes=2-5" } }), "video/mp4", data);
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("Content-Range"), "bytes 2-5/10");
    assert.deepEqual(new Uint8Array(await part.arrayBuffer()), new Uint8Array([3, 4, 5, 6]));
    const tail = serve(new Request("https://x/media/a", { headers: { Range: "bytes=-3" } }), "video/mp4", data);
    assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), new Uint8Array([8, 9, 10]));
    assert.equal(serve(new Request("https://x/media/a", { headers: { Range: "bytes=20-" } }), "video/mp4", data).status, 416);
  });
});

describe("worker", () => {
  it("opens the room only to the site's pages", async () => {
    assert.equal(allowedOrigin("https://bdlglua.github.io"), true);
    assert.equal(allowedOrigin("https://miner.bdl-pool.com"), true);  // the site's own domain
    for (const other of ["http://miner.bdl-pool.com", "https://miner.bdl-pool.com.evil.example", "https://evil.bdl-pool.com",
      "https://minerxbdl-pool.com", "https://miner.bdl-pool.com:8443"]) assert.equal(allowedOrigin(other), false);
    assert.equal(allowedOrigin("https://evil.example"), false);
    assert.equal(allowedOrigin(null), false);
    const env = { ROOM: { idFromName: () => "x", get: () => ({ fetch: async () => new Response("room") }) } };
    const ws = (origin) => new Request("https://chat.example/ws", { headers: { Upgrade: "websocket", ...(origin ? { Origin: origin } : {}) } });
    assert.equal((await handler.fetch(ws("https://evil.example"), env)).status, 403);
    assert.equal(await (await handler.fetch(ws("https://bdlglua.github.io"), env)).text(), "room");
    assert.equal(await (await handler.fetch(ws("https://miner.bdl-pool.com"), env)).text(), "room");
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
