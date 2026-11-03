/**
 * Generate safe TypeScript plugin declarations from exported runtime
 * descriptors.
 *
 * The input is intentionally data-only.  It must contain both the plugin
 * descriptors and an export from the actual host registry:
 *
 * {
 *   "protocolVersion": 1,
 *   "runtimeDependency": { "package": "@pocket/ui/host", "version": "0.1.0" },
 *   "host": { "available": [{ "name": "sensor.readings", "kind": "stream" }] },
 *   "plugins": [{ "id": "sensor", "version": "1.0.0", "types": {},
 *     "capabilities": [{ "name": "sensor.readings", "kind": "stream",
 *       "schema": { "parameters": { "type": "object" },
 *                    "streamItem": { "type": "number" } } }] }]
 * }
 *
 * No Dart source, executable plugin code, or raw TypeScript is read.  The
 * generated client only calls the already-public HostBridge and an injected
 * stream adapter; it never creates another transport.
 */

import { readFileSync, writeFileSync } from "node:fs";

export const PLUGIN_TYPES_PROTOCOL_VERSION = 1;
const MAX_DESCRIPTOR_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 256;
const MAX_SCHEMA_PROPERTIES = 64;
const MAX_ENUM_VALUES = 64;
const MAX_STRING_LENGTH = 256;
const CAPABILITY_NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const PLUGIN_ID = /^[a-z][a-z0-9._-]{1,63}$/;
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RUNTIME_VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

export interface PluginRuntimeDependency {
  package: string;
  version: string;
}
export interface GeneratePluginTypesOptions {
  runtimeDependency?: PluginRuntimeDependency;
  /** A bare module name used by generated type-only imports. */
  hostModule?: string;
  /** Public PocketStreamAdapter module used by generated stream clients. */
  streamModule?: string;
}

export interface PluginTypesGeneration {
  source: string;
  includedCapabilities: readonly string[];
  unavailableCapabilities: readonly string[];
}

export class PluginTypesError extends Error {
  readonly path: string;

  constructor(message: string, path = "descriptor") {
    super(`${path}: ${message}`);
    this.name = "PluginTypesError";
    this.path = path;
  }
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type RecordValue = Record<string, unknown>;

type SchemaType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "null"
  | "object"
  | "array"
  | "enum"
  | "ref"
  | "unknown";

interface SchemaNode {
  readonly type: SchemaType;
  readonly properties?: ReadonlyMap<string, SchemaNode>;
  readonly required?: ReadonlySet<string>;
  readonly items?: SchemaNode;
  readonly values?: readonly JsonPrimitive[];
  readonly ref?: string;
}

interface CapabilitySchema {
  readonly parameters?: SchemaNode;
  readonly result?: SchemaNode;
  readonly streamItem?: SchemaNode;
}

interface PluginCapability {
  readonly name: string;
  readonly declaredKind: "request" | "stream";
  readonly schema?: CapabilitySchema;
}

interface PluginDescriptor {
  readonly id: string;
  readonly version: string;
  readonly types: ReadonlyMap<string, SchemaNode>;
  readonly capabilities: readonly PluginCapability[];
}

interface HostCapability {
  readonly name: string;
  readonly kind: "request" | "stream";
}

interface ParsedDescriptor {
  readonly runtime: PluginRuntimeDependency;
  readonly plugins: readonly PluginDescriptor[];
  readonly registry: ReadonlyMap<string, HostCapability>;
}

interface IncludedCapability {
  readonly plugin: PluginDescriptor;
  readonly capability: PluginCapability;
  readonly host: HostCapability;
}

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginTypesError("must be an object", path);
  }
  return value as RecordValue;
}

function string(value: unknown, path: string, maxLength = MAX_STRING_LENGTH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PluginTypesError("must be a non-empty safe string", path);
  }
  return value;
}

