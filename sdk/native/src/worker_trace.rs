//! Bounded Worker lane for the existing trace-clock transaction envelope.
//!
//! The UI recorder owns the envelope and calls `begin_batch` / `finish_batch`
//! at the existing FFI transaction boundary. Worker code shares this lane;
//! it does not create an independent tape or archive format.

use crate::replay::Mode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub(crate) const MAX_WORKER_EVENTS: usize = 8192;
pub(crate) const MAX_WORKER_TRACE_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_WORKER_EVENT_BYTES: usize = 16 * 1024;
const WAIT_TIMEOUT: Duration = Duration::from_secs(30);
const CUT_WAIT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkerTraceEvent {
    pub seq: u64,
    pub session: String,
    pub kind: String,
    pub data: Value,
}

/// Producer identity is derived from the C boundary, not serialized. It lets
/// replay park one execution domain until the next recorded domain can run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TraceActor {
    Host,
    Ui,
    Worker,
    Io,
    Offload,
}

impl TraceActor {
    pub(crate) fn for_event(mode: Mode, event: &WorkerTraceEvent) -> Self {
        match event.kind.as_str() {
            "offload.session.read" | "offload.submit" | "offload.cancel" | "offload.reply.take" => {
                return Self::Ui
            }
            "offload.shutdown" => return Self::Host,
            "offload.provider.take"
            | "offload.provider.cancel.take"
            | "offload.provider.complete"
            | "offload.timeout"
            | "offload.session.set" => return Self::Offload,
            _ => {}
        }
        match event.kind.as_str() {
            "bootstrap" | "scheduler.pause" | "scheduler.resume" | "scheduler.stop" => Self::Host,
            "channel.latch" => Self::Ui,
            "channel.publish" => {
                if event.data.get("direction").and_then(Value::as_str) == Some("ui-to-worker") {
                    Self::Ui
                } else {
                    Self::Worker
                }
            }
            "io.fact" if mode == Mode::Record => Self::Io,
            // Replay has no HTTP task. The official Worker owner injects the
            // recorded IO completion at its recorded turn boundary.
            "io.fact" => Self::Worker,
            _ => Self::Worker,
        }
    }
}

struct TraceState {
    next_seq: u64,
    total_events: usize,
    total_bytes: usize,
    batch_open: bool,
    batch_events: Vec<WorkerTraceEvent>,
    consumed_events: Vec<WorkerTraceEvent>,
    pending_events: Vec<WorkerTraceEvent>,
    replay_events: VecDeque<WorkerTraceEvent>,
    incomplete: Option<String>,
    failure: Option<String>,
    stopped_sessions: HashSet<String>,
    stopped_turn_begins: HashSet<String>,
    active_turns: HashSet<String>,
}

/// Shared native lane used by the official worker runner and UI channel
/// bridge. A live-mode check is atomic and never evaluates the event builder,
/// so ordinary runs do not copy channel or IO payloads.
pub(crate) struct WorkerTrace {
    mode: AtomicU8,
    state: Mutex<TraceState>,
    changed: Condvar,
}

fn update_active_turn(state: &mut TraceState, actor: TraceActor, event: &WorkerTraceEvent) {
    if actor != TraceActor::Worker {
        return;
    }
    match event.kind.as_str() {
        "turn.begin" => {
            state.active_turns.insert(event.session.clone());
        }
        "turn.end" | "worker.exit" => {
            state.active_turns.remove(&event.session);
        }
        _ => {}
    }
}

fn worker_turn_event(kind: &str) -> bool {
    matches!(
        kind,
        "turn.facts"
            | "turn.end"
            | "clock.scalar"
            | "channel.publish"
            | "timer.set"
            | "io.open"
            | "io.submit"
            | "io.cancel"
            | "io.close"
            | "io.write"
            | "channel.declare"
    )
}

fn stopped_event_allowed(state: &TraceState, actor: TraceActor, session: &str, kind: &str) -> bool {
    matches!(
        kind,
        "scheduler.stop" | "worker.exit" | "io.close" | "io.fact"
    ) || (actor == TraceActor::Worker
        && kind == "turn.begin"
        && state.stopped_turn_begins.contains(session))
        || (actor == TraceActor::Worker
            && state.active_turns.contains(session)
            && worker_turn_event(kind))
}

impl WorkerTrace {
    pub(crate) fn new(mode: Mode) -> Arc<Self> {
        Arc::new(Self {
            mode: AtomicU8::new(mode as u8),
            state: Mutex::new(TraceState {
                next_seq: 0,
                total_events: 0,
                total_bytes: 0,
                batch_open: false,
                batch_events: Vec::new(),
                consumed_events: Vec::new(),
                pending_events: Vec::new(),
                replay_events: VecDeque::new(),
                incomplete: None,
                failure: None,
                stopped_sessions: HashSet::new(),
                stopped_turn_begins: HashSet::new(),
                active_turns: HashSet::new(),
            }),
            changed: Condvar::new(),
        })
    }

    pub(crate) fn mode(&self) -> Mode {
        match self.mode.load(Ordering::Acquire) {
            1 => Mode::Record,
            2 => Mode::Replay,
            _ => Mode::Live,
        }
    }

    /// Stop accumulating Worker payloads and release every waiter. This is
    /// intentionally safe after guest load so trace-clock mode 0 can stop a
    /// recording without replacing the Arc held by WorkerRuntime.
    pub(crate) fn set_live(&self) {
        self.mode.store(Mode::Live as u8, Ordering::Release);
        let mut state = self.lock();
        state.batch_open = false;
        state.batch_events.clear();
        state.consumed_events.clear();
        state.pending_events.clear();
        state.replay_events.clear();
        state.failure = None;
        state.stopped_sessions.clear();
        state.stopped_turn_begins.clear();
        state.total_events = 0;
        state.total_bytes = 0;
        state.next_seq = 0;
        state.active_turns.clear();
        self.changed.notify_all();
    }

