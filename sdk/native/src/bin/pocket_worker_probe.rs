//! Small native integration probe used by worker tests.
//!
//! It starts the same Rust/C runner used by PocketRuntime, attaches a real
//! QuickJS UI channel context, submits bounded channel records, and waits for
//! the C runner's wake callback. It does not emulate worker turns.

use pocket_flutter::worker::{
    WorkerDeclaration, WorkerLimits, WorkerPolicy, WorkerRuntime, WorkerUiBridge,
};
use rquickjs::{Context, Runtime as JsRuntime};
use std::error::Error;
use std::fs;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

struct WakeSignal {
    epoch: Mutex<u64>,
    changed: Condvar,
}
impl WakeSignal {
    fn global() -> &'static Self {
        static SIGNAL: OnceLock<WakeSignal> = OnceLock::new();
        SIGNAL.get_or_init(|| WakeSignal { epoch: Mutex::new(0), changed: Condvar::new() })
    }
    fn snapshot(&self) -> u64 {
        *self.epoch.lock().unwrap_or_else(|poison| poison.into_inner())
    }
    fn wake(&self) {
        let mut epoch = self.epoch.lock().unwrap_or_else(|poison| poison.into_inner());
        *epoch = epoch.wrapping_add(1);
        self.changed.notify_all();
    }
    fn wait_change(&self, seen: u64, timeout: Duration) {
        let epoch = self.epoch.lock().unwrap_or_else(|poison| poison.into_inner());
        if *epoch != seen { return; }
        let _ = self.changed.wait_timeout_while(epoch, timeout, |value| *value == seen)
            .unwrap_or_else(|poison| poison.into_inner());
    }
}

unsafe extern "C" fn on_worker_wake() {
    WakeSignal::global().wake();
}

fn argument(args: &[String], name: &str) -> Result<String, Box<dyn Error>> {
    let index = args.iter().position(|arg| arg == name)
        .ok_or_else(|| format!("missing argument {name}"))?;
    args.get(index + 1).cloned().ok_or_else(|| format!("missing value for {name}").into())
}

fn run() -> Result<(), Box<dyn Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let bytecode = fs::read(argument(&args, "--bytecode")?)?;
    let declaration: WorkerDeclaration = serde_json::from_str(&argument(&args, "--declaration")?)?;
    let origin = argument(&args, "--origin")?;
    let cancel = args.iter().any(|arg| arg == "--cancel");
    let mut worker = WorkerRuntime::spawn(
        &bytecode,
        pocket_spec::BINDING_GENERATION,
        60,
        declaration,
        WorkerPolicy {
            allowed_http_origins: vec![origin],
            required_capabilities: vec!["net.http".to_owned()],
        },
        WorkerLimits::default(),
        Some(on_worker_wake),
    )?;
    worker.wait_ready(Duration::from_secs(2))?;

    let ui_runtime = JsRuntime::new()?;
    let ui_context = Context::full(&ui_runtime)?;
    let compute = if cancel { "[2,2,3]" } else { "[1,2,3]" };
    let cancel_command = if cancel {
        "__pocketWorkerChannels.publish(2,new Uint8Array([9]));"
    } else {
        ""
    };
    let mut bridge = ui_context.with(|ctx| -> Result<WorkerUiBridge, Box<dyn Error>> {
        let bridge = unsafe { worker.attach_ui(ctx.as_raw().as_ptr()) }?;
        let setup = format!(
            "__pocketWorkerChannels.configure(1,0);\
             __pocketWorkerChannels.configure(2,0);\
             __pocketWorkerChannels.publish(2,new Uint8Array({compute}));{cancel_command}"
        );
        ctx.eval::<(), _>(setup.as_str())?;
        Ok(bridge)
    })?;

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut observed = Vec::<String>::new();
    let signal = WakeSignal::global();
    let required = if cancel {
        vec!["sum:7", "end:-2"]
    } else {
        vec!["sum:6", "http:local-http-body", "end:0"]
    };
    while !required.iter().all(|expected| observed.iter().any(|value| value == expected)) {
        if Instant::now() >= deadline {
            return Err(format!(
                "worker probe timed out; observed={observed:?}; lastError={:?}",
                worker.last_error(),
            ).into());
        }
        let seen = signal.snapshot();
        let (values, pending_output) = ui_context.with(|ctx| -> Result<(Vec<String>, bool), Box<dyn Error>> {
            bridge.latch()?;
            let pending = bridge.has_pending_output();
            let json: String = ctx.eval(
                "JSON.stringify(__pocketWorkerChannels.observe(1).map(\
                   bytes => String.fromCharCode(...bytes)))",
            )?;
            bridge.mark_frame_consumed();
            if bridge.has_pending_output() {
                return Err("worker channel demand was not acknowledged".into());
            }
            Ok((serde_json::from_str(&json)?, pending))
        })?;
        if !values.is_empty() && !pending_output {
            return Err("latched worker channel output did not request a UI turn".into());
        }
        for value in values {
            if !observed.contains(&value) { observed.push(value); }
        }
        if !required.iter().all(|expected| observed.iter().any(|value| value == expected)) {
            signal.wait_change(seen, deadline.saturating_duration_since(Instant::now()));
        }
    }

    worker.request_stop_and_wait();
    bridge.detach();
    worker.destroy_and_join()?;
    println!("WORKER_PROBE_RESULT:{}", serde_json::to_string(&observed)?);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("pocket_worker_probe: {error}");
        std::process::exit(1);
    }
}
