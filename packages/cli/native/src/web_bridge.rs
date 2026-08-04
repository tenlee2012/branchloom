use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::time::Duration;

use branchloom_core::application::ApplicationService;
use branchloom_core::core::error::CoreError;
use branchloom_core::data_location::database_path;
use serde_json::{json, Value};
use uuid::Uuid;

const MAX_REQUEST_BYTES: usize = 512 * 1024 * 1024;

pub fn serve(args: &[String], data_dir: &Path) -> Result<(), String> {
    let port = option(args, "--port")
        .ok_or_else(|| "web-bridge requires --port".to_owned())?
        .parse::<u16>()
        .map_err(|_| "web-bridge --port must be a valid TCP port".to_owned())?;
    let token = env::var("BRANCHLOOM_WEB_BRIDGE_TOKEN")
        .map_err(|_| "BRANCHLOOM_WEB_BRIDGE_TOKEN is required".to_owned())?;
    if token.len() < 32 {
        return Err("BRANCHLOOM_WEB_BRIDGE_TOKEN must contain at least 32 characters".to_owned());
    }

    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let mut service = ApplicationService::open(database_path(data_dir))
        .map_err(|error| format!("unable to open Branchloom data: {error}"))?;
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|error| format!("unable to bind 127.0.0.1:{port}: {error}"))?;
    eprintln!("Branchloom Web data bridge listening on 127.0.0.1:{port}");

    for connection in listener.incoming() {
        match connection {
            Ok(mut stream) => {
                if let Err(error) = handle_connection(&mut stream, &token, &mut service) {
                    let _ = write_response(
                        &mut stream,
                        500,
                        &json!({ "error": format!("Web data bridge request failed: {error}") }),
                    );
                }
            }
            Err(error) => eprintln!("Web data bridge connection failed: {error}"),
        }
    }
    Ok(())
}

fn option(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn handle_connection(
    stream: &mut TcpStream,
    token: &str,
    service: &mut ApplicationService,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    let request = read_request(stream)?;
    if request.token.as_deref() != Some(token) {
        return write_response(stream, 401, &json!({ "error": "Unauthorized" }))
            .map_err(|error| error.to_string());
    }

    let response = route(&request.method, &request.path, &request.body, service);
    match response {
        Ok(body) => write_response(stream, 200, &body).map_err(|error| error.to_string()),
        Err(error) => {
            let status = match error {
                CoreError::RevisionConflict { .. } | CoreError::Conflict(_) => 409,
                CoreError::Validation(_) | CoreError::Json(_) => 400,
                CoreError::NotFound { .. } => 404,
                _ => 500,
            };
            write_response(stream, status, &json!({ "error": error.to_string() }))
                .map_err(|write_error| write_error.to_string())
        }
    }
}

struct Request {
    method: String,
    path: String,
    token: Option<String>,
    body: Value,
}

fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|error| error.to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "missing HTTP method".to_owned())?;
    let path = parts.next().ok_or_else(|| "missing HTTP path".to_owned())?;

    let mut content_length = 0usize;
    let mut token = None;
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "content-length" => {
                    content_length = value
                        .trim()
                        .parse()
                        .map_err(|_| "invalid Content-Length".to_owned())?;
                }
                "x-branchloom-token" => token = Some(value.trim().to_owned()),
                _ => {}
            }
        }
    }
    if content_length > MAX_REQUEST_BYTES {
        return Err("request body is too large".to_owned());
    }
    let mut bytes = vec![0; content_length];
    reader
        .read_exact(&mut bytes)
        .map_err(|error| error.to_string())?;
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).map_err(|error| format!("invalid JSON body: {error}"))?
    };
    Ok(Request {
        method: method.to_owned(),
        path: path.split('?').next().unwrap_or(path).to_owned(),
        token,
        body,
    })
}