    /// Open one existing host transaction. Replay input is scoped to this
    /// envelope; an event from a later envelope is never consumed early.
    pub(crate) fn begin_batch(&self, replay_events: &[WorkerTraceEvent]) -> Result<(), String> {
        let mode = self.mode();
        let mut state = self.lock();
        Self::check_failure(&state)?;
        if state.batch_open {
            return Err("worker trace batch is already open".into());
        }
        match mode {
            Mode::Live => {
                state.batch_events.clear();
                state.consumed_events.clear();
                state.replay_events.clear();
            }
            Mode::Record => {
                state.batch_events = std::mem::take(&mut state.pending_events);
                state.consumed_events.clear();
            }
            Mode::Replay => {
                if !state.replay_events.is_empty() {
                    return Err("previous worker trace batch has unconsumed events".into());
                }
                let mut expected = state.next_seq;
                let mut batch_bytes = 0usize;
                for event in replay_events {
                    validate_event(event)?;
                    batch_bytes = batch_bytes
                        .checked_add(serialized_event_len(event)?)
                        .ok_or_else(|| "worker trace batch byte count overflow".to_owned())?;
                    if event.seq != expected {
                        return Err(format!(
                            "worker trace sequence expected {expected}, got {}",
                            event.seq
                        ));
                    }
                    expected = expected
                        .checked_add(1)
                        .ok_or_else(|| "worker trace sequence overflow".to_owned())?;
                }
                let new_count = state
                    .total_events
                    .checked_add(replay_events.len())
                    .ok_or_else(|| "worker trace event count overflow".to_owned())?;
                let new_bytes = state
                    .total_bytes
                    .checked_add(batch_bytes)
                    .ok_or_else(|| "worker trace byte count overflow".to_owned())?;
                if new_count > MAX_WORKER_EVENTS || new_bytes > MAX_WORKER_TRACE_BYTES {
                    return Err("worker replay lane exceeds its configured limits".into());
                }
                state.total_events = new_count;
                state.total_bytes = new_bytes;
                state.consumed_events.clear();
                state.replay_events = replay_events.iter().cloned().collect();
            }
        }
        state.batch_open = true;
        self.changed.notify_all();
        Ok(())
    }

    /// Record one event, or consume and return the matching replay input.
    /// `build` is not called in Live mode. In Replay mode it is only used to
    /// check command/admission events; pure input events should use `take`.
    pub(crate) fn observe<F>(
        &self,
        actor: TraceActor,
        session: &str,
        kind: &str,
        build: F,
    ) -> Result<Value, String>
    where
        F: FnOnce() -> Value,
    {
        self.observe_gated(actor, session, kind, &[], build)
    }

    /// Observe an event while holding a gate that prevents selected event
    /// producers from reaching their trace boundary. Replay can wait for
    /// unblocked actors but fails immediately if the next event needs the
    /// held gate.
    pub(crate) fn observe_gated<F>(
        &self,
        actor: TraceActor,
        session: &str,
        kind: &str,
        blocked_kinds: &[&str],
        build: F,
    ) -> Result<Value, String>
    where
        F: FnOnce() -> Value,
    {
        let mode = self.mode();
        if mode == Mode::Live {
            return Ok(Value::Null);
        }
        match mode {
            Mode::Live => Ok(Value::Null),
            Mode::Record => {
                let mut state = self.lock();
                if self.mode() != Mode::Record || state.incomplete.is_some() {
                    return Ok(Value::Null);
                }
                let data = build();
                let event = WorkerTraceEvent {
                    seq: state.next_seq,
                    session: session.to_owned(),
                    kind: kind.to_owned(),
                    data,
                };
                if let Err(reason) = reserve_event(&mut state, &event) {
                    state.incomplete.get_or_insert(reason);
                    self.changed.notify_all();
                    return Ok(Value::Null);
                }
                let Some(next_seq) = state.next_seq.checked_add(1) else {
                    state
                        .incomplete
                        .get_or_insert("worker trace sequence overflow".into());
                    return Ok(Value::Null);
                };
                state.next_seq = next_seq;
                if actor == TraceActor::Host && kind == "scheduler.stop" {
                    state.stopped_sessions.insert(session.to_owned());
                }
                update_active_turn(&mut state, actor, &event);
                if state.batch_open {
                    state.batch_events.push(event.clone());
                } else {
                    state.pending_events.push(event.clone());
                }
                self.changed.notify_all();
                Ok(event.data)
            }
            Mode::Replay => {
                let actual = build();
                self.consume_matching(actor, session, kind, Some(actual), blocked_kinds)
            }
        }
    }

    /// Consume one replay input without constructing or comparing a live
    /// payload. In record/live mode this returns `None`.
    pub(crate) fn take(
        &self,
        actor: TraceActor,
        session: &str,
        kind: &str,
    ) -> Result<Option<Value>, String> {
        match self.mode() {
            Mode::Live | Mode::Record => Ok(None),
            Mode::Replay => self
                .consume_matching(actor, session, kind, None, &[])
                .map(Some),
        }
    }

    /// Observe a core fact while the official C core lock is held. This path
    /// never waits for another actor, because that actor may need the same
    /// core lock to reach its own boundary.
    pub(crate) fn observe_now<F>(
        &self,
        actor: TraceActor,
        session: &str,
        kind: &str,
        build: F,
    ) -> Result<Value, String>
    where
        F: FnOnce() -> Value,
    {
        match self.mode() {
            Mode::Live => Ok(Value::Null),
            Mode::Record => self.observe(actor, session, kind, build),
            Mode::Replay => {
                let actual = build();
                let mut state = self.lock();
                Self::check_failure(&state)?;
                if !state.batch_open {
                    return Err(format!(
                        "worker replay {kind} arrived outside an open trace batch"
                    ));
                }
                let Some(expected) = state.replay_events.front().cloned() else {
                    return Err(format!(
                        "worker replay is missing event {kind} for {session}"
                    ));
                };
                if TraceActor::for_event(Mode::Replay, &expected) != actor
                    || expected.session != session
                    || expected.kind != kind
                    || expected.data != actual
                {
                    let message = format!(
                        "worker replay event {} expected {}/{}, got {session}/{kind}",
                        expected.seq, expected.session, expected.kind
                    );
                    state.failure = Some(message.clone());
                    self.changed.notify_all();
                    return Err(message);
                }
                state.replay_events.pop_front();
                state.next_seq = expected.seq.saturating_add(1);
                update_active_turn(&mut state, actor, &expected);
                state.consumed_events.push(expected.clone());
                self.changed.notify_all();
                Ok(expected.data)
            }
        }
    }

