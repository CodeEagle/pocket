# Isolated codec experiment

This is a QuickJS codec microbenchmark, not an SDK runtime dependency or an end-to-end latency/FPS test. The schema, representative fixtures, map conversion and byte-level round-trip checks are in `bench.mjs`. The committed JSON records the original measured run; machine paths identify its probe and are not required by the script.

Run from the repository root with Bun and Node, after building the current native probe:

```sh
codec_bench_dir="$(mktemp -d)"
cp sdk/scripts/bench/transport_codec/*.mjs "$codec_bench_dir/"
cd "$codec_bench_dir"
bun add protobufjs@7.5.4
bun build bench.mjs --target=browser --format=iife --outfile=bench.bundle.js
node quickjs_probe.mjs /absolute/path/to/pocket_probe 6000 7 2000
```

The harness bounds the probe process to 30 seconds. Dependency installation and bundling stay in the temporary directory. Results cover the guest codec only: JSON stringify/parse versus ProtobufJS encode/decode plus conversion of the existing open map API to/from Struct. Interpret millisecond-clock quantization and implementation/schema choice as described in `sdk/docs/TRANSPORT_CODEC_EVALUATION.md`.
