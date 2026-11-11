//! Compile a PocketJS bundle into real QuickJS serialized bytecode.
//!
//! This binary intentionally links the same `rquickjs-sys` QuickJS source as
//! the native guest. Do not replace it with a system `qjsc`: QuickJS bytecode
//! is engine-build-specific and is only valid for a matching runtime ABI.

use pocket_flutter::bytecode::{self, BytecodeKind, DEFAULT_FLAGS};
use pocket_spec::BINDING_GENERATION;
use rquickjs::{qjs, Context, Ctx, Module, Runtime, WriteOptions, WriteOptionsEndianness};
use std::env;
use std::ffi::CString;
use std::mem::MaybeUninit;
use std::path::PathBuf;

#[derive(Debug)]
struct Args {
    input: PathBuf,
    output: PathBuf,
    metadata: Option<PathBuf>,
    kind: BytecodeKind,
    binding_generation: u32,
    tick_hz: u32,
    module_name: String,
}

fn usage() -> ! {
    eprintln!(
        "usage: pocketjs_bytecode --input app.js --output app.qjbc [--module-name app.js] [--metadata app.bytecode.json] [--kind script|module] [--binding-generation N] [--tick-hz N]"
    );
    std::process::exit(2);
}

fn parse_args() -> Args {
    let mut input = None;
    let mut output = None;
    let mut metadata = None;
    let mut kind = BytecodeKind::Script;
    let mut binding_generation = BINDING_GENERATION;
    let mut tick_hz = 60;
    let mut module_name = String::from("app.js");
    let mut args = env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let name = argument.to_string_lossy();
        if let Some(raw) = name.strip_prefix("--tick-hz=") {
            tick_hz = raw.parse().unwrap_or_else(|_| {
                eprintln!("invalid --tick-hz");
                usage();
            });
            continue;
        }
        if let Some(raw) = name.strip_prefix("--module-name=") {
            module_name = raw.to_string();
            continue;
        }
        let mut value = |label: &str| {
            args.next().unwrap_or_else(|| {
                eprintln!("missing value for {label}");
                usage();
            })
        };
        match name.as_ref() {
            "--input" => input = Some(PathBuf::from(value("--input"))),
            "--output" => output = Some(PathBuf::from(value("--output"))),
            "--metadata" => metadata = Some(PathBuf::from(value("--metadata"))),
            "--module-name" => module_name = value("--module-name").to_string_lossy().into_owned(),
            "--kind" => {
                kind = match value("--kind").to_string_lossy().as_ref() {
                    "script" => BytecodeKind::Script,
                    "module" => BytecodeKind::Module,
                    other => {
                        eprintln!("unsupported bytecode kind {other:?}");
                        usage();
                    }
                }
            }
            "--binding-generation" => {
                binding_generation = value("--binding-generation")
                    .to_string_lossy()
                    .parse()
                    .unwrap_or_else(|_| {
                        eprintln!("invalid --binding-generation");
                        usage();
                    });
            }
            "--tick-hz" => {
                tick_hz = value("--tick-hz")
                    .to_string_lossy()
                    .parse()
                    .unwrap_or_else(|_| {
                        eprintln!("invalid --tick-hz");
                        usage();
                    });
            }
            "-h" | "--help" => usage(),
            other => {
                eprintln!("unknown argument {other}");
                usage();
            }
        }
    }
    Args {
        input: input.unwrap_or_else(|| {
            eprintln!("--input is required");
            usage();
        }),
        output: output.unwrap_or_else(|| {
            eprintln!("--output is required");
            usage();
        }),
        metadata,
        kind,
        binding_generation,
        tick_hz,
        module_name,
    }
}

