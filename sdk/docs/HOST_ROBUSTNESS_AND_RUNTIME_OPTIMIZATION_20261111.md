# Host Robustness and Runtime Optimization (2026-11-11)

## Overview

This document records the implementation, source paths, retained contracts, before/after benchmarks, binary size measurements, and verification results for 5 high-ROI, zero-regression optimizations across the native Rust host (`sdk/native/`) and Dart SDK packages (`sdk/packages/pocket_services`, `sdk/packages/pocket_flutter`).

## Scope & Implemented Optimizations

### 1. FFI `catch_unwind` Panic Guard & DrawList Bounds Safety (Item #3)

- **Source Paths**:
  - `sdk/native/src/lib.rs`
  - `sdk/native/src/worker.rs`
  - `sdk/native/src/offload.rs`
  - `sdk/native/tests/ffi_panic_guard.rs`
- **Retained Behavior & Necessary Changes**:
  - Added `poisoned: bool` to `HostState` (initialized `false`) and implemented `catch_ffi_unwind`, `guard_host_mut`, and `guard_host_ref` in `sdk/native/src/lib.rs`.
  - Wrapped every `#[no_mangle] pub unsafe extern "C" fn` and `pub extern "C" fn` entrypoint in `sdk/native/src/lib.rs` with panic guards so a Rust panic can never unwind across `extern "C"` and abort the host Flutter process.
  - On panic inside a `HostState`-taking entrypoint, the panic payload message (`&str` or `String`) is formatted as `native panic in {fn_name}: {msg}`, stored in `host.last_error` / `host.error_output`, `host.poisoned` is set to `true`, and the function's exact error sentinel (`ptr::null()`, `ptr::null_mut()`, `-1`, `0`, `false`, `-1.0`) is returned.
  - Subsequent mutating or frame calls on a poisoned `HostState` immediately return their error sentinel while preserving `host.last_error`. `pocket_last_error` still returns the stored error message on a poisoned handle, and `pocket_destroy` catches unwind on teardown.
  - Wrapped all `unsafe extern "C" fn` C/QuickJS callbacks in `sdk/native/src/worker.rs` (`ui_trace_callback`, `trace_fact_callback`, `trace_facts_callback`, `trace_turn_callback`, `trace_boundary_callback`, `trace_operation_callback`, `trace_scalar_callback`, `core_lock`, `core_unlock`, `core_wake`, `core_now`, `cpu_now_micros`, `runner_wait`, `runner_pause_wait`, `driver_open`, `driver_validate`, `driver_start`, `driver_cancel`, `driver_close`, `driver_write`) with `catch_worker_callback`, and wrapped `notify()` callback invocations in `worker.rs` and `offload.rs` in `std::panic::catch_unwind`.
  - Audited DrawList word decoding in `append_draw_operation_cached` (`sdk/native/src/lib.rs`) and replaced unchecked `words[...]` indexing across opcodes `1`, `3`, `4`, `7`, `8`, `9`, `10`, `11`, `12`, `17`, `18` with checked `.get(...)` returning `Err(...)`.

### 2. Zero-Duplicate `ops` Sharing & `O(1)` `nodes_revision` Cache Validation in `build_frame` (Item #2)

- **Source Paths**:
  - `sdk/native/src/lib.rs`