function optionalString(value: unknown, path: string, maxLength = MAX_STRING_LENGTH): string | undefined {
  if (value === undefined) return undefined;
  return string(value, path, maxLength);
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PluginTypesError("must be an integer", path);
  }
  return value;
}

function rejectUnknownFields(value: RecordValue, allowed: readonly string[], path: string): void {
  const names = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (names.length > 0) throw new PluginTypesError(`unknown fields: ${names.join(", ")}`, path);
}

function jsonPrimitive(value: unknown, path: string): JsonPrimitive {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new PluginTypesError("enum values must be finite JSON primitives", path);
}

function parseSchema(value: unknown, path: string, depth = 0, state = { nodes: 0 }): SchemaNode {
  if (depth > MAX_SCHEMA_DEPTH) throw new PluginTypesError(`exceeds schema depth ${MAX_SCHEMA_DEPTH}`, path);
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) throw new PluginTypesError(`exceeds ${MAX_SCHEMA_NODES} schema nodes`, path);
  const valueObject = record(value, path);
  const rawType = valueObject.type;
  if (rawType === undefined && typeof valueObject.$ref === "string") {
    rejectUnknownFields(valueObject, ["$ref"], path);
    const ref = string(valueObject.$ref, `${path}.$ref`);
    if (!TYPE_NAME.test(ref)) throw new PluginTypesError("reference name is not safe", `${path}.$ref`);
    return { type: "ref", ref };
  }
  if (typeof rawType !== "string" || !["string", "integer", "number", "boolean", "null", "object", "array", "enum", "ref", "unknown"].includes(rawType)) {
    throw new PluginTypesError("unsupported schema type", `${path}.type`);
  }
  const type = rawType as SchemaType;
  switch (type) {
    case "object": {
      rejectUnknownFields(valueObject, ["type", "properties", "required", "additionalProperties"], path);
      if (valueObject.additionalProperties !== undefined && valueObject.additionalProperties !== false) {
        throw new PluginTypesError("additionalProperties must be false when present", `${path}.additionalProperties`);
      }
      const properties = new Map<string, SchemaNode>();
      if (valueObject.properties !== undefined) {
        const propertiesObject = record(valueObject.properties, `${path}.properties`);
        const names = Object.keys(propertiesObject).sort();
        if (names.length > MAX_SCHEMA_PROPERTIES) throw new PluginTypesError(`exceeds ${MAX_SCHEMA_PROPERTIES} properties`, `${path}.properties`);
        for (const name of names) {
          if (name.length === 0 || name.length > MAX_STRING_LENGTH || /[\u0000]/u.test(name)) {
            throw new PluginTypesError("property name is not safe", `${path}.properties`);
          }
          properties.set(name, parseSchema(propertiesObject[name], `${path}.properties.${name}`, depth + 1, state));
        }
      }
      const required = new Set<string>();
      if (valueObject.required !== undefined) {
        if (!Array.isArray(valueObject.required)) throw new PluginTypesError("must be an array", `${path}.required`);
        for (const item of valueObject.required) {
          const name = string(item, `${path}.required`);
          if (required.has(name)) throw new PluginTypesError("contains a duplicate property", `${path}.required`);
          required.add(name);
        }
      }
      for (const name of required) if (!properties.has(name)) throw new PluginTypesError(`required property is not declared: ${name}`, `${path}.required`);
      return { type, properties, required };
    }
    case "array":
      rejectUnknownFields(valueObject, ["type", "items"], path);
      return { type, items: parseSchema(valueObject.items, `${path}.items`, depth + 1, state) };
    case "enum": {
      rejectUnknownFields(valueObject, ["type", "values"], path);
      if (!Array.isArray(valueObject.values) || valueObject.values.length === 0 || valueObject.values.length > MAX_ENUM_VALUES) {
        throw new PluginTypesError(`values must contain 1-${MAX_ENUM_VALUES} entries`, `${path}.values`);
      }
      return { type, values: valueObject.values.map((item, index) => jsonPrimitive(item, `${path}.values[${index}]`)) };
    }
    case "ref": {
      rejectUnknownFields(valueObject, ["type", "ref"], path);
      const ref = string(valueObject.ref, `${path}.ref`);
      if (!TYPE_NAME.test(ref)) throw new PluginTypesError("reference name is not safe", `${path}.ref`);
      return { type, ref };
    }
    case "string":
    case "integer":
    case "number":
    case "boolean":
    case "null":
    case "unknown":
      rejectUnknownFields(valueObject, ["type"], path);
      return { type };
  }
}

