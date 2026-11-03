//! Pinned PocketJS worker runner adapter.
//!
//! The independent realm, worker facts, resource queues, deadlines and channel
//! storage come from `sdk/.cache/pocketjs/engine/worker`. This module only
//! adapts its C task callbacks to Rust threads, bounded HTTP providers and the
//! host's QuickJS ABI. Worker bytecode is validated before the C runner reads
//! it; there is no worker-source fallback.

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::{c_char, c_void, CStr, CString};
#[cfg(any(
    target_os = "android",
    target_os = "ios",
    target_os = "linux",
    target_os = "macos"
))]
use std::ffi::{c_int, c_long};
use std::io::{ErrorKind, Read};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use url::Url;

use crate::bytecode::{self, BytecodeExpectation, BytecodeKind};
use crate::replay::Mode;
use crate::worker_trace::{TraceActor, WorkerTrace};

pub const WORKER_PROTOCOL_VERSION: u32 = 1;
const RESOURCE_I2C: u32 = 1;
const RESOURCE_UART: u32 = 2;
const RESOURCE_HTTP: u32 = 3;
const STATUS_OK: i32 = 0;
const STATUS_FAILED: i32 = -1;
const STATUS_CANCELLED: i32 = -2;
const STATUS_BUSY: i32 = -4;
const STATUS_INVALID: i32 = -5;
const STATUS_UNSUPPORTED: i32 = -6;
const TRACE_BEFORE_STEP: u32 = 1;
const TRACE_BEFORE_FACTS: u32 = 2;
const TRACE_IDLE: u32 = 3;
const TRACE_END: u32 = 4;
const TRACE_DEFERRED: u32 = 5;
const TRACE_BEFORE_OPERATION: u32 = 6;
const UI_TRACE_PUBLISH_BEFORE: u32 = 1;
const UI_TRACE_PUBLISH_AFTER: u32 = 2;
const UI_TRACE_LATCH: u32 = 3;
const TRACE_FACT_FINISH: u32 = 2;
const CAPTURE_GATE_WORKER_PUBLISH: u8 = 1;
const CAPTURE_GATE_UI_PUBLISH: u8 = 2;
const CAPTURE_GATE_FACTS: u8 = 3;
const OP_OPEN: u32 = 0;
const OP_SUBMIT: u32 = 1;
const OP_CANCEL: u32 = 2;
const OP_CLOSE: u32 = 3;
const OP_WRITE: u32 = 4;
const OP_PUBLISH: u32 = 5;
const OP_TIMER: u32 = 6;
const OP_DECLARE_CHANNEL: u32 = 7;
const FACT_DATA: u32 = 3;
const FACT_ERROR: u32 = 9;
const FACT_HEADERS: u32 = 8;
const MAX_RESOURCES: usize = 8;
const MAX_PAYLOAD: usize = 1024;
const MAX_EVENTS: usize = 8;
const MAX_CHANNELS: usize = 8;
const MAX_HTTP_REQUEST_BYTES: usize = 64 * 1024;
const DEFAULT_HTTP_RESPONSE_BYTES: usize = 128 * 1024;
const MAX_HTTP_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_HTTP_HEADERS: usize = 32;
const MAX_HTTP_HEADER_BYTES: usize = 8 * 1024;
const DEFAULT_HTTP_TIMEOUT_MS: u64 = 30_000;
const MAX_HTTP_TIMEOUT_MS: u64 = 120_000;
const MAX_HTTP_REDIRECTS: usize = 3;
#[allow(dead_code)]
const HTTP_READ_SLICE: Duration = Duration::from_millis(100);
#[allow(dead_code)]
const HTTP_CONNECT_SLICE: Duration = Duration::from_millis(500);

type WorkerLock = unsafe extern "C" fn(*mut c_void);
type WorkerWake = unsafe extern "C" fn(*mut c_void);
type WorkerClockCallback = unsafe extern "C" fn(*mut c_void) -> u64;
type WorkerWait = unsafe extern "C" fn(*mut c_void, u64);
type WorkerPauseWait = unsafe extern "C" fn(*mut c_void);
type WorkerAfterTurn = unsafe extern "C" fn(*mut c_void);
type WorkerTraceFact =
    unsafe extern "C" fn(*mut c_void, u32, u32, u32, u32, i32, u64, *const u8, usize) -> i32;
type WorkerTraceFacts = unsafe extern "C" fn(*mut c_void, *const CWorkerFact, usize) -> i32;
type WorkerTraceTurn = unsafe extern "C" fn(
    *mut c_void,
    u32,
    *mut CWorkerContext,
    *const CWorkerFact,
    usize,
    i32,
    u64,
    u64,
    *mut u64,
) -> i32;
type WorkerTraceBoundary = unsafe extern "C" fn(*mut c_void, u32, u32) -> i32;
type WorkerTraceOperation = unsafe extern "C" fn(
    *mut c_void,
    u32,
    u32,
    u32,
    *const c_char,
    *const u8,
    usize,
    u64,
    u64,
    u32,
    u32,
    i32,
) -> i32;
type WorkerTraceScalar = unsafe extern "C" fn(*mut c_void, *const c_char, f64, *mut f64) -> i32;
type WorkerUiTrace = unsafe extern "C" fn(
    *mut c_void,
    u32,
    u32,
    *const u8,
    usize,
    *const u32,
    u32,
    u32,
    u32,
    i32,
) -> i32;
type WorkerOpen = unsafe extern "C" fn(*mut c_void, *mut CWorkerCore, u32, *const u8, usize) -> i32;
type WorkerStart = unsafe extern "C" fn(
    *mut c_void,
    *mut CWorkerCore,
    u32,
    u32,
    u32,
    *const u8,
    usize,
    usize,
) -> i32;
type WorkerWrite =
    unsafe extern "C" fn(*mut c_void, *mut CWorkerCore, u32, *const u8, usize) -> i32;
type WorkerCancel = unsafe extern "C" fn(*mut c_void, *mut CWorkerCore, u32, u32);
type WorkerClose = unsafe extern "C" fn(*mut c_void, *mut CWorkerCore, u32) -> i32;
type WorkerValidate =
    unsafe extern "C" fn(*mut c_void, *mut CWorkerCore, u32, u32, *const u8, usize, usize) -> i32;
type WorkerMount = unsafe extern "C" fn(*mut c_void, *mut rquickjs::qjs::JSContext) -> i32;
pub type WorkerNotify = unsafe extern "C" fn();

#[repr(C)]
struct CWorkerCore {
    _opaque: [u8; 0],
}
#[repr(C)]
struct CWorkerFact {
    struct_size: u32,
    kind: u32,
    handle: u32,
    request: u32,
    status: i32,
    length: u32,
    offset: u64,
    data: *const u8,
    timer: u32,
    channel: u32,
    missed: u32,
    deadline: u64,
}
#[repr(C)]
struct CWorkerContext {
    struct_size: u32,
    generation: u32,
    sequence: u32,
    now_micros: u64,
    utc_micros: u64,
    wall_generation: u32,
    wall_error_micros: u32,
    wall_source: *const c_char,
}
#[repr(C)]
struct CWorkerRunner {
    _opaque: [u8; 0],
}
#[repr(C)]
struct CWorkerUi {
    _opaque: [u8; 0],
}

#[repr(C)]
struct CWorkerDriver {
    struct_size: u32,
    context: *mut c_void,
    open: Option<WorkerOpen>,
    start: Option<WorkerStart>,
    write: Option<WorkerWrite>,
    cancel: Option<WorkerCancel>,
    close: Option<WorkerClose>,
    validate: Option<WorkerValidate>,
}
#[repr(C)]
struct CWorkerNode {
    struct_size: u32,
    kind: u32,
    name: *const c_char,
    driver: *const CWorkerDriver,
}
#[repr(C)]
struct CWorkerConfig {
    struct_size: u32,
    generation: u32,
    nodes: *const CWorkerNode,
    node_count: usize,
    context: *mut c_void,
    lock: Option<WorkerLock>,
    unlock: Option<WorkerLock>,
    wake: Option<WorkerWake>,
    now_micros: Option<WorkerClockCallback>,
    trace_fact: Option<WorkerTraceFact>,
    trace_facts: Option<WorkerTraceFacts>,
}
#[repr(C)]
struct CWorkerQuickJsConfig {
    struct_size: u32,
    worker: *mut CWorkerCore,
    heap_limit: usize,
    stack_limit: usize,
    max_jobs: u32,
    max_facts: u32,
    max_bytes: u32,
    turn_budget_micros: u32,
    window_micros: u32,
    quota_micros: u32,
    context: *mut c_void,
    now_micros: Option<WorkerClockCallback>,
    mount: Option<WorkerMount>,
    allocator: *const c_void,
    allocator_context: *mut c_void,
    cpu_now_micros: Option<WorkerClockCallback>,
    trace_turn: Option<WorkerTraceTurn>,
    trace_boundary: Option<WorkerTraceBoundary>,
    trace_operation: Option<WorkerTraceOperation>,
    trace_scalar: Option<WorkerTraceScalar>,
}
#[repr(C)]
struct CWorkerRunnerConfig {
    struct_size: u32,
    core: CWorkerConfig,
    realm: CWorkerQuickJsConfig,
    /// The runner's pinned-source ABI field is reused for the validated QJBC
    /// payload. The adapter invokes JS_ReadObject/JS_EvalFunction on these bytes.
    source: *const c_char,
    source_size: usize,
    context: *mut c_void,
    wait: Option<WorkerWait>,
    pause_wait: Option<WorkerPauseWait>,
    after_turn: Option<WorkerAfterTurn>,
    start_paused: i32,
}

#[link(name = "pocket_worker", kind = "static")]
unsafe extern "C" {
    fn pocket_worker_runner_create(config: *const CWorkerRunnerConfig) -> *mut CWorkerRunner;
    fn pocket_worker_runner_run(runner: *mut CWorkerRunner);
    fn pocket_worker_runner_stop(runner: *mut CWorkerRunner);
    fn pocket_worker_runner_failed(runner: *const CWorkerRunner) -> i32;
    fn pocket_worker_runner_error(runner: *const CWorkerRunner) -> *const c_char;
    fn pocket_worker_runner_core(runner: *mut CWorkerRunner) -> *mut CWorkerCore;
    fn pocket_worker_runner_destroy(runner: *mut CWorkerRunner);
    fn pocket_worker_receive(core: *mut CWorkerCore, id: u32, bytes: *const u8, size: usize)
        -> i32;
    fn pocket_worker_ui_attach(
        context: *mut rquickjs::qjs::JSContext,
        core: *mut CWorkerCore,
        trace_context: *mut c_void,
        trace: Option<WorkerUiTrace>,
    ) -> *mut CWorkerUi;
    fn pocket_worker_ui_latch(
        bridge: *mut CWorkerUi,
        trace_context: *mut c_void,
        trace: Option<WorkerUiTrace>,
    ) -> i32;
    fn pocket_worker_ui_has_pending_output(bridge: *mut CWorkerUi) -> i32;
    fn pocket_worker_ui_mark_frame_consumed(bridge: *mut CWorkerUi);
    fn pocket_worker_ui_detach(bridge: *mut CWorkerUi);
    fn pocket_worker_complete(
        core: *mut CWorkerCore,
        request: u32,
        status: i32,
        data: *const u8,
        size: usize,
    ) -> i32;
    fn pocket_worker_emit_request(
        core: *mut CWorkerCore,
        handle: u32,
        request: u32,
        kind: u32,
        status: i32,
        offset: u64,
        data: *const u8,
        size: usize,
    ) -> i32;
    fn pocket_worker_finish(
        core: *mut CWorkerCore,
        handle: u32,
        request: u32,
        status: i32,
        offset: u64,
    ) -> i32;
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerDeclaration {
    pub entry: String,
    pub nodes: Vec<WorkerNodeDeclaration>,
    #[serde(default)]
    pub channels: Vec<WorkerChannelDeclaration>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerNodeDeclaration {
    pub name: String,
    pub kind: WorkerResourceKind,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkerResourceKind {
    I2c,
    Uart,
    Http,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerChannelDeclaration {
    pub name: String,
    pub kind: WorkerChannelKind,
    pub direction: WorkerChannelDirection,
    #[serde(rename = "recordBytes")]
    pub record_bytes: usize,
    pub capacity: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkerChannelKind {
    Snapshot,
    Ring,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkerChannelDirection {
    UiToWorker,
    WorkerToUi,
}

#[derive(Clone, Debug, Default)]
pub struct WorkerPolicy {
    /// Exact URL origins granted by the host. Empty means deny every HTTP node.
    pub allowed_http_origins: Vec<String>,
    /// The guest's admitted manifest capabilities; nodes cannot exceed these.
    pub required_capabilities: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct WorkerLimits {
    pub heap_bytes: usize,
    pub stack_bytes: usize,
    pub turn_budget_micros: u32,
    pub window_micros: u32,
    pub quota_micros: u32,
}
impl Default for WorkerLimits {
    fn default() -> Self {
        Self {
            heap_bytes: 16 * 1024 * 1024,
            stack_bytes: 1024 * 1024,
            turn_budget_micros: 10_000,
            window_micros: 50_000,
            quota_micros: 10_000,
        }
    }
}

#[derive(Debug)]
pub enum WorkerError {
    Bytecode(bytecode::BytecodeError),
    InvalidDeclaration(String),
    CapabilityDenied(String),
    InvalidPolicy(String),
    Bootstrap(String),
    RunnerStopped,
    JoinFailed,
    Trace(String),
}
impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bytecode(error) => write!(f, "worker bytecode: {error}"),
            Self::InvalidDeclaration(error) => write!(f, "worker declaration: {error}"),
            Self::CapabilityDenied(capability) => {
                write!(f, "worker node requires capability {capability}")
            }
            Self::InvalidPolicy(error) => write!(f, "worker policy: {error}"),
            Self::Bootstrap(error) => write!(f, "worker bootstrap: {error}"),
            Self::RunnerStopped => f.write_str("worker runner has stopped"),
            Self::JoinFailed => f.write_str("worker owner thread panicked"),
            Self::Trace(error) => write!(f, "worker trace: {error}"),
        }
    }
}
impl std::error::Error for WorkerError {}
impl From<bytecode::BytecodeError> for WorkerError {
    fn from(error: bytecode::BytecodeError) -> Self {
        Self::Bytecode(error)
    }
}

#[derive(Default)]
struct PulseState {
    epoch: u64,
}
struct Pulse {
    state: Mutex<PulseState>,
    cv: Condvar,
    runner_seen: AtomicU64,
}
impl Pulse {
    fn new() -> Self {
        Self {
            state: Mutex::new(PulseState::default()),
            cv: Condvar::new(),
            runner_seen: AtomicU64::new(0),
        }
    }
    fn signal(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.epoch = state.epoch.wrapping_add(1);
        self.cv.notify_all();
    }
    fn snapshot(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .epoch
    }
    fn wait_change(&self, seen: u64, deadline: Option<Instant>) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        while state.epoch == seen {
            if let Some(deadline) = deadline {
                let now = Instant::now();
                if now >= deadline {
                    return;
                }
                let (next, result) = self
                    .cv
                    .wait_timeout(state, deadline - now)
                    .unwrap_or_else(|poison| poison.into_inner());
                state = next;
                if result.timed_out() && state.epoch == seen {
                    return;
                }
            } else {
                state = self
                    .cv
                    .wait(state)
                    .unwrap_or_else(|poison| poison.into_inner());
            }
        }
    }
    fn wait_runner(&self, deadline_micros: u64, clock: &WorkerClock) {
        let seen = self.runner_seen.load(Ordering::Acquire);
        let deadline = (deadline_micros != u64::MAX).then_some(deadline_micros);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if state.epoch != seen {
            self.runner_seen.store(state.epoch, Ordering::Release);
            return;
        }
        loop {
            if state.epoch != seen {
                self.runner_seen.store(state.epoch, Ordering::Release);
                return;
            }
            if let Some(deadline) = deadline {
                let now = clock.now_micros();
                if now >= deadline {
                    return;
                }
                let wait = Duration::from_micros(deadline - now);
                let (next, result) = self
                    .cv
                    .wait_timeout(state, wait)
                    .unwrap_or_else(|poison| poison.into_inner());
                state = next;
                if result.timed_out() && state.epoch == seen {
                    return;
                }
            } else {
                state = self
                    .cv
                    .wait(state)
                    .unwrap_or_else(|poison| poison.into_inner());
            }
        }
    }
}

#[derive(Default)]
struct WorkerClockState {
    paused: bool,
    paused_at: Option<Instant>,
    paused_total: Duration,
    replay_now: Option<u64>,
    live_offset_micros: i128,
}

/// Monotonic worker time which stops advancing while the host scheduler is
/// suspended. Native I/O deadlines continue to use real wall duration.
struct WorkerClock {
    origin: Instant,
    state: Mutex<WorkerClockState>,
    cv: Condvar,
}
impl WorkerClock {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
            state: Mutex::new(WorkerClockState::default()),
            cv: Condvar::new(),
        }
    }
    fn now_micros(&self) -> u64 {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(now) = state.replay_now {
            return now;
        }
        let now = state.paused_at.unwrap_or_else(Instant::now);
        let elapsed = now
            .saturating_duration_since(self.origin)
            .saturating_sub(state.paused_total)
            .as_micros()
            .min(i128::MAX as u128) as i128;
        elapsed
            .saturating_add(state.live_offset_micros)
            .clamp(0, u64::MAX as i128) as u64
    }
    fn set_replay_now(&self, now_micros: u64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.replay_now = Some(now_micros);
        self.cv.notify_all();
    }
    fn advance_replay(&self, delta_micros: u64) -> Result<u64, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let current = state
            .replay_now
            .ok_or_else(|| "Worker replay clock is not initialized".to_owned())?;
        let next = current
            .checked_add(delta_micros)
            .ok_or_else(|| "Worker replay clock overflow".to_owned())?;
        state.replay_now = Some(next);
        self.cv.notify_all();
        Ok(next)
    }
    fn set_live(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(replay_now) = state.replay_now.take() {
            let now = state.paused_at.unwrap_or_else(Instant::now);
            let wall_elapsed = now
                .saturating_duration_since(self.origin)
                .saturating_sub(state.paused_total)
                .as_micros()
                .min(i128::MAX as u128) as i128;
            state.live_offset_micros = (replay_now as i128).saturating_sub(wall_elapsed);
        }
        self.cv.notify_all();
    }
    fn set_paused(&self, paused: bool) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if state.paused == paused {
            return false;
        }
        if paused {
            state.paused_at = Some(Instant::now());
            state.paused = true;
        } else {
            if let Some(paused_at) = state.paused_at.take() {
                state.paused_total += Instant::now().saturating_duration_since(paused_at);
            }
            state.paused = false;
        }
        self.cv.notify_all();
        true
    }
    fn wait_until_resumed(&self, stop_requested: &AtomicBool) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        while state.paused && !stop_requested.load(Ordering::Acquire) {
            state = self
                .cv
                .wait(state)
                .unwrap_or_else(|poison| poison.into_inner());
        }
    }
}