    /// Serialize one stateful actor transition with the shared lane sequence.
    /// The closure runs only after this actor owns the next replay event and
    /// receives that event's data as input. Use this when applying an expected
    /// provider fact also mutates a broker queue; callers must not hold their
    /// broker lock while waiting for this method.
    pub(crate) fn transition<T, F, E>(
        &self,
        actor: TraceActor,
        session: &str,
        kind: &str,
        apply: F,
        encode: E,
    ) -> Result<T, String>
    where
        F: FnOnce(Option<&Value>, bool) -> Result<T, String>,
        E: FnOnce(&T) -> Value,
    {
        match self.mode() {
            // Keep the hot live path free of trace JSON creation and payload
            // copies. The apply closure can branch on trace_enabled before it
            // gathers any event data.
            Mode::Live => apply(None, false),
            Mode::Record => {
                let mut state = self.lock();
                if self.mode() != Mode::Record || state.incomplete.is_some() {
                    drop(state);
                    return apply(None, false);
                }
                let result = apply(None, true)?;
                let data = encode(&result);
                let event = WorkerTraceEvent {
                    seq: state.next_seq,
                    session: session.to_owned(),
                    kind: kind.to_owned(),
                    data,
                };
                if let Err(reason) = reserve_event(&mut state, &event) {
                    state.incomplete.get_or_insert(reason);
                    self.changed.notify_all();
                    return Ok(result);
                }
                let Some(next_seq) = state.next_seq.checked_add(1) else {
                    state
                        .incomplete
                        .get_or_insert("worker trace sequence overflow".into());
                    return Ok(result);
                };
                state.next_seq = next_seq;
                update_active_turn(&mut state, actor, &event);
                if state.batch_open {
                    state.batch_events.push(event);
                } else {
                    state.pending_events.push(event);
                }
                self.changed.notify_all();
                Ok(result)
            }
            Mode::Replay => {
                let deadline = Instant::now() + WAIT_TIMEOUT;
                let mut state = self.lock();
                loop {
                    if self.mode() != Mode::Replay {
                        drop(state);
                        return apply(None, false);
                    }
                    Self::check_failure(&state)?;
                    if state.stopped_sessions.contains(session)
                        && !matches!(kind, "scheduler.stop" | "worker.exit" | "io.close")
                    {
                        return Err(format!(
                            "worker replay session {session} stopped before {kind}"
                        ));
                    }
                    if !state.batch_open {
                        if state.stopped_sessions.contains(session) {
                            return Err(format!(
                                "worker replay session {session} stopped while awaiting {kind}"
                            ));
                        }
                        let now = Instant::now();
                        if now >= deadline {
                            return Err(format!(
                                "worker replay event {kind} arrived outside a trace batch"
                            ));
                        }
                        let (next, result) = self
                            .changed
                            .wait_timeout(state, deadline - now)
                            .unwrap_or_else(|poison| poison.into_inner());
                        state = next;
                        if result.timed_out() && !state.batch_open {
                            return Err(format!(
                                "worker replay event {kind} arrived outside a trace batch"
                            ));
                        }
                        continue;
                    }
                    let Some(expected) = state.replay_events.front().cloned() else {
                        if state.stopped_sessions.contains(session) {
                            return Err(format!(
                                "worker replay session {session} stopped before {kind}"
                            ));
                        }
                        let now = Instant::now();
                        if now >= deadline {
                            return Err(format!(
                                "worker replay is missing event {kind} for {session}"
                            ));
                        }
                        let (next, result) = self
                            .changed
                            .wait_timeout(state, deadline - now)
                            .unwrap_or_else(|poison| poison.into_inner());
                        state = next;
                        if result.timed_out() && state.replay_events.is_empty() {
                            return Err(format!(
                                "worker replay is missing event {kind} for {session}"
                            ));
                        }
                        continue;
                    };
                    let expected_actor = TraceActor::for_event(Mode::Replay, &expected);
                    if expected_actor != actor || expected.session != session {
                        let now = Instant::now();
                        if now >= deadline {
                            return Err(format!(
                                "worker replay timed out waiting for {actor:?}/{session}; next is {expected_actor:?}/{}",
                                expected.session
                            ));
                        }
                        let (next, result) = self
                            .changed
                            .wait_timeout(state, deadline - now)
                            .unwrap_or_else(|poison| poison.into_inner());
                        state = next;
                        if result.timed_out() {
                            return Err(format!(
                                "worker replay timed out waiting for {actor:?}/{session}"
                            ));
                        }
                        continue;
                    }
                    if expected.kind != kind {
                        let message = format!(
                            "worker replay event {} expected {}/{}, got {session}/{kind}",
                            expected.seq, expected.session, expected.kind
                        );
                        state.failure = Some(message.clone());
                        self.changed.notify_all();
                        return Err(message);
                    }
                    let expected_data = expected.data.clone();
                    let result = match apply(Some(&expected_data), true) {
                        Ok(result) => result,
                        Err(error) => {
                            state.failure = Some(error.clone());
                            self.changed.notify_all();
                            return Err(error);
                        }
                    };
                    let actual_data = encode(&result);
                    if actual_data != expected_data {
                        let message = format!(
                            "worker replay event {} ({kind}) data mismatch",
                            expected.seq
                        );
                        state.failure = Some(message.clone());
                        self.changed.notify_all();
                        return Err(message);
                    }
                    state.replay_events.pop_front();
                    state.next_seq = expected.seq.saturating_add(1);
                    update_active_turn(&mut state, actor, &expected);
                    state.consumed_events.push(expected);
                    self.changed.notify_all();
                    return Ok(result);
                }
            }
        }
    }