function parseCapabilitySchema(value: unknown, path: string): CapabilitySchema {
  const valueObject = record(value, path);
  rejectUnknownFields(valueObject, ["parameters", "result", "streamItem"], path);
  return {
    ...(valueObject.parameters === undefined ? {} : { parameters: parseSchema(valueObject.parameters, `${path}.parameters`) }),
    ...(valueObject.result === undefined ? {} : { result: parseSchema(valueObject.result, `${path}.result`) }),
    ...(valueObject.streamItem === undefined ? {} : { streamItem: parseSchema(valueObject.streamItem, `${path}.streamItem`) }),
  };
}

function parseTypes(value: unknown, path: string): ReadonlyMap<string, SchemaNode> {
  if (value === undefined) return new Map();
  const valueObject = record(value, path);
  const names = Object.keys(valueObject).sort();
  if (names.length > 128) throw new PluginTypesError("contains more than 128 named types", path);
  const result = new Map<string, SchemaNode>();
  for (const name of names) {
    if (!TYPE_NAME.test(name)) throw new PluginTypesError("type name is not safe", `${path}.${name}`);
    result.set(name, parseSchema(valueObject[name], `${path}.${name}`));
  }
  return result;
}

function parsePlugin(value: unknown, path: string): PluginDescriptor {
  const valueObject = record(value, path);
  rejectUnknownFields(valueObject, ["protocolVersion", "id", "version", "kind", "permissions", "optionalPermissions", "limits", "description", "types", "capabilities"], path);
  if (valueObject.protocolVersion !== undefined && integer(valueObject.protocolVersion, `${path}.protocolVersion`) !== PLUGIN_TYPES_PROTOCOL_VERSION) {
    throw new PluginTypesError(`protocolVersion must be ${PLUGIN_TYPES_PROTOCOL_VERSION}`, `${path}.protocolVersion`);
  }
  const id = string(valueObject.id, `${path}.id`, 64);
  if (!PLUGIN_ID.test(id)) throw new PluginTypesError("plugin id is not safe", `${path}.id`);
  const version = string(valueObject.version, `${path}.version`, 128);
  if (!Array.isArray(valueObject.capabilities)) throw new PluginTypesError("must be an array", `${path}.capabilities`);
  const capabilities: PluginCapability[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < valueObject.capabilities.length; index += 1) {
    const capabilityPath = `${path}.capabilities[${index}]`;
    const capabilityObject = record(valueObject.capabilities[index], capabilityPath);
    rejectUnknownFields(capabilityObject, ["name", "kind", "description", "permissions", "optionalPermissions", "schema"], capabilityPath);
    const name = string(capabilityObject.name, `${capabilityPath}.name`, 128);
    if (!CAPABILITY_NAME.test(name)) throw new PluginTypesError("capability name is not safe", `${capabilityPath}.name`);
    if (seen.has(name)) throw new PluginTypesError(`duplicate capability: ${name}`, `${path}.capabilities`);
    seen.add(name);
    const declaredKind = capabilityObject.kind;
    if (declaredKind !== "request" && declaredKind !== "stream") throw new PluginTypesError("kind must be request or stream", `${capabilityPath}.kind`);
    const schema = capabilityObject.schema === undefined ? undefined : parseCapabilitySchema(capabilityObject.schema, `${capabilityPath}.schema`);
    if (declaredKind === "request" && schema?.streamItem !== undefined) throw new PluginTypesError("request capability cannot declare streamItem", `${capabilityPath}.schema`);
    if (declaredKind === "stream" && schema?.result !== undefined) throw new PluginTypesError("stream capability cannot declare result", `${capabilityPath}.schema`);
    capabilities.push({ name, declaredKind, ...(schema === undefined ? {} : { schema }) });
  }
  return { id, version, types: parseTypes(valueObject.types, `${path}.types`), capabilities };
}