#[derive(Default)]
struct SpinLock(AtomicBool);
impl SpinLock {
    fn lock(&self) {
        while self
            .0
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            std::hint::spin_loop();
        }
    }
    fn unlock(&self) {
        self.0.store(false, Ordering::Release);
    }
}
#[derive(Default)]
struct CaptureGate {
    locked: Mutex<bool>,
    changed: Condvar,
}
impl CaptureGate {
    fn lock(&self) {
        let mut locked = self
            .locked
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        while *locked {
            locked = self
                .changed
                .wait(locked)
                .unwrap_or_else(|poison| poison.into_inner());
        }
        *locked = true;
    }

    fn unlock(&self) {
        let mut locked = self
            .locked
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *locked = false;
        self.changed.notify_one();
    }
}
struct CaptureUnlockGuard<'a>(&'a CaptureGate);
impl CaptureUnlockGuard<'_> {
    fn acquire(gate: &CaptureGate) -> CaptureUnlockGuard<'_> {
        gate.lock();
        CaptureUnlockGuard(gate)
    }

    fn from_locked(gate: &CaptureGate) -> CaptureUnlockGuard<'_> {
        CaptureUnlockGuard(gate)
    }
}
impl Drop for CaptureUnlockGuard<'_> {
    fn drop(&mut self) {
        self.0.unlock();
    }
}
fn release_capture_gate_if_held<'a>(
    owner: &AtomicU8,
    expected_owner: u8,
    gate: &'a CaptureGate,
) -> Option<CaptureUnlockGuard<'a>> {
    owner
        .compare_exchange(expected_owner, 0, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
        .then(|| CaptureUnlockGuard::from_locked(gate))
}

struct NodeContext {
    state: Weak<WorkerState>,
    kind: WorkerResourceKind,
}
#[derive(Clone)]
struct HttpDescriptor {
    url: Url,
    method: String,
    headers: BTreeMap<String, String>,
    body: Option<String>,
    timeout: Duration,
    max_bytes: usize,
}
struct ActiveRequest {
    handle: u32,
    cancel: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    replay_stub: bool,
}
struct RunnerLifecycle {
    exited: bool,
    allow_destroy: bool,
}

struct WorkerState {
    generation: u32,
    owner_thread: OnceLock<thread::ThreadId>,
    trace: Option<Arc<WorkerTrace>>,
    session: Option<String>,
    allowed_origins: HashSet<String>,
    limits: WorkerLimits,
    notify: Option<WorkerNotify>,
    wake_pending: AtomicBool,
    pulse: Pulse,
    clock: WorkerClock,
    trace_sequence: AtomicU64,
    trace_now_micros: AtomicU64,
    core_lock: SpinLock,
    runner: AtomicPtr<CWorkerRunner>,
    core: AtomicPtr<CWorkerCore>,
    stop_requested: AtomicBool,
    offline_shutdown: AtomicBool,
    offline_gate: Mutex<()>,
    mutation_gate: CaptureGate,
    capture_gate_owner: AtomicU8,
    lifecycle: (Mutex<RunnerLifecycle>, Condvar),
    errors: Mutex<Option<String>>,
    resources: Mutex<HashMap<u32, HttpDescriptor>>,
    requests: Mutex<HashMap<u32, ActiveRequest>>,
    node_contexts: OnceLock<Vec<NodeContext>>,
    node_names: OnceLock<Vec<CString>>,
    drivers: OnceLock<Vec<CWorkerDriver>>,
    nodes: OnceLock<Vec<CWorkerNode>>,
}
impl WorkerState {
    fn wake_host(&self) {
        let Some(notify) = self.notify else {
            return;
        };
        notify_once(&self.wake_pending, || unsafe {
            notify();
        });
    }

    fn trace_failure(&self, error: String) {
        *self
            .errors
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(error.clone());
        if let Some(trace) = &self.trace {
            if trace.mode() == Mode::Replay {
                trace.fail_replay(error);
            }
        }
        self.pulse.signal();
        self.wake_host();
    }
}
fn notify_once(pending: &AtomicBool, notify: impl FnOnce()) {
    if pending
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        notify();
    }
}
fn rearm_wake(pending: &AtomicBool) {
    pending.store(false, Ordering::Release);
}
unsafe impl Send for WorkerState {}
unsafe impl Sync for WorkerState {}

/// Owns the upstream runner thread. Stop it, detach the UI bridge, then call
/// `destroy_and_join`; that ordering leaves the bounded channel core alive until
/// the UI's QuickJS values have been detached.
pub struct WorkerRuntime {
    state: Arc<WorkerState>,
    thread: Option<JoinHandle<()>>,
    stopped: bool,
    destroyed: bool,
}

/// UI-thread-owned binding into one worker's bounded channel core.
pub struct WorkerUiBridge {
    bridge: *mut CWorkerUi,
    state: Arc<WorkerState>,
    detached: bool,
}
unsafe impl Send for WorkerUiBridge {}

impl WorkerUiBridge {
    /// Copy worker-to-UI records into the UI mirror. Call once immediately
    /// before the UI guest's frame callback.
    pub fn latch(&mut self) -> Result<(), WorkerError> {
        if self.detached || self.bridge.is_null() {
            return Err(WorkerError::RunnerStopped);
        }
        let trace_mode = self
            .state
            .trace
            .as_ref()
            .map_or(Mode::Live, |trace| trace.mode());
        if trace_mode == Mode::Replay {
            let (trace, session) = self
                .state
                .trace
                .as_ref()
                .zip(self.state.session.as_ref())
                .ok_or(WorkerError::RunnerStopped)?;
            unsafe {
                await_replay_event(&self.state, trace, TraceActor::Ui, session, "channel.latch")
            }
            .map_err(WorkerError::Trace)?;
        }
        // Re-arm only after replay has reached this UI frontier. A worker
        // publication that races with the gate must keep its coalesced wake;
        // re-arming before the gate would send a second wake while the first
        // latch is still waiting for the recorded producer.
        rearm_wake(&self.state.wake_pending);
        let _mutation_guard = (trace_mode != Mode::Live)
            .then(|| CaptureUnlockGuard::acquire(&self.state.mutation_gate));
        let trace_context = Arc::as_ptr(&self.state).cast_mut().cast::<c_void>();
        let trace_callback =
            (trace_mode != Mode::Live).then_some(ui_trace_callback as WorkerUiTrace);
        let status = unsafe { pocket_worker_ui_latch(self.bridge, trace_context, trace_callback) };
        if status == STATUS_OK {
            Ok(())
        } else {
            let detail = self
                .state
                .errors
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .clone();
            Err(match detail {
                Some(message) => {
                    WorkerError::Trace(format!("UI channel latch failed with {status}: {message}"))
                }
                None => WorkerError::InvalidDeclaration(format!(
                    "UI channel latch failed with {status}"
                )),
            })
        }
    }
    /// Whether a just-latched channel record still needs one UI guest turn.
    /// The host can use this to keep demand capture awake after a zero-delta
    /// wake, then acknowledge it after the guest frame has run.
    pub fn has_pending_output(&self) -> bool {
        !self.detached
            && !self.bridge.is_null()
            && unsafe { pocket_worker_ui_has_pending_output(self.bridge) != 0 }
    }
    /// Acknowledge the frame that consumed newly latched channel output. The
    /// copied snapshot remains available to the guest until a later latch.
    pub fn mark_frame_consumed(&mut self) {
        if !self.detached && !self.bridge.is_null() {
            unsafe {
                pocket_worker_ui_mark_frame_consumed(self.bridge);
            }
        }
    }
    /// Detach the UI callback and values before the worker resource core is
    /// destroyed. This must run on the same thread as the UI QuickJS context.
    pub fn detach(&mut self) {
        if !self.detached && !self.bridge.is_null() {
            unsafe {
                pocket_worker_ui_detach(self.bridge);
            }
            self.bridge = ptr::null_mut();
            self.detached = true;
        }
    }
}
impl Drop for WorkerUiBridge {
    fn drop(&mut self) {
        self.detach();
    }
}

impl WorkerRuntime {
    /// Validate and start a distinct worker realm on its own owner thread.
    /// The input is a complete QJBC envelope, not JavaScript source.
    pub fn spawn(
        envelope: &[u8],
        expected_generation: u32,
        tick_hz: u32,
        declaration: WorkerDeclaration,
        policy: WorkerPolicy,
        limits: WorkerLimits,
        notify: Option<WorkerNotify>,
    ) -> Result<Self, WorkerError> {
        Self::spawn_inner(
            envelope,
            expected_generation,
            tick_hz,
            declaration,
            policy,
            limits,
            notify,
            None,
            None,
        )
    }

    /// Start the same pinned QJBC runner with the host's shared Worker trace
    /// lane. The ordinary `spawn` entry remains for live-only consumers and
    /// legacy native probes.
    pub(crate) fn spawn_traced(
        envelope: &[u8],
        expected_generation: u32,
        tick_hz: u32,
        declaration: WorkerDeclaration,
        policy: WorkerPolicy,
        limits: WorkerLimits,
        notify: Option<WorkerNotify>,
        trace: Arc<WorkerTrace>,
        session: String,
    ) -> Result<Self, WorkerError> {
        Self::spawn_inner(
            envelope,
            expected_generation,
            tick_hz,
            declaration,
            policy,
            limits,
            notify,
            Some(trace),
            Some(session),
        )
    }

