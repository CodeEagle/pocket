//! Native trace-clock support for deterministic external transactions.
//!
//! The demand scheduler still owns the fixed-step clock and the single
//! QuickJS event loop. This module records/replays the elapsed idle interval
//! that `demand::before_external` would otherwise obtain from `Instant`.

use super::HostState;
use crate::worker_trace::WorkerTraceEvent;
use rquickjs::{Ctx, Exception, Function, Object};
use serde_json::Value;
use std::cell::RefCell;
use std::rc::Rc;

/// Clock mode exposed through the stable C ABI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Live = 0,
    Record = 1,
    Replay = 2,
}

impl Mode {
    pub(super) fn from_raw(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::Live),
            1 => Some(Self::Record),
            2 => Some(Self::Replay),
            _ => None,
        }
    }
}

/// This is a bounded diagnostic ABI, not an unbounded event recorder.
const MAX_INTERVALS: usize = 4096;

#[derive(Clone, Debug, serde::Serialize)]
pub(super) struct ScalarSample {
    kind: String,
    value: f64,
}

pub(super) struct ScalarLane {
    mode: Mode,
    transaction_open: bool,
    recorded: Vec<ScalarSample>,
    replayed: Vec<ScalarSample>,
    replay_index: usize,
    /// Record-mode quota failures are reported by transaction end rather
    /// than thrown from the guest scalar wrapper.  Keeping one bounded
    /// marker lets an over-quota guest continue its original work without
    /// allocating an unbounded diagnostic tape.
    failure: Option<String>,
}