function parseRegistry(value: unknown, path: string): ReadonlyMap<string, HostCapability> {
  const valueObject = record(value, path);
  rejectUnknownFields(valueObject, ["available", "guest"], path);
  if (!Array.isArray(valueObject.available)) throw new PluginTypesError("must contain an available array", `${path}.available`);
  const result = new Map<string, HostCapability>();
  for (let index = 0; index < valueObject.available.length; index += 1) {
    const itemPath = `${path}.available[${index}]`;
    const item = record(valueObject.available[index], itemPath);
    rejectUnknownFields(item, ["name", "kind", "description"], itemPath);
    const name = string(item.name, `${itemPath}.name`, 128);
    if (!CAPABILITY_NAME.test(name)) throw new PluginTypesError("capability name is not safe", `${itemPath}.name`);
    if (item.kind !== "request" && item.kind !== "stream") throw new PluginTypesError("kind must be request or stream", `${itemPath}.kind`);
    if (result.has(name)) throw new PluginTypesError(`duplicate capability: ${name}`, path);
    result.set(name, { name, kind: item.kind });
  }
  return result;
}

function parseRuntime(root: RecordValue, options: GeneratePluginTypesOptions): PluginRuntimeDependency {
  const parseValue = (raw: unknown): PluginRuntimeDependency => {
    const value = record(raw, "runtimeDependency");
    rejectUnknownFields(value, ["package", "version"], "runtimeDependency");
    const packageName = string(value.package, "runtimeDependency.package", 128);
    const version = string(value.version, "runtimeDependency.version", 64);
    if (!RUNTIME_VERSION.test(version)) throw new PluginTypesError("must be a semver-like version", "runtimeDependency.version");
    return { package: packageName, version };
  };
  const declaredRaw = root.runtimeDependency ?? root.runtime;
  const declared = declaredRaw === undefined ? undefined : parseValue(declaredRaw);
  const override = options.runtimeDependency === undefined ? undefined : parseValue(options.runtimeDependency);
  if (declared !== undefined && override !== undefined &&
      (declared.package !== override.package || declared.version !== override.version)) {
    throw new PluginTypesError("CLI/runtime override does not match the exported contract", "runtimeDependency");
  }
  const raw = override ?? declared;
  if (raw === undefined) throw new PluginTypesError("an exact package/version contract is required", "runtimeDependency");
  return raw;
}

function parseDescriptorExport(input: unknown, options: GeneratePluginTypesOptions): ParsedDescriptor {
  const serialized = JSON.stringify(input);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_DESCRIPTOR_BYTES) {
    throw new PluginTypesError(`descriptor exceeds ${MAX_DESCRIPTOR_BYTES} bytes`);
  }
  const root = record(input, "descriptor");
  rejectUnknownFields(root, ["protocolVersion", "appId", "runtimeDependency", "runtime", "host", "registry", "plugins"], "descriptor");
  if (integer(root.protocolVersion, "descriptor.protocolVersion") !== PLUGIN_TYPES_PROTOCOL_VERSION) {
    throw new PluginTypesError(`protocolVersion must be ${PLUGIN_TYPES_PROTOCOL_VERSION}`, "descriptor.protocolVersion");
  }
  const host = root.host ?? root.registry;
  if (host === undefined) throw new PluginTypesError("an actual host registry export is required", "descriptor.host");
  if (!Array.isArray(root.plugins)) throw new PluginTypesError("must be an array", "descriptor.plugins");
  const plugins = root.plugins.map((plugin, index) => parsePlugin(plugin, `descriptor.plugins[${index}]`));
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) throw new PluginTypesError(`duplicate plugin: ${plugin.id}`, "descriptor.plugins");
    ids.add(plugin.id);
  }
  return { runtime: parseRuntime(root, options), plugins, registry: parseRegistry(host, "descriptor.host") };
}

