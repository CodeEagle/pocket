# Atomic platform storage batch

## Source-first boundary

The retained parent project `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` has no generic atomic key/value batch API outside `pocket_host/`. The retained WeChat adapter at `wechat_host/core/wx_pocket_host.js` writes one key at a time with `wx.setStorageSync`; it has no transaction that can commit several keys together.

Pocket's existing storage path is the single app-scoped `platform.storage` client in `packages/pocket_ui/src/platform.ts`, JS System authorization and namespace checks in `packages/pocket_ui/src/system.ts`, trusted System-only dispatch in `lib/src/pocket_system_host.dart`, and the serialized host-owned JSON store in `lib/src/pocket_platform_data.dart`. The data store already writes one full snapshot through a same-directory temporary file, flush and atomic rename. Batch reuses that boundary and adds no guest filesystem, second data store, or domain-specific slot policy.

## API and contract

```ts
await platform.storage.batch([
  { type: "set", key: "save.1", value: saveData },
  { type: "remove", key: "save.2" },
]);
```

`PlatformStorageOperation` is an exported readonly union of `set` with a JSON value and `remove` with a key. An optional second `namespace` argument follows the existing `get`, `set`, `remove`, and `keys` methods. Every operation in a batch targets the same private app bucket or one shared namespace; cross-scope transactions, reads, and compare-and-swap are not provided. Empty batches resolve as no-ops. Non-empty batches are limited to 256 operations, and each key may appear once.

The System validates every operation before forwarding the batch. Values use the existing 64 KiB per-value limit. The native data store validates the entire batch again, stages the resulting bucket, and checks the final bucket against the existing 1 MiB scope quota. This permits a move or swap to remain within quota even when an intermediate ordering would temporarily exceed it. The packet also remains subject to Pocket's existing 256 KiB host request envelope limit.

## Atomicity and authorization

The native store serializes batch calls with ordinary storage reads and writes. It copies the selected bucket, validates every operation and value, applies the unique-key mutations to that copy, validates final quota, and encodes the candidate full store snapshot. It writes one same-directory temporary file with flush enabled and atomically renames it over the store file. Only after that succeeds does it replace the in-memory selected bucket. A malformed operation, duplicate key, value/scope limit, or temporary-file/rename failure does not partially mutate the live bucket or persisted snapshot.

JS System first authorizes the calling runtime and checks the requested namespace against that app's current grants. Dart accepts the storage request only from the trusted SystemUI context, restricts the target app ID to the trusted host map, and the data store rechecks the app registration and shared namespace grant. Batch operations contain only keys and values; they cannot choose another app or namespace.

## Hosts without atomic batch support

The System host implements batch with one native data-store transaction. The WeChat adapter explicitly rejects unknown `platform.storage.*` operations with an `unsupported` error; Editor preview's in-memory storage also rejects `system.storage.batch` instead of applying sequential writes and claiming success. Single-key legacy operations remain available on those hosts. Generic browser `storage.*` is a separate framework boundary and is not advertised as this app-scoped API.

## Validation

From `sdk/`:

```sh
bun test packages/pocket_ui/test/platform_client.test.ts packages/pocket_ui/test/system_kernel.test.ts
bun test editor/test/preview_storage.test.ts
flutter test test/platform_data_test.dart
flutter test test/pocket_system_host_test.dart --plain-name='awaitFirstFrame throws when a runtime fails after producing an Offstage frame and then becoming visible'
```

The guest client fixture checks the typed wire shape. The System fixture checks one native batch request, namespace denial, duplicate/value-size rejection before native IO, and prewarmed app reads after a batch. Dart store tests cover swap and restart, malformed/duplicate/over-value/over-count/final-quota batches, and a blocked temporary path with both memory and disk unchanged. The native System host test verifies the capability is registered and invalid duplicate-key operations do not commit the first operation. Editor preview has an explicit unsupported-operation assertion.
