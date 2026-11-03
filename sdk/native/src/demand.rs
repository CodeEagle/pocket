//! Demand scheduling adapts the existing deterministic frame clock; it does
//! not introduce a second JS event loop. Only proven quiescent frames may be
//! skipped. Unknown guests retain the ordinary continuous fixed-step path.
use std::time::Instant;

use rquickjs::{Function, Object};

use super::{quickjs_error, replay, HostState};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Work {
    Continuous,
    Idle { timer_frames: Option<u64> },
}

impl Work {
    fn delay_ms(self, hz: u32, remainder_ms: f64) -> f64 {
        match self {
            Self::Continuous => 0.0,
            Self::Idle { timer_frames: None } => -1.0,
            Self::Idle {
                timer_frames: Some(frames),
            } => (frames as f64 * 1000.0 / hz as f64 - remainder_ms).max(0.0),
        }
    }

    fn skippable(self, frames: u64) -> u64 {
        match self {
            Self::Continuous => 0,
            // The due frame itself must execute the ordinary frame pump.
            Self::Idle {
                timer_frames: Some(due),
            } => frames.min(due.saturating_sub(1)),
            Self::Idle { timer_frames: None } => frames,
        }
    }
}

pub(super) struct Demand {
    work: Work,
    idle_anchor: Option<Instant>,
    /// Replay uses a logical marker instead of an Instant. It is set by the
    /// same captured work state and makes before_external consume only an
    /// interval that was actually idle in the recording.
    trace_idle_pending: bool,
    // External guest entries settle elapsed idle time before delivering the
    // message. Credit that time against the next display delta exactly once.
    elapsed_credit_ms: f64,
    paused: bool,
}

impl Default for Demand {
    fn default() -> Self {
        Self {
            work: Work::Continuous,
            idle_anchor: None,
            trace_idle_pending: false,
            elapsed_credit_ms: 0.0,
            paused: false,
        }
    }
}

pub(super) fn invalidate(host: &mut HostState) {
    host.demand.work = Work::Continuous;
    host.demand.idle_anchor = None;
    host.demand.trace_idle_pending = false;
}

/// Leaving replay must restore a real idle anchor before the next live
/// external boundary. Record mode already has an Instant anchor, so only the
/// replay-only logical marker needs conversion.
pub(super) fn leave_replay(host: &mut HostState) {
    if host.demand.trace_idle_pending && host.demand.idle_anchor.is_none() {
        host.demand.idle_anchor = Some(Instant::now());
    }
    host.demand.trace_idle_pending = false;
}

pub(super) fn delay_ms(host: &HostState) -> f64 {
    host.demand
        .work
        .delay_ms(host.tick_hz, host.tick_remainder_ms)
}

pub(super) fn capture(host: &mut HostState) {
    if host.demand.paused {
        invalidate(host);
        return;
    }
    // An externally dispatched response can queue a QuickJS Promise job
    // without advancing a virtual frame. Keep the view awake until a real
    // fixed tick runs `Guest::frame` and drains that job queue.
    let guest_jobs_pending = host.guest.has_pending_jobs();
    let work = read_guest_work(host).unwrap_or(Work::Continuous);
    let core_pending = host
        .ops
        .core()
        .map(|core| core.ui.has_pending_work())
        .unwrap_or(true);
    host.demand.work = if host.external_work_pending
        || guest_jobs_pending
        || core_pending
        || !host.pending_text.is_empty()
        || !host.touches.is_empty()
        || host.buttons != 0
        || !host.axis_deltas.is_empty()
        || host.motion.is_some()
        || host.analog != 0x8080
        || host.right_analog != 0x8080
        || host.offload.as_ref().is_some_and(|offload| offload.has_replies())
    {
        Work::Continuous
    } else {
        work
    };
    if replay::is_replay(host) {
        host.demand.idle_anchor = None;
        host.demand.trace_idle_pending = matches!(host.demand.work, Work::Idle { .. });
    } else {
        host.demand.trace_idle_pending = false;
        host.demand.idle_anchor = match host.demand.work {
            Work::Idle { .. } => {
                if host.demand.idle_anchor.is_none() {
                    host.demand.elapsed_credit_ms = 0.0;
                }
                Some(Instant::now())
            }
            Work::Continuous => None,
        };
    }
}

