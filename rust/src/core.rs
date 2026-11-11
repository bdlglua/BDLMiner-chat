use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;
pub type Result<T> = std::result::Result<T, String>;
pub trait Sql {
    fn exec(&self, query: &str, args: &[Value]) -> Result<Vec<Value>>;
    fn blob(&self, id: &str, n: usize, bytes: &[u8]) -> Result<()>;
    fn blobs(&self, id: &str) -> Result<Vec<Vec<u8>>>;
    fn one(&self, query: &str, args: &[Value]) -> Result<Value> {
        Ok(self
            .exec(query, args)?
            .into_iter()
            .next()
            .unwrap_or(Value::Null))
    }
}
pub fn text(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}
pub fn number(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_f64().map(|n| n as i64))
        .unwrap_or_default()
}
pub fn re(pattern: &str, value: &str) -> bool {
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, regex::Regex>>> = OnceLock::new();
    let mut c = CACHE.get_or_init(Default::default).lock().unwrap();
    c.entry(pattern.into())
        .or_insert_with(|| regex::Regex::new(pattern).unwrap())
        .is_match(value)
}
fn invisible(c: char) -> bool {
    matches!(c,'\0'..='\u{1f}'|'\u{7f}'..='\u{9f}'|'\u{200b}'..='\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2060}'..='\u{206f}'|'\u{feff}')
}
fn cut(value: &str, limit: usize) -> String {
    let mut n = 0;
    value
        .chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= limit
        })
        .collect()
}
pub fn clean_name(value: &str) -> String {
    cut(
        value
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .filter(|c| !invisible(*c))
            .collect::<String>()
            .trim(),
        24,
    )
}
pub fn clean_text(value: &str) -> String {
    let raw = value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| *c == '\n' || !invisible(*c))
        .collect::<String>();
    let mut out = String::new();
    let mut lines = 0;
    for c in raw.trim().chars() {
        if c == '\n' {
            lines += 1;
        } else {
            lines = 0;
        }
        if lines <= 2 {
            out.push(c);
        }
    }
    out
}
pub fn fold(name: &str) -> String {
    name.nfkd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .flat_map(char::to_lowercase)
        .filter(|c| !c.is_whitespace() && !"._-".contains(*c))
        .collect()
}
pub fn reserved(name: &str) -> bool {
    re(
        r"(?i)^(admin|administrat|bdl|bdlminer|mod[ée]rat|moderator|staff|support|[ée]quipe|team|system|syst[èe]me)",
        &name
            .chars()
            .filter(|c| !c.is_whitespace() && !"._-".contains(*c))
            .collect::<String>(),
    )
}
pub fn refuse(value: &str, admin: bool) -> Option<&'static str> {
    if value.is_empty() {
        return Some("empty");
    }
    if value.encode_utf16().count() > 500 {
        return Some("too_long");
    }
    if admin {
        return None;
    }
    let lower = value.to_lowercase();
    if [
        "seed phrase",
        "seedphrase",
        "recovery phrase",
        "phrase de récupération",
        "private key",
        "clé privée",
        "mnemonic",
        "airdrop",
        "giveaway",
        "double your",
        "doublez",
        "investment plan",
        "plan d'investissement",
        "guaranteed profit",
        "profit garanti",
        "dm me",
        "dm moi",
        "write me on telegram",
        "whatsapp me",
        "recover your",
        "wallet recovery",
        "récupérer votre wallet",
        "crypto recovery",
        "binary option",
        "forex signal",
        "pump and dump",
    ]
    .iter()
    .any(|w| lower.contains(w))
    {
        return Some("blocked");
    }
    let pattern =
        regex::Regex::new(r"(?i)\b(?:https?://)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#][^\s]*)?")
            .unwrap();
    for m in pattern.captures_iter(value) {
        let host = m[1].to_lowercase();
        if !m[0].to_ascii_lowercase().starts_with("http")
            && !re(
                r"(?i)\.(com|org|net|io|gg|dev|app|xyz|me|co|fr|link|site|ru|cn|tk)$",
                &host,
            )
        {
            continue;
        }
        if ![
            "github.com",
            "bdlglua.github.io",
            "miner.bdl-pool.com",
            "discord.gg",
            "discord.com",
            "reddit.com",
            "www.reddit.com",
            "mempool.space",
            "bdlminer-stats.bdlminer-bot.workers.dev",
        ]
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
        {
            return Some("link");
        }
    }
    None
}
pub fn code(value: &str) -> bool {
    re(r"^[A-Za-z0-9_-]{16,128}$", value)
}
pub fn hash_code(value: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("bdlminer-chat:{value}").as_bytes())
    )
}
pub fn same(given: &str, key: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    let mut diff = given.len() ^ key.len();
    for (i, b) in key.bytes().enumerate() {
        diff |= usize::from(b ^ given.as_bytes().get(i).copied().unwrap_or(0));
    }
    diff == 0
}
pub fn allowed_origin(value: &str) -> bool {
    ["https://miner.bdl-pool.com", "https://bdlglua.github.io"].contains(&value)
        || re(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$", value)
}
pub fn max_media(kind: &str) -> usize {
    match kind {
        "image" => 3 * 1024 * 1024,
        "audio" => 2 * 1024 * 1024,
        "video" => 8 * 1024 * 1024,
        _ => 0,
    }
}
pub fn sniff(bytes: &[u8], kind: &str) -> Option<(&'static str, &'static str)> {
    let at = |offset: usize, text: &[u8]| bytes.get(offset..offset + text.len()) == Some(text);
    if at(0, &[255, 216, 255]) {
        Some(("image", "image/jpeg"))
    } else if at(0, b"\x89PNG\r\n\x1a\n") {
        Some(("image", "image/png"))
    } else if at(0, b"GIF87a") || at(0, b"GIF89a") {
        Some(("image", "image/gif"))
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        Some(("image", "image/webp"))
    } else if at(4, b"ftyp") {
        if kind == "audio" || at(8, b"M4A ") {
            Some(("audio", "audio/mp4"))
        } else {
            Some((
                "video",
                if at(8, b"qt  ") {
                    "video/quicktime"
                } else {
                    "video/mp4"
                },
            ))
        }
    } else if at(0, &[0x1a, 0x45, 0xdf, 0xa3]) {
        if kind == "audio" {
            Some(("audio", "audio/webm"))
        } else {
            Some(("video", "video/webm"))
        }
    } else if at(0, b"OggS") {
        Some(("audio", "audio/ogg"))
    } else if at(0, b"ID3")
        || (bytes.first() == Some(&255) && bytes.get(1).map(|b| b & 0xe0 == 0xe0).unwrap_or(false))
    {
        Some(("audio", "audio/mpeg"))
    } else {
        None
    }
}
const HOUR: i64 = 3600000;
const DAY: i64 = 24 * HOUR;
pub const CHANGE: i64 = 30 * DAY;
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Who {
    pub sender: String,
    #[serde(default)]
    pub admin: bool,
    #[serde(default)]
    pub id: Option<String>,
}
pub enum Event {
    One(Value),
    Broadcast(Value),
    Share(&'static str, Value),
    Presence,
}
pub fn view(mut v: Value, who: &Who) -> Value {
    let own = v["owner"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|id| who.id.as_deref() == Some(id))
        .unwrap_or(false);
    v.as_object_mut().unwrap().remove("owner");
    v["own"] = json!(own);
    v
}
fn error(code: &str) -> Value {
    json!({"error":code})
}
fn row(mut v: Value) -> Value {
    let media = v["media"]
        .as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or(Value::Null);
    let owner = v["owner"].clone();
    let mut out = serde_json::Map::new();
    for k in ["id", "t", "name", "text"] {
        out.insert(k.into(), v[k].take());
    }
    out.insert("team".into(), json!(number(&v["team"]) != 0));
    out.insert("edited".into(), json!(number(&v["edited"]) != 0));
    out.insert("media".into(), media);
    out.insert("owner".into(), owner);
    Value::Object(out)
}
pub struct Room<S: Sql> {
    pub sql: S,
    pace: HashMap<String, Vec<i64>>,
}
impl<S: Sql> Room<S> {
    pub fn new(sql: S) -> Result<Self> {
        sql.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,t INTEGER NOT NULL,name TEXT NOT NULL,text TEXT NOT NULL,team INTEGER NOT NULL DEFAULT 0,sender TEXT NOT NULL)",&[])?;
        let columns = sql.exec("PRAGMA table_info(messages)", &[])?;
        for (name, definition) in [
            ("owner", "owner TEXT"),
            ("media", "media TEXT"),
            ("edited", "edited INTEGER NOT NULL DEFAULT 0"),
        ] {
            if !columns.iter().any(|v| v["name"] == name) {
                sql.exec(
                    &format!("ALTER TABLE messages ADD COLUMN {definition}"),
                    &[],
                )?;
            }
        }
        for q in ["CREATE TABLE IF NOT EXISTS bans (sender TEXT PRIMARY KEY,t INTEGER NOT NULL)","CREATE TABLE IF NOT EXISTS key_failures (sender TEXT NOT NULL,t INTEGER NOT NULL)","CREATE TABLE IF NOT EXISTS names (id TEXT PRIMARY KEY,name TEXT NOT NULL,folded TEXT NOT NULL UNIQUE,t INTEGER NOT NULL,sender TEXT NOT NULL)","CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY,t INTEGER NOT NULL,kind TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,chunks INTEGER NOT NULL,owner TEXT NOT NULL,sender TEXT NOT NULL,attached INTEGER NOT NULL DEFAULT 0)","CREATE TABLE IF NOT EXISTS media_chunks (id TEXT NOT NULL,n INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(id,n))"]{sql.exec(q,&[])?;}
        Ok(Self {
            sql,
            pace: HashMap::new(),
        })
    }
    pub fn history(&self) -> Result<Vec<Value>> {
        let mut rows = self
            .sql
            .exec("SELECT * FROM messages ORDER BY id DESC LIMIT 50", &[])?;
        rows.reverse();
        Ok(rows.into_iter().map(row).collect())
    }
    pub fn message(&self, id: i64) -> Result<Option<Value>> {
        let v = self
            .sql
            .one("SELECT * FROM messages WHERE id=?", &[json!(id)])?;
        Ok((!v.is_null()).then(|| row(v)))
    }
    pub fn banned(&self, sender: &str) -> Result<bool> {
        Ok(!self
            .sql
            .one("SELECT 1 FROM bans WHERE sender=?", &[json!(sender)])?
            .is_null())
    }
    pub fn name(&self, id: &str) -> Result<Value> {
        let r = self
            .sql
            .one("SELECT name,t FROM names WHERE id=?", &[json!(id)])?;
        Ok(if r.is_null() {
            Value::Null
        } else {
            json!({"name":r["name"],"changeAt":number(&r["t"])+CHANGE})
        })
    }
    pub fn register(&self, id: &str, name: &str, who: &Who, now: i64) -> Result<Value> {
        if self.banned(&who.sender)? {
            return Ok(error("banned"));
        }
        let name = clean_name(name);
        if name.is_empty() {
            return Ok(error("name"));
        }
        if !who.admin && reserved(&name) {
            return Ok(error("reserved"));
        }
        let folded = fold(&name);
        if folded.is_empty() {
            return Ok(error("name"));
        }
        let mine = self
            .sql
            .one("SELECT name,t FROM names WHERE id=?", &[json!(id)])?;
        if mine["name"] == name {
            return Ok(json!({"name":name,"changeAt":number(&mine["t"])+CHANGE}));
        }
        let owner = self
            .sql
            .one("SELECT id FROM names WHERE folded=?", &[json!(folded)])?;
        if !owner.is_null() && owner["id"] != id && !who.admin {
            return Ok(error("taken"));
        }
        if !who.admin {
            if !mine.is_null()
                && fold(text(&mine["name"])) != folded
                && now < number(&mine["t"]) + CHANGE
            {
                return Ok(json!({"error":"wait","until":number(&mine["t"])+CHANGE}));
            }
            if mine.is_null()
                && number(
                    &self.sql.one(
                        "SELECT COUNT(*) AS n FROM names WHERE sender=? AND t>?",
                        &[json!(who.sender), json!(now - DAY)],
                    )?["n"],
                ) >= 3
            {
                return Ok(error("too_many"));
            }
        }
        if !owner.is_null() && owner["id"] != id {
            self.sql
                .exec("DELETE FROM names WHERE id=?", &[owner["id"].clone()])?;
        }
        let at = if !mine.is_null() && fold(text(&mine["name"])) == folded {
            number(&mine["t"])
        } else {
            now
        };
        self.sql.exec("INSERT INTO names (id,name,folded,t,sender) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,folded=excluded.folded,t=excluded.t,sender=excluded.sender",&[json!(id),json!(name),json!(folded),json!(at),json!(who.sender)])?;
        Ok(json!({"name":name,"changeAt":at+CHANGE}))
    }
    fn paced(&mut self, sender: &str, now: i64) -> bool {
        let times = self.pace.entry(sender.into()).or_default();
        if times.last().map(|t| now - t < 3000).unwrap_or(false) {
            return true;
        }
        times.retain(|t| now - t < 600000);
        if times.len() >= 20 {
            return true;
        }
        times.push(now);
        if self.pace.len() > 5000 {
            self.pace
                .retain(|_, v| v.last().map(|t| now - t <= 600000).unwrap_or(false));
        }
        false
    }
    pub fn post(&mut self, message: &Value, who: &Who, now: i64) -> Result<Value> {
        if self.banned(&who.sender)? {
            return Ok(error("banned"));
        }
        let name = self.name(who.id.as_deref().unwrap_or_default())?;
        if name.is_null() {
            return Ok(error("name"));
        }
        let content = clean_text(text(&message["text"]));
        let mut file = Value::Null;
        if let Some(id) = message["media"].get("id") {
            let m = self.sql.one(
                "SELECT id,kind,mime,size,owner,attached FROM media WHERE id=?",
                std::slice::from_ref(id),
            )?;
            if m.is_null()
                || m["owner"].as_str() != who.id.as_deref()
                || number(&m["attached"]) != 0
            {
                return Ok(error("media"));
            }
            file = json!({"id":m["id"],"kind":m["kind"],"mime":m["mime"],"size":m["size"]});
        }
        if !content.is_empty() || file.is_null() {
            if let Some(why) = refuse(&content, who.admin) {
                return Ok(error(why));
            }
        }
        if !who.admin && self.paced(&who.sender, now) {
            return Ok(error("slow"));
        }
        let r=self.sql.one("INSERT INTO messages (t,name,text,team,sender,owner,media) VALUES (?,?,?,?,?,?,?) RETURNING id",&[json!(now),name["name"].clone(),json!(content),json!(i32::from(who.admin)),json!(who.sender),json!(who.id),if file.is_null(){Value::Null}else{json!(file.to_string())}])?;
        let id = number(&r["id"]);
        if !file.is_null() {
            self.sql.exec(
                "UPDATE media SET attached=1 WHERE id=?",
                &[file["id"].clone()],
            )?;
        }
        self.prune(id, now)?;
        Ok(json!({"message":self.message(id)?}))
    }
    pub fn edit(&self, id: i64, content: &str, who: &Who) -> Result<Value> {
        let Some(m) = self.message(id)? else {
            return Ok(error("gone"));
        };
        if !who.admin && (who.id.is_none() || m["owner"].as_str() != who.id.as_deref()) {
            return Ok(error("forbidden"));
        }
        let content = clean_text(content);
        if !content.is_empty() || m["media"].is_null() {
            if let Some(why) = refuse(&content, who.admin) {
                return Ok(error(why));
            }
        }
        self.sql.exec(
            "UPDATE messages SET text=?,edited=1 WHERE id=?",
            &[json!(content), json!(id)],
        )?;
        Ok(json!({"message":self.message(id)?}))
    }
    pub fn remove(&self, id: i64, who: &Who) -> Result<bool> {
        let Some(m) = self.message(id)? else {
            return Ok(false);
        };
        if !who.admin && (who.id.is_none() || m["owner"].as_str() != who.id.as_deref()) {
            return Ok(false);
        }
        self.drop("id=?", &[json!(id)])?;
        Ok(true)
    }
    fn drop_media(&self, id: &str) -> Result<()> {
        self.sql
            .exec("DELETE FROM media_chunks WHERE id=?", &[json!(id)])?;
        self.sql
            .exec("DELETE FROM media WHERE id=?", &[json!(id)])?;
        Ok(())
    }
    fn drop(&self, query: &str, args: &[Value]) -> Result<()> {
        for r in self
            .sql
            .exec(&format!("SELECT media FROM messages WHERE {query}"), args)?
        {
            if let Ok(m) = serde_json::from_str::<Value>(text(&r["media"])) {
                self.drop_media(text(&m["id"]))?;
            }
        }
        self.sql
            .exec(&format!("DELETE FROM messages WHERE {query}"), args)?;
        Ok(())
    }
    pub fn prune(&self, last: i64, now: i64) -> Result<()> {
        self.drop("id<=? OR t<?", &[json!(last - 200), json!(now - 7 * DAY)])?;
        for m in self.sql.exec(
            "SELECT id FROM media WHERE (attached=0 AND t<?) OR t<?",
            &[json!(now - HOUR), json!(now - 7 * DAY)],
        )? {
            self.drop_media(text(&m["id"]))?;
        }
        Ok(())
    }
    pub fn ban(&self, id: i64, now: i64) -> Result<Vec<Value>> {
        let m = self
            .sql
            .one("SELECT sender FROM messages WHERE id=?", &[json!(id)])?;
        if m.is_null() {
            return Ok(vec![]);
        }
        let sender = m["sender"].clone();
        self.sql.exec(
            "INSERT OR IGNORE INTO bans (sender,t) VALUES (?,?)",
            &[sender.clone(), json!(now)],
        )?;
        let ids = self
            .sql
            .exec(
                "SELECT id FROM messages WHERE sender=?",
                std::slice::from_ref(&sender),
            )?
            .into_iter()
            .map(|v| v["id"].clone())
            .collect();
        self.drop("sender=?", std::slice::from_ref(&sender))?;
        for m in self
            .sql
            .exec("SELECT id FROM media WHERE sender=?", &[sender])?
        {
            self.drop_media(text(&m["id"]))?;
        }
        Ok(ids)
    }
    pub fn save_media(
        &self,
        bytes: &[u8],
        kind: &str,
        who: &Who,
        id: &str,
        now: i64,
    ) -> Result<Value> {
        if self.banned(&who.sender)? {
            return Ok(error("banned"));
        }
        let owner = who.id.as_deref().unwrap_or_default();
        if self.name(owner)?.is_null() {
            return Ok(error("name"));
        }
        let Some((actual, mime)) = sniff(bytes, kind) else {
            return Ok(error("media_type"));
        };
        if !kind.is_empty() && kind != actual {
            return Ok(error("media_type"));
        }
        if bytes.is_empty() || bytes.len() > max_media(actual) {
            return Ok(error("media_size"));
        }
        if number(
            &self.sql.one(
                "SELECT COUNT(*) AS n FROM media WHERE sender=? AND t>?",
                &[json!(who.sender), json!(now - HOUR)],
            )?["n"],
        ) >= 10
        {
            return Ok(error("media_slow"));
        }
        self.prune(0, now)?;
        let used = number(
            &self
                .sql
                .one("SELECT COALESCE(SUM(size),0) AS n FROM media", &[])?["n"],
        );
        if used + bytes.len() as i64 > 400 * 1024 * 1024 {
            return Ok(error("media_full"));
        }
        for (n, part) in bytes.chunks(1024 * 1024).enumerate() {
            self.sql.blob(id, n, part)?;
        }
        self.sql.exec(
            "INSERT INTO media (id,t,kind,mime,size,chunks,owner,sender) VALUES (?,?,?,?,?,?,?,?)",
            &[
                json!(id),
                json!(now),
                json!(actual),
                json!(mime),
                json!(bytes.len()),
                json!(bytes.len().div_ceil(1024 * 1024)),
                json!(owner),
                json!(who.sender),
            ],
        )?;
        Ok(json!({"media":{"id":id,"kind":actual,"mime":mime,"size":bytes.len()}}))
    }
    pub fn media(&self, id: &str) -> Result<Option<(String, Vec<u8>)>> {
        let m = self.sql.one(
            "SELECT mime,size,attached FROM media WHERE id=?",
            &[json!(id)],
        )?;
        if m.is_null() || number(&m["attached"]) == 0 {
            return Ok(None);
        }
        let bytes = self.sql.blobs(id)?.concat();
        if bytes.len() != number(&m["size"]) as usize {
            return Err("Invalid stored media size".into());
        }
        Ok(Some((text(&m["mime"]).into(), bytes)))
    }
    pub fn receive(
        &mut self,
        who: &mut Who,
        m: &Value,
        admin_key: &str,
        now: i64,
    ) -> Result<Vec<Event>> {
        let one = |v: Value| vec![Event::One(v)];
        let err = |v: Value| {
            let mut v = v;
            v["type"] = "error".into();
            one(v)
        };
        let invalid = || err(error("invalid"));
        match text(&m["type"]) {
            "identify" => {
                let code = text(&m["code"]);
                if !self::code(code) {
                    return Ok(invalid());
                }
                let id = hash_code(code);
                who.id = Some(id.clone());
                let mine = self.name(&id)?;
                let ids: Vec<_> = self
                    .history()?
                    .iter()
                    .filter(|m| m["owner"] == id)
                    .map(|m| m["id"].clone())
                    .collect();
                Ok(vec![
                    Event::One(
                        json!({"type":"you","name":mine["name"],"changeAt":mine["changeAt"]}),
                    ),
                    Event::One(json!({"type":"mine","ids":ids})),
                    Event::Presence,
                ])
            }
            "register" => {
                let Some(id) = &who.id else {
                    return Ok(invalid());
                };
                let r = self.register(id, text(&m["name"]), who, now)?;
                if r.get("error").is_some() {
                    return Ok(err(r));
                }
                Ok(vec![
                    Event::One(json!({"type":"you","name":r["name"],"changeAt":r["changeAt"]})),
                    Event::Presence,
                ])
            }
            "say" | "edit" => {
                let r = if m["type"] == "say" {
                    self.post(m, who, now)?
                } else {
                    let Some(id) = id(m) else {
                        return Ok(invalid());
                    };
                    self.edit(id, text(&m["text"]), who)?
                };
                if r.get("error").is_some() {
                    Ok(err(r))
                } else {
                    Ok(vec![Event::Share(
                        if m["type"] == "say" {
                            "message"
                        } else {
                            "edited"
                        },
                        r["message"].clone(),
                    )])
                }
            }
            "delete" => {
                let Some(id) = id(m) else {
                    return Ok(invalid());
                };
                if self.remove(id, who)? {
                    Ok(vec![Event::Broadcast(json!({"type":"removed","ids":[id]}))])
                } else {
                    Ok(err(error("forbidden")))
                }
            }
            "auth" => {
                let count = number(
                    &self.sql.one(
                        "SELECT COUNT(*) AS n FROM key_failures WHERE sender=? AND t>?",
                        &[json!(who.sender), json!(now - HOUR)],
                    )?["n"],
                );
                if count >= 5 {
                    return Ok(one(json!({"type":"auth","ok":false,"error":"slow"})));
                }
                let ok = same(text(&m["key"]), admin_key);
                if !ok {
                    self.sql
                        .exec("DELETE FROM key_failures WHERE t<=?", &[json!(now - HOUR)])?;
                    self.sql.exec(
                        "INSERT INTO key_failures (sender,t) VALUES (?,?)",
                        &[json!(who.sender), json!(now)],
                    )?;
                }
                if ok {
                    who.admin = true;
                }
                let mut out = one(json!({"type":"auth","ok":ok}));
                if ok {
                    out.push(Event::Presence);
                }
                Ok(out)
            }
            "ban" | "unbanall" => {
                if !who.admin {
                    return Ok(err(error("forbidden")));
                }
                if m["type"] == "unbanall" {
                    self.sql.exec("DELETE FROM bans", &[])?;
                    Ok(one(json!({"type":"done","what":"unbanall"})))
                } else {
                    let Some(id) = id(m) else {
                        return Ok(invalid());
                    };
                    Ok(vec![Event::Broadcast(
                        json!({"type":"removed","ids":self.ban(id,now)?}),
                    )])
                }
            }
            "ping" => Ok(one(json!({"type":"pong"}))),
            _ => Ok(invalid()),
        }
    }
}
fn id(m: &Value) -> Option<i64> {
    m["id"].as_i64().or_else(|| m["id"].as_str()?.parse().ok())
}
// Content range uses inclusive bounds. An unsatisfiable range is Err.
#[derive(Debug, PartialEq, Eq)]
pub struct InvalidRange;
pub fn range(
    value: &str,
    size: usize,
) -> std::result::Result<Option<(usize, usize)>, InvalidRange> {
    let Some(value) = value.strip_prefix("bytes=") else {
        return Ok(None);
    };
    let Some((a, b)) = value.split_once('-') else {
        return Ok(None);
    };
    if a.is_empty() && b.is_empty() {
        return Ok(None);
    }
    if !a.bytes().chain(b.bytes()).all(|c| c.is_ascii_digit()) {
        return Ok(None);
    }
    let start = if a.is_empty() {
        size.saturating_sub(b.parse::<usize>().unwrap_or(usize::MAX))
    } else {
        a.parse::<usize>().unwrap_or(usize::MAX)
    };
    let end = if !a.is_empty() && !b.is_empty() {
        b.parse::<usize>()
            .unwrap_or(usize::MAX)
            .min(size.saturating_sub(1))
    } else {
        size.saturating_sub(1)
    };
    if size == 0 || start > end {
        Err(InvalidRange)
    } else {
        Ok(Some((start, end)))
    }
}