fn compile_script(ctx: Ctx<'_>, source: &[u8], filename: &CString) -> Result<Vec<u8>, String> {
    let input = CString::new(source).map_err(|_| "input source contains a NUL byte".to_owned())?;
    let value = unsafe {
        qjs::JS_Eval(
            ctx.as_raw().as_ptr(),
            input.as_ptr(),
            source.len().try_into().map_err(|_| "source is too large")?,
            filename.as_ptr(),
            (qjs::JS_EVAL_TYPE_GLOBAL | qjs::JS_EVAL_FLAG_STRICT | qjs::JS_EVAL_FLAG_COMPILE_ONLY)
                as i32,
        )
    };
    if unsafe { qjs::JS_VALUE_GET_NORM_TAG(value) } == qjs::JS_TAG_EXCEPTION {
        let detail = ctx.catch();
        return Err(format!("QuickJS script compile exception: {detail:?}"));
    }

    let mut length = MaybeUninit::<qjs::size_t>::uninit();
    let buffer = unsafe {
        qjs::JS_WriteObject(
            ctx.as_raw().as_ptr(),
            length.as_mut_ptr(),
            value,
            (qjs::JS_WRITE_OBJ_BYTECODE
                | qjs::JS_WRITE_OBJ_STRIP_SOURCE
                | qjs::JS_WRITE_OBJ_STRIP_DEBUG) as i32,
        )
    };
    let result = if buffer.is_null() {
        let detail = ctx.catch();
        Err(format!(
            "QuickJS script bytecode serialization failed: {detail:?}"
        ))
    } else {
        let length = unsafe { length.assume_init() } as usize;
        let bytes = unsafe { std::slice::from_raw_parts(buffer, length) }.to_vec();
        unsafe { qjs::js_free(ctx.as_raw().as_ptr(), buffer.cast()) };
        Ok(bytes)
    };
    unsafe { qjs::JS_FreeValue(ctx.as_raw().as_ptr(), value) };
    result
}