    fn spawn_inner(
        envelope: &[u8],
        expected_generation: u32,
        tick_hz: u32,
        declaration: WorkerDeclaration,
        policy: WorkerPolicy,
        limits: WorkerLimits,
        notify: Option<WorkerNotify>,
        trace: Option<Arc<WorkerTrace>>,
        session: Option<String>,
    ) -> Result<Self, WorkerError> {
        let artifact = bytecode::validate(
            envelope,
            BytecodeExpectation {
                kind: BytecodeKind::Script,
                binding_generation: expected_generation,
                tick_hz,
            },
        )?;
        validate_declaration(&declaration, &policy)?;
        validate_limits(limits)?;
        let allowed_origins = policy
            .allowed_http_origins
            .iter()
            .map(|origin| normalize_origin(origin).map_err(WorkerError::InvalidPolicy))
            .collect::<Result<HashSet<_>, _>>()?;
        let clock = WorkerClock::new();
        if let (Some(trace), Some(session)) = (&trace, &session) {
            match trace.mode() {
                Mode::Live => {}
                Mode::Record => {
                    let initial_now_micros = clock.now_micros();
                    trace
                        .observe(TraceActor::Host, session, "bootstrap", || {
                            bootstrap_trace_data(
                                envelope,
                                expected_generation,
                                tick_hz,
                                &artifact,
                                &declaration,
                                &policy,
                                limits,
                                &allowed_origins,
                                initial_now_micros,
                            )
                        })
                        .map_err(WorkerError::Trace)?;
                }
                Mode::Replay => {
                    let expected = trace
                        .take(TraceActor::Host, session, "bootstrap")
                        .map_err(WorkerError::Trace)?
                        .ok_or_else(|| {
                            WorkerError::Trace("replay is missing Worker bootstrap".into())
                        })?;
                    let initial_now_micros = expected
                        .get("initialNowMicros")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| {
                            WorkerError::Trace(
                                "Worker bootstrap initialNowMicros is invalid".into(),
                            )
                        })?;
                    let actual = bootstrap_trace_data(
                        envelope,
                        expected_generation,
                        tick_hz,
                        &artifact,
                        &declaration,
                        &policy,
                        limits,
                        &allowed_origins,
                        initial_now_micros,
                    );
                    if expected != actual {
                        return Err(WorkerError::Trace(
                            "Worker bootstrap identity or limits differ from recording".into(),
                        ));
                    }
                    clock.set_replay_now(initial_now_micros);
                }
            }
        }
        let state = Arc::new(WorkerState {
            generation: expected_generation,
            owner_thread: OnceLock::new(),
            trace,
            session,
            allowed_origins,
            limits,
            notify,
            wake_pending: AtomicBool::new(false),
            pulse: Pulse::new(),
            clock,
            trace_sequence: AtomicU64::new(0),
            trace_now_micros: AtomicU64::new(0),
            core_lock: SpinLock::default(),
            runner: AtomicPtr::new(ptr::null_mut()),
            core: AtomicPtr::new(ptr::null_mut()),
            stop_requested: AtomicBool::new(false),
            offline_shutdown: AtomicBool::new(false),
            offline_gate: Mutex::new(()),
            mutation_gate: CaptureGate::default(),
            capture_gate_owner: AtomicU8::new(0),
            lifecycle: (
                Mutex::new(RunnerLifecycle {
                    exited: false,
                    allow_destroy: false,
                }),
                Condvar::new(),
            ),
            errors: Mutex::new(None),
            resources: Mutex::new(HashMap::new()),
            requests: Mutex::new(HashMap::new()),
            node_contexts: OnceLock::new(),
            node_names: OnceLock::new(),
            drivers: OnceLock::new(),
            nodes: OnceLock::new(),
        });
        install_node_table(&state, &declaration)?;
        let bytecode = artifact.payload.to_vec();
        let thread_state = Arc::clone(&state);
        let thread = thread::Builder::new()
            .name(format!("pocket-worker-{}", expected_generation))
            .spawn(move || owner_thread(thread_state, bytecode))
            .map_err(|error| WorkerError::Bootstrap(error.to_string()))?;
        Ok(Self {
            state,
            thread: Some(thread),
            stopped: false,
            destroyed: false,
        })
    }

    /// Attach the worker's native channels before evaluating the UI bundle.
    /// `context` is the UI realm's rquickjs `JSContext` pointer.
    pub fn attach_ui(
        &self,
        context: *mut rquickjs::qjs::JSContext,
    ) -> Result<WorkerUiBridge, WorkerError> {
        if context.is_null() || self.stopped || self.destroyed {
            return Err(WorkerError::RunnerStopped);
        }
        let core = self.state.core.load(Ordering::Acquire);
        if core.is_null() {
            return Err(WorkerError::Bootstrap(
                "worker core is not ready".to_owned(),
            ));
        }
        let trace_context = Arc::as_ptr(&self.state).cast_mut().cast::<c_void>();
        let trace_callback = self
            .state
            .trace
            .as_ref()
            .map(|_| ui_trace_callback as WorkerUiTrace);
        let bridge =
            unsafe { pocket_worker_ui_attach(context, core, trace_context, trace_callback) };
        if bridge.is_null() {
            return Err(WorkerError::Bootstrap(
                "pocket_worker_ui_attach failed".to_owned(),
            ));
        }
        Ok(WorkerUiBridge {
            bridge,
            state: Arc::clone(&self.state),
            detached: false,
        })
    }

    /// Optional startup gate for hosts that must attach the UI bridge before
    /// evaluating the UI bytecode. Worker bytecode itself still executes on
    /// its owner thread; this waits on one condition variable without polling.
    pub fn wait_ready(&self, timeout: Duration) -> Result<(), WorkerError> {
        let deadline = Instant::now() + timeout;
        let (lock, cv) = &self.state.lifecycle;
        let mut lifecycle = lock.lock().unwrap_or_else(|poison| poison.into_inner());
        loop {
            if !self.state.core.load(Ordering::Acquire).is_null() {
                return Ok(());
            }
            if lifecycle.exited {
                return Err(WorkerError::Bootstrap(
                    self.last_error()
                        .unwrap_or_else(|| "worker exited during bootstrap".to_owned()),
                ));
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(WorkerError::Bootstrap(
                    "timed out waiting for worker bootstrap".to_owned(),
                ));
            }
            let (next, result) = cv
                .wait_timeout(lifecycle, deadline - now)
                .unwrap_or_else(|poison| poison.into_inner());
            lifecycle = next;
            if result.timed_out() && self.state.core.load(Ordering::Acquire).is_null() {
                return Err(WorkerError::Bootstrap(
                    "timed out waiting for worker bootstrap".to_owned(),
                ));
            }
        }
    }

    /// Nonblocking bounded host ingress, normally unnecessary when the UI
    /// guest uses the upstream `@pocketjs/framework/worker/channels` bridge.
    pub fn receive(&self, channel: u32, bytes: &[u8]) -> i32 {
        if bytes.len() > MAX_PAYLOAD || channel == 0 || channel as usize > MAX_CHANNELS {
            return STATUS_INVALID;
        }
        let core = self.state.core.load(Ordering::Acquire);
        if core.is_null() {
            return STATUS_INVALID;
        }
        unsafe { pocket_worker_receive(core, channel, bytes.as_ptr(), bytes.len()) }
    }

    /// Request stop and wait until the runner has returned, while retaining its
    /// core and realm so the UI bridge can detach safely.
    pub fn request_stop_and_wait(&mut self) {
        if self.stopped || self.destroyed {
            return;
        }
        if let (Some(trace), Some(session)) = (&self.state.trace, &self.state.session) {
            if trace.mode() != Mode::Live {
                let data = serde_json::json!({"generation": self.state.generation});
                let result = if trace.mode() == Mode::Replay && !trace.batch_open() {
                    Err("Worker stop requires an open trace transaction".to_owned())
                } else {
                    trace
                        .observe(TraceActor::Host, session, "scheduler.stop", || data)
                        .map(|_| ())
                };
                if let Err(error) = result {
                    self.state.trace_failure(error);
                }
            }
        }
        self.state.stop_requested.store(true, Ordering::Release);
        if let Some(trace) = &self.state.trace {
            trace.notify_stop(self.state.session.as_deref());
        }
        self.state.clock.set_paused(false);
        self.state.pulse.signal();
        let runner = self.state.runner.load(Ordering::Acquire);
        if !runner.is_null() {
            unsafe {
                pocket_worker_runner_stop(runner);
            }
        }
        self.state.pulse.signal();
        let (lock, cv) = &self.state.lifecycle;
        let mut lifecycle = lock.lock().unwrap_or_else(|poison| poison.into_inner());
        while !lifecycle.exited {
            lifecycle = cv
                .wait(lifecycle)
                .unwrap_or_else(|poison| poison.into_inner());
        }
        self.stopped = true;
    }

    /// Release the runner/core on its owner thread and wait for every admitted
    /// native request to finish. Call only after `WorkerUiBridge.detach()`.
    pub fn destroy_and_join(&mut self) -> Result<(), WorkerError> {
        if self.destroyed {
            return Ok(());
        }
        self.request_stop_and_wait();
        let (lock, cv) = &self.state.lifecycle;
        let mut lifecycle = lock.lock().unwrap_or_else(|poison| poison.into_inner());
        lifecycle.allow_destroy = true;
        cv.notify_all();
        drop(lifecycle);
        if let Some(thread) = self.thread.take() {
            thread.join().map_err(|_| WorkerError::JoinFailed)?;
        }
        self.destroyed = true;
        Ok(())
    }

    pub fn last_error(&self) -> Option<String> {
        self.state
            .errors
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// Park the worker at a turn boundary and freeze its monotonic context
    /// clock while the host scheduler is paused. Native I/O deadlines keep
    /// running; their bounded facts remain queued until resume.
    pub fn set_paused(&self, paused: bool) {
        if self.destroyed || self.stopped {
            return;
        }
        if self.state.clock.set_paused(paused) {
            if let (Some(trace), Some(session)) = (&self.state.trace, &self.state.session) {
                if trace.mode() != Mode::Live {
                    let kind = if paused {
                        "scheduler.pause"
                    } else {
                        "scheduler.resume"
                    };
                    let now = self.state.clock.now_micros();
                    let outcome = match trace.mode() {
                        Mode::Live => Ok(()),
                        Mode::Record => trace
                            .observe(TraceActor::Host, session, kind, || {
                                serde_json::json!({
                                    "generation": self.state.generation,
                                    "atMicros": now,
                                })
                            })
                            .map(|_| ()),
                        Mode::Replay => {
                            trace
                                .take(TraceActor::Host, session, kind)
                                .and_then(|value| {
                                    let value = value.ok_or_else(|| {
                                        format!("Worker replay is missing {kind}")
                                    })?;
                                    if value["generation"].as_u64()
                                        != Some(self.state.generation as u64)
                                    {
                                        return Err(format!(
                                            "Worker replay {kind} generation differs"
                                        ));
                                    }
                                    let at = value["atMicros"].as_u64().ok_or_else(|| {
                                        format!("Worker replay {kind} time is invalid")
                                    })?;
                                    self.state.clock.set_replay_now(at);
                                    Ok(())
                                })
                        }
                    };
                    if let Err(error) = outcome {
                        self.state.trace_failure(error);
                    }
                }
            }
            self.state.pulse.signal();
            if !paused {
                self.state.wake_host();
            }
        }
    }

    /// Called when the host disables trace mode after a recording/replay.
    /// The Worker keeps its current logical time, then continues with live
    /// monotonic time without replacing the shared trace Arc.
    pub fn set_trace_live(&self) {
        if let Some(trace) = &self.state.trace {
            trace.set_live();
        }
        self.state.clock.set_live();
        self.state.pulse.signal();
    }

    /// Stop a replay worker before the host switches its shared lane to Live.
    /// The flag prevents a racing driver start from opening a real socket in
    /// the interval between releasing trace waiters and joining the runner.
    /// This method does not emit a scheduler event; the replay transaction is
    /// already being finalized by the host.
    pub(crate) fn prepare_replay_stop(&self) {
        let _gate = self
            .state
            .offline_gate
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if !self
            .state
            .trace
            .as_ref()
            .is_some_and(|trace| trace.mode() == Mode::Replay)
        {
            return;
        }
        self.state.offline_shutdown.store(true, Ordering::Release);
        self.state.stop_requested.store(true, Ordering::Release);
        if let Some(trace) = &self.state.trace {
            trace.notify_stop(self.state.session.as_deref());
        }
        self.state.clock.set_paused(false);
        let runner = self.state.runner.load(Ordering::Acquire);
        if !runner.is_null() {
            unsafe { pocket_worker_runner_stop(runner) };
        }
        self.state.pulse.signal();
    }

    pub fn is_stopped(&self) -> bool {
        self.state
            .lifecycle
            .0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .exited
    }
}

impl Drop for WorkerRuntime {
    fn drop(&mut self) {
        if !self.destroyed {
            if let Some(trace) = &self.state.trace {
                if trace.mode() == Mode::Replay {
                    // Drop is an abort path. The caller will not run another
                    // host transaction to consume a scheduler.stop event, so
                    // release replay waiters and prevent any real IO before
                    // joining the owner thread.
                    self.prepare_replay_stop();
                    trace.set_live();
                }
            }
            self.request_stop_and_wait();
            let _ = self.destroy_and_join();
        }
    }
}

fn validate_limits(limits: WorkerLimits) -> Result<(), WorkerError> {
    if !(64 * 1024..=256 * 1024 * 1024).contains(&limits.heap_bytes)
        || !(64 * 1024..=16 * 1024 * 1024).contains(&limits.stack_bytes)
        || limits.turn_budget_micros == 0
        || limits.turn_budget_micros > 100_000
        || limits.window_micros == 0
        || limits.quota_micros == 0
        || limits.quota_micros > limits.window_micros
    {
        return Err(WorkerError::InvalidPolicy(
            "worker heap, stack or CPU budgets are out of range".to_owned(),
        ));
    }
    Ok(())
}

fn bootstrap_trace_data(
    envelope: &[u8],
    generation: u32,
    tick_hz: u32,
    artifact: &bytecode::BytecodeArtifact<'_>,
    declaration: &WorkerDeclaration,
    policy: &WorkerPolicy,
    limits: WorkerLimits,
    allowed_origins: &HashSet<String>,
    initial_now_micros: u64,
) -> serde_json::Value {
    use serde_json::json;

    let nodes = declaration
        .nodes
        .iter()
        .map(|node| {
            json!({
                "name": node.name,
                "kind": match node.kind {
                    WorkerResourceKind::I2c => "i2c",
                    WorkerResourceKind::Uart => "uart",
                    WorkerResourceKind::Http => "http",
                },
            })
        })
        .collect::<Vec<_>>();
    let channels = declaration
        .channels
        .iter()
        .map(|channel| {
            json!({
                "name": channel.name,
                "kind": match channel.kind {
                    WorkerChannelKind::Snapshot => "snapshot",
                    WorkerChannelKind::Ring => "ring",
                },
                "direction": match channel.direction {
                    WorkerChannelDirection::UiToWorker => "ui-to-worker",
                    WorkerChannelDirection::WorkerToUi => "worker-to-ui",
                },
                "recordBytes": channel.record_bytes,
                "capacity": channel.capacity,
            })
        })
        .collect::<Vec<_>>();
    let declaration_value = json!({
        "entry": declaration.entry,
        "nodes": nodes,
        "channels": channels,
    });
    let declaration_bytes = serde_json::to_vec(&declaration_value).unwrap_or_default();
    let mut capabilities = policy.required_capabilities.clone();
    capabilities.sort();
    let mut origins = allowed_origins.iter().cloned().collect::<Vec<_>>();
    origins.sort();

    json!({
        "generation": generation,
        "tickHz": tick_hz,
        "initialNowMicros": initial_now_micros,
        "workerBytecodeSha256": bytecode::sha256_hex(envelope),
        "payloadSha256": bytecode::sha256_hex(artifact.payload),
        "engineAbi": bytecode::sha256_hex(&artifact.engine_abi),
        "declarationSha256": bytecode::sha256_hex(&declaration_bytes),
        "declaration": declaration_value,
        "requiredCapabilities": capabilities,
        "allowedHttpOrigins": origins,
        "limits": {
            "heapBytes": limits.heap_bytes,
            "stackBytes": limits.stack_bytes,
            "turnBudgetMicros": limits.turn_budget_micros,
            "windowMicros": limits.window_micros,
            "quotaMicros": limits.quota_micros,
        }
    })
}

fn validate_declaration(
    declaration: &WorkerDeclaration,
    policy: &WorkerPolicy,
) -> Result<(), WorkerError> {
    if declaration.nodes.len() > MAX_RESOURCES || declaration.channels.len() > MAX_CHANNELS {
        return Err(WorkerError::InvalidDeclaration(
            "more than 8 worker resources or channels".to_owned(),
        ));
    }
    let capabilities = policy
        .required_capabilities
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut names = HashSet::new();
    for node in &declaration.nodes {
        if !valid_name(&node.name) || !names.insert(node.name.as_str()) {
            return Err(WorkerError::InvalidDeclaration(format!(
                "invalid or duplicate node name {:?}",
                node.name
            )));
        }
        let capability = match node.kind {
            WorkerResourceKind::I2c => "io.i2c",
            WorkerResourceKind::Uart => "io.uart",
            WorkerResourceKind::Http => "net.http",
        };
        if !capabilities.contains(capability) {
            return Err(WorkerError::CapabilityDenied(capability.to_owned()));
        }
    }
    names.clear();
    for channel in &declaration.channels {
        if !valid_name(&channel.name) || !names.insert(channel.name.as_str()) {
            return Err(WorkerError::InvalidDeclaration(format!(
                "invalid or duplicate channel name {:?}",
                channel.name
            )));
        }
        if channel.record_bytes == 0
            || channel.record_bytes > MAX_PAYLOAD
            || channel.capacity == 0
            || channel.capacity > MAX_EVENTS
        {
            return Err(WorkerError::InvalidDeclaration(format!(
                "channel {} exceeds the pinned bounded channel limits",
                channel.name
            )));
        }
    }
    Ok(())
}

fn valid_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
        && name.len() <= 63
}