function pascal(value: string): string {
  const pieces = value.split(/[^A-Za-z0-9]+/u).filter(Boolean);
  let result = pieces.map((piece) => piece[0]!.toUpperCase() + piece.slice(1)).join("");
  if (!result) result = "Pocket";
  if (/^\d/u.test(result)) result = `N${result}`;
  if (/^(?:any|boolean|never|null|number|string|symbol|unknown|undefined|object|void|type|interface|class|function|const|let|var|export|import|default|extends|implements|namespace|readonly|public|private|protected|new|this|super|static|async|await|yield)$/u.test(result)) result = `Pocket${result}`;
  return result;
}

function tsString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\r/gu, "\\r").replace(/\n/gu, "\\n").replace(/\t/gu, "\\t").replace(/\u0000/gu, "\\0").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029")}"`;
}

function tsLiteral(value: JsonPrimitive): string {
  if (typeof value === "string") return tsString(value);
  if (value === null) return "null";
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  return value ? "true" : "false";
}

class NameAllocator {
  private readonly used = new Set<string>();

  allocate(base: string): string {
    const safeBase = pascal(base);
    let candidate = safeBase;
    let suffix = 2;
    while (this.used.has(candidate)) candidate = `${safeBase}${suffix++}`;
    this.used.add(candidate);
    return candidate;
  }
}

function schemaType(
  node: SchemaNode,
  typeNames: ReadonlyMap<string, string>,
  path: string,
): string {
  switch (node.type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "unknown": return "unknown";
    case "ref": {
      const name = typeNames.get(node.ref!);
      if (name === undefined) throw new PluginTypesError(`unknown reference: ${node.ref}`, path);
      return name;
    }
    case "enum": return node.values!.map(tsLiteral).join(" | ");
    // PocketStream's public JsonValue uses ordinary JSON arrays. A readonly
    // array nested in a generated stream item violates that real constraint.
    case "array": return `Array<${schemaType(node.items!, typeNames, `${path}.items`)}>`;
    case "object": {
      const properties = [...(node.properties?.entries() ?? [])].sort(([a], [b]) => a.localeCompare(b));
      if (properties.length === 0) return "Readonly<Record<string, never>>";
      const required = node.required ?? new Set<string>();
      const fields = properties.map(([name, child]) => `    readonly ${tsString(name)}${required.has(name) ? "" : "?"}: ${schemaType(child, typeNames, `${path}.${name}`)};`);
      return `Readonly<{\n${fields.join("\n")}\n  }>`;
    }
  }
}

function schemaContainsUnknown(
  node: SchemaNode,
  plugin: PluginDescriptor,
  seen = new Set<string>(),
): boolean {
  if (node.type === "unknown") return true;
  if (node.type === "ref") {
    const ref = node.ref!;
    if (seen.has(ref)) return false;
    const target = plugin.types.get(ref);
    if (target === undefined) throw new PluginTypesError(`unknown reference: ${ref}`, `${plugin.id}.types`);
    seen.add(ref);
    return schemaContainsUnknown(target, plugin, seen);
  }
  if (node.type === "array") return schemaContainsUnknown(node.items!, plugin, seen);
  if (node.type !== "object") return false;
  return [...(node.properties?.values() ?? [])].some((child) => schemaContainsUnknown(child, plugin, seen));
}

function schemaIsObject(node: SchemaNode | undefined, plugin: PluginDescriptor, seen = new Set<string>()): boolean {
  if (node === undefined || node.type === "object" || node.type === "unknown") return true;
  if (node.type !== "ref") return false;
  const ref = node.ref!;
  if (seen.has(ref)) return false;
  const target = plugin.types.get(ref);
  if (target === undefined) throw new PluginTypesError(`unknown reference: ${ref}`, `${plugin.id}.types`);
  seen.add(ref);
  return schemaIsObject(target, plugin, seen);
}

function renderTypeAliases(
  included: readonly IncludedCapability[],
  allocator: NameAllocator,
): { lines: string[]; names: Map<IncludedCapability, { parameters: string; result: string; streamItem: string }> } {
  const lines: string[] = [];
  const names = new Map<IncludedCapability, { parameters: string; result: string; streamItem: string }>();
  const allPlugins = [...new Set(included.map((item) => item.plugin))].sort((a, b) => a.id.localeCompare(b.id));
  const pluginTypeNames = new Map<PluginDescriptor, Map<string, string>>();
  for (const plugin of allPlugins) {
    const map = new Map<string, string>();
    for (const typeName of [...plugin.types.keys()].sort()) map.set(typeName, allocator.allocate(`${plugin.id}_${typeName}`));
    pluginTypeNames.set(plugin, map);
  }
  for (const plugin of allPlugins) {
    const typeNames = pluginTypeNames.get(plugin)!;
    for (const typeName of [...plugin.types.keys()].sort()) {
      lines.push(`export type ${typeNames.get(typeName)!} = ${schemaType(plugin.types.get(typeName)!, typeNames, `${plugin.id}.types.${typeName}`)};`);
    }
  }
  for (const item of included) {
    const base = `${item.plugin.id}_${item.capability.name}`;
    const capabilityNames = {
      parameters: allocator.allocate(`${base}_Parameters`),
      result: allocator.allocate(`${base}_Result`),
      streamItem: allocator.allocate(`${base}_StreamItem`),
    };
    names.set(item, capabilityNames);
    const schema = item.capability.schema;
    const typeNames = pluginTypeNames.get(item.plugin)!;
    const parameters = schema?.parameters;
    const result = schema?.result;
    const streamItem = schema?.streamItem;
    if (parameters === undefined) lines.push(`export type ${capabilityNames.parameters} = JsonObject;`);
    else lines.push(`export type ${capabilityNames.parameters} = ${schemaType(parameters, typeNames, `${item.plugin.id}.${item.capability.name}.parameters`)};`);
    if (result === undefined) lines.push(`export type ${capabilityNames.result} = unknown;`);
    else lines.push(`export type ${capabilityNames.result} = ${schemaType(result, typeNames, `${item.plugin.id}.${item.capability.name}.result`)};`);
    if (streamItem === undefined || schemaContainsUnknown(streamItem, item.plugin)) lines.push(`export type ${capabilityNames.streamItem} = JsonValue;`);
    else lines.push(`export type ${capabilityNames.streamItem} = ${schemaType(streamItem, typeNames, `${item.plugin.id}.${item.capability.name}.streamItem`)};`);
  }
  return { lines, names };
}

function renderClient(
  plugin: PluginDescriptor,
  included: readonly IncludedCapability[],
  aliases: Map<IncludedCapability, { parameters: string; result: string; streamItem: string }>,
  allocator: NameAllocator,
): string[] {
  const own = included.filter((item) => item.plugin === plugin).sort((a, b) => a.capability.name.localeCompare(b.capability.name));
  if (own.length === 0) return [];
  const clientName = allocator.allocate(`${plugin.id}_Client`);
  const lines: string[] = [];
  lines.push(`export interface ${clientName} {`);
  for (const item of own) {
    const type = aliases.get(item)!;
    const paramsOptional = item.capability.schema?.parameters === undefined || (item.capability.schema.parameters.type === "object" && (item.capability.schema.parameters.required?.size ?? 0) === 0);
    const params = paramsOptional ? `params?: ${type.parameters}` : `params: ${type.parameters}`;
    const result = item.host.kind === "request" ? `Promise<${type.result}>` : `PocketStream<${type.streamItem}>`;
    lines.push(`  readonly ${tsString(item.capability.name)}: (${params}) => ${result};`);
  }
  lines.push("}", "");
  lines.push(`export function create${clientName}(host: HostBridge, streams?: PocketPluginStreamBridge): ${clientName} {`);
  lines.push("  return {");
  for (const item of own) {
    const type = aliases.get(item)!;
    const paramsOptional = item.capability.schema?.parameters === undefined || (item.capability.schema.parameters.type === "object" && (item.capability.schema.parameters.required?.size ?? 0) === 0);
    const params = paramsOptional ? `params = {} as ${type.parameters}` : "params";
    if (item.host.kind === "request") {
      lines.push(`    ${tsString(item.capability.name)}: (${params}) => requestTyped<${type.result}>(host, ${tsString(item.capability.name)}, params),`);
    } else {
      lines.push(`    ${tsString(item.capability.name)}: (${params}) => {`);
      lines.push(`      if (streams === undefined) throw new Error(${tsString(`Stream capability is not configured: ${item.capability.name}`)});`);
      lines.push(`      return streams.open<${type.streamItem}>(${tsString(item.capability.name)}, asHostParams(params));`);
      lines.push("    },");
    }
  }
  lines.push("  };", "}", "");
  return lines;
}

function renderSource(parsed: ParsedDescriptor, options: GeneratePluginTypesOptions): PluginTypesGeneration {
  const included: IncludedCapability[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();
  for (const plugin of [...parsed.plugins].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const capability of [...plugin.capabilities].sort((a, b) => a.name.localeCompare(b.name))) {
      const host = parsed.registry.get(capability.name);
      if (host === undefined) {
        unavailable.push(capability.name);
        continue;
      }
      if (host.kind !== capability.declaredKind) throw new PluginTypesError(`kind mismatch: descriptor says ${capability.declaredKind}, host registry says ${host.kind}`, `plugins.${plugin.id}.${capability.name}`);
      if (seen.has(capability.name)) throw new PluginTypesError(`capability is declared by more than one plugin: ${capability.name}`, "plugins");
      seen.add(capability.name);
      const schema = capability.schema;
      if (schema?.parameters !== undefined && !schemaIsObject(schema.parameters, plugin)) throw new PluginTypesError("parameters must be an object schema for the existing HostBridge wire contract", `plugins.${plugin.id}.${capability.name}.schema.parameters`);
      included.push({ plugin, capability, host });
    }
  }
  included.sort((a, b) => a.capability.name.localeCompare(b.capability.name));
  unavailable.sort();
  const hostModule = options.hostModule ?? parsed.runtime.package;
  const streamModule = options.streamModule ?? (parsed.runtime.package.endsWith("/host") ? `${parsed.runtime.package.slice(0, -5)}/streams` : "@pocket/ui/streams");
  const allocator = new NameAllocator();
  const aliases = renderTypeAliases(included, allocator);
  const lines: string[] = [
    "/* eslint-disable -- generated from a data-only Pocket host export. */",
    "/* Do not treat these declarations as authorization; the host still negotiates and checks permissions. */",
    `import type { HostBridge, JsonObject, JsonValue } from ${tsString(hostModule)};`,
    `import type { PocketStream, PocketStreamAdapter } from ${tsString(streamModule)};`,
    "",
    `export const POCKET_PLUGIN_TYPES_PROTOCOL_VERSION = ${PLUGIN_TYPES_PROTOCOL_VERSION} as const;`,
    `export const POCKET_PLUGIN_TYPES_RUNTIME = { package: ${tsString(parsed.runtime.package)}, version: ${tsString(parsed.runtime.version)} } as const;`,
    "",
    "/** Alias for the public PocketStreamAdapter; this generator does not create a transport. */",
    "export type PocketPluginStreamBridge = PocketStreamAdapter;",
    "",
    "function asHostParams(value: unknown): JsonObject {",
    "  if (value === null || typeof value !== \"object\" || Array.isArray(value)) throw new TypeError(\"Pocket host parameters must be an object\");",
    "  return value as JsonObject;",
    "}",
    "",
    "function requestTyped<T>(host: HostBridge, capability: string, params: unknown): Promise<T> {",
    "  return host.request<JsonValue>(capability, asHostParams(params)) as Promise<T>;",
    "}",
    "",
  ];
  const capabilityNames = included.map((item) => tsString(item.capability.name)).join(" | ") || "never";
  lines.push(`export type PocketPluginCapabilityName = ${capabilityNames};`, "");
  lines.push("export const POCKET_PLUGIN_CAPABILITIES = [");
  for (const item of included) lines.push(`  { name: ${tsString(item.capability.name)}, kind: ${tsString(item.host.kind)}, pluginId: ${tsString(item.plugin.id)} },`);
  lines.push("] as const;", "");
  lines.push(...aliases.lines, "");
  const mapName = allocator.allocate("PocketPluginCapabilityMap");
  lines.push(`export interface ${mapName} {`);
  for (const item of included) {
    const type = aliases.names.get(item)!;
    lines.push(`  readonly ${tsString(item.capability.name)}: { readonly kind: ${tsString(item.host.kind)}; readonly parameters: ${type.parameters}; readonly result: ${type.result}; readonly streamItem: ${type.streamItem}; };`);
  }
  lines.push("}", "");
  for (const plugin of [...parsed.plugins].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(...renderClient(plugin, included, aliases.names, allocator));
  }
  return { source: `${lines.join("\n").trimEnd()}\n`, includedCapabilities: included.map((item) => item.capability.name), unavailableCapabilities: unavailable };
}

export function generatePluginTypes(input: unknown, options: GeneratePluginTypesOptions = {}): string {
  return renderSource(parseDescriptorExport(input, options), options).source;
}

export function generatePluginTypesReport(input: unknown, options: GeneratePluginTypesOptions = {}): PluginTypesGeneration {
  return renderSource(parseDescriptorExport(input, options), options);
}

function parseArgs(argv: readonly string[]): { input: string; output?: string; runtime?: PluginRuntimeDependency; hostModule?: string; streamModule?: string } {
  let input: string | undefined;
  let output: string | undefined;
  let runtimePackage: string | undefined;
  let runtimeVersion: string | undefined;
  let hostModule: string | undefined;
  let streamModule: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--input" || arg === "-i") input = next, index += 1;
    else if (arg === "--output" || arg === "-o") output = next, index += 1;
    else if (arg === "--runtime-package") runtimePackage = next, index += 1;
    else if (arg === "--runtime-version") runtimeVersion = next, index += 1;
    else if (arg === "--host-module") hostModule = next, index += 1;
    else if (arg === "--stream-module") streamModule = next, index += 1;
    else if (arg === "--help" || arg === "-h") throw new Error("usage: bun sdk/scripts/plugin_types.ts --input descriptor.json [--output plugin-types.ts] [--runtime-package package --runtime-version version]");
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!input) throw new Error("--input is required");
  const runtime = runtimePackage === undefined && runtimeVersion === undefined ? undefined : { package: runtimePackage ?? "@pocket/ui/host", version: runtimeVersion ?? "0.1.0" };
  return { input, ...(output === undefined ? {} : { output }), ...(runtime === undefined ? {} : { runtime }), ...(hostModule === undefined ? {} : { hostModule }), ...(streamModule === undefined ? {} : { streamModule }) };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const input = JSON.parse(readFileSync(args.input, "utf8")) as unknown;
    const source = generatePluginTypes(input, {
      ...(args.runtime === undefined ? {} : { runtimeDependency: args.runtime }),
      ...(args.hostModule === undefined ? {} : { hostModule: args.hostModule }),
      ...(args.streamModule === undefined ? {} : { streamModule: args.streamModule }),
    });
    if (args.output === undefined) process.stdout.write(source);
    else writeFileSync(args.output, source, "utf8");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
