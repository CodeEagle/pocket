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
//!   Add `"rawFrame":true` on an untraced frame command to pass through the
//!   validated native JSON without converting it through a serde_json value.
//!   Add `"resourceEncoding":"base64"` on `frame`, or on `load`,
//!   `loadBytecode`, and `eval` with `"render":true`, to serialize
//!   `FrameResource` pixel/palette payloads as lossless base64 strings with
//!   `"bytesEncoding":"base64"`.
//! * `{"op":"resize","width":390,"height":400}` updates the live viewport
//! * `{"op":"traceMode","mode":1}` selects the existing native recording
//!   clock (0 live, 1 record, 2 replay) before load/eval.
//! * Add `"traceClock":{}` to a transaction to return its native trace envelope;
//!   replay supplies the previously captured envelope in the same field.
//! * `load`, `loadBytecode` and `eval` accept `"render":true` to include the
//!   initial frame in that same transaction, matching the public runtime ABI.
//! * `{"op":"lastError"}`, `{"op":"destroy"}`, `{"op":"quit"}`
//!
//! The probe deliberately has no application/page logic; all composition and
//! state continue to come from the guest bundle supplied by the caller.

use pocket_flutter::{
    pocket_bytecode_runtime_abi, pocket_configure_compositor, pocket_configure_guest_security,
    pocket_configure_worker, pocket_create, pocket_create_with_density_and_tick_hz,
    pocket_create_with_memory_limits, pocket_destroy, pocket_eval, pocket_frame_for_probe_json,
    pocket_last_error, pocket_load_bytecode_files, pocket_load_files, pocket_next_wake_delay_ms,
    pocket_resize_viewport, pocket_send, pocket_send_binary, pocket_trace_clock_begin_json,
    pocket_trace_clock_end_json, pocket_trace_clock_mode,
};
use serde::de::Deserialize;
use serde_json::{json, Value};
use base64::Engine;
use std::ffi::{c_void, CStr, CString};
use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

type Handle = *mut c_void;

const MAX_RAW_FRAME_BYTES: usize = 64 * 1024 * 1024;

enum ProbeResponse {
    Json(Value),
    RawFrame(Vec<u8>),
}

// Worker/provider completion happens on a native thread. Keep the line
// protocol responsive by emitting a tiny out-of-band wake record; the Node
// bridge treats this as an event rather than consuming a pending command
// response. A process has one probe stream, so one coalesced wake at a time is
// sufficient (the native WorkerUiBridge re-arms its own gate at latch).
static PROBE_OUTPUT_LOCK: Mutex<()> = Mutex::new(());
static PROBE_WORKER_WAKE: AtomicBool = AtomicBool::new(false);

unsafe extern "C" fn worker_notify() {
    if PROBE_WORKER_WAKE.swap(true, Ordering::AcqRel) {
        return;
    }
    let _guard = PROBE_OUTPUT_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let mut stdout = io::stdout().lock();
    let _ = serde_json::to_writer(&mut stdout, &json!({"__pocket_probe_event":"worker"}));
    let _ = stdout.write_all(b"\n");
    let _ = stdout.flush();
}

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

fn memory_limit(command: &Value, key: &str) -> Result<u64, String> {
    let Some(memory) = command.get("memory") else {
        return Ok(0);
    };
    let object = memory
        .as_object()
        .ok_or_else(|| "memory must be an object".to_owned())?;
    let Some(value) = object.get(key) else {
        return Ok(0);
    };
    value
        .as_u64()
        .ok_or_else(|| format!("memory.{key} must be a non-negative integer"))
}

fn c_string(value: &str, label: &str) -> Result<CString, Value> {
    CString::new(value).map_err(|_| error_response(format!("{label} contains a NUL byte")))
}

fn worker_bytecode_file(path: &str) -> Result<Vec<u8>, Value> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| error_response(format!("worker bytecode metadata: {error}")))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 64 * 1024 * 1024 {
        return Err(error_response(
            "worker bytecode must be a non-empty file of at most 64 MiB",
        ));
    }
    let bytes = std::fs::read(path)
        .map_err(|error| error_response(format!("worker bytecode read: {error}")))?;
    if bytes.is_empty() || bytes.len() as u64 > 64 * 1024 * 1024 {
        return Err(error_response("worker bytecode changed size while reading"));
    }
    Ok(bytes)
}

