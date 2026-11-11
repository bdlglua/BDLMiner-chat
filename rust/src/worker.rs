use crate::core::{self, Event, Room, Sql, Who};
use ::worker::*;
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{cell::RefCell, collections::BTreeMap};
struct WorkerSql(SqlStorage);
fn err(e: impl ToString) -> Error {
    Error::RustError(e.to_string())
}
impl Sql for WorkerSql {
    fn exec(&self, q: &str, args: &[Value]) -> core::Result<Vec<Value>> {
        let args = args
            .iter()
            .map(|v| match v {
                Value::Null => SqlStorageValue::Null,
                Value::Bool(v) => SqlStorageValue::Integer(i64::from(*v)),
                Value::String(s) => SqlStorageValue::String(s.clone()),
                Value::Number(n) => n
                    .as_i64()
                    .map(SqlStorageValue::Integer)
                    .unwrap_or_else(|| SqlStorageValue::Float(n.as_f64().unwrap_or(0.0))),
                _ => SqlStorageValue::String(v.to_string()),
            })
            .collect::<Vec<_>>();
        self.0
            .exec(q, Some(args))
            .and_then(|c| c.to_array())
            .map_err(|e| e.to_string())
    }
    fn blob(&self, id: &str, n: usize, bytes: &[u8]) -> core::Result<()> {
        self.0
            .exec(
                "INSERT INTO media_chunks (id,n,data) VALUES (?,?,?)",
                Some(vec![
                    id.into(),
                    (n as i64).into(),
                    SqlStorageValue::Blob(bytes.to_vec()),
                ]),
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    fn blobs(&self, id: &str) -> core::Result<Vec<Vec<u8>>> {
        let cursor = self
            .0
            .exec(
                "SELECT data FROM media_chunks WHERE id=? ORDER BY n",
                Some(vec![id.into()]),
            )
            .map_err(|e| e.to_string())?;
        cursor
            .raw()
            .map(|r| match r.map_err(|e| e.to_string())?.into_iter().next() {
                Some(SqlStorageValue::Blob(b)) => Ok(b),
                _ => Err("Invalid media chunk".into()),
            })
            .collect()
    }
}
fn time() -> i64 {
    js_sys::Date::now() as i64
}
fn who(ws: &WebSocket) -> Who {
    ws.deserialize_attachment()
        .ok()
        .flatten()
        .unwrap_or_default()
}
fn send(ws: &WebSocket, v: &Value) {
    let _ = ws.send_with_str(v.to_string());
}
fn cors(response: &mut Response, origin: &str) -> Result<()> {
    let headers = response.headers().clone();
    *response.headers_mut() = headers;
    response.headers_mut().set(
        "Access-Control-Allow-Origin",
        if core::allowed_origin(origin) {
            origin
        } else {
            "https://bdlglua.github.io"
        },
    )?;
    response.headers_mut().set("Vary", "Origin")
}
fn json_response(v: Value, status: u16) -> Result<Response> {
    Ok(Response::from_json(&v)?.with_status(status))
}
fn sender(request: &Request, env: &Env) -> Result<String> {
    let secret = env
        .secret("CHAT_SECRET")
        .map(|s| s.to_string())
        .unwrap_or_else(|_| "bdlminer-chat".into());
    let mut hmac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(err)?;
    hmac.update(
        request
            .headers()
            .get("CF-Connecting-IP")?
            .unwrap_or_default()
            .as_bytes(),
    );
    Ok(hmac.finalize().into_bytes()[..12]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
async fn bounded(request: &mut Request, max: usize) -> Result<Vec<u8>> {
    let mut stream = request.stream()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > max {
            return Err(err("media_size"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
#[event(fetch)]
pub async fn main(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let url = request.url()?;
    let path = url.path();
    let origin = request.headers().get("Origin")?.unwrap_or_default();
    let method = request.method();
    if path == "/" {
        return Response::ok("BDLMiner chat: OK (Rust)\n");
    }
    if path == "/ws" {
        if request.headers().get("Upgrade")?.as_deref() != Some("websocket") {
            return Response::error("WebSocket only", 426);
        }
        if !core::allowed_origin(&origin) {
            return Response::error("Forbidden", 403);
        }
        let headers = request.headers().clone();
        headers.set("X-Sender", &sender(&request, &env)?)?;
        let mut init = RequestInit::new();
        init.with_method(method).with_headers(headers);
        request = Request::new_with_init(url.as_str(), &init)?;
    } else if path == "/api/messages" {
        if method != Method::Get {
            return Response::error("GET only", 405);
        }
    } else if path == "/api/media" {
        if method == Method::Options {
            let mut r = Response::empty()?.with_status(204);
            cors(&mut r, &origin)?;
            for (k, v) in [
                ("Access-Control-Allow-Methods", "POST"),
                ("Access-Control-Allow-Headers", "Content-Type, X-Chat-Code"),
                ("Access-Control-Max-Age", "86400"),
            ] {
                r.headers_mut().set(k, v)?;
            }
            return Ok(r);
        }
        if method != Method::Post {
            return Response::error("POST only", 405);
        }
        if !core::allowed_origin(&origin) {
            return Response::error("Forbidden", 403);
        }
        let kind = url
            .query_pairs()
            .find(|(k, _)| k == "kind")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
        let maximum = core::max_media(&kind);
        let error = if maximum == 0 {
            Some((400, "media_type"))
        } else if request
            .headers()
            .get("Content-Length")?
            .and_then(|s| s.parse::<usize>().ok())
            .map(|n| n > maximum)
            .unwrap_or(false)
        {
            Some((413, "media_size"))
        } else {
            None
        };
        if let Some((status, error)) = error {
            let mut r = json_response(json!({"error":error}), status)?;
            cors(&mut r, &origin)?;
            return Ok(r);
        }
        let bytes = match bounded(&mut request, maximum).await {
            Ok(bytes) => bytes,
            Err(_) => {
                let mut r = json_response(json!({"error":"media_size"}), 413)?;
                cors(&mut r, &origin)?;
                return Ok(r);
            }
        };
        let headers = Headers::new();
        headers.set("X-Sender", &sender(&request, &env)?)?;
        if let Some(code) = request.headers().get("X-Chat-Code")? {
            headers.set("X-Chat-Code", &code)?;
        }
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(js_sys::Uint8Array::from(bytes.as_slice()).into()));
        request = Request::new_with_init(url.as_str(), &init)?;
    } else if core::re(r"^/media/[a-f0-9]{24}$", path) {
        if ![Method::Get, Method::Head].contains(&method) {
            return Response::error("GET only", 405);
        }
    } else {
        return Response::error("Not found", 404);
    }
    let namespace = env.durable_object("ROOM")?;
    let id = namespace.id_from_name("site")?;
    let mut response = id.get_stub()?.fetch_with_request(request).await?;
    if ["/api/messages", "/api/media"].contains(&path) {
        cors(&mut response, &origin)?;
    }
    Ok(response)
}
#[durable_object]
pub struct ChatRoom {
    state: State,
    env: Env,
    room: RefCell<Room<WorkerSql>>,
}
impl ChatRoom {
    fn broadcast(&self, v: &Value) {
        for ws in self.state.get_websockets() {
            send(&ws, v);
        }
    }
    fn presence(&self, closing: Option<&WebSocket>) -> Result<()> {
        let room = self.room.borrow();
        let mut members = BTreeMap::<String, Value>::new();
        let mut guests = 0;
        for ws in self.state.get_websockets() {
            if closing == Some(&ws) {
                continue;
            }
            let w = who(&ws);
            let name = room
                .name(w.id.as_deref().unwrap_or_default())
                .map_err(err)?;
            if name.is_null() {
                guests += 1;
            } else {
                let id = w.id.unwrap();
                let team = w.admin || members.get(&id).map(|v| v["team"] == true).unwrap_or(false);
                members.insert(id, json!({"name":name["name"],"team":team}));
            }
        }
        let mut members: Vec<_> = members.into_values().collect();
        members.sort_by(|a, b| {
            (b["team"] == true)
                .cmp(&(a["team"] == true))
                .then(core::text(&a["name"]).cmp(core::text(&b["name"])))
        });
        self.broadcast(&json!({"type":"presence","members":members,"guests":guests}));
        Ok(())
    }
    fn left(&self, ws: &WebSocket) -> Result<()> {
        let count = self
            .state
            .get_websockets()
            .iter()
            .filter(|other| *other != ws)
            .count();
        self.broadcast(&json!({"type":"online","count":count}));
        self.presence(Some(ws))
    }
    fn events(&self, ws: &WebSocket, events: Vec<Event>) -> Result<()> {
        for event in events {
            match event {
                Event::One(value) => send(ws, &value),
                Event::Broadcast(value) => self.broadcast(&value),
                Event::Share(kind, value) => {
                    for ws in self.state.get_websockets() {
                        send(
                            &ws,
                            &json!({"type":kind,"message":core::view(value.clone(),&who(&ws))}),
                        );
                    }
                }
                Event::Presence => self.presence(None)?,
            }
        }
        Ok(())
    }
}
impl DurableObject for ChatRoom {
    fn new(state: State, env: Env) -> Self {
        let room = Room::new(WorkerSql(state.storage().sql()))
            .expect("Chat storage initialization failed");
        Self {
            state,
            env,
            room: RefCell::new(room),
        }
    }
    async fn fetch(&self, mut request: Request) -> Result<Response> {
        let url = request.url()?;
        let path = url.path();
        if path == "/api/messages" {
            let mut messages = self.room.borrow().history().map_err(err)?;
            for m in &mut messages {
                m.as_object_mut().unwrap().remove("owner");
            }
            let mut r = Response::from_json(&json!({"messages":messages}))?;
            r.headers_mut().set("Cache-Control", "no-store")?;
            return Ok(r);
        }
        if path == "/api/media" {
            let code = request.headers().get("X-Chat-Code")?.unwrap_or_default();
            if !core::code(&code) {
                return json_response(json!({"error":"name"}), 400);
            }
            let kind = url
                .query_pairs()
                .find(|(k, _)| k == "kind")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            let bytes = bounded(&mut request, core::max_media(&kind)).await?;
            let w = Who {
                sender: request.headers().get("X-Sender")?.unwrap_or_default(),
                id: Some(core::hash_code(&code)),
                admin: false,
            };
            let mut random = [0u8; 12];
            getrandom::getrandom(&mut random).map_err(err)?;
            let id = random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let result = self
                .room
                .borrow()
                .save_media(&bytes, &kind, &w, &id, time())
                .map_err(err)?;
            let status = if result.get("error").is_some() {
                400
            } else {
                200
            };
            return json_response(result, status);
        }
        if let Some(id) = path.strip_prefix("/media/") {
            let file = self.room.borrow().media(id).map_err(err)?;
            return match file {
                Some((mime, bytes)) => serve(&request, &mime, bytes),
                None => Response::error("Not found", 404),
            };
        }
        if path != "/ws" {
            return Response::error("Not found", 404);
        }
        let pair = WebSocketPair::new()?;
        let w = Who {
            sender: request.headers().get("X-Sender")?.unwrap_or_default(),
            ..Who::default()
        };
        self.state.accept_web_socket(&pair.server);
        pair.server.serialize_attachment(&w)?;
        let messages = self
            .room
            .borrow()
            .history()
            .map_err(err)?
            .into_iter()
            .map(|v| core::view(v, &w))
            .collect::<Vec<_>>();
        let online = self.state.get_websockets().len();
        send(
            &pair.server,
            &json!({"type":"hello","messages":messages,"online":online}),
        );
        self.broadcast(&json!({"type":"online","count":online}));
        self.presence(None)?;
        Response::from_websocket(pair.client)
    }
    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let bytes = match message {
            WebSocketIncomingMessage::String(s) => s.into_bytes(),
            WebSocketIncomingMessage::Binary(b) => b,
        };
        let value = if bytes.len() <= 4096 {
            serde_json::from_slice::<Value>(&bytes)
                .ok()
                .filter(Value::is_object)
        } else {
            None
        };
        let Some(value) = value else {
            send(&ws, &json!({"type":"error","error":"invalid"}));
            return Ok(());
        };
        let mut w = who(&ws);
        let key = self
            .env
            .secret("CHAT_ADMIN_KEY")
            .map(|k| k.to_string())
            .unwrap_or_default();
        let events = self
            .room
            .borrow_mut()
            .receive(&mut w, &value, &key, time())
            .map_err(err)?;
        ws.serialize_attachment(w)?;
        self.events(&ws, events)
    }
    async fn websocket_close(
        &self,
        ws: WebSocket,
        code: usize,
        _reason: String,
        _clean: bool,
    ) -> Result<()> {
        self.left(&ws)?;
        let _ = ws.close(
            Some(if code == 1005 { 1000 } else { code as u16 }),
            Some("bye"),
        );
        Ok(())
    }
    async fn websocket_error(&self, ws: WebSocket, _error: Error) -> Result<()> {
        self.left(&ws)
    }
}
fn serve(request: &Request, mime: &str, bytes: Vec<u8>) -> Result<Response> {
    let size = bytes.len();
    let range = core::range(&request.headers().get("Range")?.unwrap_or_default(), size);
    let (status, range, selected) = match range {
        Ok(Some((start, end))) => (
            206,
            Some(format!("bytes {start}-{end}/{size}")),
            bytes[start..=end].to_vec(),
        ),
        Err(_) => (416, Some(format!("bytes */{size}")), vec![]),
        Ok(None) => (200, None, bytes),
    };
    let length = selected.len();
    let mut r = if request.method() == Method::Head {
        Response::empty()?
    } else {
        Response::from_bytes(selected)?
    }
    .with_status(status);
    for (k, v) in [
        ("Content-Type", mime),
        ("Accept-Ranges", "bytes"),
        ("Cache-Control", "public, max-age=604800, immutable"),
        ("X-Content-Type-Options", "nosniff"),
        ("Content-Security-Policy", "default-src 'none'; sandbox"),
        ("Cross-Origin-Resource-Policy", "cross-origin"),
        ("Content-Disposition", "inline"),
        ("Access-Control-Allow-Origin", "*"),
        (
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Range",
        ),
    ] {
        r.headers_mut().set(k, v)?;
    }
    r.headers_mut().set("Content-Length", &length.to_string())?;
    if let Some(range) = range {
        r.headers_mut().set("Content-Range", &range)?;
    }
    Ok(r)
}