fn install_node_table(
    state: &Arc<WorkerState>,
    declaration: &WorkerDeclaration,
) -> Result<(), WorkerError> {
    let contexts = declaration
        .nodes
        .iter()
        .map(|node| NodeContext {
            state: Arc::downgrade(state),
            kind: node.kind,
        })
        .collect::<Vec<_>>();
    state.node_contexts.set(contexts).map_err(|_| {
        WorkerError::InvalidDeclaration("node contexts already installed".to_owned())
    })?;
    let names = declaration
        .nodes
        .iter()
        .map(|node| {
            CString::new(node.name.as_bytes())
                .map_err(|_| WorkerError::InvalidDeclaration("node name contains NUL".to_owned()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    state
        .node_names
        .set(names)
        .map_err(|_| WorkerError::InvalidDeclaration("node names already installed".to_owned()))?;
    let contexts = state.node_contexts.get().unwrap();
    let drivers = contexts
        .iter()
        .map(|context| CWorkerDriver {
            struct_size: std::mem::size_of::<CWorkerDriver>() as u32,
            context: (context as *const NodeContext).cast_mut().cast(),
            open: Some(driver_open),
            start: Some(driver_start),
            write: Some(driver_write),
            cancel: Some(driver_cancel),
            close: Some(driver_close),
            validate: Some(driver_validate),
        })
        .collect::<Vec<_>>();
    state
        .drivers
        .set(drivers)
        .map_err(|_| WorkerError::InvalidDeclaration("drivers already installed".to_owned()))?;
    let drivers = state.drivers.get().unwrap();
    let names = state.node_names.get().unwrap();
    let nodes = declaration
        .nodes
        .iter()
        .enumerate()
        .map(|(index, node)| CWorkerNode {
            struct_size: std::mem::size_of::<CWorkerNode>() as u32,
            kind: kind_id(node.kind),
            name: names[index].as_ptr(),
            driver: &drivers[index],
        })
        .collect::<Vec<_>>();
    state
        .nodes
        .set(nodes)
        .map_err(|_| WorkerError::InvalidDeclaration("nodes already installed".to_owned()))?;
    Ok(())
}

fn kind_id(kind: WorkerResourceKind) -> u32 {
    match kind {
        WorkerResourceKind::I2c => RESOURCE_I2C,
        WorkerResourceKind::Uart => RESOURCE_UART,
        WorkerResourceKind::Http => RESOURCE_HTTP,
    }
}

static CLOCK_ORIGIN: OnceLock<Instant> = OnceLock::new();
fn now_micros() -> u64 {
    CLOCK_ORIGIN
        .get_or_init(Instant::now)
        .elapsed()
        .as_micros()
        .min(u64::MAX as u128) as u64
}

fn trace_bytes_base64(bytes: &[u8]) -> String {
    BASE64_STANDARD.encode(bytes)
}

fn trace_bytes_from_base64(encoded: &str, limit: usize) -> Result<Vec<u8>, String> {
    if encoded.len() % 4 != 0 || encoded.len() > limit.saturating_add(2) / 3 * 4 {
        return Err("Worker trace base64 length is invalid".into());
    }
    let output = BASE64_STANDARD
        .decode(encoded)
        .map_err(|error| format!("Worker trace base64 is invalid: {error}"))?;
    if output.len() > limit {
        return Err("Worker trace base64 payload exceeds its limit".into());
    }
    if trace_bytes_base64(&output) != encoded {
        return Err("Worker trace base64 is not canonical".into());
    }
    Ok(output)
}

fn worker_fact_json(fact: &CWorkerFact) -> Result<serde_json::Value, String> {
    if fact.struct_size < std::mem::size_of::<CWorkerFact>() as u32
        || fact.length as usize > MAX_PAYLOAD
        || (fact.length != 0 && fact.data.is_null())
    {
        return Err("official Worker returned an invalid fact descriptor".into());
    }
    let bytes = if fact.length == 0 {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(fact.data, fact.length as usize) }
    };
    Ok(serde_json::json!({
        "kind": fact.kind,
        "handle": fact.handle,
        "request": fact.request,
        "status": fact.status,
        "offset": fact.offset,
        "timer": fact.timer,
        "channel": fact.channel,
        "missed": fact.missed,
        "deadlineMicros": fact.deadline,
        "bytesBase64": trace_bytes_base64(bytes),
    }))
}

unsafe fn trace_state(context: *mut c_void) -> Option<&'static WorkerState> {
    (!context.is_null()).then(|| &*(context as *const WorkerState))
}

unsafe extern "C" fn ui_trace_callback(
    context: *mut c_void,
    phase: u32,
    channel: u32,
    bytes: *const u8,
    size: usize,
    lengths: *const u32,
    count: u32,
    stride: u32,
    decision: u32,
    status: i32,
) -> i32 {
    let Some(state) = trace_state(context) else {
        return -1;
    };
    let _publish_unlock = (phase == UI_TRACE_PUBLISH_AFTER)
        .then(|| {
            release_capture_gate_if_held(
                &state.capture_gate_owner,
                CAPTURE_GATE_UI_PUBLISH,
                &state.mutation_gate,
            )
        })
        .flatten();
    let (Some(trace), Some(session)) = (&state.trace, &state.session) else {
        return 0;
    };
    let mode = trace.mode();
    if mode == Mode::Live {
        return 0;
    }
    if phase == UI_TRACE_PUBLISH_BEFORE {
        if mode == Mode::Replay {
            let result = unsafe {
                await_replay_event(state, trace, TraceActor::Ui, session, "channel.publish")
            };
            if let Err(error) = result {
                state.trace_failure(error);
                return -1;
            }
        }
        state.mutation_gate.lock();
        state
            .capture_gate_owner
            .store(CAPTURE_GATE_UI_PUBLISH, Ordering::Release);
        return 0;
    }
    if phase == UI_TRACE_PUBLISH_AFTER && (size > MAX_PAYLOAD || (size != 0 && bytes.is_null())) {
        trace.mark_incomplete("UI Worker channel record exceeds 1024 bytes");
        return 0;
    }
    let data = match phase {
        UI_TRACE_PUBLISH_AFTER => {
            let payload = if size == 0 {
                &[][..]
            } else {
                std::slice::from_raw_parts(bytes, size)
            };
            serde_json::json!({
                "generation": state.generation,
                "direction": "ui-to-worker",
                "channel": channel,
                "bytesBase64": trace_bytes_base64(payload),
                "status": status,
            })
        }
        UI_TRACE_LATCH => {
            if count as usize > MAX_EVENTS
                || (stride as usize) < MAX_PAYLOAD
                || (count != 0 && (bytes.is_null() || lengths.is_null()))
            {
                state.trace_failure("UI Worker latch mirror descriptor is invalid".into());
                return -1;
            }
            let mut records = Vec::with_capacity(count as usize);
            for index in 0..count as usize {
                let length = *lengths.add(index) as usize;
                if length > MAX_PAYLOAD {
                    state.trace_failure("UI Worker latch record exceeds 1024 bytes".into());
                    return -1;
                }
                let record = std::slice::from_raw_parts(
                    bytes.add(index.saturating_mul(stride as usize)),
                    length,
                );
                records.push(trace_bytes_base64(record));
            }
            serde_json::json!({
                "generation": state.generation,
                "channel": channel,
                "snapshot": decision != 0,
                "recordsBase64": records,
                "status": status,
            })
        }
        _ => {
            state.trace_failure(format!("unsupported UI Worker trace phase {phase}"));
            return -1;
        }
    };
    let kind = if phase == UI_TRACE_LATCH {
        "channel.latch"
    } else {
        "channel.publish"
    };
    let result = if phase == UI_TRACE_LATCH {
        trace.observe_gated(
            TraceActor::Ui,
            session,
            kind,
            &["channel.publish", "turn.facts"],
            || data,
        )
    } else {
        trace.observe_now(TraceActor::Ui, session, kind, || data)
    };
    if let Err(error) = result {
        state.trace_failure(error);
        -1
    } else {
        0
    }
}

unsafe extern "C" fn trace_fact_callback(
    context: *mut c_void,
    action: u32,
    handle: u32,
    request: u32,
    kind: u32,
    status: i32,
    offset: u64,
    data: *const u8,
    size: usize,
) -> i32 {
    let Some(state) = trace_state(context) else {
        return -1;
    };
    let (Some(trace), Some(session)) = (&state.trace, &state.session) else {
        return 0;
    };
    if trace.mode() != Mode::Record {
        return 0;
    }
    if size > MAX_PAYLOAD || (size != 0 && data.is_null()) {
        trace.mark_incomplete("Worker IO fact exceeds 1024 bytes");
        return 0;
    }
    let result = trace.observe_now(TraceActor::Io, session, "io.fact", || {
        let bytes = if size == 0 {
            &[][..]
        } else {
            std::slice::from_raw_parts(data, size)
        };
        serde_json::json!({
            "action": if action == TRACE_FACT_FINISH { "finish" } else { "emit" },
            "handle": handle,
            "request": request,
            "kind": kind,
            "status": status,
            "offset": offset,
            "bytesBase64": trace_bytes_base64(bytes),
        })
    });
    if result.is_err() {
        return -1;
    }
    0
}

unsafe extern "C" fn trace_facts_callback(
    context: *mut c_void,
    facts: *const CWorkerFact,
    count: usize,
) -> i32 {
    let Some(state) = trace_state(context) else {
        return -1;
    };
    let _facts_unlock = release_capture_gate_if_held(
        &state.capture_gate_owner,
        CAPTURE_GATE_FACTS,
        &state.mutation_gate,
    );
    let (Some(trace), Some(session)) = (&state.trace, &state.session) else {
        return 0;
    };
    if trace.mode() == Mode::Live {
        return 0;
    }
    if count > 16 || (count != 0 && facts.is_null()) {
        state.trace_failure("official Worker facts exceed the configured turn limit".into());
        return -1;
    }
    let values = match (0..count)
        .map(|index| worker_fact_json(&*facts.add(index)))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(values) => values,
        Err(error) => {
            *state
                .errors
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = Some(error.clone());
            if trace.mode() == Mode::Replay {
                trace.fail_replay(error);
            }
            return -1;
        }
    };
    let sequence = state.trace_sequence.load(Ordering::Acquire);
    let now = state.trace_now_micros.load(Ordering::Acquire);
    // C calls this while the core lock still protects the fact snapshot.
    // BEFORE_FACTS gates Replay and consumes any preceding UI/IO events, so
    // this comparison is a no-wait commit under the same lock.
    let result = trace.observe_now(TraceActor::Worker, session, "turn.facts", || {
        serde_json::json!({
            "sequence": sequence,
            "nowMicros": now,
            "facts": values,
        })
    });
    if let Err(error) = result {
        *state
            .errors
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(error.clone());
        if trace.mode() == Mode::Replay {
            trace.fail_replay(error);
        }
        return -1;
    }
    0
}

unsafe fn inject_replay_io_facts(
    state: &WorkerState,
    trace: &WorkerTrace,
    session: &str,
) -> Result<(), String> {
    loop {
        let Some(next) = trace.peek_replay()? else {
            return Ok(());
        };
        if next.session != session || next.kind != "io.fact" {
            return Ok(());
        }
        let data = trace
            .take(TraceActor::Worker, session, "io.fact")?
            .ok_or_else(|| "Worker replay is missing IO fact data".to_owned())?;
        let handle = data["handle"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| "Worker replay IO fact handle is invalid".to_owned())?;
        let request = data["request"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| "Worker replay IO fact request is invalid".to_owned())?;
        let kind = data["kind"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| "Worker replay IO fact kind is invalid".to_owned())?;
        let status = data["status"]
            .as_i64()
            .and_then(|value| i32::try_from(value).ok())
            .ok_or_else(|| "Worker replay IO fact status is invalid".to_owned())?;
        let offset = data["offset"]
            .as_u64()
            .ok_or_else(|| "Worker replay IO fact offset is invalid".to_owned())?;
        let action = data["action"]
            .as_str()
            .ok_or_else(|| "Worker replay IO fact action is invalid".to_owned())?;
        let bytes = trace_bytes_from_base64(
            data["bytesBase64"]
                .as_str()
                .ok_or_else(|| "Worker replay IO fact bytes are invalid".to_owned())?,
            MAX_PAYLOAD,
        )?;
        let core = state.core.load(Ordering::Acquire);
        if core.is_null() {
            return Err("Worker replay core is not ready for an IO fact".into());
        }
        let result = match action {
            "emit" => pocket_worker_emit_request(
                core,
                handle,
                request,
                kind,
                status,
                offset,
                if bytes.is_empty() {
                    ptr::null()
                } else {
                    bytes.as_ptr()
                },
                bytes.len(),
            ),
            "finish" if bytes.is_empty() => {
                pocket_worker_finish(core, handle, request, status, offset)
            }
            "finish" => return Err("Worker replay finish fact has bytes".into()),
            _ => return Err("Worker replay IO fact action is unsupported".into()),
        };
        if result != STATUS_OK {
            return Err(format!(
                "Worker replay core rejected IO fact with status {result}"
            ));
        }
        if action == "finish" {
            if let Some(active) = state
                .requests
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get(&request)
            {
                active.finished.store(true, Ordering::Release);
            }
        }
    }
}

unsafe fn await_replay_event(
    state: &WorkerState,
    trace: &WorkerTrace,
    actor: TraceActor,
    session: &str,
    kind: &str,
) -> Result<(), String> {
    loop {
        if trace.mode() != Mode::Replay {
            return Ok(());
        }
        let draining_stopped_turn = state.stop_requested.load(Ordering::Acquire)
            && actor == TraceActor::Worker
            && trace.can_finish_active_turn(session, kind);
        if state.stop_requested.load(Ordering::Acquire) && !draining_stopped_turn {
            return Err(format!(
                "Worker replay stopped while awaiting {actor:?}/{session}/{kind}"
            ));
        }
        if actor == TraceActor::Worker {
            inject_replay_io_facts(state, trace, session)?;
        }
        if draining_stopped_turn {
            loop {
                inject_replay_io_facts(state, trace, session)?;
                let Some(next) = trace.peek_replay()? else {
                    break;
                };
                if next.session == session && next.kind == "io.fact" {
                    continue;
                }
                if TraceActor::for_event(Mode::Replay, &next) == actor && next.session == session {
                    break;
                }
                trace.wait_for_advance(next.seq)?;
            }
            return trace.await_turn(actor, session, kind);
        }
        let Some(next) = trace.peek_replay()? else {
            trace.wait_for_session(actor, session, &state.stop_requested)?;
            continue;
        };
        if next.session == session && next.kind == "io.fact" {
            if actor == TraceActor::Worker {
                // The Worker-owned injection loop above consumes every
                // consecutive fact before this point.
                continue;
            }
            trace.wait_for_advance(next.seq)?;
            continue;
        }
        if TraceActor::for_event(Mode::Replay, &next) == actor && next.session == session {
            return trace.await_turn(actor, session, kind);
        }
        trace.wait_for_session(actor, session, &state.stop_requested)?;
    }
}

unsafe fn wait_for_worker_frontier(
    state: &WorkerState,
    trace: &WorkerTrace,
    session: &str,
) -> Result<Option<crate::worker_trace::WorkerTraceEvent>, String> {
    loop {
        if trace.mode() != Mode::Replay {
            return Ok(None);
        }
        if state.stop_requested.load(Ordering::Acquire) {
            return trace.peek_replay();
        }
        inject_replay_io_facts(state, trace, session)?;
        if state.stop_requested.load(Ordering::Acquire) {
            return trace.peek_replay();
        }
        let Some(next) = trace.peek_replay()? else {
            trace.wait_for_session(TraceActor::Worker, session, &state.stop_requested)?;
            continue;
        };
        // Another actor may have consumed the event between the injection
        // loop's peek and this peek. If that exposes an IO fact, return to the
        // loop so the Worker injects it before deciding which turn event is
        // next.
        if next.session == session && next.kind == "io.fact" {
            continue;
        }
        if TraceActor::for_event(Mode::Replay, &next) == TraceActor::Worker
            && next.session == session
        {
            return Ok(Some(next));
        }
        trace.wait_for_session(TraceActor::Worker, session, &state.stop_requested)?;
    }
}

unsafe extern "C" fn trace_turn_callback(
    context: *mut c_void,
    phase: u32,
    input: *mut CWorkerContext,
    _facts: *const CWorkerFact,
    _count: usize,
    status: i32,
    elapsed_micros: u64,
    resume_at_micros: u64,
    output: *mut u64,
) -> i32 {
    let Some(state) = trace_state(context) else {
        return -1;
    };
    let (Some(trace), Some(session)) = (&state.trace, &state.session) else {
        return 0;
    };
    let mode = trace.mode();
    if mode == Mode::Live {
        return 0;
    }
    if input.is_null() {
        state.trace_failure("Worker trace callback received no turn context".into());
        return -1;
    }
    let input = &mut *input;
    if input.struct_size < std::mem::size_of::<CWorkerContext>() as u32 {
        state.trace_failure("Worker trace context ABI is too small".into());
        return -1;
    }
    if mode == Mode::Replay && phase == TRACE_DEFERRED {
        let next = match unsafe { wait_for_worker_frontier(state, trace, session) } {
            Ok(next) => next,
            Err(error) => {
                state.trace_failure(error);
                return -1;
            }
        };
        if state.stop_requested.load(Ordering::Acquire)
            || next.as_ref().is_some_and(|event| {
                event.session.as_str() == session && event.kind == "worker.exit"
            })
        {
            // The Host stop transaction releases this gate. Stop the pinned
            // runner from inside the gate so C returns from this step instead
            // of trying to start one more turn and consuming worker.exit as a
            // turn admission event.
            let runner = state.runner.load(Ordering::Acquire);
            if !runner.is_null() {
                unsafe { pocket_worker_runner_stop(runner) };
            }
            return -1;
        }
    }
    let result = (|| -> Result<(), String> {
        match phase {
            TRACE_BEFORE_STEP => {
                if mode == Mode::Replay {
                    await_replay_event(state, trace, TraceActor::Worker, session, "turn.begin")?;
                }
                let generation = state.generation;
                let sequence = input.sequence;
                let now = input.now_micros;
                match mode {
                    Mode::Live => {}
                    Mode::Record => {
                        trace.observe(TraceActor::Worker, session, "turn.begin", || {
                            serde_json::json!({
                                "generation": generation,
                                "sequence": sequence,
                                "nowMicros": now,
                            })
                        })?;
                    }
                    Mode::Replay => {
                        let expected = trace
                            .take(TraceActor::Worker, session, "turn.begin")?
                            .ok_or_else(|| "Worker replay is missing turn.begin".to_owned())?;
                        if expected["generation"].as_u64() != Some(generation as u64)
                            || expected["sequence"].as_u64() != Some(sequence as u64)
                        {
                            return Err("Worker replay turn generation/sequence differs".into());
                        }
                        let expected_now = expected["nowMicros"]
                            .as_u64()
                            .ok_or_else(|| "Worker replay turn clock is invalid".to_owned())?;
                        input.now_micros = expected_now;
                        state.clock.set_replay_now(expected_now);
                    }
                }
                state
                    .trace_sequence
                    .store(sequence as u64, Ordering::Release);
                state
                    .trace_now_micros
                    .store(input.now_micros, Ordering::Release);
            }
            TRACE_BEFORE_FACTS => {
                if mode == Mode::Replay {
                    // Park before taking the core's fact snapshot. Earlier UI
                    // publishes in this turn must reach the core before it is
                    // observed; the post-observe trace callback cannot repair
                    // a snapshot that was taken too early.
                    await_replay_event(state, trace, TraceActor::Worker, session, "turn.facts")?;
                }
                if mode != Mode::Live {
                    state.mutation_gate.lock();
                    state
                        .capture_gate_owner
                        .store(CAPTURE_GATE_FACTS, Ordering::Release);
                }
            }
            TRACE_IDLE | TRACE_END => {
                if mode == Mode::Replay {
                    await_replay_event(state, trace, TraceActor::Worker, session, "turn.end")?;
                }
                let generation = state.generation;
                let sequence = input.sequence;
                let executed = phase == TRACE_END && status != 0;
                let actual = serde_json::json!({
                    "generation": generation,
                    "sequence": sequence,
                    "executed": executed,
                    "elapsedMicros": elapsed_micros,
                });
                match mode {
                    Mode::Live => {}
                    Mode::Record => {
                        trace.observe(TraceActor::Worker, session, "turn.end", || actual)?;
                    }
                    Mode::Replay => {
                        let expected = trace
                            .take(TraceActor::Worker, session, "turn.end")?
                            .ok_or_else(|| "Worker replay is missing turn.end".to_owned())?;
                        if expected["generation"].as_u64() != Some(generation as u64)
                            || expected["sequence"].as_u64() != Some(sequence as u64)
                            || expected["executed"].as_bool() != Some(executed)
                        {
                            return Err("Worker replay turn completion differs".into());
                        }
                        let recorded = expected["elapsedMicros"]
                            .as_u64()
                            .ok_or_else(|| "Worker replay turn duration is invalid".to_owned())?;
                        state.clock.advance_replay(recorded)?;
                        if !output.is_null() {
                            *output = recorded;
                        }
                    }
                }
            }
            TRACE_DEFERRED => {
                if mode == Mode::Record {
                    if status != 0 {
                        let actual = serde_json::json!({
                            "generation": state.generation,
                            "nowMicros": input.now_micros,
                            "resumeAtMicros": resume_at_micros,
                        });
                        trace.observe(TraceActor::Worker, session, "turn.deferred", || actual)?;
                    }
                    if !output.is_null() {
                        *output = if status != 0 { resume_at_micros } else { 0 };
                    }
                } else if mode == Mode::Replay {
                    // The replay pre-gate above has waited for the next Worker
                    // event without holding the core lock and handled stop.
                    let next = trace.peek_replay()?;
                    if next.as_ref().is_some_and(|event| {
                        event.session.as_str() == session && event.kind == "turn.deferred"
                    }) {
                        let expected = trace
                            .take(TraceActor::Worker, session, "turn.deferred")?
                            .ok_or_else(|| "Worker replay is missing turn.deferred".to_owned())?;
                        if expected["generation"].as_u64() != Some(state.generation as u64) {
                            return Err("Worker replay quota boundary differs".into());
                        }
                        let recorded_now = expected["nowMicros"]
                            .as_u64()
                            .ok_or_else(|| "Worker replay quota clock is invalid".to_owned())?;
                        if recorded_now < input.now_micros {
                            return Err("Worker replay quota clock moved backwards".into());
                        }
                        let resume = expected["resumeAtMicros"]
                            .as_u64()
                            .ok_or_else(|| "Worker replay resume deadline is invalid".to_owned())?;
                        if resume < recorded_now {
                            return Err("Worker replay resume deadline precedes its clock".into());
                        }
                        input.now_micros = recorded_now;
                        // A recorded quota deferral is only a deadline, not a
                        // clock jump. UI ingress can wake the runner again
                        // before that deadline, producing another deferred
                        // decision at an earlier time. The runner gate follows
                        // the next event; turn.begin advances the clock when
                        // the recording actually reaches the deadline.
                        state.clock.set_replay_now(recorded_now);
                        if !output.is_null() {
                            *output = resume;
                        }
                    } else {
                        let expected = next
                            .as_ref()
                            .filter(|event| {
                                event.session.as_str() == session && event.kind == "turn.begin"
                            })
                            .ok_or_else(|| match next.as_ref() {
                                Some(event) => format!(
                                    "Worker replay expected turn.begin or turn.deferred, got event {} {}/{}",
                                    event.seq, event.session, event.kind
                                ),
                                None => "Worker replay expected turn.begin or turn.deferred, got end of batch".to_owned(),
                            })?;
                        let expected_sequence = state
                            .trace_sequence
                            .load(Ordering::Acquire)
                            .checked_add(1)
                            .ok_or_else(|| "Worker replay turn sequence overflow".to_owned())?;
                        if expected.data["generation"].as_u64() != Some(state.generation as u64)
                            || expected.data["sequence"].as_u64() != Some(expected_sequence as u64)
                        {
                            return Err("Worker replay turn admission identity differs".into());
                        }
                        let recorded_now = expected.data["nowMicros"]
                            .as_u64()
                            .ok_or_else(|| "Worker replay turn clock is invalid".to_owned())?;
                        if recorded_now < input.now_micros {
                            return Err("Worker replay turn clock moved backwards".into());
                        }
                        state.clock.set_replay_now(recorded_now);
                        input.now_micros = recorded_now;
                        if !output.is_null() {
                            // UINT64_MAX tells the C quota gate to recalculate
                            // its window at this recorded logical time.
                            *output = u64::MAX;
                        }
                    }
                }
            }
            _ => return Err(format!("unsupported Worker trace phase {phase}")),
        }
        Ok(())
    })();
    match result {
        Ok(()) => 0,
        Err(error) => {
            state.trace_failure(error);
            -1
        }
    }
}

unsafe extern "C" fn trace_boundary_callback(
    context: *mut c_void,
    phase: u32,
    decision: u32,
) -> i32 {
    let Some(state) = trace_state(context) else {
        return -1;
    };
    let (Some(trace), Some(session)) = (&state.trace, &state.session) else {
        return 0;
    };
    let mode = trace.mode();
    if mode == Mode::Live || phase != TRACE_BEFORE_OPERATION {
        return 0;
    }
    let kind = match decision {
        OP_OPEN => "io.open",
        OP_SUBMIT => "io.submit",
        OP_CANCEL => "io.cancel",
        OP_CLOSE => "io.close",
        OP_WRITE => "io.write",
        OP_PUBLISH => "channel.publish",
        OP_TIMER => "timer.set",
        OP_DECLARE_CHANNEL => "channel.declare",
        _ => {
            state.trace_failure(format!("unsupported Worker operation boundary {decision}"));
            return -1;
        }
    };
    if mode == Mode::Replay {
        if let Err(error) =
            unsafe { await_replay_event(state, trace, TraceActor::Worker, session, kind) }
        {
            state.trace_failure(error);
            return -1;
        }
    }
    if decision == OP_PUBLISH {
        state.mutation_gate.lock();
        state
            .capture_gate_owner
            .store(CAPTURE_GATE_WORKER_PUBLISH, Ordering::Release);
    }
    0
}

unsafe extern "C" fn trace_operation_callback(
    context: *mut c_void,
    operation: u32,
    id: u32,
    code: u32,
    name: *const c_char,
    bytes: *const u8,
    size: usize,
    deadline_micros: u64,
    period_micros: u64,
    capacity: u32,
    direction: u32,
    status: i32,
) -> i32 {
    let Some(state) = trace_state(context) else {
        return -1;
    };
    let _publish_unlock = (operation == OP_PUBLISH)
        .then(|| {
            release_capture_gate_if_held(
                &state.capture_gate_owner,
                CAPTURE_GATE_WORKER_PUBLISH,
                &state.mutation_gate,
            )
        })
        .flatten();
    let (Some(trace), Some(session)) = (&state.trace, &state.session) else {
        return 0;
    };
    if trace.mode() == Mode::Live {
        return 0;
    }
    if size > MAX_PAYLOAD || (size != 0 && bytes.is_null()) {
        trace.mark_incomplete("Worker operation payload exceeds 1024 bytes");
        return 0;
    }
    let kind = match operation {
        OP_OPEN => "io.open",
        OP_SUBMIT => "io.submit",
        OP_CANCEL => "io.cancel",
        OP_CLOSE => "io.close",
        OP_WRITE => "io.write",
        OP_PUBLISH => "channel.publish",
        OP_TIMER => "timer.set",
        OP_DECLARE_CHANNEL => "channel.declare",
        _ => {
            state.trace_failure(format!("unsupported Worker operation {operation}"));
            return -1;
        }
    };
    let name = if name.is_null() {
        None
    } else {
        Some(CStr::from_ptr(name).to_string_lossy().into_owned())
    };
    let payload = if size == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(bytes, size)
    };
    let data = serde_json::json!({
        "generation": state.generation,
        "operation": operation,
        "id": id,
        "code": code,
        "name": name,
        "bytesBase64": trace_bytes_base64(payload),
        "deadlineMicros": deadline_micros,
        "periodMicros": period_micros,
        "capacity": capacity,
        "direction": direction,
        "status": status,
    });
    match trace.observe_now(TraceActor::Worker, session, kind, || data) {
        Ok(_) => 0,
        Err(error) => {
            state.trace_failure(error);
            -1
        }
    }
}

