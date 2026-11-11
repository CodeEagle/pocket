# Bytecode Compiler Input NUL-Termination (`pocketjs_bytecode`)

## Source-First Inspection and Provenance

1. **Retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` (excluding `pocket_host/`)**:
   - Inspected `tools/compile_pocket_syslib_aot.py` and `lib/core/pocketjs_bundle_runner.dart`. The parent demo evaluates JS syslibs via Node.js and packs stripped UTF-8 JS source into `.pjc` (`PJCA`) containers; it does not contain a Rust QuickJS `JS_Eval` bytecode compiler binary.
2. **Pinned QuickJS C ABI contract (`quickjs.h`)**:
   - In the locked `rquickjs-sys` header (`quickjs/quickjs.h` line 1012):
     ```c
     /* 'input' must be zero terminated i.e. input[input_len] = '\0'. */
     JS_EXTERN JSValue JS_Eval(JSContext *ctx, const char *input, size_t input_len,
                               const char *filename, int eval_flags);
     ```
   - QuickJS's lexer expects `input[input_len] == '\0'` as its end-of-buffer sentinel and reads one byte at index `input_len`.
3. **Existing PocketJS native `JS_Eval` callers**:
   - `sdk/native/src/lib.rs` (`compile_test_worker_bytecode`, lines 8644–8654): converts `source: &[u8]` with `let input = CString::new(source).unwrap();` and passes `input.as_ptr()` with `source.len()` while passing original `source` to `bytecode::encode`.
   - `sdk/native/src/worker.rs` (`compile_worker_bytecode`, lines 3910–3920): converts `source_bytes` with `let input = CString::new(source_bytes).unwrap();` and passes `input.as_ptr()` with `source_bytes.len()` while passing `source_bytes` to `bytecode::encode`.
   - `sdk/native/tests/memory_limits.rs` (`compile_script_bytecode`, lines 32–41): converts `source: &[u8]` with `let input = CString::new(source).unwrap();` and passes `input.as_ptr()` with `source.len()`.
   - Pinned C engine adapters (`sdk/.cache/pocketjs/engine/guest-quickjs/src/guest.c` lines 254–259 and `sdk/.cache/pocketjs/engine/worker/src/quickjs.c` lines 280–285): allocate `length + 1`, copy `length` bytes, set `copy[length] = 0`, and pass `length` to `JS_Eval`.

## Root Cause and Necessary Adaptation

- In `sdk/native/src/bin/pocketjs_bytecode.rs`, `main()` read the input file via `std::fs::read(&args.input)` into a `Vec<u8>` (which has no trailing NUL byte at `source[source.len()]`) and passed `&source` to `compile_script`.
- `compile_script` previously passed `source.as_ptr().cast()` and `source.len()` directly to `qjs::JS_Eval`, violating the `input[input_len] == '\0'` precondition and allowing QuickJS's lexer to read one byte past the slice (`input[input_len]`).
- Adapted `compile_script` in `sdk/native/src/bin/pocketjs_bytecode.rs` to match `sdk/native/src/lib.rs` and `sdk/native/src/worker.rs`:
  - Construct `let input = CString::new(source).map_err(|_| "input source contains a NUL byte".to_owned())?;`.
  - Pass `input.as_ptr()` and the original `source.len()` to `qjs::JS_Eval`.
  - Keep `bytecode::encode` and metadata `sourceSha256` (`bytecode::sha256_hex(&source)`) operating on the original `source` slice (without the trailing NUL).

## Validation

- Added focused unit tests in `sdk/native/src/bin/pocketjs_bytecode.rs`:
  - `tests::compile_script_zero_terminates_subslice_without_altering_source_hash`: uses a subslice `&b"var answer = 1="[..14]` backed by a nonzero invalid `=` sentinel at `slice[slice.len()]`. Verifies that raw un-terminated `JS_Eval` overreads `=` and fails with a compile exception, whereas `compile_script` succeeds, emits identical bytecode payload to a standalone `Vec<u8>`, and preserves the exact `source_sha256` and metadata `sourceSha256` of the original 14-byte source without including the trailing sentinel or NUL byte.
  - `tests::compile_script_rejects_interior_nul_bytes`: verifies interior NUL rejection (`"input source contains a NUL byte"`).
- Executed `cargo test --manifest-path /Volumes/ORICO/Development/Github/pocket/sdk/native/Cargo.toml --bin pocketjs_bytecode`: 2 passed, 0 failed.