- **Retained Behavior & Necessary Changes**:
  - Introduced `NodeRegistry` (`sdk/native/src/lib.rs`) wrapping `Vec<NodeMeta>` with a monotonically increasing `revision: u64` incremented on every mutable access (`NodeRegistry::write(&mut self)`).
  - Audited and routed all `host.nodes.borrow_mut()` write sites (`install_host_assets`, `pocket._register`, `pocket.registerSurface`, `pocket.releaseSurface`, `install_compositor_apps`, `reset_host_for_load`) through `NodeRegistry::write()`.
  - Replaced `self.nodes == *nodes` ($O(N)$ deep `NodeMeta` comparison) and `host.nodes.borrow().clone()` (full `Vec<NodeMeta>` deep clone on every cache miss) in `FrameDrawCache::matches_primary` and `build_frame` with an $O(1)$ `self.nodes_revision == nodes_revision` check and borrowed `&host.nodes.borrow()` slice during `decode_draw_ops`.
  - Eliminated the duplicate deep-clone of `ops: Vec<FrameOp>` (`Rc::new(ops.clone())`) and `generic_texture_handles: HashSet<i32>` on every DrawList cache miss in `build_frame` by wrapping `ops` and `generic_texture_handles` in `Rc` once and sharing via `Rc::clone` across `FrameDrawCache`, `decoded`, and `FrameResult`.

### 3. Worker HTTP Connection Pool Reuse Without Deadline Regression (Item #6)

- **Source Paths**:
  - `sdk/native/src/worker.rs`
- **Retained Behavior & Necessary Changes**:
  - Defined `const SHARED_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);` and stored a reusable `http_agent: ureq::Agent` on `WorkerState`, built once via `ureq::AgentBuilder::new().redirects(0).timeout_connect(SHARED_HTTP_CONNECT_TIMEOUT).build()`.
  - In `perform_http` (`sdk/native/src/worker.rs`):
    - When `remaining >= SHARED_HTTP_CONNECT_TIMEOUT`, borrows `&state.http_agent` with `.timeout(remaining)` so sequential HTTP/1.1 requests reuse keep-alive sockets and TLS sessions across requests. On `301|302|303|307|308` redirects, bound-drains up to 4096 bytes of the redirect response body (`let _ = response.into_reader().take(4096).read_to_end(&mut Vec::new());`) so `ureq` returns redirect sockets to the pool cleanly.
    - When `remaining < SHARED_HTTP_CONNECT_TIMEOUT`, falls back to `http_agent(remaining)` so tight sub-10s deadlines enforce `timeout_connect == remaining` without being overridden by `ureq 2.12.1`'s agent-level connect timeout.
  - Preserved all origin checks, `MAX_HTTP_REDIRECTS` caps, cross-origin `authorization`/`cookie` stripping, and method rewriting untouched.

### 4. Rust `[profile.release]` Tuning & Static Archive Debug Stripping (Item #7)

- **Source Paths**:
  - `sdk/native/Cargo.toml`
  - `sdk/scripts/build_native.sh`
- **Retained Behavior & Necessary Changes**:
  - Added `[profile.release]` (`lto = "thin"`, `codegen-units = 1`, `panic = "unwind"`) to `sdk/native/Cargo.toml`, preserving `panic = "unwind"` so `catch_unwind` FFI guards operate in release builds.
  - Added `xcrun strip -S` on `libpocket_flutter.a` in `sdk/scripts/build_native.sh` (for both the `macos` target and the `ios` `PocketFlutter.xcframework` `.a` slices inside `package_ios_xcframework`) to strip prebuilt Rust standard-library DWARF sections that are materialized into the staticlib when ThinLTO is enabled.

### 5. Eliminate Redundant Load Copies & `calloc` Zeroing (Item #11)