unsafe extern "C" fn trace_scalar_callback(
    context: *mut c_void,
    name: *const c_char,
    actual: f64,
    output: *mut f64,
) -> i32 {
    let Some(state) = trace_state(context) else {
        return -1;
    };
    let (Some(trace), Some(session)) = (&state.trace, &state.session) else {
        return 0;
    };
    if trace.mode() == Mode::Live {
        return 0;
    }
    if trace.mode() == Mode::Replay {
        if let Err(error) =
            unsafe { await_replay_event(state, trace, TraceActor::Worker, session, "clock.scalar") }
        {
            state.trace_failure(error);
            return -1;
        }
    }
    if name.is_null() || output.is_null() || !actual.is_finite() {
        state.trace_failure("Worker scalar callback arguments are invalid".into());
        return -1;
    }
    let source = CStr::from_ptr(name).to_string_lossy().into_owned();
    match trace.mode() {
        Mode::Live => {}
        Mode::Record => {
            if let Err(error) = trace.observe(
                TraceActor::Worker,
                session,
                "clock.scalar",
                || serde_json::json!({"source": source, "value": actual}),
            ) {
                state.trace_failure(error);
                return -1;
            }
        }
        Mode::Replay => {
            let expected = match trace.take(TraceActor::Worker, session, "clock.scalar") {
                Ok(Some(value)) => value,
                Ok(None) => {
                    state.trace_failure("Worker replay is missing clock.scalar".into());
                    return -1;
                }
                Err(error) => {
                    state.trace_failure(error);
                    return -1;
                }
            };
            if expected["source"].as_str() != Some(&source) {
                state.trace_failure("Worker replay scalar source differs".into());
                return -1;
            }
            let Some(value) = expected["value"].as_f64().filter(|value| value.is_finite()) else {
                state.trace_failure("Worker replay scalar value is invalid".into());
                return -1;
            };
            *output = value;
        }
    }
    0
}

unsafe extern "C" fn core_lock(context: *mut c_void) {
    if !context.is_null() {
        (&*(context as *const WorkerState)).core_lock.lock();
    }
}
unsafe extern "C" fn core_unlock(context: *mut c_void) {
    if !context.is_null() {
        (&*(context as *const WorkerState)).core_lock.unlock();
    }
}
unsafe extern "C" fn core_wake(context: *mut c_void) {
    if context.is_null() {
        return;
    }
    let state = &*(context as *const WorkerState);
    // Core operations performed by the owner runner (timer registration,
    // publish, dispatch) happen before it reaches its wait callback. They
    // still notify the UI, but must not leave a stale self-wake in the
    // runner's condition variable.
    if !state
        .owner_thread
        .get()
        .is_some_and(|owner| owner == &thread::current().id())
    {
        state.pulse.signal();
    }
    state.wake_host();
}
unsafe extern "C" fn core_now(context: *mut c_void) -> u64 {
    if context.is_null() {
        now_micros()
    } else {
        (&*(context as *const WorkerState)).clock.now_micros()
    }
}

#[cfg(any(
    target_os = "android",
    target_os = "ios",
    target_os = "linux",
    target_os = "macos"
))]
#[repr(C)]
struct ThreadCpuTimespec {
    seconds: c_long,
    nanoseconds: c_long,
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
const CLOCK_THREAD_CPUTIME_ID: c_int = 16;
#[cfg(any(target_os = "android", target_os = "linux"))]
const CLOCK_THREAD_CPUTIME_ID: c_int = 3;

#[cfg(any(
    target_os = "android",
    target_os = "ios",
    target_os = "linux",
    target_os = "macos"
))]
unsafe extern "C" {
    fn clock_gettime(clock_id: c_int, value: *mut ThreadCpuTimespec) -> c_int;
}

