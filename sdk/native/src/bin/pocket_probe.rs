//! Static native-runtime probe used by guest integration tests.
//!
//! macOS 27's linker rejects the rquickjs dylib layout produced by older
//! toolchains, while Flutter links the same runtime as a force-loaded static
//! archive.  This tiny line-oriented process therefore links the Rust crate
//! directly and drives the public C ABI without depending on `dlopen`.
//!
//! Protocol (one JSON command per stdin line, one JSON response per stdout
//! line):
//!
//! * `{"op":"create","width":390,"height":844,"compositorSurfaces":{"app.child":2}}`
//! * `{"op":"loadBytecode","bytecodePath":".../app.qjbc","pakPath":".../app.pak"}`
//! * `{"op":"load","sourcePath":".../app.js","pakPath":".../app.pak"}`
//! * `{"op":"eval","source":"..."}` for source-only guests
//! * `{"op":"send","message":{"type":"event",...}}`
//! * `{"op":"frame","deltaMs":16}` -> `{ "ok": true, "frame": {...} }`
//! * `{"op":"resize","width":390,"height":400}` updates the live viewport
//! * `{"op":"lastError"}`, `{"op":"destroy"}`, `{"op":"quit"}`
//!
//! The probe deliberately has no application/page logic; all composition and
//! state continue to come from the guest bundle supplied by the caller.

use pocket_flutter::{
    pocket_bytecode_runtime_abi, pocket_configure_compositor, pocket_create, pocket_create_with_density_and_tick_hz,
    pocket_destroy, pocket_eval, pocket_frame, pocket_last_error, pocket_load_bytecode_files,
    pocket_load_files, pocket_next_wake_delay_ms, pocket_resize_viewport, pocket_send,
};
use serde_json::{json, Value};
use std::ffi::{c_void, CStr, CString};
use std::io::{self, BufRead, Write};

type Handle = *mut c_void;

fn error_response(message: impl Into<String>) -> Value {
    json!({"ok": false, "error": message.into()})
}

unsafe fn last_error(handle: Handle) -> String {
    let pointer = pocket_last_error(handle.cast());
    if pointer.is_null() {
        return "native host returned no error detail".to_owned();
    }
    CStr::from_ptr(pointer).to_string_lossy().into_owned()
}

unsafe fn native_error(handle: Handle, operation: &str) -> Value {
    let detail = last_error(handle);
    if detail.is_empty() {
        error_response(format!("{operation} failed"))
    } else {
        error_response(format!("{operation} failed: {detail}"))
    }
}

fn finite_number(command: &Value, key: &str, default: f64) -> Result<f64, String> {
    let value = command.get(key).and_then(Value::as_f64).unwrap_or(default);
    if value.is_finite() {
        Ok(value)
    } else {
        Err(format!("{key} must be finite"))
    }
}

fn positive_u32(command: &Value, key: &str, default: u32) -> Result<u32, String> {
    let raw = command
        .get(key)
        .and_then(Value::as_u64)
        .unwrap_or(default as u64);
    let value = u32::try_from(raw).map_err(|_| format!("{key} is too large"))?;
    if value > 0 {
        Ok(value)
    } else {
        Err(format!("{key} must be positive"))
    }
}

fn c_string(value: &str, label: &str) -> Result<CString, Value> {
    CString::new(value).map_err(|_| error_response(format!("{label} contains a NUL byte")))
}

unsafe fn frame_response(handle: Handle, delta_ms: f64) -> Value {
    let pointer = pocket_frame(handle.cast(), delta_ms);
    if pointer.is_null() {
        return native_error(handle, "pocket_frame");
    }
    let text = CStr::from_ptr(pointer).to_string_lossy();
    match serde_json::from_str::<Value>(&text) {
        Ok(frame) => json!({"ok": true, "frame": frame}),
        Err(error) => error_response(format!("pocket_frame returned invalid JSON: {error}")),
    }
}

unsafe fn destroy(handle: &mut Handle) {
    if !handle.is_null() {
        pocket_destroy((*handle).cast());
        *handle = std::ptr::null_mut();
    }
}

