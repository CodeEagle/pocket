# Live2D vertex-change flag facts

## Question and source boundary

This measurement checks whether Cubism Core's `VertexPositionsDidChange` flag
can gate the existing JS mesh transform and PMS1 encoder. The retained parent
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was searched outside
`pocket_host/` for Cubism, Live2D, ArtMesh and mesh-encoding support; it has no
Live2D deformation or renderer to port.

The real Core is the locally accepted official Cubism Native SDK 5 r.5 archive.
[`bootstrap_cubism_core.sh`](../packages/pocket_live2d/scripts/bootstrap_cubism_core.sh)
pins its archive SHA-256 as
`7ff3a4bbc19c0a8728965aa522ab77eb11b252916453e68a8a78d3b71188bb12`. The
official `Live2DCubismCore.h` dynamic drawable flags assign bit 5 (`1 << 5`)
to `csmVertexPositionsDidChange`; bits 0–6 also cover visibility,
visibility-change, opacity, draw-order, render-order and blend-color changes.
The actual cached header SHA-256 is
`6f1802780d1eb36ff39705e0764f9eeed9b41c313a13ac155270c6f4ad51d53f`.

The existing bridge already resets dynamic flags before each Core update,
copies current flags and positions from Core, and passes those fields through
the typed host response. The JS factory currently transforms each drawable's
positions and calls `encodeNovelMesh()` every update. Its `Float32Array` and
PMS1 byte buffer are reused, but that reuse still rewrites the geometry. This
measurement adds no production cache or Core behavior change.

## Real Core method

The existing macOS bridge test now probes both official sample MOCs directly
through `PocketLive2dPlugin`, `PocketLive2dFfiCore` and the pinned Core library.
For each model it:

- sends six repeated default-parameter updates after model load and compares
  every drawable's exact float positions and bit 5 against the prior frame;
- changes `ParamAngleX` to 30 and measures which drawables' positions move and
  which output flags are set;
- sends four further identical `ParamAngleX = 30` updates and checks that the
  coordinates remain stable while recording the flags;
- reports the four-way count of flagged/moved, flagged/still,
  unflagged/moved and unflagged/still drawables, plus moved-component count and
  maximum absolute coordinate delta.

The test asserts coordinate stability on repeated identical inputs and real
position deformation for the changed parameter. It records Core flag behavior
without assuming that the flag clears on a stable pose or exactly matches
numeric position differences.

## Measured macOS arm64 results

Command, run from `sdk/packages/pocket_live2d`:

```sh
FLUTTER_BIN=/Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter \
CUBISM_SDK_ROOT="$PWD/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5" \
sh scripts/run_macos_core_bridge_test.sh
```

The script compiles the package's Core FFI bridge in a temporary build folder
and runs only `test/live2d_core_bridge_test.dart`; it does not build the Demo
Guest or run a Flutter platform integration. Result: **2 tests passed**, log
`/tmp/pocket-live2d-geometry-core-test.log`.

| Official sample | Default pose: 6 consecutive frames | `ParamAngleX` change from stable default | Four repeated frames at angle 30 |
| --- | --- | --- | --- |
| Mao, 262 drawables | Every frame: 0 moved components; all 262 had bit 5 set and unchanged positions | 93 flagged and moved; 169 flagged but unchanged; 0 unflagged. 5,922 components moved, max delta 281.079590 px | Every frame: all 262 flagged but unchanged; 0 moved components |
| Hiyori, 134 drawables | Every frame: 0 moved components; all 134 had bit 5 set and unchanged positions | 92 flagged and moved; 42 flagged but unchanged; 0 unflagged. 2,964 components moved, max delta 61.830078 px | Every frame: all 134 flagged but unchanged; 0 moved components |

These files are the official sample models under the pinned archive's
`Samples/Resources/{Mao,Hiyori}` directories. Their observed MOC SHA-256 values
were `ad5195b39e35e0da8ba0c825ad9cc2d60571502007f6f7d4f00963b768bb90d8`
(Mao) and
`0323f5f377b9afef54318be09e9b4eea2a8cb266190ff9d2f843f95ecb77716c`
(Hiyori).

## Decision boundary

Both real models set bit 5 on every drawable for every tested update, including
repeated updates whose positions are byte-for-byte stable. The flag therefore
does not expose reusable static geometry in this bridge path, and a bit-only JS
cache would encode every drawable anyway. Parameter changes set the flag on
unchanged drawables as well as on moved ones. No production geometry cache was
added and no performance claim is made.

The result covers only the pinned Core's macOS arm64 execution and the
default/`ParamAngleX` sample poses. It is not a rendered-pixel comparison, a
cross-platform Core check, or an FPS/profile result. A value-comparison scan
would have to inspect the positions it aims to skip and has not been measured;
it should not replace the Core flag without a separate one-variable profile
showing a benefit.
