//! Bounded provider broker for the pinned PocketJS io.offload client.
//!
//! The official per-frame pump copies request/reply records. Trusted host
//! providers perform asynchronous work through take_request/complete. When
//! tracing is enabled, each state transition joins the shared trace lane; the
//! broker remains the sole state machine in both live and replay modes.

#[path = "offload_trace.rs"]
mod trace_data;

use crate::replay::Mode;
use crate::worker_trace::{TraceActor, WorkerTrace};
use rquickjs::{Ctx, Function, Object, Value as JsValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_RECORD_BYTES: usize = 4096;
const MAX_PAYLOAD_CHARS: usize = 2500;
const MAX_PENDING: usize = 8;
const MAX_METHOD_CHARS: usize = 64;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;
// The JS direct-value bridge accounts for its fixed 66-byte B1 object envelope
// (including the magic byte) plus the UTF-8 bytes of method and payload.
// Legacy JSON records retain their own input-length check below and must not
// use this estimate.
const DIRECT_RECORD_FIXED_BYTES: usize = 66;
type Notify = unsafe extern "C" fn();
type RequestKey = (u32, u64);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OffloadProviderRequest {
    pub generation: u32,
    pub session: u32,
    pub id: u64,
    pub method: String,
    pub payload: String,
    pub timeout: Duration,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
struct RequestValue {
    v: u32,
    id: u64,
    method: String,
    payload: String,
}

struct PendingRequest {
    request: OffloadProviderRequest,
    deadline: Instant,
    token: u64,
    dispatched: bool,
}
struct Reply {
    session: u32,
    id: u64,
    result: Result<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ReplyValue {
    id: u64,
    result: Result<String, String>,
}
struct BrokerState {
    session: u32,
    last_submitted_id: u64,
    next_token: u64,
    pending: HashMap<RequestKey, PendingRequest>,
    request_queue: VecDeque<RequestKey>,
    cancellations: VecDeque<OffloadProviderRequest>,
    replies: VecDeque<Reply>,
    closed: bool,
}
struct BrokerInner {
    generation: u32,
    timeout: Duration,
    methods: BTreeSet<String>,
    state: Mutex<BrokerState>,
    changed: Condvar,
    trace: Option<Arc<WorkerTrace>>,
    stable_session: String,
    notify: Option<Notify>,
    wake_pending: Arc<AtomicBool>,
    closing: AtomicBool,
}

/// Shared endpoint installed as globalThis.offload for one provider session.
pub struct OffloadHost {
    inner: Arc<BrokerInner>,
    deadline_thread: Mutex<Option<JoinHandle<()>>>,
    replay_thread: Mutex<Option<JoinHandle<()>>>,
    replay_stop: Arc<AtomicBool>,
    shutdown_started: AtomicBool,
}

#[derive(Clone)]
struct SubmitOutcome {
    accepted: bool,
    record: Option<String>,
    request: Option<RequestValue>,
    oversized_bytes: Option<usize>,
    token: Option<u64>,
    legacy: bool,
}

struct TakeOutcome {
    request: Option<OffloadProviderRequest>,
    trace_request: Option<trace_data::ProviderRequest>,
}

struct TakeValueOutcome {
    reply: Option<ReplyValue>,
    /// Replay an older string trace with the typed API without changing its
    /// persisted event shape. New typed traces use the `value` field.
    legacy: bool,
}

struct CancelOutcome {
    accepted: bool,
    session: u32,
    id: u64,
    dispatched: bool,
}

struct CompleteOutcome {
    generation: u32,
    session: u32,
    id: u64,
    result: Option<trace_data::ProviderResult>,
    accepted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RemovedRequest {
    #[serde(rename = "providerSession")]
    provider_session: u32,
    id: u64,
    dispatched: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RequestIdentity {
    #[serde(rename = "providerSession")]
    provider_session: u32,
    id: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReplyIdentity {
    session: u32,
    id: u64,
}

struct SessionSetOutcome {
    from: u32,
    to: u32,
    changed: bool,
    removed: Vec<RemovedRequest>,
    cancelled: Vec<RequestIdentity>,
    discarded_replies: Vec<ReplyIdentity>,
    wake: bool,
}

struct TimeoutOutcome {
    session: u32,
    id: u64,
    token: u64,
    dispatched: bool,
    expired: bool,
}

struct ShutdownOutcome {
    removed: Vec<RemovedRequest>,
    cancelled: Vec<RequestIdentity>,
    discarded_replies: Vec<ReplyIdentity>,
    wake: bool,
}

impl BrokerInner {
    fn transition<T, A, E>(
        &self,
        actor: TraceActor,
        kind: &'static str,
        apply: A,
        encode: E,
    ) -> Result<T, String>
    where
        A: FnOnce(&mut BrokerState, Option<&Value>, bool) -> Result<T, String>,
        E: FnOnce(&T) -> Value,
    {
        let result = if let Some(trace) = &self.trace {
            trace.transition(
                actor,
                &self.stable_session,
                kind,
                |expected, trace_enabled| {
                    let mut state = self.lock_state();
                    apply(&mut state, expected, trace_enabled)
                },
                encode,
            )
        } else {
            let mut state = self.lock_state();
            apply(&mut state, None, false)
        };
        if let Err(error) = &result {
            if let Some(trace) = &self.trace {
                if trace.mode() == Mode::Replay {
                    trace.fail_replay(format!("offload {kind}: {error}"));
                }
            }
        }
        result
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, BrokerState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn notify(&self) {
        notify_once(&self.wake_pending, self.notify);
    }

    fn rearm_wake(&self) {
        rearm_wake(&self.wake_pending);
    }

    fn expire(&self, session: u32, id: u64, token: u64) -> Option<TimeoutOutcome> {
        if self.closing.load(Ordering::Acquire) {
            return None;
        }
        let result = self.transition(
            TraceActor::Offload,
            "offload.timeout",
            |state, expected, _trace_enabled| {
                if let Some(expected) = expected {
                    expect_u32(expected, "providerSession", session)?;
                    expect_u64(expected, "id", id)?;
                    expect_u64(expected, "token", token)?;
                }
                let key = (session, id);
                let mut dispatched = false;
                let mut expired = false;
                if state
                    .pending
                    .get(&key)
                    .is_some_and(|pending| pending.token == token)
                {
                    if let Some(pending) = state.pending.remove(&key) {
                        dispatched = pending.dispatched;
                        state.request_queue.retain(|queued| *queued != key);
                        if dispatched {
                            // Admission reserves one cancellation slot for each
                            // pending request, so this transfer stays bounded.
                            state.cancellations.push_back(pending.request.clone());
                        }
                        state.replies.push_back(Reply {
                            session: pending.request.session,
                            id: pending.request.id,
                            result: Err("Provider request timed out".to_owned()),
                        });
                        expired = true;
                        self.changed.notify_all();
                    }
                }
                Ok(TimeoutOutcome {
                    session,
                    id,
                    token,
                    dispatched,
                    expired,
                })
            },
            |outcome| {
                json!({
                    "providerSession": outcome.session,
                    "id": outcome.id,
                    "token": outcome.token,
                    "dispatched": outcome.dispatched,
                    "expired": outcome.expired,
                })
            },
        );
        match result {
            Ok(outcome) => {
                if outcome.expired {
                    self.notify();
                }
                Some(outcome)
            }
            Err(_) => None,
        }
    }
}

impl OffloadHost {
    /// Create an active live broker. Use `install_disconnected` when no
    /// trusted provider is registered; that path allocates no broker threads.
    pub fn new(
        generation: u32,
        session: u32,
        timeout: Duration,
        methods: impl IntoIterator<Item = String>,
        notify: Option<Notify>,
    ) -> Arc<Self> {
        Self::create(
            generation,
            session,
            timeout,
            methods,
            notify,
            None,
            String::new(),
        )
    }

    /// Create a broker on the existing trace-clock lane. Replay starts a
    /// condition-variable facts executor and never creates a provider timer or
    /// calls a real provider.
    pub(crate) fn new_traced(
        generation: u32,
        session: u32,
        timeout: Duration,
        methods: impl IntoIterator<Item = String>,
        notify: Option<Notify>,
        trace: Arc<WorkerTrace>,
        stable_session: String,
    ) -> Arc<Self> {
        let host = Self::create(
            generation,
            session,
            timeout,
            methods,
            notify,
            Some(trace.clone()),
            stable_session,
        );
        match trace.mode() {
            Mode::Replay => host.start_replay_executor(),
            Mode::Live | Mode::Record if session > 0 => host.start_deadline_thread(),
            _ => {}
        }
        host
    }

    fn create(
        generation: u32,
        session: u32,
        timeout: Duration,
        methods: impl IntoIterator<Item = String>,
        notify: Option<Notify>,
        trace: Option<Arc<WorkerTrace>>,
        stable_session: String,
    ) -> Arc<Self> {
        let mode = trace.as_ref().map(|lane| lane.mode()).unwrap_or(Mode::Live);
        let starts_deadline = mode != Mode::Replay && session > 0 && trace.is_none();
        let inner = Arc::new(BrokerInner {
            generation,
            timeout: timeout.max(Duration::from_millis(1)),
            methods: methods.into_iter().collect(),
            state: Mutex::new(BrokerState {
                session,
                last_submitted_id: 0,
                next_token: 0,
                pending: HashMap::new(),
                request_queue: VecDeque::new(),
                cancellations: VecDeque::new(),
                replies: VecDeque::new(),
                closed: false,
            }),
            changed: Condvar::new(),
            trace,
            stable_session,
            notify: if mode == Mode::Replay { None } else { notify },
            wake_pending: Arc::new(AtomicBool::new(false)),
            closing: AtomicBool::new(false),
        });
        let host = Arc::new(Self {
            inner,
            deadline_thread: Mutex::new(None),
            replay_thread: Mutex::new(None),
            replay_stop: Arc::new(AtomicBool::new(false)),
            shutdown_started: AtomicBool::new(false),
        });
        if starts_deadline {
            host.start_deadline_thread();
        }
        host
    }

    pub fn generation(&self) -> u32 {
        self.inner.generation
    }

    pub fn session(&self) -> u32 {
        self.inner
            .transition(
                TraceActor::Ui,
                "offload.session.read",
                |state, _expected, _trace_enabled| Ok(state.session),
                |value| json!({"value": value}),
            )
            .unwrap_or(0)
    }

    /// Install an active remote provider and optional device-local provider.
    pub fn install(
        ctx: Ctx<'_>,
        remote: Arc<Self>,
        local: Option<Arc<Self>>,
    ) -> rquickjs::Result<()> {
        let root = operations_object(ctx.clone(), Arc::clone(&remote))?;
        root.set("eventDriven", true)?;
        if let Some(local) = local {
            root.set("local", operations_object(ctx.clone(), local)?)?;
        }
        ctx.globals().set("offload", root)?;
        Ok(())
    }

    /// Install an explicit disconnected capability without allocating a
    /// worker/timer thread or retaining a wake callback.
    pub fn install_disconnected(ctx: Ctx<'_>) -> rquickjs::Result<()> {
        let root = Object::new(ctx.clone())?;
        root.set("eventDriven", true)?;
        root.set("session", Function::new(ctx.clone(), || 0u32)?)?;
        root.set(
            "submit",
            Function::new(ctx.clone(), |_record: String| false)?,
        )?;
        root.set("take", Function::new(ctx.clone(), || None::<String>)?)?;
        root.set(
            "submitValue",
            Function::new(ctx.clone(), |_value: JsValue<'_>| false)?,
        )?;
        root.set(
            "takeValue",
            Function::new(ctx.clone(), || None::<JsValue<'_>>)?,
        )?;
        root.set(
            "cancel",
            Function::new(ctx.clone(), |_id: u64, _session: u32| false)?,
        )?;
        ctx.globals().set("offload", root)
    }

    /// Legacy diagnostic/test adapter for a serialized JSON record. The
    /// canonical JS client uses `submitValue` below.
    pub fn submit_record(&self, record: &str) -> bool {
        let result = self.inner.transition(
            TraceActor::Ui,
            "offload.submit",
            |state, expected, trace_enabled| {
                if let Some(expected) = expected {
                    expect_submit_input(expected, record)?;
                }
                let (accepted, token) = if record.len() <= MAX_RECORD_BYTES {
                    serde_json::from_str::<RequestValue>(record)
                        .map(|request| submit_locked(&self.inner, state, &request))
                        .unwrap_or((false, None))
                } else {
                    (false, None)
                };
                Ok(SubmitOutcome {
                    accepted,
                    record: (trace_enabled && record.len() <= MAX_RECORD_BYTES)
                        .then(|| record.to_owned()),
                    request: None,
                    oversized_bytes: (trace_enabled && record.len() > MAX_RECORD_BYTES)
                        .then_some(record.len()),
                    token: (trace_enabled).then_some(token).flatten(),
                    legacy: true,
                })
            },
            encode_submit_outcome,
        );
        match result {
            Ok(outcome) => {
                if outcome.accepted {
                    self.inner.notify();
                }
                outcome.accepted
            }
            Err(_) => false,
        }
    }

    /// Synchronous bounded admission from the typed QuickJS object path.
    /// The canonical client never serializes this request into a JSON record;
    /// only the legacy `submit` adapter below accepts a string record.
    fn submit_value(&self, request: RequestValue) -> bool {
        let result = self.inner.transition(
            TraceActor::Ui,
            "offload.submit",
            |state, expected, trace_enabled| {
                let (legacy, legacy_record, legacy_oversized_bytes, legacy_rejected) =
                    if let Some(expected) = expected {
                        expect_submit_value(expected, &request)?
                    } else {
                        (false, None, None, false)
                    };
                let direct_bytes = direct_record_bytes(&request);
                let (accepted, token) = if legacy_rejected {
                    (false, None)
                } else if legacy || direct_bytes <= MAX_RECORD_BYTES {
                    submit_locked(&self.inner, state, &request)
                } else {
                    (false, None)
                };
                Ok(SubmitOutcome {
                    accepted,
                    record: legacy_record,
                    request: (!legacy && trace_enabled).then_some(request.clone()),
                    oversized_bytes: if legacy {
                        legacy_oversized_bytes
                    } else {
                        (trace_enabled && direct_bytes > MAX_RECORD_BYTES).then_some(direct_bytes)
                    },
                    token: trace_enabled.then_some(token).flatten(),
                    legacy,
                })
            },
            encode_submit_outcome,
        );
        match result {
            Ok(outcome) => {
                if outcome.accepted {
                    self.inner.notify();
                }
                outcome.accepted
            }
            Err(_) => false,
        }
    }

    /// Nonblocking dequeue for the trusted host provider. Dequeued work is
    /// marked dispatched so cancellation is forwarded to that provider.
    pub fn take_request(&self) -> Option<OffloadProviderRequest> {
        let result = self.inner.transition(
            TraceActor::Offload,
            "offload.provider.take",
            |state, _expected, trace_enabled| {
                let request = pop_request(state);
                if work_queues_empty(state) {
                    self.inner.rearm_wake();
                }
                let trace_request = if trace_enabled {
                    request.as_ref().map(trace_data::ProviderRequest::from)
                } else {
                    None
                };
                Ok(TakeOutcome {
                    request,
                    trace_request,
                })
            },
            |outcome| json!({"request": outcome.trace_request}),
        );
        result.ok().and_then(|outcome| outcome.request)
    }

    pub fn take_cancellation(&self) -> Option<OffloadProviderRequest> {
        let result = self.inner.transition(
            TraceActor::Offload,
            "offload.provider.cancel.take",
            |state, _expected, trace_enabled| {
                let request = state.cancellations.pop_front();
                if request.is_some() {
                    self.inner.changed.notify_all();
                }
                if work_queues_empty(state) {
                    self.inner.rearm_wake();
                }
                let trace_request = if trace_enabled {
                    request.as_ref().map(trace_data::ProviderRequest::from)
                } else {
                    None
                };
                Ok(TakeOutcome {
                    request,
                    trace_request,
                })
            },
            |outcome| json!({"request": outcome.trace_request}),
        );
        result.ok().and_then(|outcome| outcome.request)
    }

    /// Complete once. Stale generation/session/id results are discarded.
    pub fn complete(
        &self,
        generation: u32,
        session: u32,
        id: u64,
        result: Result<String, String>,
    ) -> bool {
        let result = self.inner.transition(
            TraceActor::Offload,
            "offload.provider.complete",
            |state, expected, trace_enabled| {
                let trace_result = trace_enabled.then(|| trace_result(&result));
                if let Some(expected) = expected {
                    expect_u32(expected, "generation", generation)?;
                    expect_u32(expected, "providerSession", session)?;
                    expect_u64(expected, "id", id)?;
                    let actual_result = trace_result
                        .as_ref()
                        .map(trace_data::ProviderResult::as_value);
                    if expected.get("result") != actual_result.as_ref() {
                        return Err("provider completion result differs from recorded fact".into());
                    }
                }
                let accepted = complete_locked(
                    &self.inner,
                    state,
                    generation,
                    session,
                    id,
                    result,
                    trace_result.as_ref(),
                );
                Ok(CompleteOutcome {
                    generation,
                    session,
                    id,
                    result: trace_result,
                    accepted,
                })
            },
            |outcome| {
                json!({
                    "generation": outcome.generation,
                    "providerSession": outcome.session,
                    "id": outcome.id,
                    "result": outcome.result,
                    "accepted": outcome.accepted,
                })
            },
        );
        match result {
            Ok(outcome) => {
                if outcome.accepted {
                    self.inner.changed.notify_all();
                    self.inner.notify();
                }
                outcome.accepted
            }
            Err(_) => false,
        }
    }

    /// Legacy diagnostic/test adapter returning one serialized completion
    /// record at a time. The canonical JS client uses `takeValue` below.
    pub fn take_reply(&self) -> Option<String> {
        self.inner
            .transition(
                TraceActor::Ui,
                "offload.reply.take",
                |state, _expected, _trace_enabled| {
                    let selected = pop_reply(state).map(|reply| encode_reply_value(&reply));
                    // The callback gate is level-triggered. A reply can keep
                    // it armed after the provider queues have been drained;
                    // rearm only while holding the broker lock, after this
                    // dequeue has made all three queues empty. This closes
                    // the window where a later submit/cancel is coalesced
                    // behind an already-consumed reply notification.
                    if work_queues_empty(state) {
                        self.inner.rearm_wake();
                    }
                    Ok(selected)
                },
                |record| json!({"record": record}),
            )
            .unwrap_or(None)
    }

    /// One typed completion value at a time. This is the canonical JS path;
    /// it returns a QuickJS object without constructing or parsing a JSON
    /// envelope. The legacy `take_reply` adapter above remains string-based
    /// for diagnostics and old hosts.
    fn take_reply_value(&self) -> Option<ReplyValue> {
        let result = self.inner.transition(
            TraceActor::Ui,
            "offload.reply.take",
            |state, expected, _trace_enabled| {
                let selected = pop_reply(state);
                let legacy = expected.and_then(|value| value.get("record")).is_some();
                if let Some(expected) = expected {
                    expect_reply_value(expected, selected.as_ref())?;
                }
                if work_queues_empty(state) {
                    self.inner.rearm_wake();
                }
                Ok(TakeValueOutcome {
                    reply: selected,
                    legacy,
                })
            },
            |outcome| encode_take_value_outcome(outcome),
        );
        result.ok().and_then(|outcome| outcome.reply)
    }

    /// Read-only host wake probe. External-work wakeups are traced by the
    /// owner scheduler, so this callback-side observation stays off the lane.
    pub fn has_replies(&self) -> bool {
        let state = self.inner.lock_state();
        !state.replies.is_empty()
    }

    /// Called by the pinned framework adapter when a sent request is cancelled.
    pub fn cancel(&self, session: u32, id: u64) -> bool {
        let result = self.inner.transition(
            TraceActor::Ui,
            "offload.cancel",
            |state, expected, _trace_enabled| {
                if let Some(expected) = expected {
                    expect_u32(expected, "providerSession", session)?;
                    expect_u64(expected, "id", id)?;
                }
                let mut dispatched = false;
                let accepted = if let Some(pending) = state.pending.remove(&(session, id)) {
                    dispatched = pending.dispatched;
                    state.request_queue.retain(|key| *key != (session, id));
                    if dispatched {
                        state.cancellations.push_back(pending.request);
                    }
                    self.inner.changed.notify_all();
                    true
                } else {
                    false
                };
                if work_queues_empty(state) {
                    self.inner.rearm_wake();
                }
                Ok(CancelOutcome {
                    accepted,
                    session,
                    id,
                    dispatched,
                })
            },
            |outcome| {
                json!({
                    "providerSession": outcome.session,
                    "id": outcome.id,
                    "accepted": outcome.accepted,
                    "dispatched": outcome.dispatched,
                })
            },
        );
        match result {
            Ok(outcome) => {
                if outcome.dispatched {
                    self.inner.notify();
                }
                outcome.accepted
            }
            Err(_) => false,
        }
    }

    /// Changing the authenticated provider session invalidates old requests.
    /// Dispatched tasks receive cancellation; late completes fail session checks.
    pub fn set_session(&self, session: u32) {
        let result = self.inner.transition(
            TraceActor::Offload,
            "offload.session.set",
            |state, expected, trace_enabled| {
                if let Some(expected) = expected {
                    expect_u32(expected, "to", session)?;
                }
                let outcome = set_session_locked(state, session, trace_enabled);
                if work_queues_empty(state) {
                    self.inner.rearm_wake();
                }
                Ok(outcome)
            },
            |outcome| {
                json!({
                    "from": outcome.from,
                    "to": outcome.to,
                    "changed": outcome.changed,
                    "removed": outcome.removed,
                    "cancelled": outcome.cancelled,
                    "discardedReplies": outcome.discarded_replies,
                })
            },
        );
        let Ok(outcome) = result else {
            return;
        };
        if !outcome.changed {
            return;
        }
        self.inner.changed.notify_all();
        if session > 0 {
            self.start_deadline_thread();
        } else if let Some(thread) = self
            .deadline_thread
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
        {
            let _ = thread.join();
        }
        if outcome.wake {
            self.inner.notify();
        }
    }

    /// Stop trace capture without stopping the live provider or its deadline
    /// thread. Replay's facts executor is only present while the lane replays.
    pub fn set_trace_live(&self) {
        if self
            .inner
            .trace
            .as_ref()
            .is_none_or(|trace| trace.mode() == Mode::Live)
        {
            self.stop_replay_executor();
        }
    }

    fn begin_deadline_shutdown(&self) {
        let _state = self.inner.lock_state();
        self.inner.closing.store(true, Ordering::Release);
        self.inner.changed.notify_all();
    }

    /// Stops deadlines, cancels dispatched requests and prevents future
    /// callbacks. Call before releasing the Dart NativeCallable retained by
    /// this broker.
    pub fn shutdown(&self) {
        let replaying = self
            .inner
            .trace
            .as_ref()
            .is_some_and(|trace| trace.mode() == Mode::Replay);
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            if !replaying {
                self.stop_replay_executor();
            }
            return;
        }
        if !replaying {
            self.begin_deadline_shutdown();
            if let Some(thread) = self
                .deadline_thread
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .take()
            {
                let _ = thread.join();
            }
        }
        let result = self.inner.transition(
            TraceActor::Host,
            "offload.shutdown",
            |state, _expected, trace_enabled| Ok(shutdown_locked(state, trace_enabled)),
            |outcome| {
                json!({
                    "removed": outcome.removed,
                    "cancelled": outcome.cancelled,
                    "discardedReplies": outcome.discarded_replies,
                })
            },
        );
        let wake = result.as_ref().is_ok_and(|outcome| outcome.wake);
        if let Err(error) = result {
            if let Some(trace) = &self.inner.trace {
                trace.fail_replay(format!("offload shutdown: {error}"));
            }
        }
        if replaying {
            self.begin_deadline_shutdown();
        } else {
            self.stop_replay_executor();
        }
        if wake {
            self.inner.notify();
        }
    }

    fn start_deadline_thread(&self) {
        if self.inner.closing.load(Ordering::Acquire) {
            return;
        }
        if self
            .inner
            .trace
            .as_ref()
            .is_some_and(|trace| trace.mode() == Mode::Replay)
        {
            return;
        }
        let mut guard = self
            .deadline_thread
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if self.inner.closing.load(Ordering::Acquire) {
            return;
        }
        if guard.is_some() {
            return;
        }
        let weak = Arc::downgrade(&self.inner);
        *guard = thread::Builder::new()
            .name(format!("pocket-offload-deadline-{}", self.inner.generation))
            .spawn(move || deadline_loop(weak))
            .ok();
    }

    fn start_replay_executor(self: &Arc<Self>) {
        let Some(trace) = self.inner.trace.as_ref().cloned() else {
            return;
        };
        let mut guard = self
            .replay_thread
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if guard.is_some() {
            return;
        }
        let weak = Arc::downgrade(self);
        let stop = Arc::clone(&self.replay_stop);
        let stable_session = self.inner.stable_session.clone();
        *guard = thread::Builder::new()
            .name(format!("pocket-offload-replay-{}", self.inner.generation))
            .spawn(move || replay_facts_loop(weak, trace, stable_session, stop))
            .ok();
    }

    fn stop_replay_executor(&self) {
        self.replay_stop.store(true, Ordering::Release);
        if let Some(trace) = &self.inner.trace {
            trace.notify_stop(None);
        }
        if let Some(handle) = self
            .replay_thread
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
        {
            if handle.thread().id() != thread::current().id() {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for OffloadHost {
    fn drop(&mut self) {
        if !self.shutdown_started.load(Ordering::Acquire)
            && self
                .inner
                .trace
                .as_ref()
                .is_some_and(|trace| trace.mode() == Mode::Replay)
        {
            self.shutdown_started.store(true, Ordering::Release);
            self.inner.closing.store(true, Ordering::Release);
            if let Some(trace) = &self.inner.trace {
                trace.fail_replay("offload host dropped before recorded shutdown".to_owned());
            }
        } else {
            self.shutdown();
        }
        self.stop_replay_executor();
    }
}

fn operations_object<'js>(ctx: Ctx<'js>, host: Arc<OffloadHost>) -> rquickjs::Result<Object<'js>> {
    let operations = Object::new(ctx.clone())?;
    let session_host = Arc::clone(&host);
    operations.set(
        "session",
        Function::new(ctx.clone(), move || session_host.session())?,
    )?;
    let submit_host = Arc::clone(&host);
    operations.set(
        "submit",
        Function::new(ctx.clone(), move |record: String| {
            submit_host.submit_record(&record)
        })?,
    )?;
    let submit_value_host = Arc::clone(&host);
    operations.set(
        "submitValue",
        Function::new(ctx.clone(), move |value: JsValue<'_>| {
            parse_request_value(value)
                .is_some_and(|request| submit_value_host.submit_value(request))
        })?,
    )?;
    let take_host = Arc::clone(&host);
    operations.set(
        "take",
        Function::new(ctx.clone(), move || take_host.take_reply())?,
    )?;
    let take_value_host = Arc::clone(&host);
    operations.set(
        "takeValue",
        Function::new(
            ctx.clone(),
            move |call_ctx: Ctx<'js>| -> rquickjs::Result<Option<JsValue<'js>>> {
                take_value_host
                    .take_reply_value()
                    .map(|reply| reply_value_to_js(&call_ctx, &reply))
                    .transpose()
            },
        )?,
    )?;
    let cancel_host = Arc::clone(&host);
    operations.set(
        "cancel",
        Function::new(ctx.clone(), move |id: u64, session: u32| {
            cancel_host.cancel(session, id)
        })?,
    )?;
    Ok(operations)
}

fn submit_locked(
    inner: &BrokerInner,
    state: &mut BrokerState,
    request: &RequestValue,
) -> (bool, Option<u64>) {
    if !valid_request(request) {
        return (false, None);
    }

    let session = state.session;
    if state.closed
        || session == 0
        || state.pending.len() + state.replies.len() >= MAX_PENDING
        || state.pending.len() + state.cancellations.len() >= MAX_PENDING
        || state.request_queue.len() >= MAX_PENDING
        || request.id <= state.last_submitted_id
    {
        return (false, None);
    }
    if state.pending.contains_key(&(session, request.id))
        || state
            .replies
            .iter()
            .any(|reply| reply.session == session && reply.id == request.id)
        || state
            .cancellations
            .iter()
            .any(|cancel| cancel.session == session && cancel.id == request.id)
    {
        return (false, None);
    }
    let token = if inner.methods.contains(&request.method) {
        let Some(token) = state.next_token.checked_add(1) else {
            return (false, None);
        };
        Some(token)
    } else {
        None
    };
    state.last_submitted_id = request.id;
    if token.is_none() {
        state.replies.push_back(Reply {
            session,
            id: request.id,
            result: Err(format!("Provider does not implement {}", request.method)),
        });
        return (true, None);
    }
    let token = token.expect("known provider method has a token");
    state.next_token = token;
    let key = (session, request.id);
    state.pending.insert(
        key,
        PendingRequest {
            request: OffloadProviderRequest {
                generation: inner.generation,
                session,
                id: request.id,
                method: request.method.clone(),
                payload: request.payload.clone(),
                timeout: inner.timeout,
            },
            deadline: Instant::now() + inner.timeout,
            token,
            dispatched: false,
        },
    );
    state.request_queue.push_back(key);
    inner.changed.notify_all();
    (true, Some(token))
}

fn parse_request_value<'js>(value: JsValue<'js>) -> Option<RequestValue> {
    if !value.is_object() || value.is_array() || value.is_function() || value.is_null() {
        return None;
    }
    let object = Object::from_value(value).ok()?;
    for property in object.props::<String, JsValue<'js>>() {
        let (key, _) = property.ok()?;
        if !matches!(key.as_str(), "v" | "id" | "method" | "payload") {
            return None;
        }
    }
    let v = safe_js_integer(object.get("v").ok()?)?.try_into().ok()?;
    let id = safe_js_integer(object.get("id").ok()?)?;
    Some(RequestValue {
        v,
        id,
        method: object.get("method").ok()?,
        payload: object.get("payload").ok()?,
    })
}

fn safe_js_integer(value: JsValue<'_>) -> Option<u64> {
    let number = value.as_number()?;
    (number.is_finite()
        && number >= 0.0
        && number <= MAX_SAFE_JS_INTEGER as f64
        && number.fract() == 0.0)
        .then_some(number as u64)
}

fn valid_request(request: &RequestValue) -> bool {
    request.v == 1
        && request.id > 0
        && request.id <= MAX_SAFE_JS_INTEGER
        && valid_method(&request.method)
        && request.payload.chars().count() <= MAX_PAYLOAD_CHARS
}

fn decimal_digits(mut value: u64) -> usize {
    let mut digits = 1;
    while value >= 10 {
        value /= 10;
        digits += 1;
    }
    digits
}

fn json_string_bytes(value: &str) -> usize {
    let mut bytes = 2usize;
    for character in value.chars() {
        bytes = bytes.saturating_add(match character {
            '"' | '\\' | '\u{08}' | '\u{0c}' | '\n' | '\r' | '\t' => 2,
            character if character <= '\u{1f}' => 6,
            character => character.len_utf8(),
        });
    }
    bytes
}

fn direct_record_bytes(request: &RequestValue) -> usize {
    DIRECT_RECORD_FIXED_BYTES
        .saturating_add(request.method.len())
        .saturating_add(request.payload.len())
}

fn legacy_json_record_bytes(request: &RequestValue) -> usize {
    b"{\"v\":1,\"id\":"
        .len()
        .saturating_add(decimal_digits(request.id))
        .saturating_add(b",\"method\":".len())
        .saturating_add(json_string_bytes(&request.method))
        .saturating_add(b",\"payload\":".len())
        .saturating_add(json_string_bytes(&request.payload))
        .saturating_add(1)
}

fn encode_submit_outcome(outcome: &SubmitOutcome) -> Value {
    if outcome.legacy {
        json!({
            "accepted": outcome.accepted,
            "record": outcome.record,
            "oversizedBytes": outcome.oversized_bytes,
            "token": outcome.token,
        })
    } else {
        json!({
            "accepted": outcome.accepted,
            "request": outcome.request,
            "oversizedBytes": outcome.oversized_bytes,
            "token": outcome.token,
        })
    }
}

fn expect_submit_value(
    expected: &Value,
    request: &RequestValue,
) -> Result<(bool, Option<String>, Option<usize>, bool), String> {
    if let Some(record) = expected.get("record") {
        if let Some(record) = record.as_str() {
            let expected_request = serde_json::from_str::<RequestValue>(record)
                .map_err(|error| format!("legacy offload submit trace is invalid: {error}"))?;
            if &expected_request != request {
                return Err("typed offload submit differs from legacy trace".into());
            }
            return Ok((true, Some(record.to_owned()), None, false));
        }
        let expected_bytes = expected
            .get("oversizedBytes")
            .and_then(Value::as_u64)
            .ok_or_else(|| "legacy offload submit trace has no record".to_owned())?;
        if expected_bytes != legacy_json_record_bytes(request) as u64 {
            return Err("typed offload submit size differs from legacy trace".into());
        }
        let expected_bytes = usize::try_from(expected_bytes)
            .map_err(|_| "legacy offload submit size does not fit host usize".to_owned())?;
        return Ok((true, None, Some(expected_bytes), true));
    }
    let expected_request = expected
        .get("request")
        .cloned()
        .ok_or_else(|| "typed offload submit trace has no request".to_owned())
        .and_then(|value| {
            serde_json::from_value::<RequestValue>(value)
                .map_err(|error| format!("typed offload submit trace is invalid: {error}"))
        })?;
    if &expected_request != request {
        return Err("typed offload submit differs from trace".into());
    }
    Ok((false, None, None, false))
}

fn pop_request(state: &mut BrokerState) -> Option<OffloadProviderRequest> {
    while let Some(key) = state.request_queue.pop_front() {
        if let Some(pending) = state.pending.get_mut(&key) {
            pending.dispatched = true;
            return Some(pending.request.clone());
        }
    }
    None
}

fn complete_locked(
    inner: &BrokerInner,
    state: &mut BrokerState,
    generation: u32,
    session: u32,
    id: u64,
    result: Result<String, String>,
    trace_result: Option<&trace_data::ProviderResult>,
) -> bool {
    if state.closed || generation != inner.generation || state.session != session {
        return false;
    }
    let Some(pending) = state.pending.get(&(session, id)) else {
        return false;
    };
    if !pending.dispatched {
        return false;
    }
    state.pending.remove(&(session, id));
    let reply_result = trace_result
        .map(|value| value.clone().into_result())
        .unwrap_or(result);
    state.replies.push_back(Reply {
        session,
        id,
        result: normalize_reply_result(reply_result),
    });
    true
}

fn set_session_locked(
    state: &mut BrokerState,
    session: u32,
    trace_enabled: bool,
) -> SessionSetOutcome {
    let previous = state.session;
    if previous == session {
        return SessionSetOutcome {
            from: previous,
            to: session,
            changed: false,
            removed: Vec::new(),
            cancelled: Vec::new(),
            discarded_replies: Vec::new(),
            wake: false,
        };
    }
    state.session = session;
    state.last_submitted_id = 0;
    let mut keys = state
        .pending
        .keys()
        .copied()
        .filter(|(request_session, _)| *request_session == previous)
        .collect::<Vec<_>>();
    keys.sort_unstable();
    let mut removed = Vec::new();
    let mut cancelled = Vec::new();
    let mut wake = false;
    for key in keys {
        if let Some(pending) = state.pending.remove(&key) {
            state.request_queue.retain(|queued| *queued != key);
            if trace_enabled {
                removed.push(RemovedRequest {
                    provider_session: key.0,
                    id: key.1,
                    dispatched: pending.dispatched,
                });
            }
            if pending.dispatched {
                wake = true;
                if trace_enabled {
                    cancelled.push(RequestIdentity {
                        provider_session: key.0,
                        id: key.1,
                    });
                }
                state.cancellations.push_back(pending.request);
            }
        }
    }
    let mut discarded_replies = Vec::new();
    state.replies.retain(|reply| {
        if reply.session == session {
            true
        } else {
            if trace_enabled {
                discarded_replies.push(ReplyIdentity {
                    session: reply.session,
                    id: reply.id,
                });
            }
            false
        }
    });
    removed.sort_by_key(|value| (value.provider_session, value.id));
    cancelled.sort_by_key(|value| (value.provider_session, value.id));
    discarded_replies.sort_by_key(|value| (value.session, value.id));
    SessionSetOutcome {
        from: previous,
        to: session,
        changed: true,
        wake,
        removed,
        cancelled,
        discarded_replies,
    }
}

fn shutdown_locked(state: &mut BrokerState, trace_enabled: bool) -> ShutdownOutcome {
    state.closed = true;
    let mut removed = Vec::new();
    let mut cancelled = Vec::new();
    let mut wake = false;
    let mut pending = state.pending.drain().collect::<Vec<_>>();
    pending.sort_by_key(|((session, id), _)| (*session, *id));
    for ((session, id), pending) in pending {
        if trace_enabled {
            removed.push(RemovedRequest {
                provider_session: session,
                id,
                dispatched: pending.dispatched,
            });
        }
        if pending.dispatched && state.cancellations.len() < MAX_PENDING {
            wake = true;
            if trace_enabled {
                cancelled.push(RequestIdentity {
                    provider_session: session,
                    id,
                });
            }
            state.cancellations.push_back(pending.request);
        }
    }
    state.request_queue.clear();
    let mut discarded_replies = Vec::new();
    if trace_enabled {
        discarded_replies.extend(std::mem::take(&mut state.replies).into_iter().map(|reply| {
            ReplyIdentity {
                session: reply.session,
                id: reply.id,
            }
        }));
    } else {
        state.replies.clear();
    }
    removed.sort_by_key(|value| (value.provider_session, value.id));
    cancelled.sort_by_key(|value| (value.provider_session, value.id));
    discarded_replies.sort_by_key(|value| (value.session, value.id));
    ShutdownOutcome {
        wake,
        removed,
        cancelled,
        discarded_replies,
    }
}

fn trace_result(result: &Result<String, String>) -> trace_data::ProviderResult {
    match result {
        Ok(payload) if payload.chars().count() <= MAX_PAYLOAD_CHARS => {
            trace_data::ProviderResult::Payload(trace_data::PayloadResult {
                payload: payload.clone(),
            })
        }
        Ok(_) => trace_data::ProviderResult::Error(trace_data::ErrorResult {
            error: "Provider response exceeds payload budget".to_owned(),
        }),
        Err(error) => trace_data::ProviderResult::Error(trace_data::ErrorResult {
            error: error.chars().take(160).collect(),
        }),
    }
}

fn expect_submit_input(expected: &Value, record: &str) -> Result<(), String> {
    if record.len() <= MAX_RECORD_BYTES {
        if expected.get("record").and_then(Value::as_str) != Some(record) {
            return Err("submit input differs from recorded request".into());
        }
    } else {
        if expected.get("oversizedBytes").and_then(Value::as_u64) != Some(record.len() as u64) {
            return Err("oversized submit length differs from recorded input".into());
        }
    }
    Ok(())
}

fn expect_u32(expected: &Value, field: &str, value: u32) -> Result<(), String> {
    if expected.get(field).and_then(Value::as_u64) == Some(value as u64) {
        Ok(())
    } else {
        Err(format!(
            "offload fact field {field} differs from the replay call"
        ))
    }
}

fn expect_u64(expected: &Value, field: &str, value: u64) -> Result<(), String> {
    if expected.get(field).and_then(Value::as_u64) == Some(value) {
        Ok(())
    } else {
        Err(format!(
            "offload fact field {field} differs from the replay call"
        ))
    }
}

fn valid_method(method: &str) -> bool {
    let bytes = method.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_METHOD_CHARS
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(*byte, b'.' | b'_' | b'-')
        })
}

fn encode_reply(id: u64, result: Result<String, String>) -> String {
    let value = match result {
        Ok(payload) if payload.chars().count() <= MAX_PAYLOAD_CHARS => {
            json!({"id": id, "payload": payload})
        }
        Ok(_) => json!({"id": id, "error": "Provider response exceeds payload budget"}),
        Err(error) => json!({"id": id, "error": error.chars().take(160).collect::<String>()}),
    };
    let record = value.to_string();
    if record.len() <= MAX_RECORD_BYTES {
        record
    } else {
        json!({"id": id, "error": "Provider response exceeds record budget"}).to_string()
    }
}

fn normalize_reply_result(result: Result<String, String>) -> Result<String, String> {
    match result {
        Ok(payload) if payload.chars().count() <= MAX_PAYLOAD_CHARS => Ok(payload),
        Ok(_) => Err("Provider response exceeds payload budget".to_owned()),
        Err(error) => Err(error.chars().take(160).collect()),
    }
}

fn pop_reply(state: &mut BrokerState) -> Option<ReplyValue> {
    while let Some(queued) = state.replies.pop_front() {
        if queued.session == state.session {
            return Some(ReplyValue {
                id: queued.id,
                result: queued.result,
            });
        }
    }
    None
}

fn encode_reply_value(reply: &ReplyValue) -> String {
    encode_reply(reply.id, reply.result.clone())
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
struct TraceReplyValue {
    id: u64,
    #[serde(default)]
    payload: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

fn reply_value_to_trace(reply: &ReplyValue) -> Value {
    match &reply.result {
        Ok(payload) => json!({"id": reply.id, "payload": payload}),
        Err(error) => json!({"id": reply.id, "error": error}),
    }
}

fn trace_to_reply_value(value: &Value) -> Result<ReplyValue, String> {
    let trace = serde_json::from_value::<TraceReplyValue>(value.clone())
        .map_err(|error| format!("typed offload reply trace is invalid: {error}"))?;
    match (trace.payload, trace.error) {
        (Some(payload), None) => Ok(ReplyValue {
            id: trace.id,
            result: Ok(payload),
        }),
        (None, Some(error)) => Ok(ReplyValue {
            id: trace.id,
            result: Err(error),
        }),
        _ => Err("typed offload reply trace must contain payload or error".into()),
    }
}

fn encode_take_value_outcome(outcome: &TakeValueOutcome) -> Value {
    if outcome.legacy {
        json!({
            "record": outcome.reply.as_ref().map(encode_reply_value),
        })
    } else {
        json!({
            "value": outcome.reply.as_ref().map(reply_value_to_trace),
        })
    }
}

fn expect_reply_value(expected: &Value, actual: Option<&ReplyValue>) -> Result<(), String> {
    if let Some(record) = expected.get("record") {
        let actual_record = actual.map(encode_reply_value);
        if record.as_str() != actual_record.as_deref() {
            return Err("typed offload reply differs from legacy trace".into());
        }
        return Ok(());
    }
    let expected_value = expected
        .get("value")
        .ok_or_else(|| "typed offload reply trace has no value".to_owned())?;
    let expected_reply = if expected_value.is_null() {
        None
    } else {
        Some(trace_to_reply_value(expected_value)?)
    };
    if expected_reply.as_ref() != actual {
        return Err("typed offload reply differs from trace".into());
    }
    Ok(())
}

fn reply_value_to_js<'js>(ctx: &Ctx<'js>, reply: &ReplyValue) -> rquickjs::Result<JsValue<'js>> {
    let object = Object::new(ctx.clone())?;
    object.set("id", reply.id)?;
    match &reply.result {
        Ok(payload) => object.set("payload", payload.clone())?,
        Err(error) => object.set("error", error.clone())?,
    }
    Ok(object.into_value())
}

fn notify_once(pending: &AtomicBool, notify: Option<Notify>) {
    let Some(notify) = notify else {
        return;
    };
    if pending
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        unsafe {
            notify();
        }
    }
}

fn work_queues_empty(state: &BrokerState) -> bool {
    state.request_queue.is_empty() && state.cancellations.is_empty() && state.replies.is_empty()
}

fn rearm_wake(pending: &AtomicBool) {
    pending.store(false, Ordering::Release);
}

fn deadline_loop(inner: Weak<BrokerInner>) {
    loop {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        if inner.closing.load(Ordering::Acquire) {
            return;
        }
        let mut state = inner.lock_state();
        loop {
            if state.closed || inner.closing.load(Ordering::Acquire) {
                return;
            }
            let nearest = state.pending.values().map(|pending| pending.deadline).min();
            let Some(deadline) = nearest else {
                if state.session == 0 {
                    return;
                }
                state = inner
                    .changed
                    .wait(state)
                    .unwrap_or_else(|poison| poison.into_inner());
                continue;
            };
            let now = Instant::now();
            if now < deadline {
                let (next, _) = inner
                    .changed
                    .wait_timeout(state, deadline - now)
                    .unwrap_or_else(|poison| poison.into_inner());
                state = next;
                continue;
            }
            let mut expired = state
                .pending
                .iter()
                .filter_map(|(key, pending)| {
                    (pending.deadline <= now).then_some((*key, pending.token))
                })
                .collect::<Vec<_>>();
            expired.sort_unstable_by_key(|((session, id), token)| (*session, *id, *token));
            drop(state);
            for ((session, id), token) in expired {
                inner.expire(session, id, token);
            }
            break;
        }
    }
}

fn replay_facts_loop(
    host: Weak<OffloadHost>,
    trace: Arc<WorkerTrace>,
    stable_session: String,
    stop: Arc<AtomicBool>,
) {
    while !stop.load(Ordering::Acquire) && trace.mode() == Mode::Replay {
        if let Err(error) = trace.wait_for_session(TraceActor::Offload, &stable_session, &stop) {
            if !stop.load(Ordering::Acquire) {
                trace.fail_replay(format!("offload replay facts: {error}"));
            }
            return;
        }
        if stop.load(Ordering::Acquire) || trace.mode() != Mode::Replay {
            return;
        }
        let event = match trace.peek_replay() {
            Ok(Some(event)) => event,
            Ok(None) => continue,
            Err(error) => {
                trace.fail_replay(format!("offload replay facts: {error}"));
                return;
            }
        };
        let Some(host) = host.upgrade() else {
            return;
        };
        let result = match event.kind.as_str() {
            "offload.provider.take" => {
                host.take_request();
                Ok(())
            }
            "offload.provider.cancel.take" => {
                host.take_cancellation();
                Ok(())
            }
            "offload.provider.complete" => replay_complete(&host, &event.data),
            "offload.timeout" => replay_timeout(&host, &event.data),
            "offload.session.set" => replay_set_session(&host, &event.data),
            kind => Err(format!("unsupported offload replay fact {kind}")),
        };
        if let Err(error) = result {
            trace.fail_replay(format!("offload replay fact {}: {error}", event.kind));
            return;
        }
    }
}

fn replay_complete(host: &OffloadHost, data: &Value) -> Result<(), String> {
    let fact: trace_data::ProviderCompleteFact =
        serde_json::from_value(data.clone()).map_err(|error| error.to_string())?;
    let accepted = host.complete(
        fact.generation,
        fact.provider_session,
        fact.id,
        fact.result.into_result(),
    );
    if accepted != fact.accepted {
        return Err("provider completion acceptance differs from trace".into());
    }
    Ok(())
}

fn replay_timeout(host: &OffloadHost, data: &Value) -> Result<(), String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Fact {
        #[serde(rename = "providerSession")]
        provider_session: u32,
        id: u64,
        token: u64,
        dispatched: bool,
        expired: bool,
    }
    let fact: Fact = serde_json::from_value(data.clone()).map_err(|error| error.to_string())?;
    let outcome = host
        .inner
        .expire(fact.provider_session, fact.id, fact.token)
        .ok_or_else(|| "timeout fact transition failed".to_owned())?;
    if outcome.expired != fact.expired || outcome.dispatched != fact.dispatched {
        return Err("timeout result differs from trace".into());
    }
    Ok(())
}

fn replay_set_session(host: &OffloadHost, data: &Value) -> Result<(), String> {
    let session = data
        .get("to")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "session.set fact has invalid target session".to_owned())?;
    host.set_session(session);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rquickjs::{Context, Runtime};
    use std::sync::atomic::AtomicUsize;

    static NOTIFICATION_COUNT: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "C" fn count_notification() {
        NOTIFICATION_COUNT.fetch_add(1, Ordering::Relaxed);
    }

    static REPLY_DRAIN_NOTIFICATION_COUNT: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "C" fn count_reply_drain_notification() {
        REPLY_DRAIN_NOTIFICATION_COUNT.fetch_add(1, Ordering::Relaxed);
    }

    fn test_host(generation: u32, session: u32, timeout: Duration) -> Arc<OffloadHost> {
        OffloadHost::new(
            generation,
            session,
            timeout,
            ["compute.sum".to_owned()],
            None,
        )
    }

    fn wait_for_reply(host: &OffloadHost, maximum_wait: Duration) -> bool {
        let state = host.inner.lock_state();
        let (state, waited) = host
            .inner
            .changed
            .wait_timeout_while(state, maximum_wait, |state| state.replies.is_empty())
            .unwrap_or_else(|poison| poison.into_inner());
        !state.replies.is_empty() && !waited.timed_out()
    }

    #[test]
    fn quickjs_tight_cancel_loop_keeps_all_broker_queues_bounded() {
        NOTIFICATION_COUNT.store(0, Ordering::Relaxed);
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let host = OffloadHost::new(
            4,
            17,
            Duration::from_secs(30),
            ["compute.sum".to_owned()],
            Some(count_notification),
        );
        let accepted = context
            .with(|ctx| {
                OffloadHost::install(ctx.clone(), Arc::clone(&host), None)?;
                ctx.eval::<(), _>(
                    r#"
              let accepted = 0;
              if (offload.submit(JSON.stringify({v:1,id:1,method:"compute.sum",payload:"[]"}))) {
                accepted++;
                for (let id = 2; id <= 50000; id++) {
                  const record = JSON.stringify({v:1,id,method:"compute.sum",payload:"[]"});
                  if (!offload.submit(record)) break;
                  if (!offload.cancel(id, 17)) throw new Error("native cancel was rejected");
                  accepted++;
                }
                if (!offload.cancel(1, 17)) throw new Error("native cancel was rejected");
              }
              globalThis.tightLoopAccepted = accepted;
            "#,
                )?;
                ctx.globals().get::<_, usize>("tightLoopAccepted")
            })
            .unwrap();
        assert_eq!(accepted, 50000);
        assert_eq!(
            NOTIFICATION_COUNT.load(Ordering::Relaxed),
            1,
            "50,000 synchronous submits while work remains queued must queue one host wake"
        );
        assert!(
            !host.inner.wake_pending.load(Ordering::Acquire),
            "cancelling the final queued request rearms wake_pending"
        );
        {
            let state = host.inner.lock_state();
            assert_eq!(state.pending.len(), 0);
            assert_eq!(
                state.request_queue.len(),
                0,
                "cancelled queued work must be removed synchronously"
            );
            assert_eq!(state.cancellations.len(), 0);
            assert!(state.replies.is_empty());
        }

        assert!(
            host.take_request().is_none(),
            "empty provider drain re-arms the wake gate"
        );
        assert!(host.submit_record(r#"{"v":1,"id":50001,"method":"compute.sum","payload":"[]"}"#,));
        assert_eq!(NOTIFICATION_COUNT.load(Ordering::Relaxed), 2);
        assert_eq!(host.take_request().unwrap().id, 50001);
        assert!(host.cancel(17, 50001));
        assert_eq!(NOTIFICATION_COUNT.load(Ordering::Relaxed), 3);
        assert_eq!(host.take_cancellation().unwrap().id, 50001);

        for id in 50002..(50002 + MAX_PENDING as u64) {
            let record = format!(r#"{{"v":1,"id":{id},"method":"compute.sum","payload":"[]"}} "#);
            assert!(host.submit_record(record.trim()));
            assert_eq!(host.take_request().unwrap().id, id);
            assert!(host.cancel(17, id));
        }
        let state = host.inner.lock_state();
        assert_eq!(state.cancellations.len(), MAX_PENDING);
        assert_eq!(state.pending.len(), 0);
        drop(state);
        let full_id = 50002 + MAX_PENDING as u64;
        let full_record =
            format!(r#"{{"v":1,"id":{full_id},"method":"compute.sum","payload":"[]"}} "#);
        assert!(
            !host.submit_record(full_record.trim()),
            "full cancellation capacity rejects admission"
        );
        for _ in 0..MAX_PENDING {
            assert!(host.take_cancellation().is_some());
        }
        assert!(host.take_cancellation().is_none());

        let (first, duplicate) = context.with(|ctx| {
            ctx.eval::<(), _>(r#"
              const replyRecord = JSON.stringify({v:1,id:50010,method:"missing.capability",payload:""});
              globalThis.firstReplyAccepted = offload.submit(replyRecord);
              globalThis.duplicateReplyAccepted = offload.submit(replyRecord);
            "#)?;
            Ok::<_, rquickjs::Error>((
                ctx.globals().get::<_, bool>("firstReplyAccepted")?,
                ctx.globals().get::<_, bool>("duplicateReplyAccepted")?,
            ))
        }).unwrap();
        assert!(first);
        assert!(!duplicate, "a pending reply ID cannot be reused");
        let reply: Value = serde_json::from_str(&host.take_reply().unwrap()).unwrap();
        assert_eq!(reply["id"], 50010);
        assert!(reply["error"]
            .as_str()
            .unwrap()
            .contains("does not implement"));
        assert!(host.take_reply().is_none());

        drop(context);
        host.shutdown();
    }

    #[test]
    fn quickjs_typed_offload_path_does_not_use_json_roundtrip() {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let host = test_host(41, 17, Duration::from_secs(30));

        let (accepted, rejected, fractional, escaped, empty) = context
            .with(|ctx| {
                OffloadHost::install(ctx.clone(), Arc::clone(&host), None)?;
                ctx.eval::<(), _>(
                    r#"
              JSON.stringify = function() { throw new Error("typed path called stringify"); };
              JSON.parse = function() { throw new Error("typed path called parse"); };
              globalThis.typedAccepted = offload.submitValue({
                v: 1, id: 1, method: "compute.sum", payload: "[2,3]"
              });
              globalThis.typedRejected = offload.submitValue({
                v: 1, id: 2, method: "compute.sum", payload: "[]", extra: true
              });
              globalThis.typedFractional = offload.submitValue({
                v: 1, id: 1.5, method: "compute.sum", payload: "[]"
              });
              const escapedPayload = '"'.repeat(1250) + String.fromCharCode(10).repeat(1250);
              globalThis.typedEscaped = offload.submitValue({
                v: 1, id: 2, method: "compute.sum", payload: escapedPayload
              });
              globalThis.typedEmpty = offload.takeValue() === undefined;
            "#,
                )?;
                Ok::<_, rquickjs::Error>((
                    ctx.globals().get::<_, bool>("typedAccepted")?,
                    ctx.globals().get::<_, bool>("typedRejected")?,
                    ctx.globals().get::<_, bool>("typedFractional")?,
                    ctx.globals().get::<_, bool>("typedEscaped")?,
                    ctx.globals().get::<_, bool>("typedEmpty")?,
                ))
            })
            .unwrap();
        assert!(accepted);
        assert!(!rejected, "unknown typed request fields must be rejected");
        assert!(!fractional, "typed request ids must be safe integers");
        assert!(escaped, "direct value sizing must not count JSON escapes");
        assert!(empty);

        let request = host.take_request().expect("typed request must be queued");
        assert_eq!(request.id, 1);
        assert_eq!(request.method, "compute.sum");
        assert_eq!(request.payload, "[2,3]");
        assert!(host.complete(41, 17, 1, Ok("5".to_owned())));
        let escaped_request = host.take_request().expect("escaped request must be queued");
        assert_eq!(escaped_request.id, 2);
        assert_eq!(escaped_request.payload.chars().count(), MAX_PAYLOAD_CHARS);
        assert_eq!(escaped_request.payload.chars().next(), Some('"'));
        assert_eq!(escaped_request.payload.chars().nth(1250), Some('\n'));
        assert!(host.complete(41, 17, 2, Ok("escaped".to_owned())));

        let (reply_id, payload, has_error, escaped_reply_id, escaped_payload, drained) = context
            .with(|ctx| {
                ctx.eval::<(), _>(
                    r#"
              const reply = offload.takeValue();
              const escapedReply = offload.takeValue();
              globalThis.typedReplyId = reply.id;
              globalThis.typedReplyPayload = reply.payload;
              globalThis.typedReplyHasError = Object.prototype.hasOwnProperty.call(reply, "error");
              globalThis.typedEscapedReplyId = escapedReply.id;
              globalThis.typedEscapedReplyPayload = escapedReply.payload;
              globalThis.typedReplyDrained = offload.takeValue() === undefined;
            "#,
                )?;
                Ok::<_, rquickjs::Error>((
                    ctx.globals().get::<_, u64>("typedReplyId")?,
                    ctx.globals().get::<_, String>("typedReplyPayload")?,
                    ctx.globals().get::<_, bool>("typedReplyHasError")?,
                    ctx.globals().get::<_, u64>("typedEscapedReplyId")?,
                    ctx.globals().get::<_, String>("typedEscapedReplyPayload")?,
                    ctx.globals().get::<_, bool>("typedReplyDrained")?,
                ))
            })
            .unwrap();
        assert_eq!(reply_id, 1);
        assert_eq!(payload, "5");
        assert!(!has_error);
        assert_eq!(escaped_reply_id, 2);
        assert_eq!(escaped_payload, "escaped");
        assert!(drained);
        host.shutdown();
    }

    #[test]
    fn typed_offload_replays_legacy_record_trace_shapes() {
        let request = RequestValue {
            v: 1,
            id: 1,
            method: "compute.sum".to_owned(),
            payload: "[2,3]".to_owned(),
        };
        let record = r#"{"v":1,"id":1,"method":"compute.sum","payload":"[2,3]"}"#;
        let expected = json!({
            "accepted": true,
            "record": record,
            "oversizedBytes": null,
            "token": 1,
        });
        assert_eq!(
            expect_submit_value(&expected, &request).unwrap(),
            (true, Some(record.to_owned()), None, false)
        );

        let reply = ReplyValue {
            id: 1,
            result: Ok("5".to_owned()),
        };
        let expected_reply = json!({
            "record": encode_reply_value(&reply),
        });
        expect_reply_value(&expected_reply, Some(&reply)).unwrap();

        // An old JSON trace may reject a request whose escaped record is over
        // budget even though the direct object itself is within the new B1
        // envelope budget. Preserve that recorded admission result too.
        let oversized_request = RequestValue {
            payload: "\"".repeat(MAX_PAYLOAD_CHARS),
            ..request
        };
        let oversized_bytes = legacy_json_record_bytes(&oversized_request);
        assert!(oversized_bytes > MAX_RECORD_BYTES);
        let oversized = json!({
            "accepted": false,
            "record": null,
            "oversizedBytes": oversized_bytes,
            "token": null,
        });
        assert_eq!(
            expect_submit_value(&oversized, &oversized_request).unwrap(),
            (true, None, Some(oversized_bytes), true)
        );
    }

    #[test]
    fn reply_drain_rearms_wake_for_later_submit_and_cancel() {
        REPLY_DRAIN_NOTIFICATION_COUNT.store(0, Ordering::Relaxed);
        let host = OffloadHost::new(
            9,
            17,
            Duration::from_secs(30),
            ["compute.sum".to_owned()],
            Some(count_reply_drain_notification),
        );

        // A completion leaves a reply as the only queued work. Draining that
        // final reply must reopen the level-triggered callback gate.
        assert!(host.submit_record(r#"{"v":1,"id":1,"method":"compute.sum","payload":"[]"}"#));
        assert_eq!(host.take_request().unwrap().id, 1);
        assert!(host.complete(9, 17, 1, Ok("one".to_owned())));
        assert!(host.take_reply().is_some());
        assert!(host.submit_record(r#"{"v":1,"id":2,"method":"compute.sum","payload":"[]"}"#));
        assert_eq!(REPLY_DRAIN_NOTIFICATION_COUNT.load(Ordering::Relaxed), 3);
        assert_eq!(host.take_request().unwrap().id, 2);

        // A dispatched cancellation still occupies its own queue. Draining it
        // must also rearm the gate before another request is admitted.
        assert!(host.cancel(17, 2));
        assert_eq!(host.take_cancellation().unwrap().id, 2);
        assert!(host.submit_record(r#"{"v":1,"id":3,"method":"compute.sum","payload":"[]"}"#));
        assert_eq!(REPLY_DRAIN_NOTIFICATION_COUNT.load(Ordering::Relaxed), 5);
        assert_eq!(host.take_request().unwrap().id, 3);

        // With multiple replies, only the final dequeue rearms the callback.
        assert!(host.submit_record(r#"{"v":1,"id":4,"method":"compute.sum","payload":"[]"}"#));
        assert_eq!(host.take_request().unwrap().id, 4);
        assert!(host.complete(9, 17, 3, Ok("three".to_owned())));
        assert!(host.complete(9, 17, 4, Ok("four".to_owned())));
        assert!(host.take_reply().is_some());
        assert!(host.take_reply().is_some());
        assert!(host.submit_record(r#"{"v":1,"id":5,"method":"compute.sum","payload":"[]"}"#));
        assert_eq!(REPLY_DRAIN_NOTIFICATION_COUNT.load(Ordering::Relaxed), 8);

        host.shutdown();

        // A session switch normally removes stale replies before this API is
        // reached. Exercise the defensive stale-reply drain directly as well:
        // it must reopen the gate when the stale queue entry is the last work.
        REPLY_DRAIN_NOTIFICATION_COUNT.store(0, Ordering::Relaxed);
        let stale_host = OffloadHost::new(
            9,
            17,
            Duration::from_secs(30),
            ["compute.sum".to_owned()],
            Some(count_reply_drain_notification),
        );
        stale_host.inner.wake_pending.store(true, Ordering::Release);
        stale_host.inner.lock_state().replies.push_back(Reply {
            session: 99,
            id: 1,
            result: Err("stale".to_owned()),
        });
        assert!(stale_host.take_reply().is_none());
        assert!(stale_host.submit_record(r#"{"v":1,"id":1,"method":"compute.sum","payload":"[]"}"#));
        assert_eq!(REPLY_DRAIN_NOTIFICATION_COUNT.load(Ordering::Relaxed), 1);
        assert!(stale_host.cancel(17, 1));
        assert!(
            !stale_host.inner.wake_pending.load(Ordering::Acquire),
            "cancelling the last undispatched work item rearms wake_pending"
        );
        assert!(stale_host.submit_record(r#"{"v":1,"id":2,"method":"compute.sum","payload":"[]"}"#));
        assert_eq!(REPLY_DRAIN_NOTIFICATION_COUNT.load(Ordering::Relaxed), 2);
        stale_host.set_session(18);
        assert!(
            !stale_host.inner.wake_pending.load(Ordering::Acquire),
            "set_session rearms wake_pending when emptying the last queued work item"
        );
        assert!(stale_host.submit_record(r#"{"v":1,"id":1,"method":"compute.sum","payload":"[]"}"#));
        assert_eq!(REPLY_DRAIN_NOTIFICATION_COUNT.load(Ordering::Relaxed), 3);
        stale_host.shutdown();
    }

    #[test]
    fn deadline_queues_provider_cancel_and_error_reply_without_polling() {
        let host = test_host(8, 23, Duration::from_millis(100));
        assert!(host.submit_record(r#"{"v":1,"id":1,"method":"compute.sum","payload":"[1,2,3]"}"#,));
        let request = host
            .take_request()
            .expect("provider request must be dispatched");
        assert_eq!(request.timeout, Duration::from_millis(100));

        assert!(wait_for_reply(&host, Duration::from_secs(5)));
        assert!(host.has_replies());
        let reply: Value = serde_json::from_str(&host.take_reply().unwrap()).unwrap();
        assert_eq!(reply["id"], 1);
        assert_eq!(reply["error"], "Provider request timed out");
        assert!(!host.has_replies());
        let cancellation = host
            .take_cancellation()
            .expect("timed-out provider work must be cancelled");
        assert_eq!(cancellation.generation, request.generation);
        assert_eq!(cancellation.session, request.session);
        assert_eq!(cancellation.id, request.id);
        assert!(!host.complete(8, 23, 1, Ok("late".to_owned())));
        host.shutdown();
    }

    #[test]
    fn quickjs_offload_record_replays_without_a_provider() {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let record_lane = WorkerTrace::new(Mode::Record);
        record_lane.begin_batch(&[]).unwrap();
        let record_host = OffloadHost::new_traced(
            51,
            7,
            Duration::from_secs(5),
            ["compute.sum".to_owned()],
            None,
            Arc::clone(&record_lane),
            "offload:51".to_owned(),
        );
        context.with(|ctx| {
            OffloadHost::install(ctx.clone(), Arc::clone(&record_host), None)?;
            ctx.eval::<(), _>(r#"
              globalThis.recordedSession = offload.session();
              globalThis.recordedAccepted = offload.submit(JSON.stringify({v:1,id:1,method:"compute.sum",payload:"[2,3]"}));
            "#)
        }).unwrap();
        assert_eq!(record_host.take_request().unwrap().id, 1);
        assert!(record_host.complete(51, 7, 1, Ok("5".to_owned())));
        assert!(record_host.has_replies());
        let recorded_reply = context
            .with(|ctx| ctx.eval::<String, _>("offload.take()"))
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&recorded_reply).unwrap()["payload"],
            "5"
        );
        record_host.shutdown();
        let recorded = record_lane.finish_batch().unwrap();
        drop(record_host);
        drop(context);
        assert_eq!(
            recorded
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec![
                "offload.session.read",
                "offload.submit",
                "offload.provider.take",
                "offload.provider.complete",
                "offload.reply.take",
                "offload.shutdown",
            ]
        );

        let replay_lane = WorkerTrace::new(Mode::Replay);
        replay_lane.begin_batch(&recorded).unwrap();
        let context = Context::full(&runtime).unwrap();
        let replay_host = OffloadHost::new_traced(
            51,
            7,
            Duration::from_secs(5),
            ["compute.sum".to_owned()],
            None,
            Arc::clone(&replay_lane),
            "offload:51".to_owned(),
        );
        assert!(replay_host.deadline_thread.lock().unwrap().is_none());
        assert!(replay_host.inner.notify.is_none());
        assert!(replay_host.replay_thread.lock().unwrap().is_some());
        context.with(|ctx| {
            OffloadHost::install(ctx.clone(), Arc::clone(&replay_host), None)?;
            ctx.eval::<(), _>(r#"
              globalThis.replayedSession = offload.session();
              globalThis.replayedAccepted = offload.submit(JSON.stringify({v:1,id:1,method:"compute.sum",payload:"[2,3]"}));
            "#)
        }).unwrap();
        let replayed_reply = context
            .with(|ctx| ctx.eval::<String, _>("offload.take()"))
            .unwrap();
        assert_eq!(replayed_reply, recorded_reply);
        replay_host.shutdown();
        assert_eq!(replay_lane.finish_batch().unwrap(), recorded);
    }

    #[test]
    fn quickjs_typed_offload_trace_stays_structured_and_replays() {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let record_lane = WorkerTrace::new(Mode::Record);
        record_lane.begin_batch(&[]).unwrap();
        let record_host = OffloadHost::new_traced(
            52,
            7,
            Duration::from_secs(5),
            ["compute.sum".to_owned()],
            None,
            Arc::clone(&record_lane),
            "offload:52".to_owned(),
        );
        context
            .with(|ctx| {
                OffloadHost::install(ctx.clone(), Arc::clone(&record_host), None)?;
                ctx.eval::<(), _>(
                    r#"
              JSON.stringify = function() { throw new Error("typed path called stringify"); };
              JSON.parse = function() { throw new Error("typed path called parse"); };
              globalThis.typedAccepted = offload.submitValue({
                v: 1, id: 1, method: "compute.sum", payload: "[2,3]"
              });
            "#,
                )
            })
            .unwrap();
        assert!(context
            .with(|ctx| ctx.globals().get::<_, bool>("typedAccepted"))
            .unwrap());
        assert_eq!(record_host.take_request().unwrap().id, 1);
        assert!(record_host.complete(52, 7, 1, Ok("5".to_owned())));
        let recorded_reply = context
            .with(|ctx| {
                ctx.eval::<(), _>(
                    r#"
              const reply = offload.takeValue();
              globalThis.typedReplyId = reply.id;
              globalThis.typedReplyPayload = reply.payload;
            "#,
                )?;
                Ok::<_, rquickjs::Error>((
                    ctx.globals().get::<_, u64>("typedReplyId")?,
                    ctx.globals().get::<_, String>("typedReplyPayload")?,
                ))
            })
            .unwrap();
        assert_eq!(recorded_reply, (1, "5".to_owned()));
        record_host.shutdown();
        let recorded = record_lane.finish_batch().unwrap();
        drop(record_host);
        drop(context);

        let submit_event = recorded
            .iter()
            .find(|event| event.kind == "offload.submit")
            .expect("typed submit must be traced");
        assert!(submit_event.data.get("record").is_none());
        assert_eq!(submit_event.data["request"]["method"], "compute.sum");
        let reply_event = recorded
            .iter()
            .find(|event| event.kind == "offload.reply.take")
            .expect("typed reply must be traced");
        assert!(reply_event.data.get("record").is_none());
        assert_eq!(reply_event.data["value"]["payload"], "5");

        let replay_lane = WorkerTrace::new(Mode::Replay);
        replay_lane.begin_batch(&recorded).unwrap();
        let context = Context::full(&runtime).unwrap();
        let replay_host = OffloadHost::new_traced(
            52,
            7,
            Duration::from_secs(5),
            ["compute.sum".to_owned()],
            None,
            Arc::clone(&replay_lane),
            "offload:52".to_owned(),
        );
        context
            .with(|ctx| {
                OffloadHost::install(ctx.clone(), Arc::clone(&replay_host), None)?;
                ctx.eval::<(), _>(
                    r#"
              JSON.stringify = function() { throw new Error("typed path called stringify"); };
              JSON.parse = function() { throw new Error("typed path called parse"); };
              globalThis.typedAccepted = offload.submitValue({
                v: 1, id: 1, method: "compute.sum", payload: "[2,3]"
              });
            "#,
                )
            })
            .unwrap();
        assert!(context
            .with(|ctx| ctx.globals().get::<_, bool>("typedAccepted"))
            .unwrap());
        let replayed_reply = context
            .with(|ctx| {
                ctx.eval::<(), _>(
                    r#"
              const reply = offload.takeValue();
              globalThis.typedReplyId = reply.id;
              globalThis.typedReplyPayload = reply.payload;
            "#,
                )?;
                Ok::<_, rquickjs::Error>((
                    ctx.globals().get::<_, u64>("typedReplyId")?,
                    ctx.globals().get::<_, String>("typedReplyPayload")?,
                ))
            })
            .unwrap();
        assert_eq!(replayed_reply, recorded_reply);
        replay_host.shutdown();
        assert_eq!(replay_lane.finish_batch().unwrap(), recorded);
    }

    #[test]
    fn timeout_cancel_and_late_completion_replay_as_facts() {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let record_lane = WorkerTrace::new(Mode::Record);
        record_lane.begin_batch(&[]).unwrap();
        let record_host = OffloadHost::new_traced(
            62,
            17,
            Duration::from_secs(1),
            ["compute.sum".to_owned()],
            None,
            Arc::clone(&record_lane),
            "offload:62".to_owned(),
        );
        context
            .with(|ctx| {
                OffloadHost::install(ctx.clone(), Arc::clone(&record_host), None)?;
                ctx.eval::<(), _>(
                    "offload.submit(JSON.stringify({v:1,id:1,method:'compute.sum',payload:'[]'}))",
                )
            })
            .unwrap();
        assert_eq!(record_host.take_request().unwrap().id, 1);
        // Wait for the real deadline thread's condition-variable notification.
        assert!(wait_for_reply(&record_host, Duration::from_secs(5)));
        assert_eq!(record_host.take_cancellation().unwrap().id, 1);
        assert!(record_host.has_replies());
        let reply = context
            .with(|ctx| ctx.eval::<String, _>("offload.take()"))
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&reply).unwrap()["error"],
            "Provider request timed out"
        );
        assert!(!record_host.complete(62, 17, 1, Ok("late provider result".to_owned())));
        record_host.set_session(18);
        assert_eq!(
            context
                .with(|ctx| ctx.eval::<u32, _>("offload.session()"))
                .unwrap(),
            18
        );
        record_host.shutdown();
        let recorded = record_lane.finish_batch().unwrap();
        drop(record_host);
        drop(context);

        let replay_lane = WorkerTrace::new(Mode::Replay);
        replay_lane.begin_batch(&recorded).unwrap();
        let context = Context::full(&runtime).unwrap();
        let replay_host = OffloadHost::new_traced(
            62,
            17,
            Duration::from_secs(1),
            ["compute.sum".to_owned()],
            None,
            Arc::clone(&replay_lane),
            "offload:62".to_owned(),
        );
        assert!(replay_host.deadline_thread.lock().unwrap().is_none());
        assert!(replay_host.inner.notify.is_none());
        assert!(replay_host.replay_thread.lock().unwrap().is_some());
        context
            .with(|ctx| {
                OffloadHost::install(ctx.clone(), Arc::clone(&replay_host), None)?;
                ctx.eval::<(), _>(
                    "offload.submit(JSON.stringify({v:1,id:1,method:'compute.sum',payload:'[]'}))",
                )
            })
            .unwrap();
        let replayed_reply = context
            .with(|ctx| ctx.eval::<String, _>("offload.take()"))
            .unwrap();
        assert_eq!(replayed_reply, reply);
        assert_eq!(
            context
                .with(|ctx| ctx.eval::<u32, _>("offload.session()"))
                .unwrap(),
            18
        );
        replay_host.shutdown();
        assert_eq!(replay_lane.finish_batch().unwrap(), recorded);
    }

    #[test]
    fn callback_reply_probe_outside_batch_does_not_create_host_trace_event() {
        let record_lane = WorkerTrace::new(Mode::Record);
        let record_host = OffloadHost::new_traced(
            64,
            17,
            Duration::from_secs(5),
            ["compute.sum".to_owned()],
            None,
            Arc::clone(&record_lane),
            "offload:64".to_owned(),
        );

        record_lane.begin_batch(&[]).unwrap();
        let first_batch = record_lane.finish_batch().unwrap();
        assert!(!record_host.has_replies()); // native notify listener, outside the archive transaction
        record_lane.begin_batch(&[]).unwrap();
        let following_batch = record_lane.finish_batch().unwrap();
        assert!(first_batch.is_empty());
        assert!(following_batch.is_empty());
        record_lane.set_live();
        record_host.set_trace_live();
        record_host.shutdown();

        let replay_lane = WorkerTrace::new(Mode::Replay);
        replay_lane.begin_batch(&first_batch).unwrap();
        let replay_host = OffloadHost::new_traced(
            64,
            17,
            Duration::from_secs(5),
            ["compute.sum".to_owned()],
            None,
            Arc::clone(&replay_lane),
            "offload:64".to_owned(),
        );
        assert!(replay_lane.finish_batch().unwrap().is_empty());
        replay_lane.begin_batch(&following_batch).unwrap();
        // There is no replay listener to repeat the callback-side probe.
        assert!(replay_lane.finish_batch().unwrap().is_empty());
        replay_lane.set_live();
        replay_host.set_trace_live();
        assert!(replay_host.replay_thread.lock().unwrap().is_none());
        replay_host.shutdown();
    }

    #[test]
    fn provider_session_switch_cancels_and_replays_stale_completion() {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let record_lane = WorkerTrace::new(Mode::Record);
        record_lane.begin_batch(&[]).unwrap();
        let record_host = OffloadHost::new_traced(
            63,
            17,
            Duration::from_secs(5),
            ["compute.sum".to_owned()],
            None,
            Arc::clone(&record_lane),
            "offload:63".to_owned(),
        );
        context
            .with(|ctx| {
                OffloadHost::install(ctx.clone(), Arc::clone(&record_host), None)?;
                ctx.eval::<(), _>(
                    "offload.submit(JSON.stringify({v:1,id:1,method:'compute.sum',payload:'[]'}))",
                )
            })
            .unwrap();
        assert_eq!(record_host.take_request().unwrap().session, 17);
        assert!(context
            .with(|ctx| ctx.eval::<bool, _>("offload.cancel(1, 17)"))
            .unwrap());
        assert_eq!(record_host.take_cancellation().unwrap().id, 1);
        context
            .with(|ctx| {
                ctx.eval::<(), _>(
                    "offload.submit(JSON.stringify({v:1,id:2,method:'compute.sum',payload:'[]'}))",
                )
            })
            .unwrap();
        assert_eq!(record_host.take_request().unwrap().id, 2);
        record_host.set_session(18);
        assert_eq!(record_host.take_cancellation().unwrap().id, 2);
        assert!(!record_host.complete(63, 17, 2, Err("late after session switch".to_owned())));
        assert_eq!(
            context
                .with(|ctx| ctx.eval::<u32, _>("offload.session()"))
                .unwrap(),
            18
        );
        record_host.shutdown();
        let recorded = record_lane.finish_batch().unwrap();
        drop(record_host);
        drop(context);

        let replay_lane = WorkerTrace::new(Mode::Replay);
        replay_lane.begin_batch(&recorded).unwrap();
        let context = Context::full(&runtime).unwrap();
        let replay_host = OffloadHost::new_traced(
            63,
            17,
            Duration::from_secs(5),
            ["compute.sum".to_owned()],
            None,
            Arc::clone(&replay_lane),
            "offload:63".to_owned(),
        );
        assert!(replay_host.deadline_thread.lock().unwrap().is_none());
        assert!(replay_host.inner.notify.is_none());
        context
            .with(|ctx| {
                OffloadHost::install(ctx.clone(), Arc::clone(&replay_host), None)?;
                ctx.eval::<(), _>(
                    "offload.submit(JSON.stringify({v:1,id:1,method:'compute.sum',payload:'[]'}))",
                )
            })
            .unwrap();
        assert!(context
            .with(|ctx| ctx.eval::<bool, _>("offload.cancel(1, 17)"))
            .unwrap());
        context
            .with(|ctx| {
                ctx.eval::<(), _>(
                    "offload.submit(JSON.stringify({v:1,id:2,method:'compute.sum',payload:'[]'}))",
                )
            })
            .unwrap();
        assert_eq!(replay_host.session(), 18);
        replay_host.shutdown();
        assert_eq!(replay_lane.finish_batch().unwrap(), recorded);
    }
}