    /// Close the current host transaction. The returned events belong to its
    /// existing trace-clock envelope and are not a second recording format.
    pub(crate) fn finish_batch(&self) -> Result<Vec<WorkerTraceEvent>, String> {
        let mode = self.mode();
        let mut state = self.lock();
        if !state.batch_open {
            return Err("worker trace batch is not open".into());
        }
        if let Some(reason) = &state.incomplete {
            let reason = reason.clone();
            state.batch_open = false;
            state.batch_events.clear();
            state.consumed_events.clear();
            state.pending_events.clear();
            self.changed.notify_all();
            return Err(format!("worker recording is incomplete: {reason}"));
        }
        if let Err(error) = Self::check_failure(&state) {
            state.batch_open = false;
            state.batch_events.clear();
            state.consumed_events.clear();
            state.pending_events.clear();
            state.replay_events.clear();
            self.changed.notify_all();
            return Err(error);
        }
        if mode == Mode::Record {
            let deadline = Instant::now() + CUT_WAIT_TIMEOUT;
            while self.mode() == Mode::Record
                && state.incomplete.is_none()
                && !state.active_turns.is_empty()
            {
                let now = Instant::now();
                if now >= deadline {
                    state.incomplete.get_or_insert_with(|| {
                        "worker trace batch cut timed out with an active turn".into()
                    });
                    break;
                }
                let (next, result) = self
                    .changed
                    .wait_timeout(state, deadline.saturating_duration_since(now))
                    .unwrap_or_else(|poison| poison.into_inner());
                state = next;
                if let Err(error) = Self::check_failure(&state) {
                    state.batch_open = false;
                    state.batch_events.clear();
                    state.consumed_events.clear();
                    state.pending_events.clear();
                    state.replay_events.clear();
                    self.changed.notify_all();
                    return Err(error);
                }
                if result.timed_out() && !state.active_turns.is_empty() {
                    state.incomplete.get_or_insert_with(|| {
                        "worker trace batch cut timed out with an active turn".into()
                    });
                    break;
                }
            }
            if let Some(reason) = &state.incomplete {
                let reason = reason.clone();
                state.batch_open = false;
                state.batch_events.clear();
                state.consumed_events.clear();
                state.pending_events.clear();
                self.changed.notify_all();
                return Err(format!("worker recording is incomplete: {reason}"));
            }
        }
        if mode == Mode::Replay {
            let deadline = Instant::now() + CUT_WAIT_TIMEOUT;
            loop {
                let Some(event) = state.replay_events.front() else {
                    break;
                };
                match TraceActor::for_event(Mode::Replay, event) {
                    TraceActor::Ui | TraceActor::Host => {
                        let message = format!(
                            "worker trace batch left host event {} ({}) unconsumed",
                            event.seq, event.kind
                        );
                        state.failure = Some(message.clone());
                        state.batch_open = false;
                        state.replay_events.clear();
                        self.changed.notify_all();
                        return Err(message);
                    }
                    TraceActor::Worker | TraceActor::Io | TraceActor::Offload => {
                        let now = Instant::now();
                        if now >= deadline {
                            let message = format!(
                                "worker trace batch cut timed out at event {} ({})",
                                event.seq, event.kind
                            );
                            state.failure = Some(message.clone());
                            state.batch_open = false;
                            state.replay_events.clear();
                            self.changed.notify_all();
                            return Err(message);
                        }
                        let (next, result) = self
                            .changed
                            .wait_timeout(state, deadline - now)
                            .unwrap_or_else(|poison| poison.into_inner());
                        state = next;
                        if let Err(error) = Self::check_failure(&state) {
                            state.batch_open = false;
                            state.batch_events.clear();
                            state.consumed_events.clear();
                            state.pending_events.clear();
                            state.replay_events.clear();
                            self.changed.notify_all();
                            return Err(error);
                        }
                        if result.timed_out() && !state.replay_events.is_empty() {
                            let event = state.replay_events.front().unwrap();
                            let message = format!(
                                "worker trace batch cut timed out at event {} ({})",
                                event.seq, event.kind
                            );
                            state.failure = Some(message.clone());
                            state.batch_open = false;
                            state.replay_events.clear();
                            self.changed.notify_all();
                            return Err(message);
                        }
                    }
                }
            }
        }
        state.batch_open = false;
        let events = match mode {
            Mode::Record => std::mem::take(&mut state.batch_events),
            Mode::Replay => std::mem::take(&mut state.consumed_events),
            Mode::Live => Vec::new(),
        };
        self.changed.notify_all();
        Ok(events)
    }

    pub(crate) fn verify_replay_complete(&self) -> Result<(), String> {
        let state = self.lock();
        Self::check_failure(&state)?;
        if !state.replay_events.is_empty() {
            return Err("worker replay ended with unconsumed events".into());
        }
        if !state.active_turns.is_empty() {
            return Err("worker replay ended with an active unclosed turn".into());
        }
        Ok(())
    }

    pub(crate) fn peek_replay(&self) -> Result<Option<WorkerTraceEvent>, String> {
        if self.mode() != Mode::Replay {
            return Ok(None);
        }
        let state = self.lock();
        Self::check_failure(&state)?;
        Ok(state.replay_events.front().cloned())
    }

    pub(crate) fn fail_replay(&self, message: impl Into<String>) {
        let mut state = self.lock();
        if state.failure.is_none() {
            state.failure = Some(message.into());
        }
        self.changed.notify_all();
    }

    /// Stop and destroy paths call this before joining worker threads. It is
    /// safe in Live/Record mode and releases condition-variable waiters.
    pub(crate) fn notify_stop(&self, session: Option<&str>) {
        if let Some(session) = session {
            self.lock().stopped_sessions.insert(session.to_owned());
        }
        self.changed.notify_all();
    }

    pub(crate) fn batch_open(&self) -> bool {
        self.lock().batch_open
    }

    pub(crate) fn can_finish_active_turn(&self, session: &str, kind: &str) -> bool {
        let state = self.lock();
        state.active_turns.contains(session) && worker_turn_event(kind)
    }

    pub(crate) fn session_stopped(&self, session: &str) -> bool {
        self.lock().stopped_sessions.contains(session)
    }

    pub(crate) fn can_admit_stopped_turn_begin(&self, session: &str) -> bool {
        let state = self.lock();
        state.stopped_sessions.contains(session)
            && state.stopped_turn_begins.contains(session)
            && replay_frontier_is_admitted_turn(&state, session)
    }

