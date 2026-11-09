# Visual Novel Live2D Physics and Pose

## Source audit and retained behavior

The retained parent repository `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was inspected outside `pocket_host/`. It contains the general Pocket host patterns in `lib/core/ffi_bridge.dart` and `lib/core/pocketjs_bundle_runner.dart`, but no Cubism model loader, motion runtime, physics solver, pose solver, or Live2D regression fixtures. The retained source therefore contributes the existing FFI/lifecycle boundary; this implementation fills a verified Live2D gap in the reusable SDK instead of migrating code from `pocket_host/`.

The existing `sdk/packages/pocket_live2d/src/motion.ts` parser and evaluator remain the motion source of truth. Official `CubismWebFramework` `src/motion/cubismmotion.ts` treats a motion curve with `Target: "PartOpacity"` as a parameter write by ID. Pose uses those same-ID values as virtual selection parameters. Pocket keeps that virtual state in JS, then sends actual Core parameter values and actual Core part opacity values across the existing transport.

## Runtime ownership

The JavaScript SDK parses and runs `physics3.json` and `pose3.json`. It samples the existing motion/expression state, runs physics, applies pose selection/fade/link rules, and then sends parameter values and part opacities through the existing Live2D model update capability. The order is motion and expression, physics, pose, Core deformation. Physics outputs that are used by a pose group are included as pose selection writes.

Native Cubism Core remains responsible for facts only available from the actual MOC3: parameter IDs and minimum/maximum/default values, part IDs and default opacities, and model deformation. The `parameterMetadata` and `parts` load facts are optional for older injected providers. A model that references physics or pose fails clearly if its provider does not expose the facts required by that feature. The runtime does not invent an empty metadata list or use guessed Core bounds.

## Official algorithm and adaptation boundary

The solver source is pinned to [Live2D/CubismWebFramework 5-r.5](https://github.com/Live2D/CubismWebFramework/tree/5-r.5), commit `198a3769c26ca3d7b600e932590433badd392edd`. The checked-in `src/cubism-web/LICENSE.md` is the upstream license notice. The corresponding original-source hashes and checked-in adaptation hashes are in `sdk/packages/pocket_live2d/scripts/cubism-web-framework-5-r5.sha256`; `scripts/verify_cubism_web_framework.sh` verifies both against a pinned checkout.

The upstream solver's particle integration, input normalization, output calculation, and interpolation remain in `src/cubism-web/physics.ts`. Pocket adapts the JSON parser and model boundary: serialized JSON is strictly validated, IDs are strings, and the parameter arrays use real Core facts. `math.ts` and `vector2.ts` retain upstream math/vector operations with local imports and strict TypeScript types. The source headers distinguish exact upstream code from adapted code; adapted files are not described as byte-for-byte copies. Pose's reset, fade, and linked-part behavior is adapted from upstream `src/effect/cubismpose.ts` to operate on JS maps and Core facts.

The redundant local assignment to the `CubismPhysics.delete()` argument was removed because it could not affect the caller. On release the solver drops its rig, output buffers, and parameter caches. The public Live2D simulation also rejects further work after disposal. Physics delta is bounded to Cubism's official five-second maximum; a zero delta preserves the most recent physics output while paused.

The bootstrap and hash verification commands are:

```sh
cd sdk/packages/pocket_live2d
sh scripts/bootstrap_cubism_web_framework.sh
sh scripts/verify_cubism_web_framework.sh
```

The bootstrap clones the official repository into the ignored `.cache/` directory only when the pinned checkout is absent. It refuses a checkout at any other commit. No Cubism Core binary or official model binary is vendored in source.

Live2D Cubism Web Framework is licensed under the Live2D Open Software License; consult the included notice for the license terms. Live2D's notice also states that businesses with annual gross revenue of at least JPY 10 million in the most recent fiscal year must obtain the Cubism SDK Release License. Cubism Core is separately licensed as proprietary software and remains a developer-provided/cache dependency; it is not included in the SDK source package.

## Reference and integration validation

The compact fixture `sdk/packages/pocket_live2d/test/fixtures/cubism-web-5-r5-dynamics-reference.json` records Physics and Pose outputs sampled from the original upstream framework. `test/dynamics.test.ts` compares the JS adapter to those official reference values, checks pause/bounded-hitch/dispose behavior, and rejects missing Core parameter facts or inconsistent physics counts. Pose's reference uses the Hiyori-style `PartArmA` / `PartArmB` virtual selector group.

For the complete official Hiyori rig, run:

```sh
cd sdk/packages/pocket_live2d
sh scripts/bootstrap_cubism_web_framework.sh
bun scripts/compare_hiyori_physics_reference.ts
```

This loads the official cached Hiyori model3, physics3, and Idle:0 motion, compares all 300 updates at 60 Hz against `CubismPhysics` from the pinned upstream framework, and requires the adapted `ParamHairFront` output to match within `1e-6`. The script uses actual Core facts for every physics input and for `ParamHairFront`; it uses broad placeholder bounds only for unrelated output IDs and verifies that none of those output IDs feed physics inputs. The last run matched all 300 frames exactly (`maximumHairDifference: 0`) and produced a nonzero `ParamHairFront` range of `1.0629920959` across the five-second motion window.

The real default-FFI Hiyori QJBC guest was separately exercised on macOS, iOS, and Android after rebuilding the guest artifact. Each run reported 70 actual Core parameters and 24 parts; HairFront changed over 150 macOS updates (`range=0.5403402`), 123 iOS updates (`range=0.3436862`), and 144 Android updates (`range=0.5412045`). Those integration checks also verified real mesh deformation/paint, pose part-opacity changes, pause without Core updates, resume, and release. The guest builder now always rebuilds its fixture instead of reusing an earlier QJBC with physics/pose omitted.

The authored-code checks are:

```sh
cd sdk/packages/pocket_live2d
bun test test/dynamics.test.ts test/live2d.test.ts
cd ../pocket_vn
bun test test/live2d.test.ts
cd ../..
bunx tsc --noEmit --strict --allowImportingTsExtensions --target ES2022 --moduleResolution bundler --module ESNext packages/pocket_live2d/src/index.ts packages/pocket_vn/src/live2d.ts
```

The Hiyori model and Core runtime remain inputs from the official SDK cache. Consumers must comply with the applicable Live2D terms for both the framework and Core/model assets.