unsafe extern "C" fn cpu_now_micros(context: *mut c_void) -> u64 {
    // The QuickJS interrupt handler uses the runner thread's CPU time for its
    // per-turn safety guard. Replay gates consume no CPU; deterministic quota
    // accounting still uses the Worker virtual wall clock elsewhere.
    #[cfg(any(
        target_os = "android",
        target_os = "ios",
        target_os = "linux",
        target_os = "macos"
    ))]
    {
        let mut value = ThreadCpuTimespec {
            seconds: 0,
            nanoseconds: 0,
        };
        if clock_gettime(CLOCK_THREAD_CPUTIME_ID, &mut value) == 0
            && value.seconds >= 0
            && value.nanoseconds >= 0
        {
            let micros = (value.seconds as u128)
                .saturating_mul(1_000_000)
                .saturating_add(value.nanoseconds as u128 / 1_000);
            return micros.min(u64::MAX as u128) as u64;
        }
    }
    let _ = context;
    now_micros()
}
unsafe extern "C" fn runner_wait(context: *mut c_void, deadline: u64) {
    if !context.is_null() {
        let state = &*(context as *const WorkerState);
        if let Some(trace) = &state.trace {
            if trace.mode() == Mode::Replay {
                // The runner uses this callback both for its replay event
                // gate and for the C core's post-stop destruction wait. The
                // former exits as soon as stop is requested; the latter must
                // sleep until canceled native requests signal completion.
                // Returning immediately here would turn the pinned runner's
                // busy-destroy retry into a tight polling loop.
                if state.stop_requested.load(Ordering::Acquire) {
                    state.pulse.wait_runner(deadline, &state.clock);
                    return;
                }
                if let Err(error) = trace.wait_runner_or_stop(
                    state.session.as_deref().unwrap_or(""),
                    &state.stop_requested,
                ) {
                    state.trace_failure(error);
                }
                return;
            }
        }
        state.clock.wait_until_resumed(&state.stop_requested);
        state.pulse.wait_runner(deadline, &state.clock);
    }
}
unsafe extern "C" fn runner_pause_wait(context: *mut c_void) {
    if !context.is_null() {
        let state = &*(context as *const WorkerState);
        state.clock.wait_until_resumed(&state.stop_requested);
    }
}
fn owner_thread(state: Arc<WorkerState>, bytecode: Vec<u8>) {
    let _ = state.owner_thread.set(thread::current().id());
    let context = Arc::as_ptr(&state).cast_mut().cast::<c_void>();
    let payload = bytecode.as_ptr().cast::<c_char>();
    let nodes = state
        .nodes
        .get()
        .map_or(ptr::null(), |nodes| nodes.as_ptr());
    let trace_active = state
        .trace
        .as_ref()
        .is_some_and(|trace| trace.mode() != Mode::Live);
    let core = CWorkerConfig {
        struct_size: std::mem::size_of::<CWorkerConfig>() as u32,
        generation: state.generation,
        nodes,
        node_count: state.nodes.get().map_or(0, Vec::len),
        context,
        lock: Some(core_lock),
        unlock: Some(core_unlock),
        wake: Some(core_wake),
        now_micros: Some(core_now),
        trace_fact: trace_active.then_some(trace_fact_callback),
        trace_facts: trace_active.then_some(trace_facts_callback),
    };
    let limits = state.limits;
    let realm = CWorkerQuickJsConfig {
        struct_size: std::mem::size_of::<CWorkerQuickJsConfig>() as u32,
        worker: ptr::null_mut(),
        heap_limit: limits.heap_bytes,
        stack_limit: limits.stack_bytes,
        max_jobs: 64,
        max_facts: 16,
        max_bytes: 8192,
        turn_budget_micros: limits.turn_budget_micros,
        window_micros: limits.window_micros,
        quota_micros: limits.quota_micros,
        context,
        now_micros: Some(core_now),
        mount: None,
        allocator: ptr::null(),
        allocator_context: ptr::null_mut(),
        cpu_now_micros: Some(cpu_now_micros),
        trace_turn: trace_active.then_some(trace_turn_callback),
        trace_boundary: trace_active.then_some(trace_boundary_callback),
        trace_operation: trace_active.then_some(trace_operation_callback),
        trace_scalar: trace_active.then_some(trace_scalar_callback),
    };
    let config = CWorkerRunnerConfig {
        struct_size: std::mem::size_of::<CWorkerRunnerConfig>() as u32,
        core,
        realm,
        source: payload,
        source_size: bytecode.len(),
        context,
        wait: Some(runner_wait),
        pause_wait: Some(runner_pause_wait),
        // The runner is already at a turn boundary when this callback would
        // fire. Pulsing its own wait condition here creates a self-wake loop
        // under quota deferral; external producers and lifecycle paths signal
        // the same pulse when the runner actually needs to resume.
        after_turn: None,
        start_paused: 0,
    };
    let runner = unsafe { pocket_worker_runner_create(&config) };
    if runner.is_null() {
        *state
            .errors
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) =
            Some("pocket_worker_runner_create returned null".to_owned());
        trace_worker_exit(&state, "bootstrap-failed");
        mark_runner_exited(&state);
        return;
    }
    state.runner.store(runner, Ordering::Release);
    if unsafe { pocket_worker_runner_failed(runner) } != 0 {
        let message = worker_error(runner);
        *state
            .errors
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(message);
        unsafe {
            pocket_worker_runner_destroy(runner);
        }
        state.core.store(ptr::null_mut(), Ordering::Release);
        state.runner.store(ptr::null_mut(), Ordering::Release);
        trace_worker_exit(&state, "bootstrap-failed");
        mark_runner_exited(&state);
        return;
    }
    let core = unsafe { pocket_worker_runner_core(runner) };
    state.core.store(core, Ordering::Release);
    state.lifecycle.1.notify_all();
    if state.stop_requested.load(Ordering::Acquire) {
        unsafe {
            pocket_worker_runner_stop(runner);
        }
    }
    state.wake_host();
    unsafe {
        pocket_worker_runner_run(runner);
    }
    let failed = unsafe { pocket_worker_runner_failed(runner) } != 0;
    if failed {
        *state
            .errors
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(worker_error(runner));
    }
    trace_worker_exit(
        &state,
        if failed {
            "faulted"
        } else if state.stop_requested.load(Ordering::Acquire) {
            "stopped"
        } else {
            "returned"
        },
    );
    mark_runner_exited(&state);
    let (lock, cv) = &state.lifecycle;
    let mut lifecycle = lock.lock().unwrap_or_else(|poison| poison.into_inner());
    while !lifecycle.allow_destroy {
        lifecycle = cv
            .wait(lifecycle)
            .unwrap_or_else(|poison| poison.into_inner());
    }
    drop(lifecycle);
    unsafe {
        pocket_worker_runner_destroy(runner);
    }
    state.core.store(ptr::null_mut(), Ordering::Release);
    state.runner.store(ptr::null_mut(), Ordering::Release);
    state.pulse.signal();
}

fn trace_worker_exit(state: &WorkerState, status: &'static str) {
    let (Some(trace), Some(session)) = (&state.trace, &state.session) else {
        return;
    };
    if trace.mode() == Mode::Live {
        return;
    }
    if trace.mode() == Mode::Replay {
        let drain_result: Result<(), String> = (|| loop {
            unsafe { inject_replay_io_facts(state, trace, session)? };
            let Some(next) = trace.peek_replay()? else {
                break Ok(());
            };
            if next.session == *session && next.kind == "io.fact" {
                continue;
            }
            if !(TraceActor::for_event(Mode::Replay, &next) == TraceActor::Worker && next.session == *session) {
                trace.wait_for_advance(next.seq)?;
                continue;
            }
            break Ok(());
        })();
        if let Err(error) = drain_result {
            *state
                .errors
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = Some(error.clone());
            trace.fail_replay(error);
            return;
        }
    }
    if let Err(error) = trace
        .observe(TraceActor::Worker, session, "worker.exit", || {
            serde_json::json!({
                "generation": state.generation,
                "status": status,
            })
        })
        .map(|_| ())
    {
        *state
            .errors
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(error.clone());
        if trace.mode() == Mode::Replay {
            trace.fail_replay(error);
        }
    }
}

fn mark_runner_exited(state: &WorkerState) {
    let (lock, cv) = &state.lifecycle;
    {
        let mut lifecycle = lock.lock().unwrap_or_else(|poison| poison.into_inner());
        lifecycle.exited = true;
        cv.notify_all();
    }
    state.pulse.signal();
    state.wake_host();
}
fn worker_error(runner: *const CWorkerRunner) -> String {
    let message = unsafe { pocket_worker_runner_error(runner) };
    if message.is_null() {
        "worker runner fault".to_owned()
    } else {
        unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .into_owned()
    }
}

unsafe fn node_state(
    context: *mut c_void,
    expected: WorkerResourceKind,
) -> Option<Arc<WorkerState>> {
    if context.is_null() {
        return None;
    }
    let node = &*(context as *const NodeContext);
    if node.kind != expected {
        return None;
    }
    node.state.upgrade()
}

unsafe extern "C" fn driver_open(
    context: *mut c_void,
    _core: *mut CWorkerCore,
    handle: u32,
    bytes: *const u8,
    size: usize,
) -> i32 {
    let Some(state) = node_state(context, WorkerResourceKind::Http) else {
        return STATUS_UNSUPPORTED;
    };
    if size == 0 || size > MAX_PAYLOAD || bytes.is_null() {
        return STATUS_INVALID;
    }
    let source = std::slice::from_raw_parts(bytes, size);
    match parse_http_descriptor(source, &state.allowed_origins) {
        Ok(descriptor) => {
            state
                .resources
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .insert(handle, descriptor);
            STATUS_OK
        }
        Err(_) => STATUS_INVALID,
    }
}

unsafe extern "C" fn driver_validate(
    context: *mut c_void,
    _core: *mut CWorkerCore,
    handle: u32,
    opcode: u32,
    _bytes: *const u8,
    size: usize,
    capacity: usize,
) -> i32 {
    let Some(state) = node_state(context, WorkerResourceKind::Http) else {
        return STATUS_UNSUPPORTED;
    };
    if opcode != 1 || size != 0 || capacity != 0 {
        return STATUS_INVALID;
    }
    if state
        .resources
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .contains_key(&handle)
    {
        STATUS_OK
    } else {
        STATUS_INVALID
    }
}

unsafe extern "C" fn driver_start(
    context: *mut c_void,
    core: *mut CWorkerCore,
    handle: u32,
    request: u32,
    opcode: u32,
    _bytes: *const u8,
    size: usize,
    _capacity: usize,
) -> i32 {
    let Some(state) = node_state(context, WorkerResourceKind::Http) else {
        return STATUS_UNSUPPORTED;
    };
    if state.offline_shutdown.load(Ordering::Acquire) {
        return STATUS_CANCELLED;
    }
    if opcode != 1 || size != 0 || core.is_null() {
        return STATUS_INVALID;
    }
    let Some(descriptor) = state
        .resources
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .get(&handle)
        .cloned()
    else {
        return STATUS_INVALID;
    };
    if let Some(trace) = &state.trace {
        if trace.mode() != Mode::Live {
            let Some(session) = &state.session else {
                return STATUS_FAILED;
            };
            if trace.mode() == Mode::Replay {
                if let Err(error) = unsafe {
                    await_replay_event(
                        state.as_ref(),
                        trace,
                        TraceActor::Worker,
                        session,
                        "io.request",
                    )
                } {
                    state.trace_failure(error);
                    return STATUS_FAILED;
                }
            }
            let data = serde_json::json!({
                "generation": state.generation,
                "handle": handle,
                "request": request,
                "url": descriptor.url.as_str(),
                "method": &descriptor.method,
                "headers": &descriptor.headers,
                "body": &descriptor.body,
                "timeoutMicros": descriptor.timeout.as_micros(),
                "maxBytes": descriptor.max_bytes,
            });
            if let Err(error) = trace.observe(TraceActor::Worker, session, "io.request", || data) {
                state.trace_failure(error);
                return STATUS_FAILED;
            }
        }
    }
    // Serialize the final replay/live decision and provider admission against
    // prepare_replay_stop(). Do not hold this lock while the trace event above
    // may wait for another actor.
    let _offline_gate = state
        .offline_gate
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if state.offline_shutdown.load(Ordering::Acquire) {
        return STATUS_CANCELLED;
    }
    if state
        .trace
        .as_ref()
        .is_some_and(|trace| trace.mode() == Mode::Replay)
    {
        let cancel = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        state
            .requests
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(
                request,
                ActiveRequest {
                    handle,
                    cancel,
                    finished,
                    join: None,
                    replay_stub: true,
                },
            );
        return STATUS_OK;
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let state_for_task = Arc::clone(&state);
    let cancel_for_task = Arc::clone(&cancel);
    let cancel_for_panic = Arc::clone(&cancel);
    let finished_for_task = Arc::clone(&finished);
    let core_address = core as usize;
    let task = thread::Builder::new()
        .name(format!("pocket-http-{request}"))
        .spawn(move || {
            let _guard = RequestCompletion {
                state: Arc::clone(&state_for_task),
                finished: Arc::clone(&finished_for_task),
            };
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_http_request(
                    &state_for_task,
                    core_address as *mut CWorkerCore,
                    handle,
                    request,
                    descriptor,
                    Arc::clone(&cancel_for_task),
                )
            }));
            if result.is_err() {
                let message = b"HTTP provider panicked";
                let _ = emit_with_backpressure(
                    &state_for_task,
                    core_address as *mut CWorkerCore,
                    handle,
                    request,
                    FACT_ERROR,
                    0,
                    message,
                    Instant::now() + Duration::from_secs(1),
                    &cancel_for_panic,
                );
                let _ = unsafe {
                    pocket_worker_finish(
                        core_address as *mut CWorkerCore,
                        handle,
                        request,
                        STATUS_FAILED,
                        0,
                    )
                };
            }
        });
    match task {
        Ok(join) => {
            state
                .requests
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .insert(
                    request,
                    ActiveRequest {
                        handle,
                        cancel,
                        finished,
                        join: Some(join),
                        replay_stub: false,
                    },
                );
            STATUS_OK
        }
        Err(_) => STATUS_FAILED,
    }
}

struct RequestCompletion {
    state: Arc<WorkerState>,
    finished: Arc<AtomicBool>,
}
impl Drop for RequestCompletion {
    fn drop(&mut self) {
        self.finished.store(true, Ordering::Release);
        self.state.pulse.signal();
    }
}

unsafe extern "C" fn driver_cancel(
    context: *mut c_void,
    core: *mut CWorkerCore,
    _handle: u32,
    request: u32,
) {
    let Some(state) = node_state(context, WorkerResourceKind::Http) else {
        return;
    };
    let mut requests = state
        .requests
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let replay_stub = requests.get_mut(&request).map(|active| {
        active.cancel.store(true, Ordering::Release);
        let replay_stub = active.replay_stub && !active.finished.load(Ordering::Acquire);
        if replay_stub {
            active.finished.store(true, Ordering::Release);
        }
        replay_stub
    });
    drop(requests);
    if replay_stub == Some(true) && !core.is_null() {
        // Replay has no provider thread to finish a request. On a failed or
        // missing tape, finish the dummy slot so teardown cannot wait forever
        // for an event that the tape did not contain.
        let _ = pocket_worker_complete(core, request, STATUS_CANCELLED, ptr::null(), 0);
    }
    if replay_stub.is_some() {
        state.pulse.signal();
    }
}

unsafe extern "C" fn driver_close(
    context: *mut c_void,
    _core: *mut CWorkerCore,
    handle: u32,
) -> i32 {
    let Some(state) = node_state(context, WorkerResourceKind::Http) else {
        return STATUS_UNSUPPORTED;
    };
    let mut requests = state
        .requests
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if requests
        .values()
        .any(|active| active.handle == handle && !active.finished.load(Ordering::Acquire))
    {
        for active in requests.values().filter(|active| active.handle == handle) {
            active.cancel.store(true, Ordering::Release);
        }
        state.pulse.signal();
        return STATUS_BUSY;
    }
    let finished = requests
        .iter()
        .filter_map(|(id, active)| (active.handle == handle).then_some(*id))
        .collect::<Vec<_>>();
    let joins = finished
        .into_iter()
        .filter_map(|id| {
            requests
                .remove(&id)
                .and_then(|mut active| active.join.take())
        })
        .collect::<Vec<_>>();
    drop(requests);
    for join in joins {
        let _ = join.join();
    }
    state
        .resources
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .remove(&handle);
    STATUS_OK
}