    #[cfg(test)]
    pub(crate) fn wait_for_recorded_event(
        &self,
        kind: &str,
        timeout: Duration,
        predicate: impl Fn(&WorkerTraceEvent) -> bool,
    ) -> Result<WorkerTraceEvent, String> {
        let deadline = Instant::now() + timeout;
        let mut state = self.lock();
        loop {
            if let Some(event) = state
                .batch_events
                .iter()
                .find(|event| event.kind == kind && predicate(event))
            {
                return Ok(event.clone());
            }
            if let Some(incomplete) = &state.incomplete {
                return Err(incomplete.clone());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(format!("timed out waiting for recorded {kind}"));
            }
            let (next, result) = self
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|poison| poison.into_inner());
            state = next;
            if result.timed_out()
                && Instant::now() >= deadline
                && !state
                    .batch_events
                    .iter()
                    .any(|event| event.kind == kind && predicate(event))
            {
                return Err(format!("timed out waiting for recorded {kind}"));
            }
        }
    }

    pub(crate) fn mark_incomplete(&self, message: impl Into<String>) {
        let mut state = self.lock();
        state.incomplete.get_or_insert_with(|| message.into());
    }

    /// The owner runner uses the next event as its wake source in replay.
    /// It never waits for wall-clock deadlines while replay mode is active.
    pub(crate) fn wait_runner_or_stop(
        &self,
        session: &str,
        stop: &std::sync::atomic::AtomicBool,
    ) -> Result<(), String> {
        self.wait_for_session(TraceActor::Worker, session, stop)
    }

    pub(crate) fn wait_for_session(
        &self,
        actor: TraceActor,
        session: &str,
        stop: &std::sync::atomic::AtomicBool,
    ) -> Result<(), String> {
        let deadline = Instant::now() + WAIT_TIMEOUT;
        let mut state = self.lock();
        loop {
            if self.mode() != Mode::Replay {
                return Ok(());
            }
            Self::check_failure(&state)?;
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            if let Some(event) = state.replay_events.front() {
                let expected_worker_exit = actor == TraceActor::Worker
                    && event.session.as_str() == session
                    && event.kind == "worker.exit";
                if state.stopped_sessions.contains(&event.session) && !expected_worker_exit {
                    return Err(format!(
                        "worker replay session {} was stopped before event {}",
                        event.session, event.seq
                    ));
                }
            }
            if state.batch_open {
                if let Some(event) = state.replay_events.front() {
                    if TraceActor::for_event(Mode::Replay, event) == actor
                        && event.session.as_str() == session
                    {
                        return Ok(());
                    }
                }
            }
            let now = Instant::now();
            if now >= deadline {
                let detail = state
                    .replay_events
                    .front()
                    .map(|event| {
                        format!("next event {} {}/{}", event.seq, event.session, event.kind)
                    })
                    .unwrap_or_else(|| "no event is available in the current transaction".into());
                return Err(format!("worker replay wait timed out: {detail}"));
            }
            let (next, result) = self
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|poison| poison.into_inner());
            state = next;
            if result.timed_out() && Instant::now() >= deadline {
                return Err("worker replay wait timed out".into());
            }
        }
    }

    /// Wait without consuming or locking a caller's broker state until the
    /// requested actor owns the next replay event. The subsequent `transition`
    /// performs the actual atomic state change and event consumption.
    pub(crate) fn await_turn(
        &self,
        actor: TraceActor,
        session: &str,
        kind: &str,
    ) -> Result<(), String> {
        let deadline = Instant::now() + WAIT_TIMEOUT;
        let mut state = self.lock();
        loop {
            if self.mode() != Mode::Replay {
                // Switching to live clears the replay tape and wakes this
                // gate. The caller can now perform the ordinary operation.
                return Ok(());
            }
            Self::check_failure(&state)?;
            if state.stopped_sessions.contains(session)
                && !stopped_event_allowed(&state, actor, session, kind)
            {
                return Err(format!(
                    "worker replay session {session} stopped before {kind}"
                ));
            }
            if state.batch_open {
                if let Some(expected) = state.replay_events.front() {
                    let expected_actor = TraceActor::for_event(Mode::Replay, expected);
                    if expected_actor == actor && expected.session == session {
                        if expected.kind != kind {
                            let message = format!(
                                "worker replay event {} expected {}/{}, awaited {actor:?}/{session}/{kind}",
                                expected.seq, expected.session, expected.kind
                            );
                            state.failure = Some(message.clone());
                            self.changed.notify_all();
                            return Err(message);
                        }
                        return Ok(());
                    }
                }
            }
            if state.stopped_sessions.contains(session) && state.replay_events.is_empty() {
                return Err(format!("worker replay stopped before {kind} was recorded"));
            }
            let now = Instant::now();
            if now >= deadline {
                let detail = state
                    .replay_events
                    .front()
                    .map(|event| format!("{} {}/{}", event.seq, event.session, event.kind))
                    .unwrap_or_else(|| "empty current batch".to_owned());
                return Err(format!(
                    "await_turn timed out for {actor:?}/{session}/{kind}: {detail}"
                ));
            }
            let (next, result) = self
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|poison| poison.into_inner());
            state = next;
            if result.timed_out() && Instant::now() >= deadline {
                return Err(format!(
                    "await_turn timed out for {actor:?}/{session}/{kind}"
                ));
            }
        }
    }

    /// Wait until another actor consumes the current event. This is used by a
    /// host/UI caller that encounters an IO fact whose executor belongs to the
    /// Worker thread; it avoids polling or consuming that fact on the wrong
    /// execution domain.
    pub(crate) fn wait_for_advance(&self, seq: u64) -> Result<(), String> {
        if self.wait_for_advance_timeout(seq, WAIT_TIMEOUT)? {
            Ok(())
        } else {
            Err(format!("worker replay event {seq} was not consumed"))
        }
    }

    pub(crate) fn wait_for_advance_timeout(
        &self,
        seq: u64,
        timeout: Duration,
    ) -> Result<bool, String> {
        let deadline = Instant::now() + timeout;
        let mut state = self.lock();
        loop {
            if self.mode() != Mode::Replay {
                return Ok(true);
            }
            Self::check_failure(&state)?;
            let Some(event) = state.replay_events.front().filter(|event| event.seq == seq) else {
                return Ok(true);
            };
            let event_actor = TraceActor::for_event(Mode::Replay, event);
            if state.stopped_sessions.contains(&event.session)
                && !stopped_event_allowed(&state, event_actor, &event.session, &event.kind)
            {
                return Err(format!(
                    "worker replay session {} stopped before event {seq}",
                    event.session
                ));
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(false);
            }
            let (next, result) = self
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|poison| poison.into_inner());
            state = next;
            if result.timed_out() && state.replay_events.front().map(|event| event.seq) == Some(seq)
            {
                return Ok(false);
            }
        }
    }

    fn consume_matching(
        &self,
        actor: TraceActor,
        session: &str,
        kind: &str,
        actual: Option<Value>,
        blocked_kinds: &[&str],
    ) -> Result<Value, String> {
        let deadline = Instant::now() + WAIT_TIMEOUT;
        let mut state = self.lock();
        loop {
            let mode = self.mode();
            if mode == Mode::Live {
                return Ok(Value::Null);
            }
            Self::check_failure(&state)?;
            if state.stopped_sessions.contains(session) {
                if !stopped_event_allowed(&state, actor, session, kind) {
                    return Err(format!("worker replay session {session} was stopped"));
                }
            }
            if !state.batch_open {
                if state.stopped_sessions.contains(session) {
                    return Err(format!(
                        "worker replay session {session} stopped while awaiting {kind}"
                    ));
                }
                let now = Instant::now();
                if now >= deadline {
                    return Err("worker replay event arrived outside an open trace batch".into());
                }
                let (next, timed) = self
                    .changed
                    .wait_timeout(state, deadline - now)
                    .unwrap_or_else(|poison| poison.into_inner());
                state = next;
                if timed.timed_out() && !state.batch_open && Instant::now() >= deadline {
                    return Err("worker replay event arrived outside an open trace batch".into());
                }
                continue;
            }
            let Some(expected) = state.replay_events.front().cloned() else {
                if state.stopped_sessions.contains(session) {
                    return Err(format!(
                        "worker replay session {session} stopped before {kind} was recorded"
                    ));
                }
                let now = Instant::now();
                if now >= deadline {
                    return Err(format!(
                        "worker replay is missing event {kind} for session {session}"
                    ));
                }
                let (next, timed) = self
                    .changed
                    .wait_timeout(state, deadline - now)
                    .unwrap_or_else(|poison| poison.into_inner());
                state = next;
                if timed.timed_out() && state.replay_events.is_empty() {
                    return Err(format!(
                        "worker replay is missing event {kind} for session {session}"
                    ));
                }
                continue;
            };
            if TraceActor::for_event(Mode::Replay, &expected) != actor
                || expected.session != session
            {
                if blocked_kinds.contains(&expected.kind.as_str()) {
                    let message = format!(
                        "worker replay event {} ({}) is blocked by the active {kind} capture gate",
                        expected.seq, expected.kind
                    );
                    state.failure = Some(message.clone());
                    self.changed.notify_all();
                    return Err(message);
                }
                let now = Instant::now();
                if now >= deadline {
                    return Err(format!(
                        "worker replay blocked at event {} ({}) while {actor:?} requested {kind}",
                        expected.seq, expected.kind
                    ));
                }
                let (next, timed) = self
                    .changed
                    .wait_timeout(state, deadline - now)
                    .unwrap_or_else(|poison| poison.into_inner());
                state = next;
                if timed.timed_out() && Instant::now() >= deadline {
                    return Err(format!(
                        "worker replay blocked at event {} ({}) while {actor:?} requested {kind}",
                        expected.seq, expected.kind
                    ));
                }
                continue;
            }
            if expected.kind != kind {
                let message = format!(
                    "worker replay event {} expected {}/{} but got {session}/{kind}",
                    expected.seq, expected.session, expected.kind
                );
                state.failure = Some(message.clone());
                self.changed.notify_all();
                return Err(message);
            }
            if let Some(actual) = actual {
                if expected.data != actual {
                    let message = if kind == "worker.exit" {
                        format!(
                            "worker replay event {} ({kind}) data mismatch: expected {}, got {}",
                            expected.seq, expected.data, actual
                        )
                    } else {
                        format!(
                            "worker replay event {} ({kind}) data mismatch",
                            expected.seq
                        )
                    };
                    state.failure = Some(message.clone());
                    self.changed.notify_all();
                    return Err(message);
                }
            }
            let expected = state.replay_events.pop_front().unwrap();
            state.next_seq = expected.seq.saturating_add(1);
            if actor == TraceActor::Host && kind == "scheduler.stop" {
                state.stopped_sessions.insert(session.to_owned());
                state.stopped_turn_begins.remove(session);
                if replay_frontier_is_admitted_turn(&state, session) {
                    state.stopped_turn_begins.insert(session.to_owned());
                }
            }
            if actor == TraceActor::Worker
                && kind == "turn.begin"
                && state.stopped_sessions.contains(session)
            {
                state.stopped_turn_begins.remove(session);
            }
            update_active_turn(&mut state, actor, &expected);
            state.consumed_events.push(expected.clone());
            self.changed.notify_all();
            return Ok(expected.data);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, TraceState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn check_failure(state: &TraceState) -> Result<(), String> {
        if let Some(failure) = &state.failure {
            Err(failure.clone())
        } else {
            Ok(())
        }
    }
}

fn replay_frontier_is_admitted_turn(state: &TraceState, session: &str) -> bool {
    for event in &state.replay_events {
        if event.session == session && event.kind == "io.fact" {
            continue;
        }
        return event.session == session
            && TraceActor::for_event(Mode::Replay, event) == TraceActor::Worker
            && event.kind == "turn.begin";
    }
    false
}

fn validate_event(event: &WorkerTraceEvent) -> Result<(), String> {
    if event.session.is_empty() || event.session.len() > 128 {
        return Err("worker trace session must contain 1..128 bytes".into());
    }
    if !matches!(
        event.kind.as_str(),
        "bootstrap"
            | "turn.begin"
            | "turn.facts"
            | "turn.end"
            | "turn.deferred"
            | "clock.scalar"
            | "channel.declare"
            | "channel.publish"
            | "channel.latch"
            | "io.open"
            | "io.submit"
            | "io.request"
            | "io.cancel"
            | "io.close"
            | "io.write"
            | "io.fact"
            | "offload.cancel"
            | "offload.timeout"
            | "offload.session.read"
            | "offload.submit"
            | "offload.reply.take"
            | "offload.provider.take"
            | "offload.provider.cancel.take"
            | "offload.provider.complete"
            | "offload.session.set"
            | "offload.shutdown"
            | "scheduler.pause"
            | "scheduler.resume"
            | "scheduler.stop"
            | "worker.exit"
            | "timer.set"
    ) {
        return Err(format!(
            "unsupported worker trace event kind {:?}",
            event.kind
        ));
    }
    if !event.data.is_object() {
        return Err(format!(
            "worker trace {} data must be an object",
            event.kind
        ));
    }
    let size = serialized_event_len(event)?;
    if size > MAX_WORKER_EVENT_BYTES {
        return Err(format!(
            "worker trace event {} exceeds {} bytes",
            event.kind, MAX_WORKER_EVENT_BYTES
        ));
    }
    Ok(())
}

fn serialized_event_len(event: &WorkerTraceEvent) -> Result<usize, String> {
    serde_json::to_vec(event)
        .map(|bytes| bytes.len())
        .map_err(|error| format!("invalid worker trace event: {error}"))
}

fn reserve_event(state: &mut TraceState, event: &WorkerTraceEvent) -> Result<(), String> {
    validate_event(event)?;
    if state.total_events >= MAX_WORKER_EVENTS {
        return Err(format!(
            "worker trace event quota exceeded ({MAX_WORKER_EVENTS})"
        ));
    }
    let bytes = serialized_event_len(event)?;
    let total = state
        .total_bytes
        .checked_add(bytes)
        .ok_or_else(|| "worker trace byte count overflow".to_owned())?;
    if total > MAX_WORKER_TRACE_BYTES {
        return Err(format!(
            "worker trace byte quota exceeded ({MAX_WORKER_TRACE_BYTES})"
        ));
    }
    state.total_events += 1;
    state.total_bytes = total;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(seq: u64, kind: &str, data: Value) -> WorkerTraceEvent {
        WorkerTraceEvent {
            seq,
            session: "worker-1".into(),
            kind: kind.into(),
            data,
        }
    }

    #[test]
    fn live_does_not_evaluate_payload_builder() {
        let trace = WorkerTrace::new(Mode::Live);
        let mut built = false;
        trace
            .observe(TraceActor::Worker, "worker-1", "turn.begin", || {
                built = true;
                json!({"nowMicros": 7})
            })
            .unwrap();
        assert!(!built);
    }

    #[test]
    fn live_transition_runs_state_change_without_encoding() {
        let trace = WorkerTrace::new(Mode::Live);
        let mut encoded = false;
        let value = trace
            .transition(
                TraceActor::Offload,
                "offload-1",
                "offload.submit",
                |expected, enabled| {
                    assert!(expected.is_none());
                    assert!(!enabled);
                    Ok::<_, String>(17u32)
                },
                |_| {
                    encoded = true;
                    json!({"accepted":true})
                },
            )
            .unwrap();
        assert_eq!(value, 17);
        assert!(!encoded);
    }

    #[test]
    fn record_batches_use_one_monotonic_sequence_and_replay_requires_full_consumption() {
        let record = WorkerTrace::new(Mode::Record);
        record.begin_batch(&[]).unwrap();
        record
            .observe(
                TraceActor::Host,
                "worker-1",
                "bootstrap",
                || json!({"qjbc":"abc"}),
            )
            .unwrap();
        record
            .observe(
                TraceActor::Worker,
                "worker-1",
                "turn.begin",
                || json!({"nowMicros": 7}),
            )
            .unwrap();
        record
            .observe(
                TraceActor::Worker,
                "worker-1",
                "turn.end",
                || json!({"nowMicros": 7}),
            )
            .unwrap();
        let first = record.finish_batch().unwrap();
        assert_eq!(first[0].seq, 0);
        assert_eq!(first[1].seq, 1);
        assert_eq!(first[2].seq, 2);

        let replay = WorkerTrace::new(Mode::Replay);
        replay.begin_batch(&first).unwrap();
        assert_eq!(
            replay
                .take(TraceActor::Host, "worker-1", "bootstrap")
                .unwrap(),
            Some(json!({"qjbc":"abc"}))
        );
        replay
            .observe(
                TraceActor::Worker,
                "worker-1",
                "turn.begin",
                || json!({"nowMicros": 7}),
            )
            .unwrap();
        replay
            .observe(
                TraceActor::Worker,
                "worker-1",
                "turn.end",
                || json!({"nowMicros": 7}),
            )
            .unwrap();
        let replayed = replay.finish_batch().unwrap();
        assert_eq!(replayed.len(), 3);
    }

    #[test]
    fn record_scheduler_stop_is_linearized_without_rejecting_an_admitted_turn() {
        let trace = WorkerTrace::new(Mode::Record);
        trace.begin_batch(&[]).unwrap();
        trace
            .observe(
                TraceActor::Host,
                "worker-1",
                "scheduler.stop",
                || json!({"generation": 1}),
            )
            .unwrap();
        assert!(trace.session_stopped("worker-1"));
        trace
            .observe(
                TraceActor::Worker,
                "worker-1",
                "turn.begin",
                || json!({"generation": 1, "sequence": 1, "nowMicros": 7}),
            )
            .unwrap();
        trace
            .observe(
                TraceActor::Worker,
                "worker-1",
                "turn.facts",
                || json!({"sequence": 1, "nowMicros": 7, "facts": []}),
            )
            .unwrap();
        trace
            .observe(
                TraceActor::Worker,
                "worker-1",
                "turn.end",
                || json!({"generation": 1, "sequence": 1, "executed": true, "elapsedMicros": 1}),
            )
            .unwrap();
        let events = trace.finish_batch().unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            ["scheduler.stop", "turn.begin", "turn.facts", "turn.end"]
        );
    }

    #[test]
    fn replay_rejects_missing_and_mismatched_events() {
        let replay = WorkerTrace::new(Mode::Replay);
        let events = [event(0, "turn.begin", json!({"nowMicros": 7}))];
        replay.begin_batch(&events).unwrap();
        assert!(replay
            .observe(TraceActor::Worker, "worker-1", "turn.begin", || {
                json!({"nowMicros": 8})
            })
            .is_err());
        assert!(replay.finish_batch().is_err());
    }

    #[test]
    fn replay_rejects_sequence_gaps_before_opening_a_later_batch() {
        let replay = WorkerTrace::new(Mode::Replay);
        let first = [event(0, "bootstrap", json!({"qjbc":"abc"}))];
        replay.begin_batch(&first).unwrap();
        replay
            .take(TraceActor::Host, "worker-1", "bootstrap")
            .unwrap();
        replay.finish_batch().unwrap();
        let next = [event(2, "turn.begin", json!({"nowMicros": 9}))];
        assert!(replay.begin_batch(&next).is_err());
    }

    #[test]
    fn replay_turn_output_can_be_latched_in_the_next_ui_transaction() {
        let replay = WorkerTrace::new(Mode::Replay);
        let first_txn = [
            event(0, "turn.begin", json!({"sequence": 1, "nowMicros": 10})),
            event(
                1,
                "channel.publish",
                json!({"direction":"worker-to-ui", "channel":1, "bytes":[7]}),
            ),
        ];
        replay.begin_batch(&first_txn).unwrap();
        let lane = Arc::clone(&replay);
        let worker = std::thread::spawn(move || {
            lane.take(TraceActor::Worker, "worker-1", "turn.begin")
                .unwrap();
            lane.take(TraceActor::Worker, "worker-1", "channel.publish")
                .unwrap();
        });
        replay.finish_batch().unwrap();
        worker.join().unwrap();

        let second_txn = [event(
            2,
            "channel.latch",
            json!({"channel":1, "records":[[7]]}),
        )];
        replay.begin_batch(&second_txn).unwrap();
        replay
            .take(TraceActor::Ui, "worker-1", "channel.latch")
            .unwrap();
        replay.finish_batch().unwrap();
    }

    #[test]
    fn stopped_corrupt_replay_releases_a_waiter_without_thirty_second_wait() {
        let replay = WorkerTrace::new(Mode::Replay);
        replay.begin_batch(&[]).unwrap();
        let lane = Arc::clone(&replay);
        let waiter =
            std::thread::spawn(move || lane.take(TraceActor::Worker, "worker-1", "worker.exit"));
        std::thread::sleep(Duration::from_millis(10));
        replay.notify_stop(Some("worker-1"));
        assert!(waiter.join().unwrap().is_err());
    }

    #[test]
    fn switching_to_live_releases_an_operation_gate_for_the_live_path() {
        let replay = WorkerTrace::new(Mode::Replay);
        replay.begin_batch(&[]).unwrap();
        let lane = Arc::clone(&replay);
        let waiter = std::thread::spawn(move || {
            lane.await_turn(TraceActor::Ui, "worker-1", "channel.latch")
        });
        std::thread::sleep(Duration::from_millis(10));
        replay.set_live();
        assert!(waiter.join().unwrap().is_ok());
    }

    #[test]
    fn record_overflow_makes_the_batch_unexportable() {
        let record = WorkerTrace::new(Mode::Record);
        record.begin_batch(&[]).unwrap();
        record.mark_incomplete("test quota");
        assert!(record.finish_batch().unwrap_err().contains("test quota"));
        assert!(!record.batch_open());
    }

    #[test]
    fn verify_replay_complete_fails_on_active_unclosed_turn() {
        let replay = WorkerTrace::new(Mode::Replay);
        let events = [event(
            0,
            "turn.begin",
            json!({"sequence": 1, "nowMicros": 10}),
        )];
        replay.begin_batch(&events).unwrap();
        replay
            .take(TraceActor::Worker, "worker-1", "turn.begin")
            .unwrap();
        replay.finish_batch().unwrap();

        let err = replay.verify_replay_complete().unwrap_err();
        assert_eq!(err, "worker replay ended with an active unclosed turn");
    }

    #[test]
    fn verify_replay_complete_fails_on_unconsumed_events() {
        let replay = WorkerTrace::new(Mode::Replay);
        let events = [
            event(0, "turn.begin", json!({"sequence": 1, "nowMicros": 10})),
            event(1, "turn.end", json!({"sequence": 1})),
        ];
        replay.begin_batch(&events).unwrap();
        replay
            .take(TraceActor::Worker, "worker-1", "turn.begin")
            .unwrap();
        let err = replay.verify_replay_complete().unwrap_err();
        assert_eq!(err, "worker replay ended with unconsumed events");
    }

    #[test]
    fn record_finish_batch_waits_for_active_turn_to_end() {
        let record = WorkerTrace::new(Mode::Record);
        record.begin_batch(&[]).unwrap();
        let lane = Arc::clone(&record);
        lane.observe(
            TraceActor::Worker,
            "worker-1",
            "turn.begin",
            || json!({"sequence": 1}),
        )
        .unwrap();

        let lane_worker = Arc::clone(&record);
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            lane_worker
                .observe(
                    TraceActor::Worker,
                    "worker-1",
                    "turn.end",
                    || json!({"sequence": 1}),
                )
                .unwrap();
        });

        let events = record.finish_batch().unwrap();
        worker.join().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, "turn.begin");
        assert_eq!(events[1].kind, "turn.end");
    }

    #[test]
    fn record_finish_batch_times_out_on_unclosed_active_turn() {
        let record = WorkerTrace::new(Mode::Record);
        record.begin_batch(&[]).unwrap();
        record
            .observe(
                TraceActor::Worker,
                "worker-1",
                "turn.begin",
                || json!({"sequence": 1}),
            )
            .unwrap();

        let err = record.finish_batch().unwrap_err();
        assert!(err.contains("worker trace batch cut timed out with an active turn"));
    }
}
