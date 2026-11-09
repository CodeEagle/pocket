//! WASM admission facade for the pinned C Worker core and QuickJS realm.
//! The browser only transports IO facts; it never evaluates guest JavaScript.
use crate::bytecode::{self, BytecodeExpectation, BytecodeKind};
use pocket_runtime::generated_ops::BINDING_GENERATION;
use serde::Deserialize;
use std::{
    collections::HashSet,
    ffi::{c_char, c_void, CStr, CString},
    ptr,
};

#[repr(C)]
struct Node {
    name: *const c_char,
    kind: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    kind: String,
    protocol_version: u32,
    runtime_abi: String,
    binding_generation: u32,
    tick_hz: u32,
    required_caps: Vec<String>,
    bytecode: Artifact,
    declaration: Declaration,
}
#[derive(Deserialize)]
struct Artifact {
    bytes: usize,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Declaration {
    entry: String,
    nodes: Vec<NodeDeclaration>,
    channels: Vec<serde_json::Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeDeclaration {
    name: String,
    kind: String,
}

thread_local! {
    static CREATE_ERROR: std::cell::RefCell<CString> = std::cell::RefCell::new(CString::new("Worker admission failed").unwrap());
}
fn create_error(message: &str) {
    CREATE_ERROR
        .with(|error| *error.borrow_mut() = CString::new(message.replace('\0', " ")).unwrap());
}

pub struct WebWorker {
    realm: *mut c_void,
    // pocket_worker_config borrows node names until the resource core dies.
    _names: Vec<CString>,
    _nodes: Vec<Node>,
}

unsafe extern "C" {
    fn pweb_worker_create(nodes: *const Node, count: usize, generation: u32) -> *mut c_void;
    fn pweb_worker_boot(worker: *mut c_void, bytes: *const u8, size: usize) -> i32;
    fn pweb_worker_step(worker: *mut c_void, now: f64) -> i32;
    fn pweb_worker_deadline(worker: *mut c_void) -> f64;
    fn pweb_worker_receive(worker: *mut c_void, channel: u32, bytes: *const u8, size: usize)
        -> i32;
    fn pweb_worker_take(worker: *mut c_void, channel: u32, bytes: *mut u8, size: usize) -> i32;
    fn pweb_worker_emit(
        worker: *mut c_void,
        request: u32,
        kind: u32,
        status: i32,
        offset: f64,
        bytes: *const u8,
        size: usize,
    ) -> i32;
    fn pweb_worker_finish(
        worker: *mut c_void,
        request: u32,
        handle: u32,
        status: i32,
        offset: f64,
    ) -> i32;
    fn pweb_worker_error(worker: *mut c_void) -> *const c_char;
    fn pweb_worker_destroy(worker: *mut c_void) -> i32;
}

fn descriptor(bytes: &[u8], qjbc: &[u8], tick_hz: u32) -> Option<Descriptor> {
    let descriptor: Descriptor = serde_json::from_slice(bytes).ok()?;
    if descriptor.kind != "quickjs-bytecode"
        || descriptor.protocol_version != 1
        || descriptor.runtime_abi != bytecode::runtime_abi()
        || descriptor.binding_generation != BINDING_GENERATION
        || descriptor.tick_hz != tick_hz
        || !(1..=240).contains(&tick_hz)
        || descriptor.bytecode.bytes != qjbc.len()
        || descriptor.bytecode.sha256 != bytecode::sha256_hex(qjbc)
        || descriptor.declaration.nodes.len() > 8
        || descriptor.declaration.entry.is_empty()
        || descriptor.declaration.entry.len() > 4096
        || descriptor.declaration.entry.starts_with('/')
        || descriptor.declaration.entry.contains('\\')
        || descriptor.declaration.entry.contains('\0')
        || descriptor
            .declaration
            .entry
            .split('/')
            .any(|part| part == ".." || part == "." || part.is_empty())
        || !crate::web_worker_channels::UiChannels::valid_declarations(
            &descriptor.declaration.channels,
        )
    {
        return None;
    }
    let mut names = HashSet::new();
    let mut required = HashSet::from(["runtime.worker"]);
    for node in &descriptor.declaration.nodes {
        // This Web provider implements HTTP only. Device declarations cannot
        // become working I2C/UART merely by being listed in a manifest.
        if node.kind != "http"
            || node.name.is_empty()
            || node.name.len() > 63
            || !node.name.as_bytes()[0].is_ascii_alphabetic()
            || !node
                .name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
            || !names.insert(node.name.as_str())
        {
            return None;
        }
        required.insert("net.http");
    }
    let actual: HashSet<&str> = descriptor
        .required_caps
        .iter()
        .map(String::as_str)
        .collect();
    if actual.len() != descriptor.required_caps.len() || actual != required {
        return None;
    }
    Some(descriptor)
}

/// Admission happens before JS_ReadObject: envelope, payload hash, exact ABI,
/// protocol, generation, tick rate, declared nodes and required capabilities.
#[no_mangle]
pub unsafe extern "C" fn web_worker_create(
    qp: *const u8,
    qn: usize,
    cp: *const u8,
    cn: usize,
    tick_hz: u32,
) -> *mut WebWorker {
    if qp.is_null() || cp.is_null() || qn == 0 || qn > 16 * 1024 * 1024 || cn == 0 || cn > 64 * 1024
    {
        return ptr::null_mut();
    }
    let qjbc = std::slice::from_raw_parts(qp, qn);
    create_error("Worker descriptor or QJBC envelope rejected");
    let Some(descriptor) = descriptor(std::slice::from_raw_parts(cp, cn), qjbc, tick_hz) else {
        return ptr::null_mut();
    };
    let Ok(artifact) = bytecode::validate(
        qjbc,
        BytecodeExpectation {
            kind: BytecodeKind::Script,
            binding_generation: BINDING_GENERATION,
            tick_hz,
        },
    ) else {
        return ptr::null_mut();
    };
    let names: Vec<CString> = descriptor
        .declaration
        .nodes
        .iter()
        .map(|node| CString::new(node.name.as_str()).unwrap())
        .collect();
    let nodes: Vec<Node> = names
        .iter()
        .map(|name| Node {
            name: name.as_ptr(),
            kind: 3,
        })
        .collect();
    let realm = pweb_worker_create(nodes.as_ptr(), nodes.len(), 1);
    if realm.is_null() {
        return ptr::null_mut();
    }
    let worker = Box::new(WebWorker {
        realm,
        _names: names,
        _nodes: nodes,
    });
    if pweb_worker_boot(realm, artifact.payload.as_ptr(), artifact.payload.len()) != 0 {
        let detail = pweb_worker_error(realm);
        if !detail.is_null() {
            create_error(&CStr::from_ptr(detail).to_string_lossy());
        }
        if pweb_worker_destroy(realm) != 0 {
            // A provider that failed to revoke retains the borrowed names.
            // The Worker owner will terminate this isolated WASM instance.
            let _ = Box::into_raw(worker);
        }
        return ptr::null_mut();
    }
    Box::into_raw(worker)
}

#[no_mangle]
pub unsafe extern "C" fn web_worker_step(worker: *mut WebWorker, now: f64) -> i32 {
    if worker.is_null() || !now.is_finite() || now < 0.0 {
        return -5;
    }
    pweb_worker_step((*worker).realm, now)
}
#[no_mangle]
pub unsafe extern "C" fn web_worker_deadline(worker: *mut WebWorker) -> f64 {
    if worker.is_null() {
        return -1.0;
    }
    pweb_worker_deadline((*worker).realm)
}
#[no_mangle]
pub unsafe extern "C" fn web_worker_receive(
    worker: *mut WebWorker,
    channel: u32,
    p: *const u8,
    n: usize,
) -> i32 {
    if worker.is_null() || n > 1024 || (n > 0 && p.is_null()) {
        return -5;
    }
    pweb_worker_receive((*worker).realm, channel, p, n)
}
#[no_mangle]
pub unsafe extern "C" fn web_worker_take(
    worker: *mut WebWorker,
    channel: u32,
    p: *mut u8,
    n: usize,
) -> i32 {
    if worker.is_null() || p.is_null() || n > 1024 {
        return -5;
    }
    pweb_worker_take((*worker).realm, channel, p, n)
}
#[no_mangle]
pub unsafe extern "C" fn web_worker_emit(
    worker: *mut WebWorker,
    request: u32,
    kind: u32,
    status: i32,
    offset: f64,
    p: *const u8,
    n: usize,
) -> i32 {
    if worker.is_null()
        || n > 1024
        || (n > 0 && p.is_null())
        || !offset.is_finite()
        || offset < 0.0
        || offset > 9_007_199_254_740_991.0
        || offset.fract() != 0.0
    {
        return -5;
    }
    pweb_worker_emit((*worker).realm, request, kind, status, offset, p, n)
}
#[no_mangle]
pub unsafe extern "C" fn web_worker_finish(
    worker: *mut WebWorker,
    request: u32,
    handle: u32,
    status: i32,
    offset: f64,
) -> i32 {
    if worker.is_null()
        || !offset.is_finite()
        || offset < 0.0
        || offset > 9_007_199_254_740_991.0
        || offset.fract() != 0.0
    {
        return -5;
    }
    pweb_worker_finish((*worker).realm, request, handle, status, offset)
}
#[no_mangle]
pub unsafe extern "C" fn web_worker_error(worker: *mut WebWorker) -> *const c_char {
    if worker.is_null() {
        return CREATE_ERROR.with(|error| error.borrow().as_ptr());
    }
    pweb_worker_error((*worker).realm)
}
#[no_mangle]
pub unsafe extern "C" fn web_worker_destroy(worker: *mut WebWorker) -> i32 {
    if worker.is_null() {
        return 0;
    }
    let status = pweb_worker_destroy((*worker).realm);
    if status == 0 {
        drop(Box::from_raw(worker));
    }
    status
}
