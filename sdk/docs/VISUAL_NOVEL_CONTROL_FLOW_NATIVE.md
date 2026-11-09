# Visual novel native control flow

This fixture verifies that the existing VN engine’s nested `call`/`return` behavior and bounded execution error survive the pinned Guest compiler and real native pointer input.

## Retained source and adaptation

The retained parent at `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was searched outside `pocket_host/` for VN interpreter, call-stack, and step-budget implementations. No retained VN control-flow interpreter was found. The relevant behavior comes from the current reusable SDK engine: `call` pushes the caller’s next script location, `return` pops it, and `runUntilBlocking` enforces the instruction budget in [engine.ts](../packages/pocket_vn/src/engine.ts). Its existing transaction boundary restores the prior state when an instruction chain throws.

The test adds no interpreter or runtime wrapper. It compiles a temporary Solid Guest with `buildGuest`, creates the ordinary `createNovelEngine`, and uses four visible `Focusable` controls to invoke `start`, `advance`, and `selectChoice`. `NativeSession` sends pointer down/up events to the pinned native probe and reads the resulting DrawList. The fixture renders selected engine snapshot fields so assertions are based on the engine state actually displayed by that Guest.

## Native interaction covered

The test performs these actions through painted button text:

1. Start at the root dialogue, then advance to an outer subroutine and an inner subroutine.
2. Check the inner dialogue’s two return addresses (`start[3]`, then `outer[3]`) and the variable trace `root>outer>inner`.
3. Advance through both returns and verify the outer and root dialogues show the matching one-frame and empty stacks, with trace values confirming execution order.
4. Select the authored loop option. With `maxStepBudget: 32`, the real Guest displays `StepBudgetExceededError: Story execution exceeded its 32-step budget`.
5. Verify the failed choice transaction leaves the root choice active, restores `loopCount` to `0`, and keeps the safe choice usable. A second real pointer action selects it and reaches the next dialogue.

The expected call-stack depths at the successive root/outer/inner/outer/root dialogue stops are `0, 1, 2, 1, 0`. The return addresses and trace values are asserted from the Guest-rendered `getSnapshot()` data, not inferred from the fixture’s button sequence.

## Validation evidence

Run from the repository root with the pinned Bun 1.4.4 executable:

```sh
sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test sdk/editor/test/novel_control_flow_native.test.ts
```

The test selects the pinned `highres-native-tools-20261107` package and its `bin/pocket_probe` directly. Result: **1 pass, 0 failures**. Guest output from the passing run:

- QuickJS bytecode SHA-256: `b60a44f36a38e96fadb2b0c786e367b5b3089c626ca2956ca0d6ecb17758142b`
- PAK SHA-256: `94147c01838a87a787fce0c08c000157587c40ff21390ff587107d43f0e5c244`
- Runtime ABI: `quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021`
- Observed stack depths: `[0,1,2,1,0]`; execution budget: `32`; recovery after rollback: `true`.

The temporary Guest and its generated artifacts are removed after each run. This proves compiled QuickJS execution, native DrawList output, and pointer-driven recovery through `NativeSession`; it is not a Flutter platform or device test.
