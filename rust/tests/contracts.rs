use bdlminer_chat::core::*;
use rusqlite::{
    params_from_iter,
    types::{Value as S, ValueRef},
    Connection,
};
use serde_json::{json, Value};
struct Db(Connection);
impl Db {
    fn new() -> Self {
        Self(Connection::open_in_memory().unwrap())
    }
}
impl Sql for Db {
    fn exec(&self, q: &str, args: &[Value]) -> Result<Vec<Value>> {
        let args: Vec<S> = args
            .iter()
            .map(|v| match v {
                Value::Null => S::Null,
                Value::String(s) => S::Text(s.clone()),
                Value::Number(n) => n
                    .as_i64()
                    .map(S::Integer)
                    .unwrap_or_else(|| S::Real(n.as_f64().unwrap())),
                Value::Bool(b) => S::Integer(i64::from(*b)),
                _ => S::Text(v.to_string()),
            })
            .collect();
        let mut stmt = self.0.prepare(q).map_err(|e| e.to_string())?;
        if stmt.column_count() == 0 {
            stmt.execute(params_from_iter(args))
                .map_err(|e| e.to_string())?;
            return Ok(vec![]);
        }
        let names = stmt
            .column_names()
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        let rows = stmt
            .query_map(params_from_iter(args), |row| {
                let mut out = serde_json::Map::new();
                for (i, name) in names.iter().enumerate() {
                    out.insert(
                        name.clone(),
                        match row.get_ref(i)? {
                            ValueRef::Null => Value::Null,
                            ValueRef::Integer(n) => json!(n),
                            ValueRef::Real(n) => json!(n),
                            ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                            ValueRef::Blob(_) => Value::Null,
                        },
                    );
                }
                Ok(Value::Object(out))
            })
            .map_err(|e| e.to_string())?;
        rows.map(|r| r.map_err(|e| e.to_string())).collect()
    }
    fn blob(&self, id: &str, n: usize, b: &[u8]) -> Result<()> {
        self.0
            .execute(
                "INSERT INTO media_chunks VALUES (?,?,?)",
                rusqlite::params![id, n as i64, b],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    fn blobs(&self, id: &str) -> Result<Vec<Vec<u8>>> {
        let mut s = self
            .0
            .prepare("SELECT data FROM media_chunks WHERE id=? ORDER BY n")
            .unwrap();
        let r = s.query_map([id], |r| r.get(0)).unwrap();
        r.map(|r| r.map_err(|e| e.to_string())).collect()
    }
}
const NOW: i64 = 1794326400000;
fn who(code: &str) -> Who {
    Who {
        sender: format!("network-{code}"),
        id: Some(hash_code(code)),
        admin: false,
    }
}
fn room() -> Room<Db> {
    Room::new(Db::new()).unwrap()
}
#[test]
fn moderation_identity_and_origin_contracts() {
    assert_eq!(fold("B.ö_b"), fold("Bob"));
    assert_eq!(clean_name("  Bob\n\u{200b} Miner  "), "Bob  Miner");
    assert_eq!(
        clean_text("\r\nHello\u{202e}\r\n\n\nworld\0"),
        "Hello\n\nworld"
    );
    assert!(reserved("b.d.l miner"));
    assert_eq!(refuse("seed phrase", false), Some("blocked"));
    assert_eq!(refuse("https://github.com/bdlglua", false), None);
    assert_eq!(
        refuse("https://github.com.evil.example", false),
        Some("link")
    );
    assert_eq!(refuse("evil.com", false), Some("link"));
    assert_eq!(refuse("Bitaxe.Gamma 1.9.3", false), None);
    assert_eq!(refuse("evil.com", true), None);
    assert_eq!(refuse(&"💻".repeat(251), true), Some("too_long"));
    assert!(same("test", "test"));
    assert!(!same("", ""));
    assert!(!same("testx", "test"));
    for origin in [
        "https://miner.bdl-pool.com",
        "https://bdlglua.github.io",
        "http://127.0.0.1:1234",
    ] {
        assert!(allowed_origin(origin));
    }
    for origin in [
        "https://evil.com",
        "https://miner.bdl-pool.com.evil.com",
        "https://miner.bdl-pool.com/",
        "https://miner.bdl-pool.com:443",
    ] {
        assert!(!allowed_origin(origin));
    }
    assert_eq!(
        hash_code("abcdefghijklmnop"),
        format!(
            "{:x}",
            sha2::Sha256::digest(b"bdlminer-chat:abcdefghijklmnop")
        )
    );
}
#[test]
fn names_keep_original_folded_ownership_and_thirty_day_rules() {
    let r = room();
    let a = who("abcdefghijklmnop");
    let b = who("qrstuvwxyz012345");
    let id = a.id.as_deref().unwrap();
    assert_eq!(r.register(id, "Bob", &a, NOW).unwrap()["name"], "Bob");
    assert_eq!(
        r.register(b.id.as_deref().unwrap(), "Böb", &b, NOW)
            .unwrap()["error"],
        "taken"
    );
    assert_eq!(r.register(id, "New", &a, NOW + 1).unwrap()["error"], "wait");
    assert_eq!(
        r.register(id, "b.o.b", &a, NOW + 1).unwrap()["changeAt"],
        NOW + CHANGE
    );
    assert_eq!(
        r.register(id, "New", &a, NOW + CHANGE).unwrap()["name"],
        "New"
    );
    let mut team = b;
    team.admin = true;
    assert_eq!(
        r.register(team.id.as_deref().unwrap(), "Admin", &team, NOW)
            .unwrap()["name"],
        "Admin"
    );
}
#[test]
fn message_ownership_edits_bans_and_retention_survive_existing_sql_schema() {
    let db = Db::new();
    db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,t INTEGER NOT NULL,name TEXT NOT NULL,text TEXT NOT NULL,team INTEGER NOT NULL DEFAULT 0,sender TEXT NOT NULL)",&[]).unwrap();
    let mut r = Room::new(db).unwrap();
    let a = who("abcdefghijklmnop");
    let b = who("qrstuvwxyz012345");
    r.register(a.id.as_deref().unwrap(), "Bob", &a, NOW)
        .unwrap();
    let first = r.post(&json!({"text":"Hello"}), &a, NOW).unwrap()["message"].clone();
    let id = number(&first["id"]);
    assert!(view(first.clone(), &a)["own"] == true);
    assert!(view(first, &b).get("owner").is_none());
    assert_eq!(r.edit(id, "other", &b).unwrap()["error"], "forbidden");
    assert_eq!(r.edit(id, "fixed", &a).unwrap()["message"]["edited"], true);
    assert!(!r.remove(id, &b).unwrap());
    assert_eq!(
        r.post(&json!({"text":"too soon"}), &a, NOW + 1).unwrap()["error"],
        "slow"
    );
    for i in 1..=205 {
        r.post(
            &json!({"text":format!("message {i}")}),
            &Who {
                admin: true,
                ..a.clone()
            },
            NOW + i * 3000,
        )
        .unwrap();
    }
    assert_eq!(r.history().unwrap().len(), 50);
    assert_eq!(
        number(
            &r.sql
                .one("SELECT COUNT(*) AS n FROM messages", &[])
                .unwrap()["n"]
        ),
        200
    );
    let ids = r.ban(206, NOW + 1000000).unwrap();
    assert_eq!(ids.len(), 200);
    assert!(r.banned(&a.sender).unwrap());
    assert_eq!(
        r.post(&json!({"text":"banned"}), &a, NOW + 1000001)
            .unwrap()["error"],
        "banned"
    );
    assert!(r.history().unwrap().is_empty());
}
#[test]
fn media_are_sniffed_chunked_owner_only_and_removed_with_their_message() {
    let mut r = room();
    let a = who("abcdefghijklmnop");
    let b = who("qrstuvwxyz012345");
    r.register(a.id.as_deref().unwrap(), "Bob", &a, NOW)
        .unwrap();
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.resize(1024 * 1024 + 33, 42);
    let upload = r
        .save_media(&bytes, "image", &a, "0123456789abcdef01234567", NOW)
        .unwrap();
    assert!(upload["error"].is_null());
    assert!(r.media("0123456789abcdef01234567").unwrap().is_none());
    r.register(b.id.as_deref().unwrap(), "Alice", &b, NOW)
        .unwrap();
    let msg = json!({"text":"","media":upload["media"]});
    assert_eq!(r.post(&msg, &b, NOW).unwrap()["error"], "media");
    let posted = r.post(&msg, &a, NOW).unwrap()["message"].clone();
    assert_eq!(
        r.media("0123456789abcdef01234567").unwrap().unwrap().1,
        bytes
    );
    assert_eq!(r.post(&msg, &a, NOW + 3000).unwrap()["error"], "media");
    assert!(r.remove(number(&posted["id"]), &a).unwrap());
    assert!(r.media("0123456789abcdef01234567").unwrap().is_none());
    assert_eq!(
        number(
            &r.sql
                .one("SELECT COUNT(*) AS n FROM media_chunks", &[])
                .unwrap()["n"]
        ),
        0
    );
    assert_eq!(
        r.save_media(b"<svg onload=alert(1)>", "image", &a, "x", NOW)
            .unwrap()["error"],
        "media_type"
    );
    assert_eq!(
        r.save_media(b"OggS bytes", "video", &a, "x", NOW).unwrap()["error"],
        "media_type"
    );
    assert_eq!(range("bytes=2-5", 10), Ok(Some((2, 5))));
    assert_eq!(range("bytes=-3", 10), Ok(Some((7, 9))));
    assert_eq!(range("bytes=30-", 10), Err(InvalidRange));
}
#[test]
fn websocket_protocol_keeps_identity_auth_throttling_and_private_owner_views() {
    let mut r = room();
    let mut w = Who {
        sender: "same-network".into(),
        ..Who::default()
    };
    let events = r
        .receive(
            &mut w,
            &json!({"type":"identify","code":"abcdefghijklmnop"}),
            "secret",
            NOW,
        )
        .unwrap();
    assert!(w.id.is_some());
    assert_eq!(events.len(), 3);
    let events = r
        .receive(
            &mut w,
            &json!({"type":"register","name":"Bob"}),
            "secret",
            NOW,
        )
        .unwrap();
    assert_eq!(events.len(), 2);
    let events = r
        .receive(&mut w, &json!({"type":"say","text":"hello"}), "secret", NOW)
        .unwrap();
    match &events[0] {
        Event::Share("message", v) => {
            assert_eq!(v["text"], "hello");
            assert_eq!(view(v.clone(), &w)["own"], true);
        }
        _ => panic!("message event"),
    };
    for _ in 0..5 {
        r.receive(&mut w, &json!({"type":"auth","key":"wrong"}), "secret", NOW)
            .unwrap();
    }
    let events = r
        .receive(
            &mut w,
            &json!({"type":"auth","key":"secret"}),
            "secret",
            NOW,
        )
        .unwrap();
    match &events[0] {
        Event::One(v) => assert_eq!(v["error"], "slow"),
        _ => panic!("auth event"),
    };
    assert!(!w.admin);
    r.receive(
        &mut w,
        &json!({"type":"auth","key":"secret"}),
        "secret",
        NOW + 3600001,
    )
    .unwrap();
    assert!(w.admin);
}
use sha2::Digest;