impl Default for ScalarLane {
    fn default() -> Self {
        Self {
            mode: Mode::Live,
            transaction_open: false,
            recorded: Vec::new(),
            replayed: Vec::new(),
            replay_index: 0,
            failure: None,
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct InputScalar {
    kind: String,
    value: f64,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct InputEnvelope {
    #[serde(default)]
    version: Option<u32>,
    #[serde(rename = "idleMs")]
    idle_ms: Vec<Value>,
    #[serde(default)]
    scalars: Vec<InputScalar>,
    #[serde(default, rename = "workerEvents")]
    worker_events: Option<Vec<WorkerTraceEvent>>,
    #[serde(default, rename = "offloadEvents")]
    offload_events: Option<Vec<WorkerTraceEvent>>,
}

struct ParsedInput {
    idle_ms: Vec<f64>,
    scalars: Vec<ScalarSample>,
    worker_events: Option<Vec<WorkerTraceEvent>>,
    offload_events: Option<Vec<WorkerTraceEvent>>,
}

#[derive(serde::Serialize)]
struct OutputEnvelope<'a> {
    #[serde(rename = "idleMs")]
    idle_ms: &'a [f64],
    scalars: &'a [ScalarSample],
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<u32>,
    #[serde(rename = "workerEvents", skip_serializing_if = "Option::is_none")]
    worker_events: Option<&'a [WorkerTraceEvent]>,
    #[serde(rename = "offloadEvents", skip_serializing_if = "Option::is_none")]
    offload_events: Option<&'a [WorkerTraceEvent]>,
}

pub(super) struct TraceClock {
    mode: Mode,
    transaction_open: bool,
    recorded: Vec<f64>,
    replayed: Vec<f64>,
    replay_index: usize,
    scalar_lane: Rc<RefCell<ScalarLane>>,
    last_scalars: Vec<ScalarSample>,
    /// As with the scalar lane, an interval quota failure invalidates the
    /// recording but must not change the production guest transaction.
    failure: Option<String>,
    /// Retained so scalar `end` callers can fetch the exact ordered record
    /// with `pocket_trace_clock_last_json` afterwards.
    last_completed: Vec<f64>,
    last_worker_events: Option<Vec<WorkerTraceEvent>>,
    last_offload_events: Option<Vec<WorkerTraceEvent>>,
}

impl Default for TraceClock {
    fn default() -> Self {
        Self {
            mode: Mode::Live,
            transaction_open: false,
            recorded: Vec::new(),
            replayed: Vec::new(),
            replay_index: 0,
            scalar_lane: Rc::new(RefCell::new(ScalarLane::default())),
            last_scalars: Vec::new(),
            failure: None,
            last_completed: Vec::new(),
            last_worker_events: None,
            last_offload_events: None,
        }
    }
}

impl TraceClock {
    fn clear_transaction(&mut self) {
        self.transaction_open = false;
        self.recorded.clear();
        self.replayed.clear();
        self.replay_index = 0;
        self.failure = None;
        let mut lane = self.scalar_lane.borrow_mut();
        lane.mode = self.mode;
        lane.transaction_open = false;
        lane.recorded.clear();
        lane.replayed.clear();
        lane.replay_index = 0;
        lane.failure = None;
    }

    fn clear_data(&mut self) {
        self.clear_transaction();
        self.last_completed.clear();
        self.last_scalars.clear();
        self.last_worker_events = None;
        self.last_offload_events = None;
    }

    fn begin(
        &mut self,
        replayed: Vec<f64>,
        replayed_scalars: Vec<ScalarSample>,
    ) -> Result<(), String> {
        if self.transaction_open {
            return Err("trace clock transaction already open".to_owned());
        }
        self.last_completed.clear();
        self.last_scalars.clear();
        self.last_worker_events = None;
        self.last_offload_events = None;
        self.recorded.clear();
        self.replayed.clear();
        self.replay_index = 0;
        self.failure = None;
        self.transaction_open = true;
        if self.mode == Mode::Replay {
            self.replayed = replayed;
        }
        let mut lane = self.scalar_lane.borrow_mut();
        lane.mode = self.mode;
        lane.transaction_open = true;
        lane.recorded.clear();
        lane.replayed.clear();
        lane.replay_index = 0;
        lane.failure = None;
        if self.mode == Mode::Replay {
            lane.replayed = replayed_scalars;
        }
        Ok(())
    }

    fn before_external(&mut self, elapsed_ms: Option<f64>) -> Result<f64, String> {
        match self.mode {
            Mode::Live => Ok(elapsed_ms.unwrap_or(0.0)),
            Mode::Record => {
                // Older hosts are tolerated when they omit begin. New hosts
                // should bracket every FFI transaction to retrieve the array.
                if !self.transaction_open {
                    self.begin(Vec::new(), Vec::new())?;
                }
                let elapsed_ms = elapsed_ms.unwrap_or(0.0);
                validate_elapsed(elapsed_ms)?;
                if self.recorded.len() >= MAX_INTERVALS {
                    if self.failure.is_none() {
                        self.failure = Some(format!(
                            "trace clock interval quota exceeded ({MAX_INTERVALS})"
                        ));
                    }
                    return Ok(elapsed_ms);
                }
                self.recorded.push(elapsed_ms);
                Ok(elapsed_ms)
            }
            Mode::Replay => {
                if !self.transaction_open {
                    return Err(
                        "replay trace clock requires begin before an external transaction"
                            .to_owned(),
                    );
                }
                let Some(elapsed_ms) = self.replayed.get(self.replay_index).copied() else {
                    return Err(format!(
                        "replay trace clock is missing interval {}",
                        self.replay_index
                    ));
                };
                self.replay_index += 1;
                Ok(elapsed_ms)
            }
        }
    }

    fn finish(&mut self) -> Result<Vec<f64>, String> {
        if !self.transaction_open {
            return Err("trace clock transaction is not open".to_owned());
        }
        if self.mode == Mode::Replay && self.replay_index != self.replayed.len() {
            let consumed = self.replay_index;
            let expected = self.replayed.len();
            self.clear_transaction();
            return Err(format!(
                "replay trace clock has {expected} intervals but only {consumed} were used"
            ));
        }
        let scalar_values = {
            let lane = self.scalar_lane.borrow();
            if self.mode == Mode::Replay && lane.replay_index != lane.replayed.len() {
                let consumed = lane.replay_index;
                let expected = lane.replayed.len();
                drop(lane);
                self.clear_transaction();
                return Err(format!(
                    "replay trace clock has {expected} scalar calls but only {consumed} were used"
                ));
            }
            match self.mode {
                Mode::Live => Vec::new(),
                Mode::Record => lane.recorded.clone(),
                Mode::Replay => lane.replayed.clone(),
            }
        };
        let record_failure = if self.mode == Mode::Record {
            let scalar_failure = self.scalar_lane.borrow().failure.clone();
            self.failure.clone().or(scalar_failure)
        } else {
            None
        };
        if let Some(error) = record_failure {
            self.clear_transaction();
            return Err(error);
        }
        let values = match self.mode {
            Mode::Live => Vec::new(),
            Mode::Record => self.recorded.clone(),
            Mode::Replay => self.replayed.clone(),
        };
        self.last_completed = values.clone();
        self.last_scalars = scalar_values;
        self.clear_transaction();
        Ok(values)
    }

    fn last_json(&self) -> String {
        serde_json::to_string(&OutputEnvelope {
            idle_ms: &self.last_completed,
            scalars: &self.last_scalars,
            version: (self.last_worker_events.is_some() || self.last_offload_events.is_some())
                .then_some(2),
            worker_events: self.last_worker_events.as_deref(),
            offload_events: self.last_offload_events.as_deref(),
        })
        .unwrap_or_else(|_| "{\"idleMs\":[],\"scalars\":[]}".to_owned())
    }

    pub(super) fn scalar_lane(&self) -> Rc<RefCell<ScalarLane>> {
        self.scalar_lane.clone()
    }
}

fn validate_elapsed(value: f64) -> Result<(), String> {
    if !value.is_finite() || value < 0.0 {
        return Err(format!(
            "trace clock elapsed interval must be finite and non-negative (got {value})"
        ));
    }
    Ok(())
}

fn parse_intervals(input: &str) -> Result<ParsedInput, String> {
    if input.len() > 16 * 1024 * 1024 {
        return Err("trace clock envelope exceeds 16 MiB".to_owned());
    }
    let value: Value =
        serde_json::from_str(input).map_err(|error| format!("trace clock begin JSON: {error}"))?;
    let (values, scalars, worker_events, offload_events) = match value {
        // Accept the first scalar-array ABI as a compatibility input. New
        // recordings always emit the envelope below.
        Value::Array(values) => (values, Vec::new(), None, None),
        value @ Value::Object(_) => {
            let envelope: InputEnvelope = serde_json::from_value(value)
                .map_err(|error| format!("trace clock begin envelope: {error}"))?;
            if envelope.version.is_some() && envelope.version != Some(2) {
                return Err("unsupported trace clock envelope version".to_owned());
            }
            if (envelope.worker_events.is_some() || envelope.offload_events.is_some())
                && envelope.version != Some(2)
            {
                return Err("Worker/offload facts require trace clock version 2".to_owned());
            }
            let scalars = envelope
                .scalars
                .into_iter()
                .map(|sample| validate_scalar(sample.kind, sample.value))
                .collect::<Result<Vec<_>, _>>()?;
            (
                envelope.idle_ms,
                scalars,
                envelope.worker_events,
                envelope.offload_events,
            )
        }
        _ => {
            return Err(
                "trace clock begin JSON must be an elapsed array or transaction envelope"
                    .to_owned(),
            )
        }
    };
    if values.len() > MAX_INTERVALS {
        return Err(format!(
            "trace clock transaction has too many intervals ({} > {MAX_INTERVALS})",
            values.len()
        ));
    }
    let intervals = values
        .into_iter()
        .map(|value| {
            let value = value
                .as_f64()
                .ok_or_else(|| "trace clock interval must be a JSON number".to_owned())?;
            validate_elapsed(value)?;
            Ok(value)
        })
        .collect::<Result<Vec<f64>, String>>()?;
    Ok(ParsedInput {
        idle_ms: intervals,
        scalars,
        worker_events,
        offload_events,
    })
}

fn validate_scalar(kind: String, value: f64) -> Result<ScalarSample, String> {
    if !matches!(kind.as_str(), "dateNow" | "mathRandom" | "performanceNow") {
        return Err(format!("unsupported trace scalar kind {kind:?}"));
    }
    if !value.is_finite() {
        return Err(format!("trace scalar {kind} must be finite"));
    }
    if kind == "mathRandom" && !(0.0..1.0).contains(&value) {
        return Err("trace scalar mathRandom must be in [0,1)".to_owned());
    }
    Ok(ScalarSample { kind, value })
}

pub(super) fn mode(host: &HostState) -> Mode {
    host.trace.mode
}

pub(super) fn is_replay(host: &HostState) -> bool {
    host.trace.mode == Mode::Replay
}

pub(super) fn set_mode(host: &mut HostState, raw_mode: u32) -> Result<(), String> {
    let mode = Mode::from_raw(raw_mode).ok_or_else(|| {
        format!("trace clock mode must be 0 (live), 1 (record), or 2 (replay), got {raw_mode}")
    })?;
    if (host.worker_program.is_some() || host.offload.is_some()) && mode != Mode::Live {
        return Err("trace clock mode must be selected before Worker/offload configuration".into());
    }
    if host.guest_loaded && mode != Mode::Live {
        return Err(
            "trace clock mode must be selected before the first guest load/eval".to_owned(),
        );
    }
    if host.trace.transaction_open && mode != Mode::Live {
        return Err("cannot change trace clock mode during a transaction".to_owned());
    }
    let finalize_offline = host.trace.mode == Mode::Replay && mode == Mode::Live;
    if finalize_offline {
        if let Some(runtime) = &host.worker_runtime {
            runtime.prepare_replay_stop();
        }
    }
    host.trace.mode = mode;
    let mut stopped = Ok(());
    if mode == Mode::Live {
        if let Some(lane) = &host.worker_trace {
            lane.set_live();
        }
        if finalize_offline {
            // Mode 0 ends an offline replay. It must not turn replay-only IO
            // stubs into real network requests or leave a broker without a
            // provider/deadline executor accepting new work.
            stopped = super::stop_worker_checked(host);
        } else if let Some(runtime) = &host.worker_runtime {
            runtime.set_trace_live();
        }
        if let Some(provider) = &host.offload {
            provider.set_trace_live();
            if finalize_offline {
                provider.shutdown();
            }
        }
    } else {
        // Select the lane before configuration so the first Worker/provider
        // bootstrap transaction can replay its own facts. Empty async lanes
        // are omitted from pure UI recordings by finish_transaction.
        host.worker_trace = Some(crate::worker_trace::WorkerTrace::new(mode));
    }
    host.trace.scalar_lane.borrow_mut().mode = mode;
    // Live is also the explicit disable operation. It is allowed after a
    // guest has loaded so a recording controller can stop without leaving
    // scalar hooks or an open lane accumulating values in the background.
    host.trace.clear_data();
    stopped
}

pub(super) fn begin_scalar(host: &mut HostState, elapsed_ms: f64) -> Result<(), String> {
    let (replayed, scalars) = if mode(host) == Mode::Replay {
        // NaN is the scalar ABI's unambiguous representation of an empty
        // interval array. JSON cannot encode NaN, hence this is scalar-only.
        if elapsed_ms.is_nan() {
            (Vec::new(), Vec::new())
        } else {
            validate_elapsed(elapsed_ms)?;
            (vec![elapsed_ms], Vec::new())
        }
    } else {
        // Record explicitly ignores the scalar input, as does live mode.
        (Vec::new(), Vec::new())
    };
    host.trace.begin(replayed, scalars)?;
    if let Some(lane) = &host.worker_trace {
        if let Err(error) = lane.begin_batch(&[]) {
            host.trace.clear_transaction();
            return Err(error);
        }
    }
    Ok(())
}

pub(super) fn begin_json(host: &mut HostState, input: &str) -> Result<(), String> {
    let parsed = if mode(host) == Mode::Replay {
        parse_intervals(input)?
    } else {
        // Record/live deliberately ignore the payload.
        ParsedInput {
            idle_ms: Vec::new(),
            scalars: Vec::new(),
            worker_events: None,
            offload_events: None,
        }
    };
    let mut events = parsed.worker_events.unwrap_or_default();
    if events.windows(2).any(|pair| pair[0].seq >= pair[1].seq) {
        return Err("Worker facts are not in strict sequence order".to_owned());
    }
    if events
        .iter()
        .any(|event| event.kind.starts_with("offload."))
    {
        return Err("offload fact appears in the Worker lane".to_owned());
    }
    let offload = parsed.offload_events.unwrap_or_default();
    if offload.windows(2).any(|pair| pair[0].seq >= pair[1].seq) {
        return Err("offload facts are not in strict sequence order".to_owned());
    }
    if offload
        .iter()
        .any(|event| !event.kind.starts_with("offload."))
    {
        return Err("Worker fact appears in the offload lane".to_owned());
    }
    events.extend(offload);
    events.sort_by_key(|event| event.seq);
    if events.windows(2).any(|pair| pair[0].seq == pair[1].seq) {
        return Err("trace facts contain a duplicate global sequence".to_owned());
    }
    host.trace.begin(parsed.idle_ms, parsed.scalars)?;
    if let Some(lane) = &host.worker_trace {
        if let Err(error) = lane.begin_batch(&events) {
            host.trace.clear_transaction();
            return Err(error);
        }
    } else if !events.is_empty() {
        host.trace.clear_transaction();
        return Err("async facts require a configured native trace lane".to_owned());
    }
    Ok(())
}

/// Return the elapsed interval settled by one idle external boundary.
/// `wall_elapsed` is populated only in live/record mode; replay never reads
/// it and therefore never consults `Instant`.
pub(super) fn before_external_elapsed(
    host: &mut HostState,
    wall_elapsed: Option<f64>,
) -> Result<f64, String> {
    host.trace.before_external(wall_elapsed)
}

pub(super) fn end(host: &mut HostState) -> Result<f64, String> {
    let values = finish_transaction(host)?;
    let mut total = 0.0;
    for value in values {
        total += value;
        if !total.is_finite() {
            return Err("trace clock elapsed sum is not finite".to_owned());
        }
    }
    Ok(total)
}

pub(super) fn end_json(host: &mut HostState) -> Result<String, String> {
    finish_transaction(host)?;
    Ok(host.trace.last_json())
}

fn finish_transaction(host: &mut HostState) -> Result<Vec<f64>, String> {
    let clock_result = host.trace.finish();
    let worker_result = host.worker_trace.as_ref().map(|lane| lane.finish_batch());
    let events = match worker_result {
        Some(result) => result?,
        None => Vec::new(),
    };
    let (offload, worker): (Vec<_>, Vec<_>) = events
        .into_iter()
        .partition(|event| event.kind.starts_with("offload."));
    if (!offload.is_empty() && host.offload.is_none())
        || (!worker.is_empty() && host.worker_program.is_none())
    {
        return Err("async trace facts have no configured owner".to_owned());
    }
    host.trace.last_worker_events = host.worker_program.as_ref().map(|_| worker);
    host.trace.last_offload_events = host.offload.as_ref().map(|_| offload);
    clock_result
}

pub(super) fn last_json(host: &HostState) -> String {
    host.trace.last_json()
}

/// Called by the explicit debug-only JS wrappers for Date.now,
/// Math.random, and performance.now. In live mode the wrappers are absent.
pub(super) fn scalar_value(
    lane: &Rc<RefCell<ScalarLane>>,
    kind: &str,
    original: f64,
) -> Result<f64, String> {
    let mode = lane.borrow().mode;
    if mode == Mode::Live {
        return Ok(original);
    }
    let kind = kind.to_owned();
    match mode {
        Mode::Record => {
            validate_scalar(kind.clone(), original)?;
            let mut lane = lane.borrow_mut();
            if !lane.transaction_open {
                return Ok(original);
            }
            if lane.recorded.len() >= MAX_INTERVALS {
                if lane.failure.is_none() {
                    lane.failure = Some(format!("trace scalar quota exceeded ({MAX_INTERVALS})"));
                }
                return Ok(original);
            }
            lane.recorded.push(ScalarSample {
                kind,
                value: original,
            });
            Ok(original)
        }
        Mode::Replay => {
            let mut lane = lane.borrow_mut();
            if !lane.transaction_open {
                return Err("replay trace scalar call is outside a transaction".to_owned());
            }
            let Some(expected) = lane.replayed.get(lane.replay_index).cloned() else {
                return Err(format!(
                    "replay trace is missing scalar call {} ({kind})",
                    lane.replay_index
                ));
            };
            if expected.kind != kind {
                return Err(format!(
                    "replay trace scalar call {} expected {}, got {kind}",
                    lane.replay_index, expected.kind
                ));
            }
            lane.replay_index += 1;
            Ok(expected.value)
        }
        Mode::Live => Ok(original),
    }
}

/// Install the opt-in scalar lane. The static Date constructor itself is not
/// replaced: `new Date()` remains an explicit unsupported nondeterminism.
pub(super) fn install_scalar_hooks<'js>(
    ctx: &Ctx<'js>,
    mode: Mode,
    lane: Rc<RefCell<ScalarLane>>,
) -> rquickjs::Result<()> {
    let globals = ctx.globals();
    let pocket: Object = globals.get("pocket")?;
    if mode == Mode::Live {
        // A mode switch before first load may turn hooks off. Reinitializing a
        // guest also starts from a clean global, so all restores are guarded.
        ctx.eval::<(), _>(
            r#"(() => {
              const g = globalThis, saved = g.__pocketTraceScalarOriginals;
              if (saved) {
                if (saved.dateCtor) g.Date = saved.dateCtor;
                if (saved.mathObject) g.Math = saved.mathObject;
                if (saved.performanceObject) g.performance = saved.performanceObject;
                delete g.__pocketTraceScalarOriginals;
              }
              if (g.pocket) delete g.pocket._traceScalar;
            })();"#,
        )?;
        return Ok(());
    }
    let callback = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'_>, kind: String, original: f64| {
            scalar_value(&lane, &kind, original)
                .map_err(|error| Exception::throw_type(&ctx, error.as_str()))
        },
    )?;
    pocket.set("_traceScalar", callback)?;
    ctx.eval::<(), _>(
        r#"(() => {
          const g = globalThis;
          if (!g.__pocketTraceScalarOriginals) {
            const saved = {
              dateCtor: (g.Date && typeof g.Date.now === 'function') ? g.Date : null,
              mathObject: (g.Math && typeof g.Math.random === 'function') ? g.Math : null,
              performanceObject: (g.performance && typeof g.performance.now === 'function') ? g.performance : null,
            };
            Object.defineProperty(g, '__pocketTraceScalarOriginals', {value:saved, writable:false, configurable:true});
          }
          const p = g.pocket, traceScalar = p._traceScalar,
            saved = g.__pocketTraceScalarOriginals;
          if (saved.dateCtor) {
            const DateCtor = saved.dateCtor;
            const dateNow = () => traceScalar('dateNow', DateCtor.now());
            g.Date = new Proxy(DateCtor, {
              get:(target,key,receiver)=>key === 'now' ? dateNow : Reflect.get(target,key,receiver),
              apply:(target,thisArg,args)=>Reflect.apply(target,thisArg,args),
              construct:(target,args,newTarget)=>Reflect.construct(target,args,newTarget),
            });
          }
          if (saved.mathObject) {
            const MathObject = saved.mathObject;
            const mathRandom = () => traceScalar('mathRandom', MathObject.random());
            g.Math = new Proxy(MathObject, {get:(target,key,receiver)=>key === 'random' ? mathRandom : Reflect.get(target,key,receiver)});
          }
          if (saved.performanceObject) {
            const PerformanceObject = saved.performanceObject;
            // QuickJS exposes performance.now as an own, enumerable,
            // non-writable and non-configurable function property.  A Proxy
            // get trap is therefore not allowed to return a different
            // function for that key: the engine correctly rejects it with
            // "proxy: inconsistent get" before our scalar callback runs.
            // Clone the ordinary object instead, preserving every original
            // descriptor (including now's read-only contract) and replace
            // only the cloned value.  The original object is retained for
            // mode(0) restoration and for invoking the real clock.
            const nowDescriptor = Object.getOwnPropertyDescriptor(PerformanceObject, 'now');
            const descriptors = Object.getOwnPropertyDescriptors(PerformanceObject);
            delete descriptors.now;
            const wrappedPerformance = Object.create(
              Object.getPrototypeOf(PerformanceObject), descriptors);
            Object.defineProperty(wrappedPerformance, 'now', {
              value: () => traceScalar('performanceNow', PerformanceObject.now()),
              enumerable: nowDescriptor ? !!nowDescriptor.enumerable : false,
              writable: nowDescriptor && 'writable' in nowDescriptor ? !!nowDescriptor.writable : true,
              configurable: nowDescriptor ? !!nowDescriptor.configurable : true,
            });
            g.performance = wrappedPerformance;
          }
        })();"#,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        pocket_create, pocket_destroy, pocket_eval, pocket_frame, pocket_last_error, pocket_send,
        pocket_set_scheduler_paused, pocket_trace_clock_begin, pocket_trace_clock_begin_json,
        pocket_trace_clock_end, pocket_trace_clock_end_json, pocket_trace_clock_mode,
    };
    use std::ffi::{CStr, CString};

    #[test]
    fn ordered_arrays_round_trip() {
        let mut clock = TraceClock::default();
        clock.mode = Mode::Record;
        clock.begin(Vec::new(), Vec::new()).unwrap();
        clock.before_external(Some(12.5)).unwrap();
        clock.before_external(Some(0.0)).unwrap();
        assert_eq!(clock.finish().unwrap(), vec![12.5, 0.0]);
        assert_eq!(clock.last_json(), "{\"idleMs\":[12.5,0.0],\"scalars\":[]}");

        clock.mode = Mode::Replay;
        clock.begin(vec![12.5, 0.0], Vec::new()).unwrap();
        assert_eq!(clock.before_external(None).unwrap(), 12.5);
        assert_eq!(clock.before_external(None).unwrap(), 0.0);
        assert_eq!(clock.finish().unwrap(), vec![12.5, 0.0]);
    }

    #[test]
    fn malformed_intervals_are_rejected() {
        assert!(parse_intervals("{}").is_err());
        assert!(parse_intervals("[-1]").is_err());
        assert!(parse_intervals("[null]").is_err());
        assert!(validate_elapsed(f64::INFINITY).is_err());
        assert!(validate_elapsed(-0.1).is_err());
    }

    #[test]
    fn record_interval_quota_is_reported_at_end_without_rejecting_boundary() {
        let mut clock = TraceClock::default();
        clock.mode = Mode::Record;
        clock.begin(Vec::new(), Vec::new()).unwrap();
        for index in 0..=MAX_INTERVALS {
            let elapsed = index as f64;
            assert_eq!(clock.before_external(Some(elapsed)).unwrap(), elapsed);
        }
        let error = clock.finish().unwrap_err();
        assert!(error.contains("interval quota exceeded"), "error={error}");

        // The failed transaction is closed and its bounded marker is gone;
        // the recorder can start a fresh transaction afterwards.
        clock.begin(Vec::new(), Vec::new()).unwrap();
        assert_eq!(clock.before_external(Some(1.0)).unwrap(), 1.0);
        assert_eq!(clock.finish().unwrap(), vec![1.0]);
    }

    fn c_string(pointer: *const std::ffi::c_char) -> String {
        assert!(!pointer.is_null());
        unsafe { CStr::from_ptr(pointer).to_string_lossy().into_owned() }
    }

    #[test]
    fn quickjs_scalar_lane_replays_date_random_and_performance_values() {
        unsafe {
            let source = CString::new(
                r#"globalThis.frame=()=>{
                  pocket._emit(JSON.stringify({name:'scalar',payload:{
                    date:Date.now(), random:Math.random(),
                    performance:performance.now(),
                    descriptor:(()=>{const d=Object.getOwnPropertyDescriptor(performance,'now');
                      return {configurable:d.configurable,writable:d.writable};})()
                  }}));
                };"#,
            )
            .unwrap();

            let recorded = pocket_create(64.0, 64.0);
            assert_eq!(
                pocket_trace_clock_mode(recorded, 1),
                0,
                "{}",
                c_string(crate::pocket_last_error(recorded))
            );
            assert_eq!(
                pocket_eval(recorded, source.as_ptr()),
                0,
                "{}",
                c_string(pocket_last_error(recorded))
            );
            let empty = CString::new(r#"{"idleMs":[],"scalars":[]}"#).unwrap();
            assert_eq!(pocket_trace_clock_begin_json(recorded, empty.as_ptr()), 0);
            let recorded_frame = pocket_frame(recorded, 0.0);
            assert!(!recorded_frame.is_null());
            let recorded_frame = c_string(recorded_frame);
            let trace = c_string(pocket_trace_clock_end_json(recorded));
            let trace_value: Value = serde_json::from_str(&trace).unwrap();
            let scalars = trace_value
                .get("scalars")
                .and_then(Value::as_array)
                .unwrap_or_else(|| panic!("trace={trace}"));
            assert_eq!(
                scalars
                    .iter()
                    .filter_map(|scalar| scalar.get("kind").and_then(Value::as_str))
                    .collect::<Vec<_>>(),
                ["dateNow", "mathRandom", "performanceNow"]
            );

            let replayed = pocket_create(64.0, 64.0);
            assert_eq!(pocket_trace_clock_mode(replayed, 2), 0);
            assert_eq!(
                pocket_eval(replayed, source.as_ptr()),
                0,
                "{}",
                c_string(pocket_last_error(replayed))
            );
            let trace_input = CString::new(trace.clone()).unwrap();
            assert_eq!(
                pocket_trace_clock_begin_json(replayed, trace_input.as_ptr()),
                0
            );
            let replayed_frame = pocket_frame(replayed, 0.0);
            assert!(!replayed_frame.is_null());
            let replayed_frame = c_string(replayed_frame);
            assert_eq!(recorded_frame, replayed_frame);
            assert_eq!(c_string(pocket_trace_clock_end_json(replayed)), trace);
            pocket_destroy(recorded);
            pocket_destroy(replayed);
        }
    }

    #[test]
    fn record_scalar_quota_keeps_guest_frame_and_end_reports_quota() {
        unsafe {
            let source = CString::new(
                r#"globalThis.frame=()=>{
                  let calls=0;
                  for(let i=0;i<4097;i++){ Math.random(); calls++; }
                  pocket._emit(JSON.stringify({name:'quota',payload:{calls}}));
                };"#,
            )
            .unwrap();
            let empty = CString::new(r#"{"idleMs":[],"scalars":[]}"#).unwrap();

            let recorded = pocket_create(64.0, 64.0);
            assert_eq!(pocket_trace_clock_mode(recorded, 1), 0);
            assert_eq!(pocket_eval(recorded, source.as_ptr()), 0);
            assert_eq!(pocket_trace_clock_begin_json(recorded, empty.as_ptr()), 0);
            let recorded_frame = pocket_frame(recorded, 0.0);
            assert!(!recorded_frame.is_null());
            assert!(c_string(pocket_last_error(recorded)).is_empty());
            let recorded_frame = c_string(recorded_frame);
            let recorded_value: Value = serde_json::from_str(&recorded_frame).unwrap();
            assert_eq!(recorded_value["events"][0]["payload"]["calls"], 4097);

            // The guest transaction remains successful, but the recording is
            // explicitly rejected at end rather than being reported as a
            // complete, silently truncated tape.
            assert!(pocket_trace_clock_end_json(recorded).is_null());
            let error = c_string(pocket_last_error(recorded));
            assert!(error.contains("scalar quota exceeded"), "error={error}");

            let live = pocket_create(64.0, 64.0);
            assert_eq!(pocket_eval(live, source.as_ptr()), 0);
            let live_frame = pocket_frame(live, 0.0);
            assert!(!live_frame.is_null());
            assert_eq!(recorded_frame, c_string(live_frame));

            pocket_destroy(recorded);
            pocket_destroy(live);
        }
    }

    #[test]
    fn replay_uses_recorded_idle_interval_when_real_sleep_changes() {
        unsafe {
            let source = CString::new(
                r#"let virtualFrame=-1,due=null,calls=0;
                globalThis.frame=()=>{virtualFrame++;calls++;
                  if(due!==null&&virtualFrame>=due){due=null;
                    pocket._emit(JSON.stringify({name:'timer.fired',payload:{virtualFrame,calls}}));}};
                globalThis.__pocketWorkState=()=>({version:1,continuous:false,simulationHz:60,
                  framesUntilTimer:due===null?null:due-Math.max(0,virtualFrame)});
                globalThis.__pocketSkipIdleFrames=(n)=>{const limit=due===null?n:Math.max(0,due-virtualFrame-1);
                  const skipped=Math.max(0,Math.min(n,limit));virtualFrame+=skipped;return skipped;};
                globalThis.__pocketEvent=()=>{due=virtualFrame+3;
                  pocket._emit(JSON.stringify({name:'timer.registered',payload:{virtualFrame,due}}));};"#,
            )
            .unwrap();
            let empty = CString::new(r#"{"idleMs":[],"scalars":[]}"#).unwrap();

            let recorded = pocket_create(64.0, 64.0);
            assert_eq!(pocket_trace_clock_mode(recorded, 1), 0);
            assert_eq!(pocket_eval(recorded, source.as_ptr()), 0);
            pocket_frame(recorded, 0.0);
            assert_eq!(pocket_trace_clock_begin_json(recorded, empty.as_ptr()), 0);
            std::thread::sleep(std::time::Duration::from_millis(110));
            let register = CString::new(r#"{"type":"event","name":"register"}"#).unwrap();
            assert_eq!(pocket_send(recorded, register.as_ptr()), 0);
            let trace = c_string(pocket_trace_clock_end_json(recorded));
            let trace_value: Value = serde_json::from_str(&trace).unwrap();
            assert_eq!(trace_value["scalars"], Value::Array(Vec::new()));
            assert_eq!(trace_value["idleMs"].as_array().unwrap().len(), 1);
            let recorded_frame = c_string(pocket_frame(recorded, 500.0));

            let replayed = pocket_create(64.0, 64.0);
            assert_eq!(pocket_trace_clock_mode(replayed, 2), 0);
            assert_eq!(pocket_eval(replayed, source.as_ptr()), 0);
            pocket_frame(replayed, 0.0);
            let trace_input = CString::new(trace.clone()).unwrap();
            assert_eq!(
                pocket_trace_clock_begin_json(replayed, trace_input.as_ptr()),
                0
            );
            // Deliberately unlike the record: replay must never use this
            // wall-clock duration to settle the timer.
            std::thread::sleep(std::time::Duration::from_millis(260));
            assert_eq!(pocket_send(replayed, register.as_ptr()), 0);
            assert_eq!(
                serde_json::from_str::<Value>(&c_string(pocket_trace_clock_end_json(replayed)))
                    .unwrap(),
                serde_json::from_str::<Value>(&trace).unwrap()
            );
            let replayed_frame = c_string(pocket_frame(replayed, 500.0));
            assert_eq!(replayed_frame, recorded_frame);

            pocket_destroy(recorded);
            pocket_destroy(replayed);
        }
    }

    #[test]
    fn replay_zero_tick_keeps_promise_continuation_until_real_tick() {
        unsafe {
            let source = CString::new(
                r#"let frames=0,continuations=0,resolveExternal;
                new Promise(resolve=>{resolveExternal=resolve;}).then(()=>{continuations++;});
                globalThis.frame=()=>{frames++;};
                globalThis.__pocketWorkState=()=>({version:1,continuous:false,simulationHz:60,framesUntilTimer:null});
                globalThis.__pocketSkipIdleFrames=n=>{frames+=n;return n;};
                globalThis.__pocketEvent=()=>{resolveExternal();};
                globalThis.__state=()=>({frames,continuations});"#,
            )
            .unwrap();
            let host = pocket_create(64.0, 64.0);
            assert_eq!(pocket_trace_clock_mode(host, 2), 0);
            assert_eq!(pocket_eval(host, source.as_ptr()), 0);
            pocket_frame(host, 1000.0 / 60.0);
            let message = CString::new(r#"{"type":"event","name":"resolve"}"#).unwrap();
            let trace = CString::new(r#"{"idleMs":[0],"scalars":[]}"#).unwrap();
            assert_eq!(pocket_trace_clock_begin_json(host, trace.as_ptr()), 0);
            assert_eq!(pocket_send(host, message.as_ptr()), 0);
            let _ = c_string(pocket_trace_clock_end_json(host));
            assert_eq!(host.as_ref().unwrap().guest.has_pending_jobs(), true);
            // The credited zero elapsed boundary cannot drain a QuickJS job.
            pocket_frame(host, 0.0);
            let state = host
                .as_ref()
                .unwrap()
                .guest
                .with_turn(|ctx| {
                    let function: rquickjs::Function = ctx.globals().get("__state")?;
                    let value: rquickjs::Object = function.call(())?;
                    Ok::<(u32, u32), rquickjs::Error>((
                        value.get("frames")?,
                        value.get("continuations")?,
                    ))
                })
                .unwrap()
                .unwrap();
            assert_eq!(state.1, 0);
            pocket_frame(host, 1000.0 / 60.0);
            let state = host
                .as_ref()
                .unwrap()
                .guest
                .with_turn(|ctx| {
                    let function: rquickjs::Function = ctx.globals().get("__state")?;
                    let value: rquickjs::Object = function.call(())?;
                    Ok::<(u32, u32), rquickjs::Error>((
                        value.get("frames")?,
                        value.get("continuations")?,
                    ))
                })
                .unwrap()
                .unwrap();
            assert_eq!(state.1, 1);
            pocket_destroy(host);
        }
    }

    #[test]
    fn trace_clock_rejects_invalid_modes_transactions_and_replay_payloads() {
        unsafe {
            let host = pocket_create(64.0, 64.0);
            assert_eq!(pocket_trace_clock_mode(host, 99), -1);
            assert_eq!(pocket_trace_clock_mode(host, 2), 0);
            assert_eq!(pocket_trace_clock_begin(host, -1.0), -1);
            assert_eq!(
                pocket_trace_clock_begin_json(host, CString::new("{}").unwrap().as_ptr()),
                -1
            );
            let valid = CString::new(r#"{"idleMs":[1],"scalars":[]}"#).unwrap();
            assert_eq!(pocket_trace_clock_begin_json(host, valid.as_ptr()), 0);
            // No matching idle boundary was reached, so end reports the
            // replay divergence and closes the transaction for recovery.
            assert!(pocket_trace_clock_end_json(host).is_null());
            assert!(!c_string(pocket_last_error(host)).is_empty());
            assert!(pocket_trace_clock_end(host).is_nan());
            pocket_destroy(host);
        }
    }

    #[test]
    fn trace_mode_cannot_change_after_guest_eval_and_live_remains_wall_clock_compatible() {
        unsafe {
            let host = pocket_create(64.0, 64.0);
            let source = CString::new("globalThis.frame=()=>{};").unwrap();
            assert_eq!(pocket_trace_clock_mode(host, 1), 0);
            assert_eq!(pocket_eval(host, source.as_ptr()), 0);
            assert_eq!(pocket_trace_clock_mode(host, 2), -1);
            assert_eq!(pocket_trace_clock_mode(host, 0), 0);
            // A live runtime keeps the historical unbracketed FFI path; this
            // separate handle verifies mode 0 does not require begin/end.
            let live = pocket_create(64.0, 64.0);
            assert_eq!(pocket_eval(live, source.as_ptr()), 0);
            let message = CString::new(r#"{"type":"event","name":"noop"}"#).unwrap();
            assert_eq!(pocket_send(live, message.as_ptr()), 0);
            pocket_destroy(host);
            pocket_destroy(live);
        }
    }

    #[test]
    fn live_mode_disables_an_active_debug_lane_after_guest_load() {
        unsafe {
            let source = CString::new(
                r#"globalThis.__originalPerformance =
                  globalThis.__pocketTraceScalarOriginals.performanceObject;
                const cachedDateNow = Date.now;
                const cachedMathRandom = Math.random;
                const cachedPerformanceNow = performance.now;
                globalThis.frame=()=>{
                  const descriptor=Object.getOwnPropertyDescriptor(performance,'now');
                  if (descriptor.configurable || descriptor.writable)
                    throw new Error('performance.now descriptor was relaxed');
                  const restored=performance===globalThis.__originalPerformance;
                  const date=cachedDateNow();
                  const random=cachedMathRandom();
                  const performanceValue=cachedPerformanceNow();
                  pocket._emit(JSON.stringify({name:'mode',payload:{
                    restored,date,random,performance:performanceValue,
                    dateIdentity:Date.now===Date.now,
                    randomIdentity:Math.random===Math.random,
                    performanceIdentity:performance.now===performance.now
                  }}));
                };"#,
            )
            .unwrap();
            let host = pocket_create(64.0, 64.0);
            assert_eq!(pocket_trace_clock_mode(host, 1), 0);
            assert_eq!(pocket_eval(host, source.as_ptr()), 0);
            let empty = CString::new(r#"{"idleMs":[],"scalars":[]}"#).unwrap();
            assert_eq!(pocket_trace_clock_begin_json(host, empty.as_ptr()), 0);
            let recorded = c_string(pocket_frame(host, 0.0));
            let recorded: Value = serde_json::from_str(&recorded).unwrap();
            assert_eq!(recorded["events"][0]["payload"]["restored"], false);
            assert_eq!(recorded["events"][0]["payload"]["dateIdentity"], true);
            assert_eq!(recorded["events"][0]["payload"]["randomIdentity"], true);
            assert_eq!(
                recorded["events"][0]["payload"]["performanceIdentity"],
                true
            );
            assert!(!pocket_trace_clock_end_json(host).is_null());
            // Recording is explicitly disabled after load; the wrapper is
            // restored and the lane is cleared instead of accumulating.
            assert_eq!(pocket_trace_clock_mode(host, 0), 0);
            assert_eq!(pocket_trace_clock_begin_json(host, empty.as_ptr()), 0);
            // A zero-delta poll need not execute the guest frame. Use one
            // real fixed tick so the restored globals are exercised.
            let live = c_string(pocket_frame(host, 1000.0 / 60.0));
            let live: Value = serde_json::from_str(&live).unwrap();
            assert_eq!(live["events"][0]["payload"]["restored"], true);
            assert_eq!(live["events"][0]["payload"]["dateIdentity"], true);
            assert_eq!(live["events"][0]["payload"]["randomIdentity"], true);
            assert_eq!(live["events"][0]["payload"]["performanceIdentity"], true);
            assert_eq!(
                c_string(pocket_trace_clock_end_json(host)),
                r#"{"idleMs":[],"scalars":[]}"#
            );
            pocket_destroy(host);
        }
    }

    #[test]
    fn paused_external_input_does_not_consume_replay_idle_and_reset_keeps_mode() {
        unsafe {
            let source = CString::new(
                r#"globalThis.frame=()=>{};
                globalThis.__pocketWorkState=()=>({version:1,continuous:false,simulationHz:60,framesUntilTimer:null});
                globalThis.__pocketSkipIdleFrames=n=>n;"#,
            )
            .unwrap();
            let host = pocket_create(64.0, 64.0);
            assert_eq!(pocket_trace_clock_mode(host, 2), 0);
            assert_eq!(pocket_eval(host, source.as_ptr()), 0);
            pocket_frame(host, 1000.0 / 60.0);

            let pause_trace = CString::new(r#"{"idleMs":[0],"scalars":[]}"#).unwrap();
            assert_eq!(pocket_trace_clock_begin_json(host, pause_trace.as_ptr()), 0);
            pocket_set_scheduler_paused(host, 1);
            let pause_output: Value =
                serde_json::from_str(&c_string(pocket_trace_clock_end_json(host))).unwrap();
            assert_eq!(pause_output["idleMs"][0].as_f64(), Some(0.0));
            assert!(pause_output["scalars"].as_array().unwrap().is_empty());

            // While paused, an external event is dispatched but elapsed idle
            // settlement is deliberately skipped, so its transaction array
            // is empty rather than inventing background time.
            let empty = CString::new(r#"{"idleMs":[],"scalars":[]}"#).unwrap();
            assert_eq!(pocket_trace_clock_begin_json(host, empty.as_ptr()), 0);
            let message = CString::new(r#"{"type":"event","name":"noop"}"#).unwrap();
            assert_eq!(pocket_send(host, message.as_ptr()), 0);
            let empty_output: Value =
                serde_json::from_str(&c_string(pocket_trace_clock_end_json(host))).unwrap();
            assert!(empty_output["idleMs"].as_array().unwrap().is_empty());
            assert!(empty_output["scalars"].as_array().unwrap().is_empty());
            pocket_set_scheduler_paused(host, 0);

            crate::reset_host_for_load(&mut *host);
            assert_eq!(mode(&*host), Mode::Replay);
            pocket_destroy(host);
        }
    }
}
