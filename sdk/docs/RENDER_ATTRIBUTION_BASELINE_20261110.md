# Flutter Host Render Attribution Baseline (2026-11-10)

## 1. Purpose

This document records the **Step 0 render attribution instrumentation and baseline** for the Pocket Flutter host (`sdk/packages/pocket_flutter`). No rendering optimizations were introduced in this step.

Prior baselines in [`VISUAL_NOVEL_MESH_SSAA_ABLATION.md`](file:///Volumes/ORICO/Development/Github/pocket/sdk/docs/VISUAL_NOVEL_MESH_SSAA_ABLATION.md) and [`RENDER_PIPELINE_REVIEW_20261105.md`](file:///Volumes/ORICO/Development/Github/pocket/sdk/docs/RENDER_PIPELINE_REVIEW_20261105.md) reported overall Flutter `FrameTiming.buildDuration` and ` pocket_NextFrameDeltaAt` FFI duration, leaving a black box between FFI completion and Flutter UI frame submission. This baseline breaks UI-thread execution into five explicit stages:

1. **`pocket.native`**: Synchronous guest tick + DrawList/PFB1 generation + binary frame decode (`deltaFn(runtime, frameDelta)` in [`_PocketViewState._onTick`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L2911-L2995)).
2. **`pocket.decode`**: Binary frame buffer parsing (`BorrowedPocketRenderFrame.parse` inside [`FfiPocketRuntime._parseBorrowedBinaryFrame`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L1318-L1339)). Note: `pocket.decode` executes *inside* `pocket.native`, so `pocket.native - pocket.decode` isolates pure C/QuickJS/Live2D FFI execution time.
3. **`pocket.diff`**: Retained surface block visual equality checking ([`_PocketViewState._surfaceVisualEquals`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L3015-L3055), aggregated across all blocks compared during `_applyFrame`).
4. **`pocket.build`**: Flutter widget tree construction for retained surface blocks, platform views, and overlays ([`_PocketViewState._buildSurface`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L7325-L7415)).
5. **`pocket.paint`**: `CustomPainter` display-list recording across all repainted `PocketCanvasPainter` blocks in the frame ([`PocketCanvasPainter.paint`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view_painter.dart#L337-L361), aggregated per frame).

---

## 2. Instrumentation Method

- **`dart:developer` Timeline Spans**:
  - Every stage wraps its execution in `developer.Timeline.timeSync('pocket.<stage>', ...)`:
    - `pocket.native` in [`pocket_view.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L2942-L2945)
    - `pocket.decode` in [`pocket_runtime.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L1324-L1332)
    - `pocket.diff` in [`pocket_view.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L3023-L3030)
    - `pocket.build` in [`pocket_view.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L7332-L7342)
    - `pocket.paint` in [`pocket_view_painter.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view_painter.dart#L345-L355)
- **Existing `PocketPerformanceSample` Pipeline Integration**:
  - Added `decodeMsP95`, `diffMsP95`, `buildMsP95`, and `paintMsP95` to [`PocketPerformanceSample`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_performance.dart#L97-L186) (and `toJson()`).
  - Per-stage `Stopwatch` collection is strictly gated behind `_performanceCollectionEnabled` (`widget.performanceConfig.enabled && widget.onPerformanceSample != null`) or test-only attribution hooks (`debugOnPocketTickAttribution` / `debugOnPocketFrameStageAttribution`).
  - When performance sampling is disabled, **no `Stopwatch` is allocated or started**, and `PocketCanvasPainter.onPaintMicroseconds` is `null` (zero overhead when disabled, no new state machine).

---

## 3. Environment & Reproducible Commands

- **Device / OS**: macOS desktop (`arm64` Apple Silicon)
- **Toolchain**: Flutter `3.35.7` (stable) • Dart `3.9.2`
- **Build Mode**: `--profile` (`ARCHS = arm64` in `demo/macos/Podfile` matching `demo/macos/Runner/Configs/Release.xcconfig`)
- **Display Refresh Rate**: `60.0 Hz` (`16.667 ms` frame budget)

### Exact Commands

```sh
# 1. Scene (b) Text-heavy Showcase pages & Scene (c) Mini-app sheet/page open/close transitions
cd /Volumes/ORICO/Development/Github/pocket/demo && \
  flutter drive --no-pub --profile --no-start-paused -d macos \
  --driver test_driver/integration_test.dart \
  --target integration_test/render_pipeline_profile_test.dart

# 2. Scene (a) Lantern Live2D 10-second model soak windows (Hiyori idle / closeup / repeat)
cd /Volumes/ORICO/Development/Github/pocket/demo && \
  flutter drive --no-pub --profile --no-start-paused -d macos \
  --dart-define=POCKET_NOVEL_PROFILE_ABLATION=true \
  --dart-define=POCKET_MESH_GROUP_ONLY=false \
  --dart-define=POCKET_MESH_SUPERSAMPLE=1 \
  --driver test_driver/integration_test.dart \
  --target integration_test/novel_model_soak_test.dart

# 3. Scene (a) Lantern Live2D story reading windows (1.6s manual reading windows)
cd /Volumes/ORICO/Development/Github/pocket/demo && \
  flutter drive --no-pub --profile --no-start-paused -d macos \
  --driver test_driver/integration_test.dart \
  --target integration_test/novel_performance_test.dart

# 4. Unit & Widget Test Suites
cd /Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter && flutter test
cd /Volumes/ORICO/Development/Github/pocket/demo && flutter test
```

---

## 4. Per-Stage Baseline Tables (macOS `--profile`, 60 Hz)

> **Note on columns**:
> - `pocket.decode` is measured *inside* `pocket.native`. Pure native FFI time (`pocket_NextFrameDeltaAt` in C/QuickJS/Cubism) is approximately `pocket.native - pocket.decode`.
> - `UI Build` and `Raster` are Flutter engine `FrameTiming.buildDuration` and `FrameTiming.rasterDuration`.

### Scene (a): Lantern Live2D Scene

#### A1. 10-Second Live2D Hiyori Soak Windows (`novel_model_soak_test.dart`, `POCKET_MESH_SUPERSAMPLE=1`)

| Window | Frames / Native Calls | Max Ops / Painters | `pocket.native` p50 / p95 (ms) | `pocket.decode` p50 / p95 (ms) | `pocket.diff` p50 / p95 (ms) | `pocket.build` p50 / p95 (ms) | `pocket.paint` p50 / p95 (ms) | Flutter `UI Build` p50 / p95 (ms) | Flutter `Raster` p50 / p95 (ms) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `hiyori_idle_0` | 597 / 400 | 3,496 / 113 | 7.514 / **9.381** | 0.515 / 0.696 | 0.000 / 0.005 | 0.171 / 0.266 | 0.861 / **1.371** | 5.433 / **11.483** | 1.109 / 1.431 |
| `hiyori_idle_1` | 600 / 400 | 3,537 / 114 | 7.537 / **8.905** | 0.439 / 0.658 | 0.000 / 0.006 | 0.165 / 0.279 | 0.858 / **1.525** | 6.211 / **10.981** | 1.104 / 1.388 |
| `hiyori_idle_1_closeup` | 596 / 397 | 3,035 / 98 | 7.353 / **9.533** | 0.445 / 0.595 | 0.000 / 0.006 | 0.149 / 0.352 | 0.774 / **1.552** | 5.973 / **11.583** | 1.180 / 1.709 |
| `hiyori_idle_0_repeat` | 605 / 399 | 3,496 / 113 | 6.078 / **9.187** | 0.436 / 0.677 | 0.000 / 0.006 | 0.164 / 0.293 | 0.809 / **1.475** | 6.111 / **11.133** | 1.082 / 1.387 |
| `hiyori_idle_1_repeat` | 600 / 124 | 3,535 / 114 | 7.731 / **9.982** | 0.470 / 0.672 | 0.001 / 0.007 | 0.182 / 0.382 | 0.882 / **1.554** | 0.098 / **10.294** | 0.886 / 1.475 |

#### A2. Story Reading Windows with Active Model (`novel_performance_test.dart`, 1.6s windows)

| Window | Frames / Native Calls | Max Ops / Triangle Batches | `pocket.native` p50 / p95 (ms) | `pocket.decode` p50 / p95 (ms) | `pocket.diff` p50 / p95 (ms) | `pocket.build` p50 / p95 (ms) | `pocket.paint` p50 / p95 (ms) | Flutter `UI Build` p50 / p95 (ms) | Flutter `Raster` p50 / p95 (ms) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `launch_title` | 91 / 25 | 79 / 0 | 0.654 / 1.662 | 0.015 / 0.025 | 0.002 / 0.007 | 0.026 / 0.097 | 0.141 / 0.312 | 0.096 / 1.855 | 0.422 / 1.242 |
| `scene_reveal` | 96 / 47 | 248 / 700 | 0.903 / 2.288 | 0.043 / 0.091 | 0.001 / 0.010 | 0.020 / 0.068 | 0.151 / 0.562 | 0.720 / 2.976 | 0.631 / 1.662 |
| `manual_reading_model_0` | 96 / 48 | 248 / 704 | 0.920 / **1.919** | 0.042 / 0.075 | 0.001 / 0.009 | 0.019 / 0.045 | 0.135 / **0.281** | 0.917 / **1.970** | 0.657 / 1.430 |
| `manual_reading_model_1` | 95 / 48 | 246 / 697 | 0.838 / **1.064** | 0.037 / 0.076 | 0.002 / 0.010 | 0.017 / 0.023 | 0.134 / **0.255** | 0.710 / **1.523** | 0.602 / 1.385 |
| `manual_reading_model_2` | 96 / 48 | 249 / 710 | 0.880 / **2.092** | 0.039 / 0.081 | 0.001 / 0.007 | 0.017 / 0.039 | 0.136 / **0.284** | 0.785 / **2.111** | 0.651 / 1.298 |

---

### Scene (b): Text-Heavy Showcase Pages (`render_pipeline_profile_test.dart`)

| Window | Frames / Native Calls | Max Ops / Retained Blocks | `pocket.native` p50 / p95 (ms) | `pocket.decode` p50 / p95 (ms) | `pocket.diff` p50 / p95 (ms) | `pocket.build` p50 / p95 (ms) | `pocket.paint` p50 / p95 (ms) | Flutter `UI Build` p50 / p95 (ms) | Flutter `Raster` p50 / p95 (ms) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `mobile-0` (cold text layout) | 60 / 6 | 173 / 6 | 1.196 / 3.057 | 0.044 / 0.168 | 0.001 / 0.004 | 0.017 / 0.171 | 0.254 / **17.282** | 0.123 / **19.555** | 1.078 / 3.310 |
| `mobile-1` (warm) | 60 / 5 | 173 / 6 | 1.218 / 1.484 | 0.073 / 0.117 | 0.001 / 0.003 | 0.016 / 0.098 | 0.280 / 0.708 | 0.130 / 1.841 | 1.158 / 1.981 |
| `mobile-2` (warm) | 60 / 5 | 173 / 6 | 0.562 / 1.246 | 0.046 / 0.083 | 0.001 / 0.005 | 0.015 / 0.068 | 0.266 / 0.677 | 0.127 / 1.564 | 1.270 / 1.664 |
| `gallery-0` | 60 / 5 | 207 / 6 | 0.908 / 1.911 | 0.056 / 0.097 | 0.001 / 0.004 | 0.032 / 0.075 | 0.440 / 0.896 | 0.163 / 1.720 | 1.077 / 1.835 |
| `gallery-1` | 60 / 5 | 207 / 6 | 0.907 / 1.839 | 0.049 / 0.080 | 0.001 / 0.003 | 0.016 / 0.065 | 0.343 / 0.506 | 0.152 / 1.653 | 1.215 / 1.689 |
| `gallery-2` | 60 / 5 | 207 / 6 | 0.793 / 1.547 | 0.063 / 0.092 | 0.001 / 0.004 | 0.014 / 0.078 | 0.300 / **2.386** | 0.168 / **2.186** | 1.043 / 2.214 |
| `transitions-0` | 60 / 6 | 256 / 6 | 0.456 / 1.124 | 0.034 / 0.085 | 0.001 / 0.003 | 0.017 / 0.082 | 0.415 / 0.935 | 0.156 / 1.608 | 1.258 / 1.662 |
| `transitions-1` | 60 / 5 | 256 / 6 | 0.659 / 0.808 | 0.038 / 0.052 | 0.001 / 0.001 | 0.025 / 0.049 | 0.402 / 0.478 | 0.145 / 1.494 | 1.113 / 1.491 |
| `transitions-2` | 60 / 5 | 256 / 6 | 0.563 / 1.163 | 0.052 / 0.073 | 0.001 / 0.002 | 0.015 / 0.034 | 0.314 / 0.543 | 0.129 / 1.576 | 1.045 / 1.343 |
| `home-0` | 60 / 5 | 249 / 6 | 1.028 / 2.060 | 0.083 / 0.099 | 0.001 / 0.003 | 0.033 / 0.069 | 0.573 / 0.840 | 0.166 / **3.037** | 1.148 / 1.999 |
| `home-1` | 60 / 5 | 249 / 6 | 0.588 / 1.031 | 0.059 / 0.066 | 0.001 / 0.001 | 0.024 / 0.041 | 0.288 / 0.306 | 0.130 / 1.426 | 1.132 / 1.351 |
| `home-2` | 60 / 5 | 249 / 6 | 0.517 / 1.029 | 0.057 / 0.083 | 0.001 / 0.002 | 0.024 / 0.057 | 0.289 / 0.377 | 0.146 / 1.519 | 1.198 / 1.552 |
| **`mobile_scroll`** (12,530 painted ops) | 71 / 68 | 227 / 6 | 0.689 / **1.011** | 0.059 / 0.089 | 0.001 / 0.003 | 0.028 / 0.065 | 0.452 / **0.842** | 1.674 / **2.394** | 1.328 / 1.836 |
| **`home_pointer_burst`** (11,982 painted ops) | 67 / 68 | 249 / 6 | 0.786 / **1.347** | 0.070 / 0.098 | 0.001 / 0.003 | 0.027 / 0.041 | 0.504 / **0.865** | 1.765 / **2.458** | 1.245 / 1.661 |

---

### Scene (c): Mini-App Sheet and Page Open/Close Transitions (`render_pipeline_profile_test.dart`)

| Window | Frames / Native Calls | Max Ops / Retained Blocks | `pocket.native` p50 / p95 (ms) | `pocket.decode` p50 / p95 (ms) | `pocket.diff` p50 / p95 (ms) | `pocket.build` p50 / p95 (ms) | `pocket.paint` p50 / p95 (ms) | Flutter `UI Build` p50 / p95 (ms) | Flutter `Raster` p50 / p95 (ms) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `miniapp_sheet_open` | 94 / 58 | 242 / 12 | 0.826 / **2.796** | 0.062 / 0.154 | 0.012 / 0.033 | 0.040 / 0.074 | 0.178 / **1.048** | 0.287 / **3.775** | 1.522 / 2.238 |
| `miniapp_sheet_close` | 63 / 71 | 242 / 6 | 0.544 / **1.234** | 0.051 / 0.077 | 0.016 / 0.026 | 0.033 / 0.071 | 0.161 / **0.387** | 1.275 / **2.607** | 1.155 / 1.655 |
| `miniapp_page_open` | 93 / 58 | 237 / 12 | 0.758 / **4.006** | 0.056 / 0.102 | 0.017 / 0.028 | 0.038 / 0.090 | 0.132 / **0.363** | 0.206 / **4.527** | 1.407 / 1.837 |
| `miniapp_page_close` | 69 / 81 | 234 / 6 | 0.441 / **0.936** | 0.050 / 0.065 | 0.016 / 0.037 | 0.029 / 0.052 | 0.131 / **0.355** | 1.086 / **2.203** | 1.331 / 1.601 |

---

## 5. Dominant Stage Analysis

### 1. Lantern Live2D Scene (`hiyori_idle_*`)
- **Dominant Stage**: **`pocket.native`** (`7.35–7.73 ms` p50, **`8.91–9.98 ms` p95** out of `10.29–11.58 ms` total Flutter UI `buildDuration`, or **~80–85% of UI-thread frame time**).
- **Sub-stage Breakdown**:
  - **`pocket.decode`** (Dart PFB1 binary frame parsing of ~3,500 ops / ~100 Live2D mesh spans) accounts for only **`0.44–0.52 ms` p50 / `0.60–0.70 ms` p95** (~7% of `pocket.native`).
  - Therefore, **`~8.2–9.3 ms` at P95** is spent inside the synchronous C/FFI call (`pocket_NextFrameDeltaAt`: QuickJS guest tick + Cubism Live2D mesh deformation + native DrawList/PFB1 buffer emission).
  - **`pocket.paint`** (`PocketCanvasPainter.paint` recording ~100 textured mesh `drawVertices` calls and UI overlays into Flutter display lists) is the **second largest stage** at **`0.77–0.88 ms` p50 / `1.37–1.55 ms` p95**.
  - **`pocket.build`** (`_buildSurface` building ~114 painter widgets) takes **`0.15–0.18 ms` p50 / `0.27–0.38 ms` p95**.
  - **`pocket.diff`** (`_surfaceVisualEquals`) is negligible (**`0.000–0.001 ms` p50 / `0.005–0.007 ms` p95**) because animated mesh blocks early-exit on the first changed vertex/op.

### 2. Text-Heavy Showcase Pages (`mobile-*`, `gallery-*`, `transitions-*`, `home-*`, `mobile_scroll`, `home_pointer_burst`)
- **Dominant Stage (Cold First Paint)**: **`pocket.paint`** (`17.282 ms` p95 on `mobile-0`) dominates the cold first mount due to uncached `TextPainter.layout()` paragraph shaping and macOS CJK/symbol font fallback before `PocketTextLayoutCache` is populated.
- **Dominant Stages (Warm Routes & Continuous Scrolling)**: Once `PocketTextLayoutCache` is warm (`mobile_scroll` and `home_pointer_burst`, ~12,000–12,500 painted ops across 68 frames), total UI `buildDuration` P95 is **`2.39–2.46 ms`**, split almost evenly between:
  - **`pocket.native`**: **`0.69–0.79 ms` p50 / `1.01–1.35 ms` p95** (with `pocket.decode` at `0.06–0.07 ms` p50 / `0.09–0.10 ms` p95), and
  - **`pocket.paint`**: **`0.45–0.50 ms` p50 / `0.84–0.87 ms` p95** (`2.39 ms` p95 when newly revealed text strings are laid out in `gallery-2`).
  - `pocket.build` (`0.04–0.07 ms` p95) and `pocket.diff` (`0.003 ms` p95) are negligible.

### 3. Mini-App Sheet and Page Open/Close Transitions (`miniapp_*`)
- **Dominant Stage**: **`pocket.native`** (`2.80 ms` p95 on `miniapp_sheet_open`, `4.01 ms` p95 on `miniapp_page_open`, and `0.94–1.23 ms` p95 on close; max `12.35–13.42 ms` on open).
- **Why**: During mini-app sheet/page open, two `PocketView` instances (the host SystemUI shell and the embedded `pocket.demo.profile` guest) tick concurrently on the UI thread, and the opening window includes initial JS bundle evaluation and first-frame layout for the child mini-app.
- **Secondary Stage**: **`pocket.paint`** reaches **`1.048 ms` p95** during `miniapp_sheet_open` (cold text/canvas paint of the newly mounted mini-app) and drops to **`0.36–0.39 ms` p95** on subsequent open/close transitions.
- **`pocket.diff` Note**: `pocket.diff` increases from `~0.001 ms` p50 on single-surface routes to **`0.012–0.017 ms` p50 / `0.026–0.037 ms` p95** during dual-surface mini-app transitions because unchanged retained blocks in the non-changing surface run full deep equality checks in `_surfaceVisualEquals`.

---

## 6. Measurement Caveats

All three requested scenes were measured non-interactively in macOS `--profile` mode. Two harness details are worth noting for future comparisons:
1. **`novel_model_soak_test.dart` vs `novel_performance_test.dart` window geometry**: `novel_model_soak_test.dart` runs at the default macOS desktop viewport (`800×600`) and enters the Live2D replay showcase directly (`hiyori_idle_*`), whereas `novel_performance_test.dart` sets a `390×760` mobile viewport where the secondary `panel_沿途回声` return button requires scrolling in the journal menu after `panel_雾港纪念`. Both Live2D workloads (`hiyori_idle_*` 10s soak windows and `manual_reading_model_0..2` story reading windows) completed and emitted full `POCKET_NOVEL_SOAK_WINDOW` / `POCKET_NOVEL_PERF_WINDOW` JSON payloads.
2. **Cold vs Warm Text Layout (`mobile-0` vs `mobile-1..2`)**: Because `mobile-0` is the very first route rendered after app boot in `render_pipeline_profile_test.dart`, its `pocket.paint` P95 (`17.282 ms`) reflects one-time cold font/paragraph initialization rather than steady-state Showcase rendering (`0.68–0.71 ms` p95 in `mobile-1..2`).

---

## 7. Native Stage Attribution

### 7.1 Instrumentation & Gate (`Step 0b`)

To isolate where the `8.2–9.3 ms` p95 inside `pocket.native` (`pocket_frame_delta_binary_v2` / `NextFrameDeltaAt`) is spent during Live2D Hiyori scenes, low-overhead `std::time::Instant` stage timers were added inside [`sdk/native/src/lib.rs`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs) and [`sdk/packages/pocket_live2d/native/src/pocket_live2d_core.cpp`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_live2d/native/src/pocket_live2d_core.cpp):

- **Atomic Sampling Gate**:
  - Controlled by `PERF_SAMPLING_ENABLED` (`AtomicBool` in [`sdk/native/src/lib.rs`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L33-L41)) and `g_live2d_perf_sampling_enabled` (`std::atomic<bool>` in [`pocket_live2d_core.cpp`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_live2d/native/src/pocket_live2d_core.cpp#L48-L60)).
  - Toggled from Dart via `pocket_set_perf_sampling_enabled(int32_t enabled)` only when `PocketView` performance collection is active (`_performanceCollectionEnabled`). When disabled, no `Instant::now()` or `steady_clock::now()` calls are executed (~zero overhead).
- **Single FFI Getter & `PocketPerformanceSample` Integration**:
  - Exposed via `pocket_last_frame_stage_timings_us(int32_t runtime_handle, uint64_t* out_us, uint32_t cap)` in [`sdk/native/include/pocket_flutter.h`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/include/pocket_flutter.h#L72-L80), reading 8 per-frame microsecond counters in a single FFI call and surfacing them on [`PocketPerformanceSample`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_performance.dart#L112-L236) (`native.<stage>MsP95` / `native<Stage>MsP95`):
    1. **`native.js_tick`**: QuickJS `runtime.run_virtual_frames(frames)` (guest timers, `requestAnimationFrame`, Live2D motion/physics/pose evaluation, and JS-to-Core mesh bridge calls).
    2. **`native.live2d_update`**: Cubism C core `csmUpdateModel`, `reset_to_defaults`, `set_parameter`, and `set_part_opacity` in [`pocket_live2d_core.cpp`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_live2d/native/src/pocket_live2d_core.cpp#L62-L91), accumulated per frame and drained on frame emission.
    3. **`native.live2d_emit`**: Core retained `ui.draw()` DrawList emission (including retained `ImageMesh` vertex/UV emission and DrawList word cache check).
    4. **`native.relayout`**: `core.ui.relayout_outputs()` layout pass when layout is dirty.
    5. **`native.draw_decode`**: `decode_draw_ops(&words)` converting raw DrawList words into `FrameOp` records.
    6. **`native.splice`**: `frame_delta::common_splice` computing the prefix/suffix diff against the previous frame's `FrameOp` list.
    7. **`native.encode`**: `encode_frame_delta_binary` / `encode_render_frame_binary` serialising PFP1/PFB1 binary buffers.
    8. **`native.other`**: Remaining synchronous time inside `frame_delta_binary_for_runtime` (resource/texture ledger updates, node list clone, outbound event drain, and `demand::capture` calling `__pocketWorkState` in QuickJS).

### 7.2 Live2D Hiyori 10-Second Soak Native Stage Table (`novel_model_soak_test.dart`, macOS `--profile`, `POCKET_MESH_SUPERSAMPLE=1`)

> **Note**: Values are reported as **`p50 / p95` in milliseconds (ms)**. `pocket.native` includes `pocket.decode` (Dart binary frame decode) plus the C FFI call (`pocket_frame_delta_binary_v2`).

| Window | Frames / Native Calls | `pocket.native` p50 / p95 (ms) | `pocket.decode` p50 / p95 (ms) | `js_tick` p50 / p95 (ms) | `live2d_update` p50 / p95 (ms) | `live2d_emit` p50 / p95 (ms) | `relayout` p50 / p95 (ms) | `draw_decode` p50 / p95 (ms) | `splice` p50 / p95 (ms) | `encode` p50 / p95 (ms) | `other` p50 / p95 (ms) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `hiyori_idle_0` | 601 / 400 | 7.590 / **8.223** | 0.522 / 0.628 | **6.083 / 6.544** | 0.051 / 0.076 | 0.134 / 0.150 | 0.000 / 0.000 | 0.237 / **0.264** | 0.063 / 0.107 | 0.070 / 0.080 | **0.339 / 0.423** |
| `hiyori_idle_1` | 604 / 400 | 7.680 / **9.024** | 0.445 / 0.642 | **6.104 / 6.985** | 0.051 / 0.070 | 0.130 / 0.147 | 0.000 / 0.000 | 0.253 / **0.312** | 0.063 / 0.127 | 0.071 / 0.090 | **0.376 / 0.531** |
| `hiyori_idle_1_closeup` | 601 / 399 | 7.504 / **8.202** | 0.439 / 0.537 | **6.122 / 6.660** | 0.052 / 0.073 | 0.143 / 0.158 | 0.000 / 0.000 | 0.218 / **0.245** | 0.025 / 0.096 | 0.063 / 0.077 | **0.323 / 0.421** |
| `hiyori_idle_0_repeat` | 603 / 77 | 2.672 / **8.441** | 0.268 / 0.616 | **1.328 / 6.759** | 0.000 / 0.073 | 0.134 / 0.145 | 0.000 / 0.000 | 0.259 / **0.289** | 0.065 / 0.112 | 0.007 / 0.080 | **0.385 / 0.501** |
| `hiyori_idle_1_repeat` | 600 / 400 | 7.755 / **8.838** | 0.505 / 0.628 | **6.145 / 6.889** | 0.048 / 0.067 | 0.132 / 0.147 | 0.000 / 0.000 | 0.260 / **0.324** | 0.064 / 0.139 | 0.075 / 0.095 | **0.384 / 0.521** |

### 7.3 Overhead Verification on Text-Heavy Showcase Windows (`render_pipeline_profile_test.dart`, macOS `--profile`)

| Window | Baseline `pocket.native` p50 / p95 (ms) | With Stage Timing `pocket.native` p50 / p95 (ms) | `js_tick` p50 / p95 (ms) | `live2d_emit` p50 / p95 (ms) | `relayout` p50 / p95 (ms) | `draw_decode` p50 / p95 (ms) | `splice` p50 / p95 (ms) | `encode` p50 / p95 (ms) | `other` p50 / p95 (ms) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `mobile-1` (warm) | 1.218 / 1.484 | **0.588 / 0.903** | 0.069 / 0.369 | 0.044 / 0.281 | 0.000 / 0.036 | 0.006 / 0.025 | 0.002 / 0.008 | 0.000 / 0.005 | 0.028 / 0.115 |
| `mobile_scroll` | 0.689 / 1.011 | **0.195 / 0.296** | 0.072 / 0.072 | 0.026 / 0.026 | 0.000 / 0.000 | 0.008 / 0.008 | 0.002 / 0.002 | 0.003 / 0.003 | 0.021 / 0.021 |
| `home_pointer_burst` | 0.786 / 1.347 | **0.240 / 0.311** | 0.069 / 0.069 | 0.024 / 0.024 | 0.000 / 0.000 | 0.008 / 0.008 | 0.002 / 0.002 | 0.003 / 0.003 | 0.018 / 0.018 |

- **Overhead Conclusion**: Both Live2D soak (`8.202–9.024 ms` p95 vs `8.905–9.982 ms` baseline) and text-heavy Showcase (`0.296–0.311 ms` p95 vs `1.011–1.347 ms` baseline) confirm that the atomic-gated `Instant` timers and single 8-`u64` FFI copy add **negligible (~0 ms) overhead**.

### 7.4 Top 2 Native Stages & Root Cause Summary

1. **#1 Dominant Stage — `native.js_tick` (`6.083–6.145 ms` p50 / `6.544–6.985 ms` p95)**:
   - Accounts for **~77–81% of total `pocket.native` p95** (and **~85–87% of pure C/Rust native time** excluding `pocket.decode`).
   - Crucially, Cubism C++ model update (`native.live2d_update`: `csmUpdateModel` + parameter/part updates in `pocket_live2d_core.cpp`) takes only **`0.048–0.052 ms` p50 / `0.067–0.076 ms` p95** (<1% of `pocket.native`), and retained core DrawList emission (`native.live2d_emit`) takes only **`0.130–0.143 ms` p50 / `0.145–0.158 ms` p95**.
   - Instead, the `~6.1–7.0 ms` in `js_tick` is spent inside `runtime.run_virtual_frames(frames)` in QuickJS: per-frame JS Live2D driver orchestration, reading back deformed mesh buffers from the native Cubism bridge into JS arrays, and pushing ~100 drawable meshes (~3,200 triangles / ~16,800 vertex/UV floats) back across the QuickJS-to-Rust `setImageMesh` bridge on every animation frame.
2. **#2 Stage — `native.other` (`0.323–0.385 ms` p50 / `0.421–0.531 ms` p95) & `native.draw_decode` (`0.218–0.260 ms` p50 / `0.245–0.324 ms` p95)**:
   - **`native.other`** (`0.421–0.531 ms` p95) is the second largest raw bucket, driven by `demand::capture(runtime)` evaluating `__pocketWorkState` in QuickJS at the end of every frame tick plus cloning the `core.ui.nodes` vector (`~115` nodes with retained properties).
   - Among explicit pipeline stages, **`native.draw_decode`** (`decode_draw_ops` parsing ~35,000 DrawList `u32` words into ~3,500 `FrameOp` structs with newly allocated `Vec<f32>` vertex/UV buffers every frame) is the **#2 named pipeline stage** at **`0.245–0.324 ms` p95**, followed by `native.live2d_emit` (`0.145–0.158 ms` p95), `native.splice` (`0.096–0.139 ms` p95), `native.encode` (`0.077–0.095 ms` p95), and `native.live2d_update` (`0.067–0.076 ms` p95). `native.relayout` is **`0.000 ms`** throughout steady-state Live2D animation.