fn read_guest_work(host: &HostState) -> Option<Work> {
    host.guest.with_turn(|ctx| {
        let result = (|| -> rquickjs::Result<Option<Work>> {
            let function: Option<Function> = ctx.globals().get("__pocketWorkState")?;
            let Some(function) = function else {
                return Ok(None);
            };
            let skip: Option<Function> = ctx.globals().get("__pocketSkipIdleFrames")?;
            if skip.is_none() {
                return Ok(None);
            }
            let state: Object = function.call(())?;
            let version: u32 = state.get("version")?;
            let hz: f64 = state.get("simulationHz")?;
            let continuous: bool = state.get("continuous")?;
            if version != 1 || hz != host.tick_hz as f64 || continuous {
                return Ok(Some(Work::Continuous));
            }
            let timer: Option<f64> = state.get("framesUntilTimer")?;
            let timer_frames = match timer {
                Some(n)
                    if n.is_finite()
                        && n >= 1.0
                        && n.fract() == 0.0
                        && n <= 9_007_199_254_740_991.0 =>
                {
                    Some(n as u64)
                }
                Some(_) => return Ok(Some(Work::Continuous)),
                None => None,
            };
            Ok(Some(Work::Idle { timer_frames }))
        })();
        // Invalid/legacy scheduling is a conservative continuous fallback.
        // Clear a thrown exception so it cannot poison the next guest turn.
        match result {
            Ok(work) => work,
            Err(error) => {
                let _ = quickjs_error(&ctx, error);
                None
            }
        }
    })?
}

/// Consume a display delta, retaining fractional fixed-step time and skipping
/// only idle virtual frames. Active catch-up still uses the existing bounds.
pub(super) fn ticks_for_delta(host: &mut HostState, delta_ms: f64) -> Result<u32, String> {
    if host.demand.paused {
        return Ok(0);
    }
    let delta_ms = if delta_ms.is_finite() {
        delta_ms.max(0.0)
    } else {
        0.0
    };
    let credit = delta_ms.min(host.demand.elapsed_credit_ms);
    host.demand.elapsed_credit_ms -= credit;
    advance(host, delta_ms - credit)
}

fn advance(host: &mut HostState, delta_ms: f64) -> Result<u32, String> {
    let step = 1000.0 / host.tick_hz as f64;
    let frames = ((delta_ms + host.tick_remainder_ms + super::CLOCK_EPSILON_MS) / step)
        .floor()
        .max(0.0)
        .min(9_007_199_254_740_991.0) as u64;
    let skip = if host.clock_started {
        host.demand.work.skippable(frames)
    } else {
        0
    };
    let mut skipped = 0;
    if skip > 0
        && !host
            .ops
            .core()
            .map_err(|e| format!("{e:?}"))?
            .ui
            .has_pending_work()
    {
        skipped = host
            .guest
            .with_turn(|ctx| -> Result<u64, String> {
                let function: Function = ctx
                    .globals()
                    .get("__pocketSkipIdleFrames")
                    .map_err(|e| quickjs_error(&ctx, e))?;
                let result: f64 = function
                    .call((skip as f64,))
                    .map_err(|e| quickjs_error(&ctx, e))?;
                if !result.is_finite()
                    || result < 0.0
                    || result.fract() != 0.0
                    || result > skip as f64
                {
                    return Err("invalid idle clock skip result".to_owned());
                }
                Ok(result as u64)
            })
            .ok_or_else(|| "guest context is not initialized".to_owned())??;
        if skipped > 0 {
            if !host
                .ops
                .core_mut()
                .map_err(|e| format!("{e:?}"))?
                .ui
                .skip_idle_ticks(skipped)
            {
                return Err("core became active during idle clock skip".to_owned());
            }
            if let Work::Idle {
                timer_frames: Some(ref mut due),
            } = host.demand.work
            {
                *due -= skipped;
            }
        }
    }
    let remaining = if skipped > 0 {
        // Skips may consume part of the carried fraction as well as this
        // delta (e.g. 10ms carried + 10ms incoming at 60Hz).
        let remaining = delta_ms + host.tick_remainder_ms - skipped as f64 * step;
        host.tick_remainder_ms = 0.0;
        remaining.max(0.0)
    } else {
        delta_ms
    };
    Ok(super::fixed_tick_count(host, remaining))
}