fn validate_raw_json(bytes: &[u8]) -> Result<(), serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    serde::de::IgnoredAny::deserialize(&mut deserializer)?;
    deserializer.end()
}

fn compact_resources_requested(command: &Value) -> Result<bool, String> {
    match command.get("resourceEncoding") {
        None => Ok(false),
        Some(Value::String(encoding)) if encoding == "base64" => Ok(true),
        Some(_) => Err("resourceEncoding must be \"base64\"".to_owned()),
    }
}

unsafe fn frame_response_mode(
    handle: Handle,
    delta_ms: f64,
    raw_frame: bool,
    compact_resources: bool,
) -> ProbeResponse {
    let pointer = pocket_frame_for_probe_json(handle.cast(), delta_ms, compact_resources);
    if pointer.is_null() {
        return ProbeResponse::Json(native_error(handle, "pocket_frame"));
    }

    let bytes = CStr::from_ptr(pointer).to_bytes();
    if bytes.len() > MAX_RAW_FRAME_BYTES {
        return ProbeResponse::Json(error_response(
            "pocket_frame returned JSON larger than 64 MiB",
        ));
    }
    if raw_frame {
        // The runtime owns this JSON and normally emits canonical UTF-8. Validate
        // it without materializing a serde_json::Value tree, then keep its bytes
        // unchanged for the probe's response writer.
        return match validate_raw_json(bytes) {
            Ok(()) => ProbeResponse::RawFrame(bytes.to_vec()),
            Err(error) => ProbeResponse::Json(error_response(format!(
                "pocket_frame returned invalid JSON: {error}"
            ))),
        };
    }

    match serde_json::from_slice::<Value>(bytes) {
        Ok(frame) => ProbeResponse::Json(json!({"ok": true, "frame": frame})),
        Err(error) => ProbeResponse::Json(error_response(format!(
            "pocket_frame returned invalid JSON: {error}"
        ))),
    }
}

unsafe fn frame_response(handle: Handle, delta_ms: f64, compact_resources: bool) -> Value {
    match frame_response_mode(handle, delta_ms, false, compact_resources) {
        ProbeResponse::Json(response) => response,
        ProbeResponse::RawFrame(_) => unreachable!("parsed frame response cannot be raw"),
    }
}

unsafe fn frame_command(command: &Value, handle: Handle, raw_frame: bool) -> ProbeResponse {
    if handle.is_null() {
        return ProbeResponse::Json(error_response("create a native runtime before framing"));
    }
    let delta_ms = match finite_number(command, "deltaMs", 16.0) {
        Ok(value) => value,
        Err(error) => return ProbeResponse::Json(error_response(error)),
    };
    let compact_resources = match compact_resources_requested(command) {
        Ok(value) => value,
        Err(error) => return ProbeResponse::Json(error_response(error)),
    };
    // The preceding UI frame latches the coalesced Worker wake. Allow the next
    // provider completion to publish a fresh event.
    PROBE_WORKER_WAKE.store(false, Ordering::Release);
    frame_response_mode(handle, delta_ms, raw_frame, compact_resources)
}

fn raw_frame_requested(command: &Value) -> bool {
    command.get("traceClock").is_none()
        && command.get("rawFrame") == Some(&Value::Bool(true))
        && command
            .get("op")
            .or_else(|| command.get("command"))
            .and_then(Value::as_str)
            == Some("frame")
}

unsafe fn command_response(command_value: &Value, handle: &mut Handle) -> (bool, ProbeResponse) {
    if raw_frame_requested(command_value) {
        return (false, frame_command(command_value, *handle, true));
    }
    let (quit, response) = command(command_value, handle);
    (quit, ProbeResponse::Json(response))
}

