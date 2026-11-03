# Pocket plugin TypeScript contracts

`pocket_services` descriptors can carry an optional, bounded JSON schema for a
capability. `sdk/scripts/plugin_types.ts` turns a consumer's exported plugin
descriptor plus the actual `PocketHost.capabilitiesJson()` registry export into
deterministic TypeScript declarations and a typed client. Generated requests
use the public `@pocket/ui/host` `HostBridge`; generated stream methods use the
public `@pocket/ui/streams` `PocketStreamAdapter`. The generator reads JSON
only; it does not inspect or execute Dart, install plugins, or infer a
signature from a method name.

This is the source-first adaptation of the retained demo generator at
[`sync_pocket_plugins.py:256`](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/tools/sync_pocket_plugins.py:256).
The old static method table, fixed `sizeKB` estimates and pseudo ABI hashes are
not part of this contract.

## Consumer export

The canonical generator input combines the plugin manager manifest and the
host registry export. The registry is authoritative for capability existence
and `request`/`stream` kind:

```json
{
  "protocolVersion": 1,
  "runtimeDependency": {
    "package": "@pocket/ui/host",
    "version": "0.1.0"
  },
  "host": {
    "available": [
      { "name": "device.info", "kind": "request" },
      { "name": "sensor.readings", "kind": "stream" }
    ]
  },
  "plugins": [
    {
      "id": "sensor.plugin",
      "version": "1.0.0",
      "types": {
        "Reading": {
          "type": "object",
          "properties": {
            "value": { "type": "number" },
            "unit": { "type": "enum", "values": ["c", "f"] }
          },
          "required": ["value"]
        }
      },
      "capabilities": [
        {
          "name": "sensor.readings",
          "kind": "stream",
          "schema": {
            "parameters": {
              "type": "object",
              "properties": { "sampleRate": { "type": "integer" } },
              "required": ["sampleRate"]
            },
            "streamItem": { "type": "ref", "ref": "Reading" }
          }
        }
      ]
    }
  ]
}
```
`PocketPluginManager.manifest()` remains compatible with old consumers. A
consumer that already exports the manager manifest and host registry can wrap
them under `plugins` and `host` without changing runtime permission or
lifecycle policy. `runtimeDependency` is an exact package/version contract for
the generated import; it can instead be supplied to the script as
`--runtime-package` and `--runtime-version`.

## Schema vocabulary

Schema nodes are deliberately JSON-only and have a 16-level depth, 256-node,
64-property, 64-enum-value and 64 KiB descriptor-schema bound. Supported node
types are:

- `string`, `integer`, `number`, `boolean`, `null`, and `unknown`;
- `object` with `properties` and an optional `required` array;
- `array` with one `items` node;
- `enum` with finite JSON primitive `values`;
- `ref` with a safe name resolved in the owning descriptor's `types` map.

An object property omitted from `required` becomes an optional readonly
TypeScript property. `unknown` stays `unknown`; it is never widened to `any`.
Unknown fields, unsafe identifiers, unresolved references, invalid enum values,
and `additionalProperties: true` are rejected. The current host wire accepts
an object for request parameters, so a capability's top-level `parameters`
schema must be an object (primitive, array, enum and reference types are fully
supported for nested values, results and stream items).

Descriptors without `schema` remain valid. Their generated parameters use
`JsonObject`, results/items use `unknown`, and no unsupported signature is
invented.

## Generated client and transport boundary

For every capability present in both the plugin descriptor and the actual host
registry, the output preserves the exact dotted wire name as a quoted property
key. Request methods call the existing `HostBridge`; stream methods receive a
`PocketStreamAdapter` over the existing Dart `PocketStreamBridge` event wire.
The generated file does not create a request queue, timer, stream transport,
permission state machine or second bridge.

The output includes readonly schema aliases, a capability map, runtime package
and version constants, and a plugin client factory. Capabilities declared by a
plugin but absent from the host registry are omitted from all generated types
and clients; `generatePluginTypesReport()` returns them as diagnostics. A kind
mismatch or duplicate declaration is an error. The generated declarations are
not authorization: host negotiation, allowlists, permissions, quotas and
activation remain the runtime authority.

Example command:

```sh
bun sdk/pocket.ts types host-descriptors.json --out=src/plugin-types.ts
# The standalone script also exposes generation options:
bun sdk/scripts/plugin_types.ts \
  --input build/plugin-descriptors.json \
  --output build/pocket-plugin-types.ts
```

When the input does not carry `runtimeDependency`, pass both runtime flags:

```sh
bun sdk/scripts/plugin_types.ts \
  --input build/plugin-descriptors.json \
  --runtime-package @pocket/ui/host \
  --runtime-version 0.1.0 \
  --output build/pocket-plugin-types.ts
```

If a consumer uses a package alias instead of the conventional runtime paths,
override the type-only imports with `--host-module` and `--stream-module`.

The generated module is deterministic: plugins, capabilities, named types and
object properties are sorted, and identifiers are allocated from safe names
without accepting raw TypeScript fragments. It is a type/client generation
step only; it does not claim native tree-shaking, dependency locking, dynamic
plugin installation or ABI verification.

## Verification

The fixture and tests cover deterministic output, exact wire names, reference
types, enum/optional properties, an untyped legacy descriptor, malicious names,
registry kind mismatches, unavailable capabilities and an independent positive
and negative TypeScript typecheck:

```sh
bun test --timeout 60000 sdk/scripts/tests/plugin_types.test.ts
cd sdk/packages/pocket_services
dart test test/plugin_schema_test.dart
```