/// Settle elapsed idle time before an externally delivered response/input is
/// allowed to register new virtual timers. This preserves relative deadlines
/// even when the previous display transaction happened many seconds ago.
pub(super) fn before_external(host: &mut HostState) -> Result<(), String> {
    if host.demand.paused {
        invalidate(host);
        return Ok(());
    }
    let wall_elapsed = if replay::is_replay(host) {
        // Replay must never consult a wall clock. The logical marker is set
        // by capture() when the previous transaction was proven idle.
        host.demand.trace_idle_pending.then_some(0.0)
    } else {
        host.demand
            .idle_anchor
            .take()
            .map(|anchor| anchor.elapsed().as_secs_f64() * 1000.0)
    };
    if wall_elapsed.is_some() {
        let elapsed = replay::before_external_elapsed(host, wall_elapsed)?;
        let ticks = advance(host, elapsed)?;
        if ticks > 0 {
            super::run_virtual_frames(host, Vec::new(), ticks)?;
        }
        host.demand.elapsed_credit_ms += elapsed;
    }
    invalidate(host);
    Ok(())
}

pub(super) fn set_paused(host: &mut HostState, paused: bool) -> Result<(), String> {
    if host.demand.paused == paused {
        return Ok(());
    }
    if paused {
        before_external(host)?;
    }
    host.demand.paused = paused;
    host.demand.elapsed_credit_ms = 0.0;
    invalidate(host);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{
        pocket_create, pocket_destroy, pocket_eval, pocket_frame, pocket_next_wake_delay_ms,
        pocket_send,
    };
    use super::*;
    use std::ffi::{CStr, CString};

    // A protocol guest isolates native clock accounting. Framework timer and
    // activity semantics are also tested against the actual pinned JS patch.
    const TIMER_GUEST: &str = r#"
      let virtual = -1, due = 300, calls = 0;
      globalThis.frame = () => {
        virtual++; calls++;
        if (due !== null && virtual >= due) {
          due = null;
          pocket._emit(JSON.stringify({name:'timer.fired', payload:{virtual,calls}}));
        }
      };
      globalThis.__pocketWorkState = () => ({version:1,continuous:false,
        simulationHz:60,framesUntilTimer:due === null ? null : due-Math.max(0,virtual)});
      globalThis.__pocketSkipIdleFrames = n => {
        const skipped = Math.max(0, Math.min(n, due === null ? n : due-virtual-1));
        virtual += skipped; return skipped;
      };
      globalThis.__pocketEvent = () => {
        due = virtual + 300;
        pocket._emit(JSON.stringify({name:'timer.registered',payload:{virtual,due}}));
      };
    "#;

    unsafe fn frame(host: *mut HostState, elapsed: f64) -> serde_json::Value {
        let output = pocket_frame(host, elapsed);
        assert!(!output.is_null());
        let value: serde_json::Value =
            serde_json::from_slice(CStr::from_ptr(output).to_bytes()).unwrap();
        assert!(value.get("error").is_none(), "{value}");
        value
    }

    unsafe fn timer_host() -> *mut HostState {
        let host = pocket_create(64.0, 64.0);
        assert_eq!(
            pocket_eval(host, CString::new(TIMER_GUEST).unwrap().as_ptr()),
            0
        );
        frame(host, 0.0);
        host
    }

    #[test]
    fn only_quiescent_frames_before_timer_can_be_skipped() {
        assert_eq!(Work::Continuous.skippable(10_000), 0);
        assert_eq!(Work::Idle { timer_frames: None }.skippable(10_000), 10_000);
        assert_eq!(
            Work::Idle {
                timer_frames: Some(300)
            }
            .skippable(10_000),
            299
        );
        assert_eq!(
            Work::Idle {
                timer_frames: Some(1)
            }
            .skippable(1),
            0
        );
    }

    #[test]
    fn deadlines_preserve_fractional_fixed_step_remainder() {
        assert_eq!(Work::Continuous.delay_ms(60, 0.0), 0.0);
        assert_eq!(Work::Idle { timer_frames: None }.delay_ms(60, 0.0), -1.0);
        let delay = Work::Idle {
            timer_frames: Some(300),
        }
        .delay_ms(60, 0.25);
        assert!((delay - 4999.75).abs() < 1e-9);
    }

    #[test]
    fn native_long_deadline_fast_forwards_without_guest_poll_frames() {
        unsafe {
            let host = timer_host();
            assert_eq!(pocket_next_wake_delay_ms(host), 5000.0);
            let output = frame(host, 5000.0);
            assert_eq!(output["events"][0]["name"], "timer.fired");
            assert_eq!(output["events"][0]["payload"]["virtual"], 300);
            assert_eq!(output["events"][0]["payload"]["calls"], 2);
            assert_eq!(pocket_next_wake_delay_ms(host), -1.0);
            pocket_destroy(host);
        }
    }

    #[test]
    fn native_idle_skip_consumes_the_carried_fraction_once() {
        unsafe {
            let host = timer_host();
            frame(host, 10.0);
            frame(host, 10.0);
            assert!((pocket_next_wake_delay_ms(host) - 4980.0).abs() < 1e-6);
            let output = frame(host, 4980.0);
            assert_eq!(output["events"][0]["payload"]["virtual"], 300);
            assert_eq!(output["events"][0]["payload"]["calls"], 2);
            pocket_destroy(host);
        }
    }

    #[test]
    fn external_registration_uses_settled_idle_clock_and_credits_elapsed_delta() {
        unsafe {
            let host = timer_host();
            (*host).demand.idle_anchor = Some(Instant::now() - std::time::Duration::from_secs(2));
            let message = CString::new(r#"{"type":"event","name":"register"}"#).unwrap();
            assert_eq!(pocket_send(host, message.as_ptr()), 0);
            assert_eq!(
                pocket_next_wake_delay_ms(host),
                0.0,
                "external work forces a real frame"
            );
            let output = frame(host, 2000.0 + 1000.0 / 30.0);
            let registered = &output["events"][0]["payload"];
            assert_eq!(registered["virtual"], 120);
            assert_eq!(registered["due"], 420);
            let delay = pocket_next_wake_delay_ms(host);
            assert!(
                delay > 4900.0 && delay < 5000.0,
                "elapsed was counted twice: {delay}"
            );
            let output = frame(host, delay);
            assert_eq!(output["events"][0]["payload"]["virtual"], 420);
            pocket_destroy(host);
        }
    }

    #[test]
    fn legacy_or_incomplete_contract_never_parks_the_guest() {
        unsafe {
            let host = pocket_create(64.0, 64.0);
            let source = CString::new("globalThis.frame=()=>{}; globalThis.__pocketWorkState=()=>({version:1,continuous:false,simulationHz:60,framesUntilTimer:null});").unwrap();
            assert_eq!(pocket_eval(host, source.as_ptr()), 0);
            frame(host, 0.0);
            assert_eq!(pocket_next_wake_delay_ms(host), 0.0);
            pocket_destroy(host);
        }
    }

    #[test]
    fn lifecycle_pause_excludes_background_time_from_external_timers() {
        unsafe {
            let host = timer_host();
            set_paused(&mut *host, true).unwrap();
            assert!((*host).demand.idle_anchor.is_none());
            // A response delivered while backgrounded must not acquire an
            // idle wall-time anchor or advance the virtual clock.
            let message = CString::new(r#"{"type":"event","name":"register"}"#).unwrap();
            assert_eq!(pocket_send(host, message.as_ptr()), 0);
            set_paused(&mut *host, false).unwrap();
            let output = frame(host, 1000.0 / 60.0);
            assert_eq!(output["events"][0]["payload"]["virtual"], 0);
            assert!(pocket_next_wake_delay_ms(host) > 4900.0);
            pocket_destroy(host);
        }
    }

    #[test]
    fn an_idle_guest_receives_a_fresh_bounded_external_execution_turn() {
        unsafe {
            let host = timer_host();
            let source = CString::new(
                r#"globalThis.__pocketEvent=()=>{
                let total=0; for(let i=0;i<60000;i++) total+=i;
                pocket._emit(JSON.stringify({name:'external.completed',payload:{total}}));
            };"#,
            )
            .unwrap();
            assert_eq!(pocket_eval(host, source.as_ptr()), 0);
            frame(host, 1000.0 / 60.0);
            std::thread::sleep(std::time::Duration::from_millis(300));
            let message = CString::new(r#"{"type":"event","name":"wake"}"#).unwrap();
            assert_eq!(pocket_send(host, message.as_ptr()), 0);
            let output = frame(host, 0.0);
            assert_eq!(output["events"][0]["name"], "external.completed");
            assert_eq!(output["events"][0]["payload"]["total"], 1_799_970_000u64);
            pocket_destroy(host);
        }
    }

    #[test]
    fn pending_promise_jobs_keep_idle_guest_awake_without_advancing_a_zero_tick() {
        unsafe {
            let host = pocket_create(64.0, 64.0);
            let source = CString::new(
                r#"let virtualFrame = 0, continuation = 0, resolveExternal;
                new Promise((resolve) => { resolveExternal = resolve; })
                  .then(() => { continuation++; });
                globalThis.frame = () => { virtualFrame++; };
                globalThis.__pocketWorkState = () => ({version:1,continuous:false,
                  simulationHz:60,framesUntilTimer:null});
                globalThis.__pocketSkipIdleFrames = (n) => { virtualFrame += n; return n; };
                globalThis.__pocketEvent = () => { resolveExternal(); };
                globalThis.__promiseState = () => ({virtualFrame, continuation});"#,
            )
            .unwrap();
            assert_eq!(pocket_eval(host, source.as_ptr()), 0);
            frame(host, 1000.0 / 60.0);
            assert_eq!(promise_state(host), (1, 0));
            assert_eq!(pocket_next_wake_delay_ms(host), -1.0);

            // The legacy policy sees no framework work or timer and therefore
            // would park even though resolving the external Promise queued a
            // QuickJS job which no Guest::frame has drained yet.
            let message = CString::new(r#"{"type":"event","name":"resolve"}"#).unwrap();
            assert_eq!(pocket_send(host, message.as_ptr()), 0);
            assert_eq!(promise_state(host).1, 0);
            assert!(host.as_ref().unwrap().guest.has_pending_jobs());
            let legacy_work = read_guest_work(host.as_ref().unwrap()).unwrap();
            assert_eq!(legacy_work, Work::Idle { timer_frames: None });
            assert_eq!(legacy_work.delay_ms(60, 0.0), -1.0);

            let credited_delta = host.as_ref().unwrap().demand.elapsed_credit_ms;
            let state_before_zero_tick = promise_state(host);
            frame(host, credited_delta);
            assert_eq!(promise_state(host), state_before_zero_tick);
            assert_eq!(
                promise_state(host).1,
                0,
                "zero ticks must not drain Promise jobs"
            );
            assert_eq!(
                pocket_next_wake_delay_ms(host),
                0.0,
                "pending jobs must request the next real tick"
            );

            frame(host, 1000.0 / 60.0);
            assert_eq!(promise_state(host), (state_before_zero_tick.0 + 1, 1));
            assert!(!host.as_ref().unwrap().guest.has_pending_jobs());
            assert_eq!(
                pocket_next_wake_delay_ms(host),
                -1.0,
                "drained jobs allow the guest to park again"
            );
            pocket_destroy(host);
        }
    }

    unsafe fn promise_state(host: *mut HostState) -> (u32, u32) {
        host.as_ref()
            .unwrap()
            .guest
            .with_turn(|ctx| {
                let read: Function = ctx.globals().get("__promiseState")?;
                let state: Object = read.call(())?;
                Ok::<(u32, u32), rquickjs::Error>((
                    state.get("virtualFrame")?,
                    state.get("continuation")?,
                ))
            })
            .unwrap()
            .unwrap()
    }
}
