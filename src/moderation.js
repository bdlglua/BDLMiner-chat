// What the chat accepts: names, message text, links and words.

export const MAX_TEXT = 500;
export const MAX_NAME = 24;

// Scams that target miners (the Discord server's AutoMod list, condensed).
const BLOCKED = [
  "seed phrase", "seedphrase", "recovery phrase", "phrase de récupération", "private key", "clé privée",
  "mnemonic", "airdrop", "giveaway", "double your", "doublez", "investment plan", "plan d'investissement",
  "guaranteed profit", "profit garanti", "dm me", "dm moi", "write me on telegram", "whatsapp me",
  "recover your", "wallet recovery", "récupérer votre wallet", "crypto recovery", "binary option",
  "forex signal", "pump and dump",
];

// Links are allowed only to the project's own places.
const ALLOWED_HOSTS = [
  "github.com", "bdlglua.github.io", "discord.gg", "discord.com", "reddit.com", "www.reddit.com",
  "mempool.space", "bdlminer-stats.bdlminer-bot.workers.dev",
];

// Names the team uses: only a signed-in admin may take them.
const RESERVED = /^(admin|administrat|bdl|bdlminer|mod[ée]rat|moderator|staff|support|[ée]quipe|team|system|syst[èe]me)/i;

// Control characters and invisible format characters, which can hide text.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

export function cleanName(name) {
  return String(name ?? "").replace(/\s+/g, " ").replace(INVISIBLE, "").trim().slice(0, MAX_NAME);
}

export function cleanText(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(INVISIBLE, (c) => (c === "\n" ? c : ""))
    .replace(/\n{3,}/g, "\n\n").trim();
}

// null when the message may go, otherwise why not (a key the page translates).
export function refuse(text, { admin = false } = {}) {
  if (!text) return "empty";
  if (text.length > MAX_TEXT) return "too_long";
  if (admin) return null;
  const lower = text.toLowerCase();
  if (BLOCKED.some((w) => lower.includes(w))) return "blocked";
  for (const m of text.matchAll(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#][^\s]*)?/gi)) {
    const host = m[1].toLowerCase();
    // Bare "word.word" that is not a link-like host (e.g. "1.9.3", "Bitaxe.Gamma") passes.
    if (!/^https?:\/\//i.test(m[0]) && !/\.(com|org|net|io|gg|dev|app|xyz|me|co|fr|link|site|ru|cn|tk)$/i.test(host)) continue;
    if (!ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h))) return "link";
  }
  return null;
}

export function reservedName(name) {
  return RESERVED.test(name.replace(/[\s._-]/g, ""));
}