unsafe extern "C" fn driver_write(
    _context: *mut c_void,
    _core: *mut CWorkerCore,
    _handle: u32,
    _bytes: *const u8,
    _size: usize,
) -> i32 {
    STATUS_UNSUPPORTED
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawHttpOptions {
    url: String,
    method: Option<String>,
    headers: Option<BTreeMap<String, String>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    max_bytes: Option<usize>,
}

fn normalize_origin(raw: &str) -> Result<String, String> {
    let url = Url::parse(raw).map_err(|error| format!("invalid origin {raw:?}: {error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!(
            "origin must contain only http(s) scheme, host and optional port: {raw:?}"
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn parse_http_descriptor(bytes: &[u8], grants: &HashSet<String>) -> Result<HttpDescriptor, String> {
    if bytes.len() > MAX_PAYLOAD {
        return Err("HTTP descriptor exceeds 1024 bytes".to_owned());
    }
    let raw: RawHttpOptions = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid HTTP descriptor: {error}"))?;
    if raw.url.len() > 8192 {
        return Err("URL is too long".to_owned());
    }
    let url = Url::parse(&raw.url).map_err(|error| format!("invalid URL: {error}"))?;
    validate_destination(&url, grants)?;
    let method = raw
        .method
        .unwrap_or_else(|| "GET".to_owned())
        .to_ascii_uppercase();
    if !matches!(
        method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) {
        return Err("HTTP method is not in the portable worker contract".to_owned());
    }
    let timeout_ms = raw.timeout_ms.unwrap_or(DEFAULT_HTTP_TIMEOUT_MS);
    if timeout_ms == 0 || timeout_ms > MAX_HTTP_TIMEOUT_MS {
        return Err("timeoutMs is outside 1..120000".to_owned());
    }
    let max_bytes = raw.max_bytes.unwrap_or(DEFAULT_HTTP_RESPONSE_BYTES);
    if max_bytes == 0 || max_bytes > MAX_HTTP_RESPONSE_BYTES {
        return Err("maxBytes must be 1..256 KiB".to_owned());
    }
    if let Some(body) = &raw.body {
        if body.len() > MAX_HTTP_REQUEST_BYTES {
            return Err("request body exceeds 64 KiB".to_owned());
        }
        if matches!(method.as_str(), "GET" | "HEAD") {
            return Err(format!("{method} does not carry a body"));
        }
    }
    let headers = raw.headers.unwrap_or_default();
    if headers.len() > MAX_HTTP_HEADERS {
        return Err("too many request headers".to_owned());
    }
    let mut header_bytes = 0;
    let mut normalized = BTreeMap::new();
    for (name, value) in headers {
        if !valid_header_name(&name) || value.bytes().any(|byte| matches!(byte, b'\r' | b'\n' | 0))
        {
            return Err(format!("invalid HTTP header {name:?}"));
        }
        header_bytes += name.len() + value.len() + 4;
        normalized.insert(name.to_ascii_lowercase(), value);
    }
    if header_bytes > MAX_HTTP_HEADER_BYTES {
        return Err("request headers exceed 8 KiB".to_owned());
    }
    Ok(HttpDescriptor {
        url,
        method,
        headers: normalized,
        body: raw.body,
        timeout: Duration::from_millis(timeout_ms),
        max_bytes,
    })
}

fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
}

fn validate_destination(url: &Url, grants: &HashSet<String>) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("only credential-free http(s) URLs without fragments are allowed".to_owned());
    }
    let origin = url.origin().ascii_serialization();
    if !grants.contains(&origin) {
        return Err(format!("HTTP origin {origin} has no host grant"));
    }
    Ok(())
}

fn run_http_request(
    state: &Arc<WorkerState>,
    core: *mut CWorkerCore,
    handle: u32,
    request: u32,
    descriptor: HttpDescriptor,
    cancel: Arc<AtomicBool>,
) {
    let deadline = Instant::now() + descriptor.timeout;
    let result = perform_http(state, core, handle, request, &descriptor, &cancel, deadline);
    let (status, offset) = match result {
        Ok(offset) => (STATUS_OK, offset),
        Err(_error) if cancel.load(Ordering::Acquire) => (STATUS_CANCELLED, 0),
        Err(error) => {
            let mut message = error.into_bytes();
            message.truncate(MAX_PAYLOAD);
            let _ = emit_with_backpressure(
                state, core, handle, request, FACT_ERROR, 0, &message, deadline, &cancel,
            );
            (STATUS_FAILED, 0)
        }
    };
    let _ = unsafe { pocket_worker_finish(core, handle, request, status, offset) };
}

fn perform_http(
    state: &Arc<WorkerState>,
    core: *mut CWorkerCore,
    handle: u32,
    request: u32,
    descriptor: &HttpDescriptor,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<u64, String> {
    let mut url = descriptor.url.clone();
    let mut method = descriptor.method.clone();
    let mut body = descriptor.body.clone();
    let mut headers = descriptor.headers.clone();
    let mut redirects = 0usize;
    let response = loop {
        check_request_alive(cancel, deadline)?;
        validate_destination(&url, &state.allowed_origins)?;
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1));
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout_connect(remaining)
            .timeout_read(remaining)
            .timeout_write(remaining)
            .build();
        let mut request = agent
            .request(&method, url.as_str())
            .set("accept-encoding", "identity");
        for (name, value) in &headers {
            if request_header_allowed(name) {
                request = request.set(name, value);
            }
        }
        let result = match body.as_deref() {
            Some(data) => request.send_string(data),
            None => request.call(),
        };
        let response = match result {
            Ok(response) => response,
            Err(ureq::Error::Status(_, response)) => response,
            Err(error) => return Err(map_http_error(error.to_string(), cancel, deadline)),
        };
        let status = response.status();
        let location = response.header("location").map(str::to_owned);
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            if let Some(location) = location {
                if redirects >= MAX_HTTP_REDIRECTS {
                    return Err("more than three redirects".to_owned());
                }
                redirects += 1;
                let next = url
                    .join(&location)
                    .map_err(|error| format!("invalid redirect location: {error}"))?;
                validate_destination(&next, &state.allowed_origins)?;
                if next.origin().ascii_serialization() != url.origin().ascii_serialization() {
                    headers.remove("authorization");
                    headers.remove("cookie");
                }
                if status == 303 || ((status == 301 || status == 302) && method == "POST") {
                    method = if method == "HEAD" { "HEAD" } else { "GET" }.to_owned();
                    body = None;
                    headers.remove("content-type");
                }
                url = next;
                continue;
            }
        }
        break response;
    };
    let status = response.status();
    let final_url = response.get_url().to_owned();
    let mut response_headers = BTreeMap::new();
    let mut header_bytes = 0usize;
    for name in response.headers_names() {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "connection"
                | "keep-alive"
                | "proxy-authenticate"
                | "proxy-authorization"
                | "proxy-connection"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
                | "set-cookie"
        ) {
            continue;
        }
        if let Some(value) = response.header(&name) {
            let size = lower.len() + value.len() + 4;
            if response_headers.len() < MAX_HTTP_HEADERS
                && header_bytes + size <= MAX_HTTP_HEADER_BYTES
            {
                header_bytes += size;
                response_headers.insert(lower, value.to_owned());
            }
        }
    }
    let head = serde_json::to_vec(
        &serde_json::json!({"status": status, "url": final_url, "headers": response_headers}),
    )
    .map_err(|error| error.to_string())?;
    if head.len() > MAX_PAYLOAD {
        return Err("HTTP response headers exceed the 1024-byte worker record".to_owned());
    }
    emit_with_backpressure(
        state,
        core,
        handle,
        request,
        FACT_HEADERS,
        0,
        &head,
        deadline,
        cancel,
    )?;
    let mut reader = response.into_reader();
    let mut buffer = [0u8; MAX_PAYLOAD];
    let mut offset = 0usize;
    if method != "HEAD" {
        loop {
            check_request_alive(cancel, deadline)?;
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    offset = offset
                        .checked_add(length)
                        .ok_or_else(|| "HTTP response size overflow".to_owned())?;
                    if offset > descriptor.max_bytes {
                        return Err("HTTP response exceeds maxBytes".to_owned());
                    }
                    emit_with_backpressure(
                        state,
                        core,
                        handle,
                        request,
                        FACT_DATA,
                        offset.saturating_sub(length) as u64,
                        &buffer[..length],
                        deadline,
                        cancel,
                    )?;
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                    ) =>
                {
                    continue
                }
                Err(error) => return Err(map_http_error(error.to_string(), cancel, deadline)),
            }
        }
    }
    Ok(offset as u64)
}

fn request_header_allowed(name: &str) -> bool {
    !matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
            | "expect"
            | "accept-encoding"
    )
}

fn check_request_alive(cancel: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        return Err("HTTP request cancelled".to_owned());
    }
    if Instant::now() >= deadline {
        return Err("HTTP request timed out".to_owned());
    }
    Ok(())
}

fn map_http_error(error: String, cancel: &AtomicBool, deadline: Instant) -> String {
    if cancel.load(Ordering::Acquire) {
        "HTTP request cancelled".to_owned()
    } else if Instant::now() >= deadline {
        "HTTP request timed out".to_owned()
    } else {
        format!("HTTP transport failed: {error}")
    }
}

