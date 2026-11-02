//! Synchronous native benchmark for the real QuickJS bytecode guest.
//!
//! This binary intentionally measures the C ABI used by Flutter, without
//! starting Flutter or a platform runner.  It keeps the full-frame and
//! delta-frame runs in separate native handles, warms each handle, and emits a
//! single JSON document suitable for archiving in a profiling artifact.

use pocket_flutter::{
    pocket_bytecode_actual_abi, pocket_create_with_density_and_tick_hz, pocket_destroy,
    pocket_frame, pocket_frame_delta, pocket_last_error, pocket_load_bytecode_files, pocket_send,
};
use serde_json::{json, Value};
use std::env;
use std::ffi::{CStr, CString};
use std::path::PathBuf;
use std::time::Instant;

type Handle = *mut std::ffi::c_void;

#[derive(Debug)]
struct Args {
    bytecode: PathBuf,
    pak: PathBuf,
    frames: usize,
    warmup: usize,
    width: f64,
    height: f64,
    raster_density: u32,
    tick_hz: u32,
}

fn usage() -> ! {
    eprintln!(
        "usage: pocket_bench [--bytecode PATH] [--pak PATH] [--frames N] [--warmup N] \
         [--width N] [--height N] [--raster-density N] [--tick-hz N]"
    );
    std::process::exit(2);
}

fn next_value(args: &mut impl Iterator<Item = String>, label: &str) -> String {
    args.next().unwrap_or_else(|| {
        eprintln!("missing value for {label}");
        usage();
    })
}

fn parse_usize(value: String, label: &str) -> usize {
    value.parse().unwrap_or_else(|_| {
        eprintln!("invalid {label}: {value}");
        usage();
    })
}

fn parse_u32(value: String, label: &str) -> u32 {
    value.parse().unwrap_or_else(|_| {
        eprintln!("invalid {label}: {value}");
        usage();
    })
}

fn parse_f64(value: String, label: &str) -> f64 {
    let value: f64 = value.parse().unwrap_or_else(|_| {
        eprintln!("invalid {label}: {value}");
        usage();
    });
    if !value.is_finite() || value <= 0.0 {
        eprintln!("{label} must be finite and positive");
        usage();
    }
    value
}

fn parse_args() -> Args {
    let mut bytecode = None;
    let mut pak = None;
    let mut frames = 300;
    let mut warmup = 10;
    let mut width = 390.0;
    let mut height = 844.0;
    let mut raster_density = 1;
    let mut tick_hz = 60;
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        let (name, inline) = argument
            .split_once('=')
            .map_or((argument.as_str(), None), |(name, value)| {
                (name, Some(value))
            });
        let value = |args: &mut _| {
            inline
                .map(str::to_owned)
                .unwrap_or_else(|| next_value(args, name))
        };
        match name {
            "--bytecode" => bytecode = Some(PathBuf::from(value(&mut args))),
            "--pak" => pak = Some(PathBuf::from(value(&mut args))),
            "--frames" => frames = parse_usize(value(&mut args), "--frames"),
            "--warmup" => warmup = parse_usize(value(&mut args), "--warmup"),
            "--width" => width = parse_f64(value(&mut args), "--width"),
            "--height" => height = parse_f64(value(&mut args), "--height"),
            "--raster-density" => raster_density = parse_u32(value(&mut args), "--raster-density"),
            "--tick-hz" => tick_hz = parse_u32(value(&mut args), "--tick-hz"),
            "-h" | "--help" => usage(),
            other => {
                eprintln!("unknown argument {other}");
                usage();
            }
        }
    }
    if frames == 0 || tick_hz == 0 || tick_hz > 120 || raster_density == 0 {
        eprintln!("frames, tick-hz and raster-density must be positive; tick-hz <= 120");
        usage();
    }
    Args {
        bytecode: bytecode.unwrap_or_else(|| usage()),
        pak: pak.unwrap_or_else(|| usage()),
        frames,
        warmup,
        width,
        height,
        raster_density,
        tick_hz,
    }
}

unsafe fn last_error(handle: Handle) -> String {
    let pointer = pocket_last_error(handle.cast());
    if pointer.is_null() {
        return String::new();
    }
    CStr::from_ptr(pointer).to_string_lossy().into_owned()
}

fn c_path(path: &PathBuf, label: &str) -> CString {
    CString::new(path.to_string_lossy().as_bytes()).unwrap_or_else(|_| {
        eprintln!("{label} contains a NUL byte: {}", path.display());
        std::process::exit(2);
    })
}

unsafe fn create_runtime(args: &Args) -> Result<Handle, String> {
    let handle = pocket_create_with_density_and_tick_hz(
        args.width,
        args.height,
        args.raster_density,
        args.tick_hz,
    )
    .cast::<std::ffi::c_void>();
    if handle.is_null() {
        return Err("pocket_create_with_density_and_tick_hz returned null".to_owned());
    }
    let bytecode_path = c_path(&args.bytecode, "bytecode path");
    let pak_path = c_path(&args.pak, "pak path");
    if pocket_load_bytecode_files(handle.cast(), bytecode_path.as_ptr(), pak_path.as_ptr()) != 0 {
        let error = last_error(handle);
        pocket_destroy(handle.cast());
        return Err(if error.is_empty() {
            "pocket_load_bytecode_files failed".to_owned()
        } else {
            error
        });
    }
    Ok(handle)
}