unsafe fn command(command: &Value, handle: &mut Handle) -> (bool, Value) {
    let operation = command
        .get("op")
        .or_else(|| command.get("command"))
        .and_then(Value::as_str)
        .unwrap_or("");

    match operation {
        "schedule" => {
            if handle.is_null() {
                return (false, error_response("create a native runtime before querying schedule"));
            }
            (false, json!({"ok": true, "nextWakeDelayMs": pocket_next_wake_delay_ms((*handle).cast())}))
        }
        "create" => {
            let width = match finite_number(command, "width", 390.0) {
                Ok(value) => value,
                Err(error) => return (false, error_response(error)),
            };
            let height = match finite_number(command, "height", 844.0) {
                Ok(value) => value,
                Err(error) => return (false, error_response(error)),
            };
            let density = match positive_u32(command, "rasterDensity", 1) {
                Ok(value) => value,
                Err(error) => return (false, error_response(error)),
            };
            let tick_hz = match positive_u32(command, "tickHz", 60) {
                Ok(value) => value,
                Err(error) => return (false, error_response(error)),
            };
            destroy(handle);
            let created =
                if command.get("rasterDensity").is_some() || command.get("tickHz").is_some() {
                    pocket_create_with_density_and_tick_hz(width, height, density, tick_hz)
                } else {
                    pocket_create(width, height)
                };
            if created.is_null() {
                return (
                    false,
                    error_response("pocket_create returned a null handle"),
                );
            }
            *handle = created.cast();
            let detail = last_error(*handle);
            if !detail.is_empty() {
                destroy(handle);
                return (false, error_response(detail));
            }
            if let Some(applications) = command.get("compositorSurfaces") {
                let registry = CString::new(applications.to_string()).expect("JSON has no literal NUL");
                if pocket_configure_compositor(created, registry.as_ptr()) != 0 {
                    let detail = last_error(*handle);
                    destroy(handle);
                    return (false, error_response(detail));
                }
            }
            (false, json!({"ok": true}))
        }
        "load" => {
            if handle.is_null() {
                return (
                    false,
                    error_response("create a native runtime before loading"),
                );
            }
            let source_path = match command.get("sourcePath").and_then(Value::as_str) {
                Some(value) => match c_string(value, "sourcePath") {
                    Ok(value) => value,
                    Err(error) => return (false, error),
                },
                None => return (false, error_response("load requires sourcePath")),
            };
            let pak_path = match command.get("pakPath").and_then(Value::as_str) {
                Some(value) => match c_string(value, "pakPath") {
                    Ok(value) => value,
                    Err(error) => return (false, error),
                },
                None => return (false, error_response("load requires pakPath")),
            };
            let result =
                pocket_load_files((*handle).cast(), source_path.as_ptr(), pak_path.as_ptr());
            if result != 0 {
                return (false, native_error(*handle, "pocket_load_files"));
            }
            (false, json!({"ok": true}))
        }
        "loadBytecode" => {
            if handle.is_null() {
                return (
                    false,
                    error_response("create a native runtime before loading bytecode"),
                );
            }
            let bytecode_path = match command.get("bytecodePath").and_then(Value::as_str) {
                Some(value) => match c_string(value, "bytecodePath") {
                    Ok(value) => value,
                    Err(error) => return (false, error),
                },
                None => return (false, error_response("loadBytecode requires bytecodePath")),
            };
            let pak_path = match command.get("pakPath").and_then(Value::as_str) {
                Some(value) => match c_string(value, "pakPath") {
                    Ok(value) => value,
                    Err(error) => return (false, error),
                },
                None => return (false, error_response("loadBytecode requires pakPath")),
            };
            let result = pocket_load_bytecode_files(
                (*handle).cast(),
                bytecode_path.as_ptr(),
                pak_path.as_ptr(),
            );
            if result != 0 {
                return (false, native_error(*handle, "pocket_load_bytecode_files"));
            }
            let abi = CStr::from_ptr(pocket_bytecode_runtime_abi())
                .to_string_lossy()
                .into_owned();
            (false, json!({"ok": true, "runtimeAbi": abi}))
        }
        "eval" => {
            if handle.is_null() {
                return (
                    false,
                    error_response("create a native runtime before evaluating"),
                );
            }
            let source = match command.get("source").and_then(Value::as_str) {
                Some(value) => match c_string(value, "source") {
                    Ok(value) => value,
                    Err(error) => return (false, error),
                },
                None => return (false, error_response("eval requires source")),
            };
            if pocket_eval((*handle).cast(), source.as_ptr()) != 0 {
                return (false, native_error(*handle, "pocket_eval"));
            }
            (false, json!({"ok": true}))
        }
        "send" => {
            if handle.is_null() {
                return (
                    false,
                    error_response("create a native runtime before sending"),
                );
            }
            let message = match command.get("message") {
                Some(Value::String(value)) => value.clone(),
                Some(value) => match serde_json::to_string(value) {
                    Ok(value) => value,
                    Err(error) => return (false, error_response(error.to_string())),
                },
                None => return (false, error_response("send requires message")),
            };
            let message = match c_string(&message, "message") {
                Ok(value) => value,
                Err(error) => return (false, error),
            };
            if pocket_send((*handle).cast(), message.as_ptr()) != 0 {
                return (false, native_error(*handle, "pocket_send"));
            }
            (false, json!({"ok": true}))
        }
        "resize" => {
            if handle.is_null() {
                return (
                    false,
                    error_response("create a native runtime before resizing"),
                );
            }
            let width = match finite_number(command, "width", 390.0) {
                Ok(value) => value,
                Err(error) => return (false, error_response(error)),
            };
            let height = match finite_number(command, "height", 400.0) {
                Ok(value) => value,
                Err(error) => return (false, error_response(error)),
            };
            if pocket_resize_viewport((*handle).cast(), width, height) != 0 {
                return (false, native_error(*handle, "pocket_resize_viewport"));
            }
            (false, json!({"ok": true}))
        }
        "frame" => {
            if handle.is_null() {
                return (
                    false,
                    error_response("create a native runtime before framing"),
                );
            }
            let delta_ms = match finite_number(command, "deltaMs", 16.0) {
                Ok(value) => value,
                Err(error) => return (false, error_response(error)),
            };
            (false, frame_response(*handle, delta_ms))
        }
        "lastError" => {
            if handle.is_null() {
                return (false, json!({"ok": true, "error": ""}));
            }
            (false, json!({"ok": true, "error": last_error(*handle)}))
        }
        "destroy" => {
            destroy(handle);
            (false, json!({"ok": true}))
        }
        "quit" => {
            destroy(handle);
            (true, json!({"ok": true}))
        }
        _ => (false, error_response("unknown probe command")),
    }
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut handle: Handle = std::ptr::null_mut();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(command_value) => {
                // `command` is the only unsafe boundary in this process; the
                // native C ABI owns the handle and all returned C strings.
                let (quit, response) = unsafe { command(&command_value, &mut handle) };
                if serde_json::to_writer(&mut stdout, &response).is_err() {
                    break;
                }
                stdout.write_all(b"\n")?;
                stdout.flush()?;
                if quit {
                    return Ok(());
                }
                continue;
            }
            Err(error) => error_response(format!("invalid command JSON: {error}")),
        };
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }

    unsafe { destroy(&mut handle) };
    Ok(())
}