- **Source Paths**:
  - `sdk/packages/pocket_services/lib/src/pocket_package.dart`
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart`
  - `sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart`
- **Retained Behavior & Necessary Changes**:
  - Removed redundant `Uint8List.fromList(...)` copies around `File.readAsBytes()` and `File.readAsBytesSync()` (which already return freshly allocated `Uint8List` instances) in `pocket_package.dart`, `pocket_view.dart`, and `pocket_runtime.dart`.
  - Replaced `calloc<Uint8>(len)` with `malloc<Uint8>(len)` (and `malloc.free` in `finally`, guarding `address != 0` for zero-length buffers) in `PocketNativeRuntime.load` and `PocketNativeRuntime.loadBytecode` (`pocket_runtime.dart`), avoiding redundant zero-initialization of buffers that are immediately overwritten via `.asTypedList(len).setAll(0, ...)`.

---

## Before vs. After Measurements

### 1. Release Binary Sizes (`aarch64-apple-darwin`)

| Artifact | Baseline (Bytes) | Post-Optimization (Bytes) | Delta (Bytes) | Delta (%) |
| --- | ---: | ---: | ---: | ---: |
| `sdk/native/target/aarch64-apple-darwin/release/libpocket_flutter.a` | `33,007,888` | `11,357,984` | `-21,649,904` | **-65.59%** |
| `sdk/native/target/aarch64-apple-darwin/release/pocket_probe` | `6,129,952` | `5,428,528` | `-701,424` | **-11.44%** |

### 2. `pocket_bench` Release Benchmarks (`--frames 500 --warmup 20`)

Runtime ABI: `quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021`

| App | Scenario | Metric | Baseline (`us`) | Post-Optimization (`us`) | Delta |
| --- | --- | --- | ---: | ---: | ---: |
| `lobby` | `dynamicCounter.full` | mean / p50 / p95 / p99 / max | `27.708` / `27` / `29` / `44` / `107` | `26.086` / `26` / `28` / `28` / `32` | **-5.85% mean, -36.36% p99, -70.09% max** |
| `lobby` | `dynamicCounter.delta` | mean / p50 / p95 / p99 / max | `24.640` / `24` / `26` / `31` / `70` | `24.154` / `24` / `25` / `27` / `28` | **-1.97% mean, -12.90% p99, -60.00% max** |
| `lantern` | `idleHome.full` | mean / p50 / p95 / p99 / max | `5.994` / `6` / `6` / `8` / `11` | `5.008` / `5` / `5` / `5` / `6` | **-16.45% mean, -37.50% p99, -45.45% max** |
| `lantern` | `idleHome.delta` | mean / p50 / p95 / p99 / max | `5.086` / `5` / `5` / `9` / `13` | `4.444` / `4` / `5` / `6` / `6` | **-12.62% mean, -33.33% p99, -53.85% max** |
| `lantern` | `dynamicCounter.full` | mean / p50 / p95 / p99 / max | `10.756` / `9` / `16` / `51` / `84` | `7.702` / `8` / `8` / `9` / `10` | **-28.39% mean, -82.35% p99, -88.10% max** |
| `lantern` | `dynamicCounter.delta` | mean / p50 / p95 / p99 / max | `7.738` / `8` / `8` / `10` / `11` | `7.038` / `7` / `7` / `9` / `9` | **-9.05% mean, -10.00% p99, -18.18% max** |
| `profile` | `idleHome.full` | mean / p50 / p95 / p99 / max | `13.224` / `13` / `14` / `23` / `49` | `12.396` / `11` / `22` / `22` / `27` | **-6.26% mean, -15.38% p50, -44.90% max** |
| `profile` | `idleHome.delta` | mean / p50 / p95 / p99 / max | `11.334` / `11` / `12` / `18` / `55` | `11.022` / `11` / `11` / `13` / `13` | **-2.75% mean, -27.78% p99, -76.36% max** |
| `profile` | `dynamicCounter.full` | mean / p50 / p95 / p99 / max | `28.470` / `27` / `32` / `51` / `148` | `25.258` / `25` / `26` / `28` / `28` | **-11.28% mean, -45.10% p99, -81.08% max** |
| `profile` | `dynamicCounter.delta` | mean / p50 / p95 / p99 / max | `24.794` / `24` / `27` / `33` / `45` | `24.902` / `25` / `25` / `27` / `28` | **-7.41% p95, -18.18% p99, -37.78% max** |

### 3. macOS `--profile` Render Pipeline Verification (`render_pipeline_profile_test.dart`)

Command:
```bash
cd demo && flutter drive --no-pub --profile --no-start-paused -d macos \
  --driver test_driver/integration_test.dart \
  --target integration_test/render_pipeline_profile_test.dart
