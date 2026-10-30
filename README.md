# BDLMiner chat

The live chat of the [BDLMiner site](https://bdlglua.github.io/BDLMinerV1/): the round
bubble at the bottom right. Visitors pick a name and talk, without an account; the
team signs in with a key to get a badge and moderate.

## Names

Each browser keeps a random secret code. The first message registers the name chosen
with that code (the room stores only the code's hash): the name then belongs to it,
whatever its spelling ("Bob", "bob", "B.o.b", "Böb" are one name), and it can change
only after **30 days** (a different capitalisation is not a change). In the chat's
settings, *Show my QR code* shows the site's address with the code in its fragment
(`#chat-code=…`, never sent to a server): scanned by another device, it opens the chat
there with the same name, and the page takes the code out of its address at once. At most 3 new names
a day come from one connection, so that clearing the browser does not dodge the wait.
The team's names (admin, BDL…, moderator, support, team…) are kept for the team, who
may take any name, even one already registered, at any time.

## Messages, photos, voice and video

Members edit or delete their own messages (the team any message). A message may carry
one file, uploaded first to `POST /api/media?kind=image|audio|video` with the browser's
code in `X-Chat-Code`, then attached by its id:

- **photos** (JPEG, PNG, WebP, GIF), made smaller in the browser, up to 3 MB;
- **voice messages** recorded in the browser (WebM/Ogg Opus, MP4 audio), up to 60 s
  and 2 MB;
- **videos** (MP4, MOV, WebM) up to 8 MB.

The type is read from the file's first bytes, never from what the page says, and the
file is served from `/media/<id>` with that type, byte ranges (for Safari's videos) and a
sandboxing policy, so that nothing in it can run as a page. At most 10 files an hour per
sender and 400 MB in all; a file is kept with its message (7 days) and dropped with it,
or after an hour if it was never sent.

It runs as a [Cloudflare Worker](https://developers.cloudflare.com/workers/) (free plan)
with one Durable Object: the room. It holds the WebSockets with the hibernation API (an
idle room costs nothing) and keeps the last 200 messages, at most 7 days, in SQLite.

## What it accepts

- Names up to 24 characters, messages up to 500; invisible and control characters are
  removed.
- One message every 3 seconds and 20 every 10 minutes per sender.
- No scam phrases (seed phrase, private key, airdrop, giveaway, "DM me"…).
- Links only to GitHub, Discord, Reddit, mempool.space and the project's own sites.
- The team's names (admin, BDL, BDLMiner, moderator, support, team…) only for the team.
- Only the site's pages may open the room (checked on the WebSocket's `Origin`).

The sender of a message is a keyed hash of its network address (`CHAT_SECRET`), kept
with the message for bans; the address itself is never stored.

## Moderation

In the chat, type `/login <key>` with the `CHAT_ADMIN_KEY`: the browser remembers it,
your messages carry a *team* badge, and every message gets **Delete** and **Ban**
buttons. *Ban* removes all the messages of their author, who can no longer write.
`/logout` forgets the key.

## Protocol

`GET /ws` (WebSocket) — the client sends JSON: `{"type":"identify","code"}` (its
secret code), `{"type":"register","name"}`, `{"type":"say","text","media":{"id"}}`,
`{"type":"edit","id","text"}`, `{"type":"delete","id"}`, `{"type":"auth","key"}`, and
for the team `{"type":"ban","id"}` and `{"type":"unbanall"}`. The room answers `hello`
(last 50 messages, people online), `you` (`name`, `changeAt`), `mine` (ids of one's own
messages shown), `message` and `edited` (each with `own` for that page), `removed`
(ids), `online` (count), `auth` and `error` (`name`, `reserved`, `taken`, `wait` with
`until`, `too_many`, `empty`, `too_long`, `blocked`, `link`, `slow`, `banned`,
`forbidden`, `invalid`, `gone`, `media`).

`POST /api/media?kind=…` — a file, answered `{media: {id, kind, mime, size}}` or
`{error}` (`name`, `banned`, `media_type`, `media_size`, `media_slow`, `media_full`).
`GET /media/<id>` — a file attached to a message.

`GET /api/messages` — the last 50 messages as JSON, for the site.

## Setup

1. **GitHub** (Settings → Secrets and variables → Actions → secrets):
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (as for the other Workers),
   `CHAT_ADMIN_KEY` (the moderators' key: long and random) and `CHAT_SECRET` (another
   long random value, for the senders' hashes).
2. Run the **Test and deploy** workflow, or push to `main`. The room answers at
   `wss://bdlminer-chat.<your-subdomain>.workers.dev/ws`, the address in the site.

## Development

```sh
npm test    # Node 22+: the room on node:sqlite, the hub and the Worker on fakes
```

## License

[GNU GPL v3.0](LICENSE), like BDLMiner V1.
