# BDLMiner chat

The live chat of the [BDLMiner site](https://bdlglua.github.io/BDLMinerV1/): the round
bubble at the bottom right. Visitors pick a name and talk, without an account; the
team signs in with a key to get a badge and moderate.

## Names

Each browser keeps a random secret code. The first message registers the name chosen
with that code (the room stores only the code's hash): the name then belongs to it,
whatever its spelling ("Bob", "bob", "B.o.b", "Böb" are one name), and it can change
only after **30 days** (a different capitalisation is not a change). *My code* copies
the code; `/code <code>` on another device brings the name there. At most 3 new names
a day come from one connection, so that clearing the browser does not dodge the wait.
The team's names (admin, BDL…, moderator, support, team…) are kept for the team, who
may take any name, even one already registered, at any time.

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
secret code), `{"type":"register","name"}`, `{"type":"say","text"}`,
`{"type":"auth","key"}`, and for the team `{"type":"delete"|"ban","id"}` and
`{"type":"unbanall"}`. The room answers `hello` (last 50 messages, people online),
`you` (`name`, `changeAt`), `message`, `removed` (ids), `online` (count), `auth` and
`error` (`name`, `reserved`, `taken`, `wait` with `until`, `too_many`, `empty`,
`too_long`, `blocked`, `link`, `slow`, `banned`, `forbidden`, `invalid`).

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