fn route(
    method: &str,
    path: &str,
    body: &Value,
    service: &mut ApplicationService,
) -> Result<Value, CoreError> {
    match (method, path) {
        ("GET", "/health") => Ok(json!({ "ok": true })),
        ("GET", "/revision") => Ok(json!(service.data_revision()?)),
        ("POST", "/duplicates/list") => serde_json::to_value(
            service.list_duplicate_candidates(required_string(body, "projectId")?)?,
        )
        .map_err(CoreError::from),
        ("GET", "/state") => {
            let snapshot = service.load_state_snapshot()?;
            Ok(json!({
                "revision": snapshot.revision,
                "state": snapshot.state.map(|state| json!({
                    "stateJson": state.state_json,
                    "snapshotPayloadsJson": state.snapshot_payloads_json,
                })),
            }))
        }
        ("PUT", "/state") => {
            let state_json = required_string(body, "stateJson")?;
            let snapshot_payloads_json = required_string(body, "snapshotPayloadsJson")?;
            let expected_revision = body
                .get("expectedRevision")
                .and_then(Value::as_i64)
                .ok_or_else(|| CoreError::Validation("expectedRevision is required".to_owned()))?;
            Ok(json!(service.synchronize_state_if_revision(
                state_json,
                snapshot_payloads_json,
                expected_revision,
            )?))
        }
        ("POST", "/mutation/apply") => {
            let method = required_string(body, "method")?;
            let args = body
                .get("args")
                .ok_or_else(|| CoreError::Validation("args is required".to_owned()))?;
            let expected_revision = body
                .get("expectedRevision")
                .and_then(Value::as_i64)
                .ok_or_else(|| CoreError::Validation("expectedRevision is required".to_owned()))?;
            serde_json::to_value(service.apply_desktop_mutation_if_revision(
                method,
                args,
                expected_revision,
            )?)
            .map_err(CoreError::from)
        }
        ("POST", "/snapshot/create") => serde_json::to_value(service.create_manual_snapshot(
            required_string(body, "projectId")?,
            required_string(body, "note")?,
        )?)
        .map_err(CoreError::from),
        ("POST", "/attachment/import") => {
            let expected_hash = body.get("expectedHash").and_then(Value::as_str);
            let result = service.import_attachment_bytes(
                required_string(body, "projectId")?,
                required_string(body, "name")?,
                required_string(body, "mimeType")?,
                &required_bytes(body)?,
                expected_hash,
            )?;
            serde_json::to_value(result).map_err(CoreError::from)
        }
        ("POST", "/attachment/exists") => Ok(json!(service.attachment_exists(
            required_string(body, "projectId")?,
            required_string(body, "contentHash")?,
        )?)),
        ("POST", "/attachment/read") => Ok(json!(service.read_attachment(
            required_string(body, "projectId")?,
            required_string(body, "contentHash")?,
        )?)),
        ("POST", "/attachment/set-local") => {
            let revision = service.data_revision()?;
            let result = service.set_local_attachment_bytes_if_revision(
                required_string(body, "projectId")?,
                required_string(body, "targetType")?,
                required_string(body, "targetId")?,
                required_string(body, "role")?,
                required_string(body, "name")?,
                required_string(body, "mimeType")?,
                &required_bytes(body)?,
                &Uuid::new_v4().to_string(),
                &Uuid::new_v4().to_string(),
                revision,
            )?;
            serde_json::to_value(result).map_err(CoreError::from)
        }
        _ => Err(CoreError::NotFound {
            entity: "web bridge route",
            id: format!("{method} {path}"),
        }),
    }
}

fn required_string<'a>(body: &'a Value, name: &str) -> Result<&'a str, CoreError> {
    body.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Validation(format!("{name} is required")))
}

fn required_bytes(body: &Value) -> Result<Vec<u8>, CoreError> {
    body.get("bytes")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::Validation("bytes are required".to_owned()))?
        .iter()
        .map(|value| {
            value
                .as_u64()
                .filter(|byte| *byte <= u8::MAX as u64)
                .map(|byte| byte as u8)
                .ok_or_else(|| CoreError::Validation("bytes must contain octets".to_owned()))
        })
        .collect()
}

fn write_response(stream: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Internal Server Error",
    };
    let bytes = serde_json::to_vec(body).expect("serialize Web bridge response");
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        bytes.len()
    )?;
    stream.write_all(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn state_routes_share_the_application_service_revision() {
        let directory = tempdir().expect("create data directory");
        let mut service = ApplicationService::open(directory.path().join("branchloom.sqlite3"))
            .expect("open application service");
        assert_eq!(
            route("GET", "/revision", &Value::Null, &mut service).unwrap(),
            json!(0)
        );
        let snapshot = route("GET", "/state", &Value::Null, &mut service).unwrap();
        assert_eq!(snapshot["revision"], 0);
        assert!(snapshot["state"].is_null());
    }

    #[test]
    fn duplicate_candidates_route_is_read_only_and_project_scoped() {
        use branchloom_core::core::project::NewProject;

        let directory = tempdir().expect("create data directory");
        let mut service = ApplicationService::open(directory.path().join("branchloom.sqlite3"))
            .expect("open application service");
        service
            .create_project_with_id(
                "project-test".to_owned(),
                NewProject {
                    name: "Test".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let revision = service.data_revision().expect("read revision");

        let candidates = route(
            "POST",
            "/duplicates/list",
            &json!({ "projectId": "project-test" }),
            &mut service,
        )
        .expect("list duplicate candidates");

        assert_eq!(candidates, json!([]));
        assert_eq!(service.data_revision().unwrap(), revision);
    }

    #[test]
    fn mutation_route_dispatches_to_the_rust_application_service() {
        let directory = tempdir().expect("create data directory");
        let mut service = ApplicationService::open(directory.path().join("branchloom.sqlite3"))
            .expect("open application service");
        let outcome = route(
            "POST",
            "/mutation/apply",
            &json!({
                "method": "createProject",
                "args": [{ "name": "Core project", "description": "native write" }],
                "expectedRevision": 0,
            }),
            &mut service,
        )
        .expect("apply mutation");
        assert_eq!(outcome["revision"], 1);
        assert_eq!(outcome["result"]["name"], "Core project");
        assert_eq!(service.list_projects().unwrap().len(), 1);
    }

    #[test]
    fn bridge_rejects_unknown_routes() {
        let directory = tempdir().expect("create data directory");
        let mut service = ApplicationService::open(directory.path().join("branchloom.sqlite3"))
            .expect("open application service");
        assert!(matches!(
            route("GET", "/unknown", &Value::Null, &mut service),
            Err(CoreError::NotFound { .. })
        ));
    }
}