unsafe fn frame_pointer(
    handle: Handle,
    delta_ms: f64,
    delta: bool,
) -> Result<(*const i8, bool), String> {
    let pointer = if delta {
        pocket_frame_delta(handle.cast(), delta_ms)
    } else {
        pocket_frame(handle.cast(), delta_ms)
    };
    if pointer.is_null() {
        let error = last_error(handle);
        return Err(if error.is_empty() {
            "frame ABI returned null".to_owned()
        } else {
            error
        });
    }
    let text = CStr::from_ptr(pointer).to_bytes();
    let unchanged = text == br#"{"unchanged":true}"#;
    Ok((pointer, unchanged))
}

unsafe fn send_counter(handle: Handle, message: &CString) -> Result<(), String> {
    if pocket_send(handle.cast(), message.as_ptr()) != 0 {
        let error = last_error(handle);
        return Err(if error.is_empty() {
            "pocket_send failed".to_owned()
        } else {
            error
        });
    }
    Ok(())
}

#[derive(Debug)]
struct Samples {
    durations_us: Vec<u64>,
    return_bytes: Vec<usize>,
    unchanged_frames: usize,
}

impl Samples {
    fn new(capacity: usize) -> Self {
        Self {
            durations_us: Vec::with_capacity(capacity),
            return_bytes: Vec::with_capacity(capacity),
            unchanged_frames: 0,
        }
    }

    fn summary(mut self) -> Value {
        self.durations_us.sort_unstable();
        let count = self.durations_us.len();
        let percentile = |percent: usize| -> u64 {
            if count == 0 {
                return 0;
            }
            let index = ((count - 1) * percent).div_ceil(100);
            self.durations_us[index]
        };
        let total_us: u128 = self.durations_us.iter().map(|value| *value as u128).sum();
        let total_bytes: usize = self.return_bytes.iter().sum();
        json!({
            "frames": count,
            "changedFrames": count.saturating_sub(self.unchanged_frames),
            "unchangedFrames": self.unchanged_frames,
            "returnBytesTotal": total_bytes,
            "returnBytesAvg": if count == 0 { 0.0 } else { total_bytes as f64 / count as f64 },
            "durationUs": {
                "mean": if count == 0 { 0.0 } else { total_us as f64 / count as f64 },
                "p50": percentile(50),
                "p95": percentile(95),
                "p99": percentile(99),
                "max": self.durations_us.last().copied().unwrap_or(0),
            },
        })
    }
}

unsafe fn run_case(args: &Args, delta: bool, dynamic: bool) -> Result<Value, String> {
    let handle = create_runtime(args)?;
    let result = (|| {
        let delta_ms = 1000.0 / args.tick_hz as f64;
        for _ in 0..args.warmup {
            if dynamic {
                send_counter(handle, &counter_message())?;
            }
            let _ = frame_pointer(handle, delta_ms, delta)?;
        }
        let mut samples = Samples::new(args.frames);
        let message = counter_message();
        for _ in 0..args.frames {
            if dynamic {
                send_counter(handle, &message)?;
            }
            let started = Instant::now();
            let (pointer, unchanged) = frame_pointer(handle, delta_ms, delta)?;
            let elapsed = started.elapsed();
            samples
                .durations_us
                .push(elapsed.as_micros().min(u64::MAX as u128) as u64);
            samples
                .return_bytes
                .push(CStr::from_ptr(pointer).to_bytes().len());
            if unchanged {
                samples.unchanged_frames += 1;
            }
        }
        Ok(samples.summary())
    })();
    pocket_destroy(handle.cast());
    result
}

fn counter_message() -> CString {
    CString::new(r#"{"type":"event","id":"bench-counter","name":"demo.increment","payload":{}}"#)
        .expect("static counter message has no NUL")
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args();
    if !args.bytecode.is_file() {
        return Err(format!("bytecode file does not exist: {}", args.bytecode.display()).into());
    }
    if !args.pak.is_file() {
        return Err(format!("pak file does not exist: {}", args.pak.display()).into());
    }
    let runtime_abi = unsafe {
        CStr::from_ptr(pocket_bytecode_actual_abi())
            .to_string_lossy()
            .into_owned()
    };
    let mut scenarios = serde_json::Map::new();
    for (name, dynamic) in [("idleHome", false), ("dynamicCounter", true)] {
        let full = unsafe { run_case(&args, false, dynamic)? };
        let delta = unsafe { run_case(&args, true, dynamic)? };
        scenarios.insert(name.to_owned(), json!({"full": full, "delta": delta}));
    }
    let result = json!({
        "benchmark": "pocketjs-native-frame",
        "runtimeAbi": runtime_abi,
        "bytecode": args.bytecode,
        "pak": args.pak,
        "config": {
            "frames": args.frames,
            "warmup": args.warmup,
            "width": args.width,
            "height": args.height,
            "rasterDensity": args.raster_density,
            "tickHz": args.tick_hz,
        },
        "scenarios": scenarios,
    });
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