fn write_response<W: Write>(writer: &mut W, response: ProbeResponse) -> io::Result<()> {
    match response {
        ProbeResponse::Json(response) => serde_json::to_writer(&mut *writer, &response)?,
        ProbeResponse::RawFrame(frame) => {
            writer.write_all(br#"{"ok":true,"frame":"#)?;
            writer.write_all(&frame)?;
            writer.write_all(b"}")?;
        }
    }
    writer.write_all(b"\n")?;
    writer.flush()
}

unsafe fn destroy(handle: &mut Handle) {
    if !handle.is_null() {
        pocket_destroy((*handle).cast());
        *handle = std::ptr::null_mut();
    }
}

unsafe fn command(command: &Value, handle: &mut Handle) -> (bool, Value) {
    let Some(envelope) = command.get("traceClock") else {
        return command_inner(command, handle);
    };
    let operation = command
        .get("op")
        .or_else(|| command.get("command"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if !matches!(
        operation,
        "load"
            | "loadBytecode"
            | "configureWorker"
            | "eval"
            | "send"
            | "sendBinary"
            | "resize"
            | "frame"
            | "compositor"
            | "traceBoundary"
    ) {
        return (
            false,
            error_response("traceClock requires a live native transaction"),
        );
    }
    if handle.is_null() {
        return (
            false,
            error_response("create a native runtime before tracing"),
        );
    }
    let encoded = CString::new(envelope.to_string()).expect("JSON has no literal NUL");
    if pocket_trace_clock_begin_json((*handle).cast(), encoded.as_ptr()) != 0 {
        return (
            false,
            native_error(*handle, "pocket_trace_clock_begin_json"),
        );
    }
    let (quit, mut response) = command_inner(command, handle);
    let trace = pocket_trace_clock_end_json((*handle).cast());
    if trace.is_null() {
        let mut failure = native_error(*handle, "pocket_trace_clock_end_json");
        failure["operationResult"] = response;
        return (quit, failure);
    }
    match serde_json::from_str::<Value>(&CStr::from_ptr(trace).to_string_lossy()) {
        Ok(envelope) => response["traceClock"] = envelope,
        Err(error) => {
            return (
                quit,
                error_response(format!("invalid native trace clock JSON: {error}")),
            )
        }
    }
    (quit, response)
}

unsafe fn command_inner(command: &Value, handle: &mut Handle) -> (bool, Value) {
    let operation = command
        .get("op")
        .or_else(|| command.get("command"))
        .and_then(Value::as_str)
        .unwrap_or("");

    match operation {
        "compositor" => {
            if handle.is_null() {
                return (
                    false,
                    error_response(
                        "create a native runtime before configuring compositor surfaces",
                    ),
                );
            }
            let Some(applications) = command
                .get("applications")
                .filter(|value| value.is_object())
            else {
                return (
                    false,
                    error_response("compositor requires an applications object"),
                );
            };
            let encoded = CString::new(applications.to_string()).expect("JSON has no literal NUL");
            if pocket_configure_compositor((*handle).cast(), encoded.as_ptr()) != 0 {
                return (false, native_error(*handle, "pocket_configure_compositor"));
            }
            (false, json!({"ok": true, "configured": true}))
        }
        "traceMode" => {
            if handle.is_null() {
                return (
                    false,
                    error_response("create a native runtime before selecting trace mode"),
                );
            }
            let Some(mode) = command
                .get("mode")
                .and_then(Value::as_u64)
                .filter(|mode| *mode <= 2)
            else {
                return (false, error_response("trace mode must be 0, 1, or 2"));
            };
            if pocket_trace_clock_mode((*handle).cast(), mode as u32) != 0 {
                return (false, native_error(*handle, "pocket_trace_clock_mode"));
            }
            (false, json!({"ok": true}))
        }
        "traceBoundary" => {
            if command.get("traceClock").is_none() {
                return (false, error_response("traceBoundary requires traceClock"));
            }
            (false, json!({"ok": true, "captured": true}))
        }
        "configureWorker" => {
            if handle.is_null() {
                return (
                    false,
                    error_response("create a native runtime before configuring a worker"),
                );
            }
            let bytecode_path = match command.get("bytecodePath").and_then(Value::as_str) {
                Some(value) => value,
                None => {
                    return (
                        false,
                        error_response("configureWorker requires bytecodePath"),
                    )
                }
            };
            let config = match command.get("config") {
                Some(value) if value.is_object() => value,
                Some(_) => {
                    return (
                        false,
                        error_response("configureWorker config must be an object"),
                    )
                }
                None => return (false, error_response("configureWorker requires config")),
            };
            let bytes = match worker_bytecode_file(bytecode_path) {
                Ok(value) => value,
                Err(error) => return (false, error),
            };
            let config_json = match CString::new(config.to_string()) {
                Ok(value) => value,
                Err(_) => {
                    return (
                        false,
                        error_response("configureWorker config contains a NUL byte"),
                    )
                }
            };
            PROBE_WORKER_WAKE.store(false, Ordering::Release);
            if pocket_configure_worker(
                (*handle).cast(),
                bytes.as_ptr(),
                bytes.len(),
                config_json.as_ptr(),
                if command.get("notify") == Some(&Value::Bool(false)) {
                    None
                } else {
                    Some(worker_notify)
                },
            ) != 0
            {
                return (false, native_error(*handle, "pocket_configure_worker"));
            }
            (false, json!({"ok": true, "configured": true}))
        }
        "schedule" => {
            if handle.is_null() {
                return (
                    false,
                    error_response("create a native runtime before querying schedule"),
                );
            }
            (
                false,
                json!({"ok": true, "nextWakeDelayMs": pocket_next_wake_delay_ms((*handle).cast())}),
            )
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
            let heap_limit_bytes = match memory_limit(command, "heapLimitBytes") {
                Ok(value) => value,
                Err(error) => return (false, error_response(error)),
            };
            let max_pak_bytes = match memory_limit(command, "maxPakBytes") {
                Ok(value) => value,
                Err(error) => return (false, error_response(error)),
            };
            destroy(handle);
            let created = if command.get("memory").is_some() {
                pocket_create_with_memory_limits(
                    width,
                    height,
                    density,
                    tick_hz,
                    heap_limit_bytes,
                    max_pak_bytes,
                )
            } else if command.get("rasterDensity").is_some() || command.get("tickHz").is_some() {
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
            let install_host_fonts = match command.get("hostFonts") {
                None => true,
                Some(Value::Bool(enabled)) => *enabled,
                Some(_) => {
                    destroy(handle);
                    return (false, error_response("hostFonts must be a boolean"));
                }
            };
            if install_host_fonts {
                let (lh, cjk, ascii) = pocket_flutter::default_probe_host_font_metrics();
                if pocket_flutter::pocket_set_host_font_metrics(
                    created,
                    lh.len() as u32,
                    lh.as_ptr(),
                    cjk.as_ptr(),
                    ascii.as_ptr(),
                ) != 0
                {
                    let detail = last_error(*handle);
                    destroy(handle);
                    return (false, error_response(detail));
                }
            }
            if let Some(policy) = command.get("guestSecurity") {
                let encoded = CString::new(policy.to_string()).expect("JSON has no literal NUL");
                if pocket_configure_guest_security(created, encoded.as_ptr()) != 0 {
                    let detail = last_error(*handle);
                    destroy(handle);
                    return (false, error_response(detail));
                }
            }
            if let Some(applications) = command.get("compositorSurfaces") {
                let registry =
                    CString::new(applications.to_string()).expect("JSON has no literal NUL");
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
            let compact_resources = match compact_resources_requested(command) {
                Ok(value) => value,
                Err(error) => return (false, error_response(error)),
            };
            let result =
                pocket_load_files((*handle).cast(), source_path.as_ptr(), pak_path.as_ptr());
            if result != 0 {
                return (false, native_error(*handle, "pocket_load_files"));
            }
            if command.get("render") == Some(&Value::Bool(true)) {
                return (false, frame_response(*handle, 0.0, compact_resources));
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
            let compact_resources = match compact_resources_requested(command) {
                Ok(value) => value,
                Err(error) => return (false, error_response(error)),
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
            if command.get("render") == Some(&Value::Bool(true)) {
                let mut response = frame_response(*handle, 0.0, compact_resources);
                response["runtimeAbi"] = Value::String(abi);
                return (false, response);
            }
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
            let compact_resources = match compact_resources_requested(command) {
                Ok(value) => value,
                Err(error) => return (false, error_response(error)),
            };
            if pocket_eval((*handle).cast(), source.as_ptr()) != 0 {
                return (false, native_error(*handle, "pocket_eval"));
            }
            if command.get("render") == Some(&Value::Bool(true)) {
                return (false, frame_response(*handle, 0.0, compact_resources));
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
        "sendBinary" => {
            if handle.is_null() {
                return (false, error_response("create a native runtime before sending"));
            }
            let encoded = match command.get("base64").and_then(Value::as_str) {
                Some(value) if value.len() <= 6 * 1024 * 1024 => value,
                _ => return (false, error_response("sendBinary requires bounded base64")),
            };
            let bytes = match base64::engine::general_purpose::STANDARD.decode(encoded) {
                Ok(bytes) if !bytes.is_empty() && bytes.len() <= 4 * 1024 * 1024 => bytes,
                _ => return (false, error_response("sendBinary contains invalid or oversized bytes")),
            };
            if pocket_send_binary((*handle).cast(), bytes.as_ptr(), bytes.len()) != 0 {
                return (false, native_error(*handle, "pocket_send_binary"));
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
            let response = match frame_command(command, *handle, false) {
                ProbeResponse::Json(response) => response,
                ProbeResponse::RawFrame(_) => unreachable!("parsed frame command cannot be raw"),
            };
            (false, response)
        }
        "lastError" => {
            if handle.is_null() {
                return (false, json!({"ok": true, "error": ""}));
            }
            (false, json!({"ok": true, "error": last_error(*handle)}))
        }
        "destroy" => {
            PROBE_WORKER_WAKE.store(false, Ordering::Release);
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
    // Do not retain StdoutLock for the process lifetime: the native Worker
    // wake callback writes an out-of-band line while this loop is blocked in a
    // load/frame call. The process-wide output mutex serializes both writers.
    let mut stdout = io::BufWriter::new(io::stdout());
    let mut handle: Handle = std::ptr::null_mut();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(command_value) => {
                // Dispatch is the only unsafe boundary in this process; the
                // native C ABI owns the handle and all returned C strings.
                let (quit, response) = unsafe { command_response(&command_value, &mut handle) };
                let _guard = PROBE_OUTPUT_LOCK
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                if write_response(&mut stdout, response).is_err() {
                    break;
                }
                if quit {
                    return Ok(());
                }
                continue;
            }
            Err(error) => error_response(format!("invalid command JSON: {error}")),
        };
        let _guard = PROBE_OUTPUT_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        write_response(&mut stdout, ProbeResponse::Json(response))?;
    }

    unsafe { destroy(&mut handle) };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe fn run(handle: &mut Handle, value: Value) -> Value {
        let (_, response) = command(&value, handle);
        assert_eq!(response["ok"], true, "{response}");
        response
    }

    #[test]
    fn raw_frame_matches_default_envelope_and_trace_uses_value_path() {
        unsafe {
            let source = "globalThis.__pocketEvent=function(){}; globalThis.frame=function(){pocket._emit(JSON.stringify({method:'frame.sample',params:{value:7}}));};";
            let mut standard = std::ptr::null_mut();
            run(
                &mut standard,
                json!({"op":"create", "width":80, "height":80}),
            );
            run(&mut standard, json!({"op":"eval", "source":source}));

            let mut passthrough = std::ptr::null_mut();
            run(
                &mut passthrough,
                json!({"op":"create", "width":80, "height":80}),
            );
            run(&mut passthrough, json!({"op":"eval", "source":source}));

            let expected = run(&mut standard, json!({"op":"frame", "deltaMs":16}));
            let (_, raw_response) = command_response(
                &json!({"op":"frame", "deltaMs":16, "rawFrame":true}),
                &mut passthrough,
            );
            let ProbeResponse::RawFrame(frame) = raw_response else {
                panic!("untraced rawFrame request did not use the raw response");
            };
            assert_eq!(
                serde_json::from_slice::<Value>(&frame).unwrap(),
                expected["frame"]
            );

            let mut wire = Vec::new();
            write_response(&mut wire, ProbeResponse::RawFrame(frame)).unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&wire).unwrap(), expected);

            let (_, traced_response) = command_response(
                &json!({"op":"frame", "deltaMs":16, "rawFrame":true, "traceClock":{}}),
                &mut passthrough,
            );
            let ProbeResponse::Json(traced_response) = traced_response else {
                panic!("traced frame request bypassed the JSON value path");
            };
            assert_eq!(traced_response["ok"], true);
            assert!(traced_response.get("traceClock").is_some());

            destroy(&mut standard);
            destroy(&mut passthrough);
        }
    }

    #[test]
    fn raw_frame_validation_rejects_trailing_data_and_invalid_utf8() {
        assert!(validate_raw_json(br#"{"ops":[1,2]}"#).is_ok());
        assert!(validate_raw_json(br#"{"ops":[]} trailing"#).is_err());
        assert!(validate_raw_json(b"[\xff]").is_err());
    }

    #[test]
    fn native_trace_round_trip_and_unconsumed_facts_fail() {
        unsafe {
            let mut recorded = std::ptr::null_mut();
            run(
                &mut recorded,
                json!({"op":"create", "width":80, "height":80}),
            );
            run(&mut recorded, json!({"op":"traceMode", "mode":1}));
            let source = "globalThis.__pocketEvent=function(){}; globalThis.frame=function(){pocket._emit(JSON.stringify({method:'trace.sample',params:{random:Math.random(),now:Date.now()}}));};";
            let boot = run(
                &mut recorded,
                json!({"op":"eval", "source":source, "render":true, "traceClock":{}}),
            );
            let frame = run(
                &mut recorded,
                json!({"op":"frame", "deltaMs":16, "traceClock":{}}),
            );
            assert!(!boot["traceClock"]["scalars"].as_array().unwrap().is_empty());

            let mut replayed = std::ptr::null_mut();
            run(
                &mut replayed,
                json!({"op":"create", "width":80, "height":80}),
            );
            run(&mut replayed, json!({"op":"traceMode", "mode":2}));
            let replay_boot = run(
                &mut replayed,
                json!({"op":"eval", "source":source, "render":true, "traceClock":boot["traceClock"]}),
            );
            assert_eq!(replay_boot["frame"]["events"], boot["frame"]["events"]);
            let replay_frame = run(
                &mut replayed,
                json!({"op":"frame", "deltaMs":16, "traceClock":frame["traceClock"]}),
            );
            assert_eq!(replay_frame["frame"]["events"], frame["frame"]["events"]);

            let mut invalid = frame["traceClock"].clone();
            let scalars = invalid["scalars"].as_array_mut().unwrap();
            for _ in 0..8 {
                scalars.push(boot["traceClock"]["scalars"][0].clone());
            }
            let (_, failure) = command(
                &json!({"op":"frame", "deltaMs":16, "traceClock":invalid}),
                &mut replayed,
            );
            assert_eq!(
                failure["ok"], false,
                "unconsumed trace facts cannot be reported as a successful replay"
            );
            destroy(&mut recorded);
            destroy(&mut replayed);
        }
    }

    #[test]
    fn resource_encoding_base64_works_across_raw_traced_and_render_commands() {
        unsafe {
            let dir = std::env::temp_dir().join(format!(
                "pocket-probe-compact-test-{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let source_path = dir.join("app.js");
            let pak_path = dir.join("app.pak");
            let source = "const img = ui.createNode(2); ui.setProp(img, 1, 16); ui.setProp(img, 2, 16); ui.setImage(img, ui.__textures.sample); ui.insertBefore(1, img, 0); globalThis.frame = function() {};";
            std::fs::write(&source_path, source).unwrap();

            let key = b"ui:img.sample";
            let blob: [u8; 12] = [1, 0, 1, 0, 3, 0, 0, 0, 12, 34, 56, 255];
            let dir_off = 32usize;
            let names_off = dir_off + 24;
            let blob_off = (names_off + key.len() + 15) & !15;
            let pak_len = (blob_off + blob.len() + 15) & !15;
            let mut pak = vec![0u8; pak_len];
            pak[0..4].copy_from_slice(&0x4b50_4344u32.to_le_bytes());
            pak[4..6].copy_from_slice(&1u16.to_le_bytes());
            pak[8..12].copy_from_slice(&1u32.to_le_bytes());
            pak[12..16].copy_from_slice(&(dir_off as u32).to_le_bytes());
            pak[16..20].copy_from_slice(&(names_off as u32).to_le_bytes());
            pak[20..24].copy_from_slice(&(blob_off as u32).to_le_bytes());
            pak[24..28].copy_from_slice(&(pak_len as u32).to_le_bytes());
            pak[dir_off + 4..dir_off + 8].copy_from_slice(&(blob_off as u32).to_le_bytes());
            pak[dir_off + 8..dir_off + 12].copy_from_slice(&(blob.len() as u32).to_le_bytes());
            pak[dir_off + 12..dir_off + 16].copy_from_slice(&0u32.to_le_bytes());
            pak[dir_off + 16..dir_off + 18].copy_from_slice(&(key.len() as u16).to_le_bytes());
            pak[names_off..names_off + key.len()].copy_from_slice(key);
            pak[blob_off..blob_off + blob.len()].copy_from_slice(&blob);
            std::fs::write(&pak_path, &pak).unwrap();

            let src_str = source_path.to_str().unwrap();
            let pak_str = pak_path.to_str().unwrap();

            let mut legacy = std::ptr::null_mut();
            run(&mut legacy, json!({"op":"create", "width":80, "height":40}));
            let legacy_load = run(
                &mut legacy,
                json!({"op":"load", "sourcePath":src_str, "pakPath":pak_str, "render":true}),
            );
            let legacy_res = &legacy_load["frame"]["resources"][0];
            assert!(legacy_res.get("bytesEncoding").is_none());
            assert!(legacy_res["pixels"].is_array());

            let mut compact_load_handle = std::ptr::null_mut();
            run(
                &mut compact_load_handle,
                json!({"op":"create", "width":80, "height":40}),
            );
            let compact_load = run(
                &mut compact_load_handle,
                json!({"op":"load", "sourcePath":src_str, "pakPath":pak_str, "render":true, "resourceEncoding":"base64"}),
            );
            let compact_res = &compact_load["frame"]["resources"][0];
            assert_eq!(compact_res["bytesEncoding"], "base64");
            let decoded_pixels = base64::engine::general_purpose::STANDARD
                .decode(compact_res["pixels"].as_str().unwrap())
                .unwrap();
            let expected_pixels: Vec<u8> = legacy_res["pixels"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u8)
                .collect();
            assert_eq!(decoded_pixels, expected_pixels);

            let mut raw_compact = std::ptr::null_mut();
            run(
                &mut raw_compact,
                json!({"op":"create", "width":80, "height":40}),
            );
            run(
                &mut raw_compact,
                json!({"op":"load", "sourcePath":src_str, "pakPath":pak_str}),
            );
            let (_, raw_response) = command_response(
                &json!({"op":"frame", "deltaMs":16, "rawFrame":true, "resourceEncoding":"base64"}),
                &mut raw_compact,
            );
            let ProbeResponse::RawFrame(raw_bytes) = raw_response else {
                panic!("expected RawFrame for untraced rawFrame + resourceEncoding:base64");
            };
            let parsed_raw: Value = serde_json::from_slice(&raw_bytes).unwrap();
            assert_eq!(parsed_raw["resources"][0]["bytesEncoding"], "base64");
            assert_eq!(parsed_raw["resources"][0]["pixels"], compact_res["pixels"]);

            let mut traced_compact = std::ptr::null_mut();
            run(
                &mut traced_compact,
                json!({"op":"create", "width":80, "height":40}),
            );
            run(&mut traced_compact, json!({"op":"traceMode", "mode":1}));
            run(
                &mut traced_compact,
                json!({"op":"load", "sourcePath":src_str, "pakPath":pak_str, "traceClock":{}}),
            );
            let (_, traced_response) = command_response(
                &json!({"op":"frame", "deltaMs":16, "rawFrame":true, "resourceEncoding":"base64", "traceClock":{}}),
                &mut traced_compact,
            );
            let ProbeResponse::Json(traced_json) = traced_response else {
                panic!("expected Json response for traced frame with resourceEncoding:base64");
            };
            assert_eq!(traced_json["ok"], true);
            assert!(traced_json.get("traceClock").is_some());
            assert_eq!(
                traced_json["frame"]["resources"][0]["bytesEncoding"],
                "base64"
            );

            let (_, invalid_encoding) = command_response(
                &json!({"op":"frame", "deltaMs":16, "resourceEncoding":"hex"}),
                &mut raw_compact,
            );
            let ProbeResponse::Json(invalid_json) = invalid_encoding else {
                panic!("expected error Json response");
            };
            assert_eq!(invalid_json["ok"], false);

            let mut unconfigured = std::ptr::null_mut();
            run(
                &mut unconfigured,
                json!({"op":"create", "width":80, "height":40, "hostFonts":false}),
            );
            let (_, rejected) = command(
                &json!({"op":"load", "sourcePath":src_str, "pakPath":pak_str}),
                &mut unconfigured,
            );
            assert_eq!(rejected["ok"], false);
            assert!(rejected["error"]
                .as_str()
                .unwrap_or("")
                .contains("no baked ui:font.* atlases"));

            destroy(&mut unconfigured);
            destroy(&mut legacy);
            destroy(&mut compact_load_handle);
            destroy(&mut raw_compact);
            destroy(&mut traced_compact);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