fn emit_with_backpressure(
    state: &WorkerState,
    core: *mut CWorkerCore,
    handle: u32,
    request: u32,
    kind: u32,
    offset: u64,
    bytes: &[u8],
    deadline: Instant,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if bytes.len() > MAX_PAYLOAD {
        return Err("HTTP chunk exceeds 1024 bytes".to_owned());
    }
    loop {
        check_request_alive(cancel, deadline)?;
        let seen = state.pulse.snapshot();
        let status = unsafe {
            pocket_worker_emit_request(
                core,
                handle,
                request,
                kind,
                STATUS_OK,
                offset,
                bytes.as_ptr(),
                bytes.len(),
            )
        };
        if status == STATUS_OK {
            return Ok(());
        }
        if status != STATUS_BUSY {
            return Err(format!(
                "worker rejected HTTP stream event with status {status}"
            ));
        }
        state.pulse.wait_change(seen, Some(deadline));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_trace::WorkerTraceEvent;
    use rquickjs::{qjs, Context, Runtime as JsRuntime};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::OnceLock;

    struct TestWake {
        epoch: Mutex<u64>,
        changed: Condvar,
    }
    impl TestWake {
        fn global() -> &'static Self {
            static WAKE: OnceLock<TestWake> = OnceLock::new();
            WAKE.get_or_init(|| TestWake {
                epoch: Mutex::new(0),
                changed: Condvar::new(),
            })
        }
        fn snapshot(&self) -> u64 {
            *self
                .epoch
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
        }
        fn wait_change(&self, seen: u64, timeout: Duration) {
            let epoch = self
                .epoch
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if *epoch != seen {
                return;
            }
            let _ = self
                .changed
                .wait_timeout_while(epoch, timeout, |value| *value == seen)
                .unwrap_or_else(|poison| poison.into_inner());
        }
    }

    unsafe extern "C" fn test_worker_wake() {
        let wake = TestWake::global();
        let mut epoch = wake
            .epoch
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *epoch = epoch.wrapping_add(1);
        wake.changed.notify_all();
    }

    struct LocalHttpFixture {
        stop: Arc<AtomicBool>,
        requests: Arc<AtomicUsize>,
        thread: Option<JoinHandle<()>>,
        origin: String,
    }
    impl LocalHttpFixture {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let stop = Arc::new(AtomicBool::new(false));
            let requests = Arc::new(AtomicUsize::new(0));
            let thread_stop = Arc::clone(&stop);
            let thread_requests = Arc::clone(&requests);
            let thread = thread::spawn(move || loop {
                if thread_stop.load(Ordering::Acquire) {
                    break;
                }
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        thread_requests.fetch_add(1, Ordering::Relaxed);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let mut request = Vec::new();
                        let mut chunk = [0u8; 512];
                        loop {
                            match stream.read(&mut chunk) {
                                Ok(0) => break,
                                Ok(count) => {
                                    request.extend_from_slice(&chunk[..count]);
                                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                                        break;
                                    }
                                }
                                Err(error)
                                    if matches!(
                                        error.kind(),
                                        std::io::ErrorKind::WouldBlock
                                            | std::io::ErrorKind::TimedOut
                                    ) =>
                                {
                                    break;
                                }
                                Err(_) => break,
                            }
                        }
                        let response =
                            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\npong";
                        let _ = stream.write_all(response);
                        let _ = stream.flush();
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            });
            Self {
                stop,
                requests,
                thread: Some(thread),
                origin,
            }
        }
        fn close(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                thread.join().unwrap();
            }
        }
    }
    impl Drop for LocalHttpFixture {
        fn drop(&mut self) {
            self.close();
        }
    }

    fn compile_worker_bytecode(source: &str) -> Vec<u8> {
        let source_bytes = source.as_bytes();
        let runtime = JsRuntime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let payload = context.with(|ctx| unsafe {
            let input = CString::new(source_bytes).unwrap();
            let filename = CString::new("worker-record-replay-test.js").unwrap();
            let value = qjs::JS_Eval(
                ctx.as_raw().as_ptr(),
                input.as_ptr(),
                source_bytes.len() as _,
                filename.as_ptr(),
                (qjs::JS_EVAL_TYPE_GLOBAL
                    | qjs::JS_EVAL_FLAG_STRICT
                    | qjs::JS_EVAL_FLAG_COMPILE_ONLY) as i32,
            );
            assert_ne!(qjs::JS_VALUE_GET_NORM_TAG(value), qjs::JS_TAG_EXCEPTION);
            let mut length = 0;
            let buffer = qjs::JS_WriteObject(
                ctx.as_raw().as_ptr(),
                &mut length,
                value,
                (qjs::JS_WRITE_OBJ_BYTECODE
                    | qjs::JS_WRITE_OBJ_STRIP_SOURCE
                    | qjs::JS_WRITE_OBJ_STRIP_DEBUG) as i32,
            );
            assert!(!buffer.is_null());
            let bytes = std::slice::from_raw_parts(buffer, length as usize).to_vec();
            qjs::js_free(ctx.as_raw().as_ptr(), buffer.cast());
            qjs::JS_FreeValue(ctx.as_raw().as_ptr(), value);
            bytes
        });
        bytecode::encode(
            BytecodeKind::Script,
            bytecode::DEFAULT_FLAGS,
            pocket_spec::BINDING_GENERATION,
            60,
            source_bytes,
            &payload,
        )
        .unwrap()
    }

    fn collect_worker_outputs(
        context: &Context,
        bridge: &mut WorkerUiBridge,
        expected_tags: &[u8],
        phase: &str,
        trace: &WorkerTrace,
        recorded_tape: &[WorkerTraceEvent],
    ) -> Vec<Vec<u8>> {
        let deadline = Instant::now() + Duration::from_secs(8);
        let wake = TestWake::global();
        let replay = phase == "replay";
        let mut seen_records = Vec::<Vec<u8>>::new();
        while !expected_tags.iter().all(|tag| {
            seen_records
                .iter()
                .any(|record| record.first() == Some(tag))
        }) {
            if replay {
                let next = match trace.peek_replay() {
                    Ok(Some(next)) => next,
                    Ok(None) => panic!(
                        "{}",
                        worker_output_diagnostic(
                            phase,
                            &seen_records,
                            bridge,
                            trace,
                            recorded_tape,
                            "Replay tape ended before the expected UI output arrived",
                        )
                    ),
                    Err(error) => panic!(
                        "{}",
                        worker_output_diagnostic(
                            phase,
                            &seen_records,
                            bridge,
                            trace,
                            recorded_tape,
                            &format!("Replay trace failed: {error}"),
                        )
                    ),
                };
                if next.session == bridge.state.session.as_deref().unwrap_or("")
                    && TraceActor::for_event(Mode::Replay, &next) == TraceActor::Ui
                {
                    if next.kind != "channel.latch" {
                        panic!(
                            "{}",
                            worker_output_diagnostic(
                                phase,
                                &seen_records,
                                bridge,
                                trace,
                                recorded_tape,
                                &format!(
                                    "Replay expects unsupported UI event {} seq={}",
                                    next.kind, next.seq
                                ),
                            )
                        );
                    }
                } else {
                    let now = Instant::now();
                    if now >= deadline
                        || !trace
                            .wait_for_advance_timeout(
                                next.seq,
                                deadline.saturating_duration_since(now),
                            )
                            .unwrap_or(false)
                    {
                        panic!(
                            "{}",
                            worker_output_diagnostic(
                                phase,
                                &seen_records,
                                bridge,
                                trace,
                                recorded_tape,
                                "Timed out waiting for the next recorded UI latch boundary",
                            )
                        );
                    }
                    continue;
                }
            }
            // Live recording uses the real coalesced host wake. Replay follows
            // the recorded UI latch boundaries directly; its host wake
            // notifications are intentionally not part of the tape.
            let seen = (!replay).then(|| wake.snapshot());
            let collected = context.with(|ctx| -> Result<_, String> {
                bridge.latch().map_err(|error| error.to_string())?;
                let pending = bridge.has_pending_output();
                let encoded: String = ctx
                    .eval(
                        "JSON.stringify(__pocketWorkerChannels.observe(2).map(record => Array.from(record)))",
                    )
                    .map_err(|error| error.to_string())?;
                let records = serde_json::from_str::<Vec<Vec<u8>>>(&encoded)
                    .map_err(|error| error.to_string())?;
                bridge.mark_frame_consumed();
                if bridge.has_pending_output() {
                    return Err("UI did not acknowledge the latched Worker records".into());
                }
                Ok((records, pending))
            });
            let (records, pending) = match collected {
                Ok(result) => result,
                Err(error) => panic!(
                    "{}",
                    worker_output_diagnostic(
                        phase,
                        &seen_records,
                        bridge,
                        trace,
                        recorded_tape,
                        &format!("UI collection failed: {error}"),
                    )
                ),
            };
            if !records.is_empty() {
                assert!(pending, "latched records did not request a UI turn");
            }
            seen_records.extend(records);
            if expected_tags.iter().all(|tag| {
                seen_records
                    .iter()
                    .any(|record| record.first() == Some(tag))
            }) {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                panic!(
                    "{}",
                    worker_output_diagnostic(
                        phase,
                        &seen_records,
                        bridge,
                        trace,
                        recorded_tape,
                        "Worker output timed out",
                    )
                );
            }
            if let Some(seen) = seen {
                wake.wait_change(seen, deadline.saturating_duration_since(now));
            }
        }
        seen_records
    }

    fn worker_output_diagnostic(
        phase: &str,
        seen_records: &[Vec<u8>],
        bridge: &WorkerUiBridge,
        trace: &WorkerTrace,
        recorded_tape: &[WorkerTraceEvent],
        reason: &str,
    ) -> String {
        let worker_error = bridge
            .state
            .errors
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        let next_event = match trace.peek_replay() {
            Ok(Some(event)) => {
                format!("{} seq={} session={}", event.kind, event.seq, event.session)
            }
            Ok(None) => "none".to_owned(),
            Err(error) => format!("trace-error: {error}"),
        };
        let tape_context = trace
            .peek_replay()
            .ok()
            .flatten()
            .and_then(|next| {
                let index = recorded_tape
                    .iter()
                    .position(|event| event.seq == next.seq)?;
                let start = index.saturating_sub(6);
                let end = (index + 10).min(recorded_tape.len());
                Some(
                    recorded_tape[start..end]
                        .iter()
                        .map(|event| {
                            let detail = match event.kind.as_str() {
                                "turn.begin" => format!(
                                    " seq={:?} now={:?}",
                                    event.data.get("sequence"),
                                    event.data.get("nowMicros")
                                ),
                                "turn.facts" => {
                                    let facts = event.data["facts"]
                                        .as_array()
                                        .map(|facts| {
                                            facts
                                                .iter()
                                                .map(|fact| {
                                                    format!(
                                                        "kind={:?},channel={:?},handle={:?},request={:?}",
                                                        fact.get("kind"),
                                                        fact.get("channel"),
                                                        fact.get("handle"),
                                                        fact.get("request")
                                                    )
                                                })
                                                .collect::<Vec<_>>()
                                                .join(";")
                                        })
                                        .unwrap_or_default();
                                    format!(" seq={:?} facts=[{facts}]", event.data.get("sequence"))
                                }
                                "channel.publish" => format!(
                                    " operation={:?} id={:?} direction={:?} status={:?}",
                                    event.data.get("operation"),
                                    event.data.get("id"),
                                    event.data.get("direction"),
                                    event.data.get("status")
                                ),
                                "io.fact" => format!(
                                    " action={:?} handle={:?} request={:?} kind={:?} status={:?} offset={:?}",
                                    event.data.get("action"),
                                    event.data.get("handle"),
                                    event.data.get("request"),
                                    event.data.get("kind"),
                                    event.data.get("status"),
                                    event.data.get("offset")
                                ),
                                _ => String::new(),
                            };
                            format!("{}:{}{detail}", event.seq, event.kind)
                        })
                        .collect::<Vec<_>>()
                        .join(" | "),
                )
            })
            .unwrap_or_else(|| "unavailable".to_owned());
        let sequence = bridge.state.trace_sequence.load(Ordering::Acquire);
        let worker_now = bridge.state.clock.now_micros();
        let stop_requested = bridge.state.stop_requested.load(Ordering::Acquire);
        let runner_present = !bridge.state.runner.load(Ordering::Acquire).is_null();
        let exited = bridge
            .state
            .lifecycle
            .0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .exited;
        let active_requests = bridge
            .state
            .requests
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .iter()
            .map(|(id, request)| {
                (
                    *id,
                    request.finished.load(Ordering::Acquire),
                    request.replay_stub,
                )
            })
            .collect::<Vec<_>>();
        format!(
            "Worker output {phase} failed: {reason}; seen_records={seen_records:?}; pending_output={}; worker_error={worker_error:?}; trace_mode={:?}; next_replay_event={next_event}; worker_sequence={sequence} virtual_now={worker_now} stop_requested={stop_requested} runner_present={runner_present} exited={exited} active_requests={active_requests:?}; tape_context={tape_context}",
            bridge.has_pending_output(),
            trace.mode(),
        )
    }

    #[test]
    fn official_worker_records_http_timer_and_duplex_channels_then_replays_offline() {
        let mut server = LocalHttpFixture::start();
        let descriptor = serde_json::json!({
            "url": format!("{}/body", server.origin),
            "method": "GET",
            "timeoutMs": 2000,
            "maxBytes": 64,
        })
        .to_string();
        let descriptor_bytes = descriptor
            .as_bytes()
            .iter()
            .map(|byte| byte.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let source = format!(
            r#"
            __pocketWorker.declareChannel(1,0,16,2,1);
            __pocketWorker.declareChannel(2,0,64,4,0);
            const httpHandle=__pocketWorker.open(3,"net",new Uint8Array([{descriptor_bytes}]));
            if(httpHandle<=0) throw new Error("HTTP open failed");
            const httpRequest=__pocketWorker.submit(httpHandle,1,new Uint8Array(0),0);
            if(httpRequest<=0) throw new Error("HTTP submit failed");
            const httpBytes=[];
            globalThis.__pocketWorkerTurn=(context,facts)=>{{
              if(context.sequence===1) __pocketWorker.timer(1,context.nowMicros+80000,0);
              for(const fact of facts) {{
                if(fact.kind===7 && fact.channel===1) {{
                  __pocketWorker.publish(2,new Uint8Array([1,fact.data[0],Math.floor(Math.random()*256),Date.now()%256]));
                }} else if(fact.kind===6) {{
                  __pocketWorker.publish(2,new Uint8Array([2,Math.floor(Math.random()*256),Date.now()%256]));
                }} else if(fact.kind===3) {{
                  httpBytes.push(...fact.data);
                }} else if(fact.kind===2) {{
                  __pocketWorker.publish(2,new Uint8Array([3,...httpBytes]));
                  __pocketWorker.publish(2,new Uint8Array([4]));
                  __pocketWorker.close(httpHandle);
                }}
              }}
            }};
            "#
        );
        let bytecode = compile_worker_bytecode(&source);
        let declaration = WorkerDeclaration {
            entry: "worker.js".into(),
            nodes: vec![WorkerNodeDeclaration {
                name: "net".into(),
                kind: WorkerResourceKind::Http,
            }],
            channels: vec![
                WorkerChannelDeclaration {
                    name: "commands".into(),
                    kind: WorkerChannelKind::Ring,
                    direction: WorkerChannelDirection::UiToWorker,
                    record_bytes: 16,
                    capacity: 2,
                },
                WorkerChannelDeclaration {
                    name: "results".into(),
                    kind: WorkerChannelKind::Ring,
                    direction: WorkerChannelDirection::WorkerToUi,
                    record_bytes: 64,
                    capacity: 4,
                },
            ],
        };
        let policy = WorkerPolicy {
            allowed_http_origins: vec![server.origin.clone()],
            required_capabilities: vec!["net.http".into()],
        };
        let limits = WorkerLimits {
            heap_bytes: 16 * 1024 * 1024,
            stack_bytes: 1024 * 1024,
            turn_budget_micros: 10_000,
            window_micros: 1_000_000,
            quota_micros: 900_000,
        };
        let session = "worker:1:1".to_owned();
        let ui_runtime = JsRuntime::new().unwrap();
        let ui_context = Context::full(&ui_runtime).unwrap();
        let record = WorkerTrace::new(Mode::Record);
        record.begin_batch(&[]).unwrap();
        let mut worker = WorkerRuntime::spawn_traced(
            &bytecode,
            pocket_spec::BINDING_GENERATION,
            60,
            declaration.clone(),
            policy.clone(),
            limits,
            Some(test_worker_wake),
            Arc::clone(&record),
            session.clone(),
        )
        .unwrap();
        worker.wait_ready(Duration::from_secs(2)).unwrap();
        let mut bridge = ui_context
            .with(|ctx| worker.attach_ui(ctx.as_raw().as_ptr()))
            .unwrap();
        ui_context.with(|ctx| {
            ctx.eval::<(), _>(
                "__pocketWorkerChannels.configure(1,0);__pocketWorkerChannels.configure(2,0);",
            )
            .unwrap();
            let status: i32 = ctx
                .eval("__pocketWorkerChannels.publish(1,new Uint8Array([7]))")
                .unwrap();
            assert_eq!(status, STATUS_OK);
        });
        let recorded_outputs = collect_worker_outputs(
            &ui_context,
            &mut bridge,
            &[1, 2, 3, 4],
            "record",
            &record,
            &[],
        );
        assert!(recorded_outputs
            .iter()
            .any(|record| record.as_slice() == &[3, b'p', b'o', b'n', b'g']));
        worker.request_stop_and_wait();
        bridge.detach();
        worker.destroy_and_join().unwrap();
        let events = record.finish_batch().unwrap();
        server.close();
        assert_eq!(server.requests.load(Ordering::Relaxed), 1);
        assert!(events.iter().any(|event| event.kind == "io.request"));
        assert!(events.iter().any(|event| event.kind == "io.fact"));
        assert!(events.iter().any(|event| event.kind == "timer.set"));
        assert!(events
            .iter()
            .any(|event| event.kind == "channel.publish"
                && event.data["direction"] == "ui-to-worker"));
        assert!(events.iter().any(|event| {
            event.kind == "channel.publish"
                && event.data["operation"].as_u64() == Some(OP_PUBLISH as u64)
                && event.data["id"].as_u64() == Some(2)
                && event.data["status"].as_i64() == Some(STATUS_OK as i64)
        }));
        assert!(events
            .iter()
            .any(|event| event.kind == "clock.scalar" && event.data["source"] == "date.now"));
        assert!(events
            .iter()
            .any(|event| event.kind == "clock.scalar" && event.data["source"] == "math.random"));
        let turn_count = events
            .iter()
            .filter(|event| event.kind == "turn.begin")
            .count();
        assert!(
            turn_count < 64,
            "idle runner spun {turn_count} Worker turns"
        );

        let replay = WorkerTrace::new(Mode::Replay);
        replay.begin_batch(&events).unwrap();
        let mut worker = WorkerRuntime::spawn_traced(
            &bytecode,
            pocket_spec::BINDING_GENERATION,
            60,
            declaration.clone(),
            policy.clone(),
            limits,
            Some(test_worker_wake),
            Arc::clone(&replay),
            session.clone(),
        )
        .unwrap();
        worker.wait_ready(Duration::from_secs(2)).unwrap();
        let mut bridge = ui_context
            .with(|ctx| worker.attach_ui(ctx.as_raw().as_ptr()))
            .unwrap();
        ui_context.with(|ctx| {
            ctx.eval::<(), _>(
                "__pocketWorkerChannels.configure(1,0);__pocketWorkerChannels.configure(2,0);",
            )
            .unwrap();
        });
        unsafe {
            await_replay_event(
                &worker.state,
                &replay,
                TraceActor::Ui,
                &session,
                "channel.publish",
            )
        }
        .unwrap();
        // This is longer than the JS turn budget. Replay must park at the
        // trace gate without charging that wait to the Guest's CPU guard.
        thread::sleep(Duration::from_millis(25));
        ui_context.with(|ctx| {
            let status: i32 = ctx
                .eval("__pocketWorkerChannels.publish(1,new Uint8Array([7]))")
                .unwrap();
            assert_eq!(status, STATUS_OK);
        });
        let replayed_outputs = collect_worker_outputs(
            &ui_context,
            &mut bridge,
            &[1, 2, 3, 4],
            "replay",
            &replay,
            &events,
        );
        assert_eq!(replayed_outputs, recorded_outputs);
        assert_eq!(
            server.requests.load(Ordering::Relaxed),
            1,
            "Replay performed HTTP"
        );
        worker.request_stop_and_wait();
        bridge.detach();
        worker.destroy_and_join().unwrap();
        assert_eq!(replay.finish_batch().unwrap(), events);

        let request_index = events
            .iter()
            .position(|event| event.kind == "io.request")
            .expect("recording omitted HTTP request admission");
        let replay_prefix = &events[..=request_index];
        let replay_stop = WorkerTrace::new(Mode::Replay);
        replay_stop.begin_batch(replay_prefix).unwrap();
        let mut active_replay = WorkerRuntime::spawn_traced(
            &bytecode,
            pocket_spec::BINDING_GENERATION,
            60,
            declaration,
            policy,
            limits,
            Some(test_worker_wake),
            Arc::clone(&replay_stop),
            "worker:1:1".to_owned(),
        )
        .unwrap();
        active_replay.wait_ready(Duration::from_secs(2)).unwrap();
        let stub_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let has_active_stub = active_replay
                .state
                .requests
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .values()
                .any(|request| request.replay_stub && !request.finished.load(Ordering::Acquire));
            if has_active_stub {
                break;
            }
            assert!(
                Instant::now() < stub_deadline,
                "Replay HTTP stub was not admitted"
            );
            thread::sleep(Duration::from_millis(1));
        }
        active_replay.prepare_replay_stop();
        replay_stop.set_live();
        active_replay.request_stop_and_wait();
        active_replay.destroy_and_join().unwrap();
        assert_eq!(
            server.requests.load(Ordering::Relaxed),
            1,
            "offline Replay opened a real HTTP request during cleanup"
        );
    }

    #[test]
    fn worker_wakes_coalesce_until_the_ui_latch_rearms() {
        let pending = AtomicBool::new(false);
        let callbacks = AtomicUsize::new(0);
        for _ in 0..1_000 {
            notify_once(&pending, || {
                callbacks.fetch_add(1, Ordering::Relaxed);
            });
        }
        assert_eq!(callbacks.load(Ordering::Relaxed), 1);

        rearm_wake(&pending);
        notify_once(&pending, || {
            callbacks.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(callbacks.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn origin_grants_are_exact_and_credentials_are_rejected() {
        let origins = ["http://127.0.0.1:4000".to_owned()].into_iter().collect();
        assert!(
            validate_destination(&Url::parse("http://127.0.0.1:4000/data").unwrap(), &origins)
                .is_ok()
        );
        assert!(
            validate_destination(&Url::parse("http://127.0.0.1:4001/data").unwrap(), &origins)
                .is_err()
        );
        assert!(validate_destination(
            &Url::parse("http://u:p@127.0.0.1:4000/data").unwrap(),
            &origins
        )
        .is_err());
        assert!(normalize_origin("http://127.0.0.1:4000/path").is_err());
    }

    #[test]
    fn http_descriptor_is_bounded_and_origin_checked() {
        let grants = ["http://127.0.0.1:4000".to_owned()].into_iter().collect();
        let valid = br#"{"url":"http://127.0.0.1:4000/data","timeoutMs":500,"maxBytes":1024}"#;
        assert!(parse_http_descriptor(valid, &grants).is_ok());
        let denied = br#"{"url":"http://127.0.0.1:4001/data"}"#;
        assert!(parse_http_descriptor(denied, &grants).is_err());
        let invalid_method = br#"{"url":"http://127.0.0.1:4000/data","method":"TRACE"}"#;
        assert!(parse_http_descriptor(invalid_method, &grants).is_err());
    }
}