```

| Scene | `nativeP50Ms` | `nativeP95Ms` | `nativeDrawDecodeP50Ms` | `buildP50Ms` | `buildP95Ms` | `rasterP50Ms` | `rasterP95Ms` | `overBudget` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `mobile-1` | `0.589` | `1.460` | `0.018` | `0.255` | `1.895` | `0.903` | `1.358` | `0` |
| `gallery-1` | `1.317` | `2.020` | `0.019` | `0.241` | `2.586` | `0.744` | `1.487` | `0` |
| `transitions-1` | `0.845` | `1.196` | `0.028` | `0.233` | `1.805` | `1.107` | `1.499` | `0` |
| `home-1` | `0.898` | `1.116` | `0.032` | `0.247` | `2.196` | `0.844` | `1.737` | `0` |
| `mobile-2` | `0.735` | `1.536` | `0.014` | `0.241` | `2.269` | `0.995` | `1.478` | `0` |
| `gallery-2` | `1.559` | `2.079` | `0.016` | `0.253` | `2.815` | `1.039` | `1.496` | `0` |
| `transitions-2` | `0.798` | `1.030` | `0.029` | `0.273` | `1.990` | `1.163` | `1.553` | `0` |
| `home-2` | `0.829` | `1.056` | `0.031` | `0.265` | `2.067` | `0.890` | `1.900` | `0` |
| `miniapp_sheet_open` | `0.494` | `5.521` | `0.018` | `0.241` | `3.586` | `0.634` | `1.310` | `1` |
| `miniapp_sheet_close` | `0.371` | `0.895` | `0.017` | `0.839` | `2.203` | `0.598` | `1.196` | `0` |
| `miniapp_page_open` | `0.757` | `5.559` | `0.019` | `0.303` | `2.899` | `0.993` | `1.443` | `0` |
| `miniapp_page_close` | `0.475` | `0.927` | `0.020` | `1.331` | `2.274` | `0.883` | `1.244` | `0` |
| `mobile_scroll` | `0.794` | `1.038` | `0.024` | `1.586` | `2.327` | `1.276` | `1.729` | `0` |
| `home_pointer_burst` | `0.763` | `1.046` | `0.024` | `1.598` | `2.590` | `1.323` | `1.764` | `0` |

---

## Test Suite Validation Summary

- `cargo test --manifest-path sdk/native/Cargo.toml`:
  - `lib` unit tests: **112 passed, 0 failed** (including `smoke_tests::node_metadata_mutation_bumps_revision_and_invalidates_draw_cache`, `smoke_tests::truncated_drawlist_opcodes_return_err_without_panicking`, `worker::tests::worker_http_pool_reuses_single_tcp_connection_for_sequential_keep_alive_requests`, and `worker::tests::worker_http_sub_10s_timeout_does_not_regress_to_shared_connect_timeout`).
  - Integration tests (`bridge_limits`, `duplex_layout`, `ffi_panic_guard`, `frame_delta_cache`, `guest_security`, `image_mesh`, `memory_limits`): **29 passed, 0 failed**.
- `cd sdk/packages/pocket_services && flutter test`: **89 passed, 0 failed**.
- `cd sdk/packages/pocket_flutter && flutter test`: **237 passed, 0 failed** (plus 5 native dylib FFI tests in `pocket_duplex_ffi_test.dart` and `pocket_memory_ffi_test.dart`: **5 passed, 0 failed**).
- `cd sdk && flutter test`: **196 passed, 0 failed**.
- `cd demo && flutter test`: **54 passed, 0 failed**.
- `python3 sdk/scripts/check_architecture.py`: **Passed**.
- `cd demo && flutter drive --no-pub --profile --no-start-paused -d macos --driver test_driver/integration_test.dart --target integration_test/render_pipeline_profile_test.dart`: **All tests passed**.