fn compile_module(ctx: Ctx<'_>, source: &[u8], filename: &str) -> Result<Vec<u8>, String> {
    let module = Module::declare(ctx, filename, source.to_vec())
        .map_err(|error| format!("QuickJS module compile failed: {error}"))?;
    module
        .write(WriteOptions {
            endianness: WriteOptionsEndianness::Little,
            strip_source: true,
            strip_debug: true,
            ..Default::default()
        })
        .map_err(|error| format!("QuickJS module bytecode serialization failed: {error}"))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args();
    if args.tick_hz == 0 || args.tick_hz > 120 {
        return Err(format!("tick rate must be between 1 and 120 (got {})", args.tick_hz).into());
    }
    if args.binding_generation == 0 {
        return Err("binding generation must be non-zero".into());
    }
    let source = std::fs::read(&args.input)?;
    if source.is_empty() {
        return Err("input source is empty".into());
    }
    if source.contains(&0) {
        return Err("input source contains a NUL byte".into());
    }
    let filename = CString::new(args.module_name.as_bytes())?;
    let runtime = Runtime::new()?;
    let context = Context::full(&runtime)?;
    let payload = context.with(|ctx| match args.kind {
        BytecodeKind::Script => compile_script(ctx, &source, &filename),
        BytecodeKind::Module => compile_module(ctx, &source, &args.module_name),
    })?;
    let artifact = bytecode::encode(
        args.kind,
        DEFAULT_FLAGS,
        args.binding_generation,
        args.tick_hz,
        &source,
        &payload,
    )?;
    if let Some(parent) = args
        .output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&args.output, &artifact)?;
    if let Some(metadata_path) = args.metadata {
        let metadata_value = serde_json::json!({
            "entryFormat": bytecode::ENTRY_FORMAT,
            "formatVersion": bytecode::FORMAT_VERSION,
            "kind": match args.kind {
                BytecodeKind::Script => "script",
                BytecodeKind::Module => "module",
            },
            "bindingGeneration": args.binding_generation,
            "tickHz": args.tick_hz,
            "runtimeAbi": bytecode::runtime_abi(),
            "engineAbi": bytecode::engine_abi_hex(),
            "headerBytes": bytecode::HEADER_LEN,
            "bytecodeBytes": artifact.len(),
            "sourceSha256": bytecode::sha256_hex(&source),
            "payloadSha256": bytecode::sha256_hex(&payload),
        });
        let metadata_bytes = serde_json::to_vec_pretty(&metadata_value)?;
        if let Some(parent) = metadata_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(metadata_path, metadata_bytes)?;
    }
    eprintln!(
        "wrote {} bytes of QuickJS {:?} bytecode to {} (engine ABI {:02x?})",
        artifact.len(),
        args.kind,
        args.output.display(),
        &bytecode::engine_abi()[..8]
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocket_flutter::bytecode::BytecodeExpectation;

    #[test]
    fn compile_script_zero_terminates_subslice_without_altering_source_hash() {
        let sentinel_backing = b"var answer = 1=";
        let sentinel_source = &sentinel_backing[..b"var answer = 1".len()];
        assert_eq!(sentinel_backing[sentinel_source.len()], b'=');

        let filename = CString::new("app.js").unwrap();
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();

        // Prove that QuickJS JS_Eval overreads `input[input_len]` when not NUL-terminated:
        // `var answer = 1` followed by `=` at `input[input_len]` causes the lexer to parse
        // the trailing `=` sentinel and fail with a compile exception.
        let unpadded_failed = context.with(|ctx| unsafe {
            let value = qjs::JS_Eval(
                ctx.as_raw().as_ptr(),
                sentinel_source.as_ptr().cast(),
                sentinel_source.len() as _,
                filename.as_ptr(),
                (qjs::JS_EVAL_TYPE_GLOBAL
                    | qjs::JS_EVAL_FLAG_STRICT
                    | qjs::JS_EVAL_FLAG_COMPILE_ONLY) as i32,
            );
            let is_err = qjs::JS_VALUE_GET_NORM_TAG(value) == qjs::JS_TAG_EXCEPTION;
            if is_err {
                let _ = ctx.catch();
            } else {
                qjs::JS_FreeValue(ctx.as_raw().as_ptr(), value);
            }
            is_err
        });
        assert!(
            unpadded_failed,
            "raw JS_Eval on subslice backed by '=' sentinel at slice end fails without NUL termination"
        );

        let payload = context
            .with(|ctx| compile_script(ctx, sentinel_source, &filename))
            .expect("compile_script must NUL-terminate source slice so QuickJS lexer does not read trailing '='");

        let standalone_source = sentinel_source.to_vec();
        let standalone_payload = context
            .with(|ctx| compile_script(ctx, &standalone_source, &filename))
            .expect("compile_script on standalone Vec");
        assert_eq!(payload, standalone_payload);

        let artifact = bytecode::encode(
            BytecodeKind::Script,
            DEFAULT_FLAGS,
            BINDING_GENERATION,
            60,
            sentinel_source,
            &payload,
        )
        .unwrap();
        let decoded = bytecode::validate(
            &artifact,
            BytecodeExpectation {
                kind: BytecodeKind::Script,
                binding_generation: BINDING_GENERATION,
                tick_hz: 60,
            },
        )
        .unwrap();
        assert_eq!(
            decoded.source_sha256,
            pocketjs_core::sha256::sha256(b"var answer = 1")
        );
        assert_eq!(
            bytecode::sha256_hex(sentinel_source),
            bytecode::sha256_hex(b"var answer = 1")
        );
        assert_ne!(
            bytecode::sha256_hex(sentinel_source),
            bytecode::sha256_hex(sentinel_backing)
        );
        assert_ne!(
            bytecode::sha256_hex(sentinel_source),
            bytecode::sha256_hex(b"var answer = 1\0")
        );
        assert_eq!(decoded.payload, payload.as_slice());

        let metadata_value = serde_json::json!({
            "entryFormat": bytecode::ENTRY_FORMAT,
            "formatVersion": bytecode::FORMAT_VERSION,
            "kind": "script",
            "bindingGeneration": BINDING_GENERATION,
            "tickHz": 60,
            "runtimeAbi": bytecode::runtime_abi(),
            "engineAbi": bytecode::engine_abi_hex(),
            "headerBytes": bytecode::HEADER_LEN,
            "bytecodeBytes": artifact.len(),
            "sourceSha256": bytecode::sha256_hex(sentinel_source),
            "payloadSha256": bytecode::sha256_hex(&payload),
        });
        assert_eq!(
            metadata_value["sourceSha256"].as_str().unwrap(),
            bytecode::sha256_hex(b"var answer = 1")
        );
        assert_eq!(
            metadata_value["payloadSha256"].as_str().unwrap(),
            bytecode::sha256_hex(&standalone_payload)
        );
    }

    #[test]
    fn compile_script_rejects_interior_nul_bytes() {
        let filename = CString::new("app.js").unwrap();
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let err = context
            .with(|ctx| compile_script(ctx, b"var a = 1;\0var b = 2;", &filename))
            .unwrap_err();
        assert_eq!(err, "input source contains a NUL byte");
    }
}
