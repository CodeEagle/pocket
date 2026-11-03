import protobuf from 'protobufjs';
const proto = String.raw`syntax = "proto3";
package google.protobuf;

enum NullValue { NULL_VALUE = 0; }
message Struct { map<string, Value> fields = 1; }
message Value {
  oneof kind {
    NullValue null_value = 1;
    double number_value = 2;
    string string_value = 3;
    bool bool_value = 4;
    Struct struct_value = 5;
    ListValue list_value = 6;
  }
}
message ListValue { repeated Value values = 1; }

package pocket;
message Event {
  string type = 1;
  string id = 2;
  string name = 3;
  oneof payload {
    HostRequest request = 4;
    HostResponse response = 5;
    google.protobuf.Struct generic_payload = 6;
    PointerInput pointer = 7;
  }
}
message HostRequest { string request_id = 1; string capability = 2; google.protobuf.Struct params = 3; }
message HostResponse { string request_id = 1; bool ok = 2; google.protobuf.Struct result = 3; HostError error = 4; }
message HostError { string code = 1; string message = 2; }
message PointerInput {
  enum Phase { PHASE_UNSPECIFIED = 0; DOWN = 1; MOVE = 2; UP = 3; CANCEL = 4; }
  Phase phase = 1; uint32 id = 2; float x = 3; float y = 4; uint32 surface = 5;
}
`;
const root = new protobuf.Root();
const pocketProtoAt = proto.indexOf('package pocket;');
protobuf.parse(proto.slice(0, pocketProtoAt), root);
protobuf.parse('syntax = \"proto3\";\n' + proto.slice(pocketProtoAt), root);
const Event = root.lookupType('pocket.Event');
const Pointer = root.lookupType('pocket.PointerInput');
const Struct = root.lookupType('google.protobuf.Struct');
const Value = root.lookupType('google.protobuf.Value');
const ListValue = root.lookupType('google.protobuf.ListValue');

function asProtoValue(value) {
  if (value === null) return { nullValue: 0 };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return { numberValue: value };
  if (Array.isArray(value)) return { listValue: { values: value.map(asProtoValue) } };
  if (value && typeof value === 'object') {
    const fields = Object.create(null);
    for (const key of Object.keys(value)) fields[key] = asProtoValue(value[key]);
    return { structValue: { fields } };
  }
  throw new TypeError('value is not JSON-safe');
}
function asProtoStruct(value) {
  const fields = Object.create(null);
  for (const key of Object.keys(value)) fields[key] = asProtoValue(value[key]);
  return { fields };
}
function fromProtoValue(value) {
  if (Object.prototype.hasOwnProperty.call(value, 'nullValue') || Object.prototype.hasOwnProperty.call(value, 'null_value')) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'numberValue') || Object.prototype.hasOwnProperty.call(value, 'number_value')) return value.numberValue ?? value.number_value;
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue') || Object.prototype.hasOwnProperty.call(value, 'string_value')) return value.stringValue ?? value.string_value;
  if (Object.prototype.hasOwnProperty.call(value, 'boolValue') || Object.prototype.hasOwnProperty.call(value, 'bool_value')) return value.boolValue ?? value.bool_value;
  if (Object.prototype.hasOwnProperty.call(value, 'structValue') || Object.prototype.hasOwnProperty.call(value, 'struct_value')) return fromProtoStruct(value.structValue ?? value.struct_value);
  if (Object.prototype.hasOwnProperty.call(value, 'listValue') || Object.prototype.hasOwnProperty.call(value, 'list_value')) return (value.listValue ?? value.list_value).values.map(fromProtoValue);
  return null;
}
function fromProtoStruct(value) {
  const result = {};
  for (const key of Object.keys(value.fields)) result[key] = fromProtoValue(value.fields[key]);
  return result;
}
const structPlainOptions = { defaults: false, arrays: true, objects: true, oneofs: true, enums: String };

const cases = {
  request: {
    json: {
      type: 'event', name: 'host.request',
      payload: { requestId: 'guest-1', capability: 'runtime.info', params: {} },
    },
    proto: {
      type: 'event', name: 'host.request',
      request: { requestId: 'guest-1', capability: 'runtime.info', params: asProtoStruct({}) },
    },
    runProto: () => {
      const bytes = Event.encode({ type: 'event', name: 'host.request', request: {
        requestId: 'guest-1', capability: 'runtime.info', params: asProtoStruct({}),
      }}).finish();
      const decoded = Event.toObject(Event.decode(bytes), structPlainOptions);
      const request = decoded.request;
      return { type: decoded.type, name: decoded.name, payload: {
        requestId: request.requestId, capability: request.capability,
        params: fromProtoStruct(request.params),
      }};
    },
  },
  response: {
    json: {
      type: 'event', id: 'dart-1793650500000000', name: 'host.response',
      payload: { requestId: 'guest-1', ok: true, result: {
        entryFormat: 'quickjs-bytecode',
        runtimeAbi: 'quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021',
        version: 'embedded', build: 0, source: 'embedded', entryBytes: 250223,
      }},
    },
    proto: {
      type: 'event', id: 'dart-1793650500000000', name: 'host.response',
      response: { requestId: 'guest-1', ok: true, result: asProtoStruct({
        entryFormat: 'quickjs-bytecode',
        runtimeAbi: 'quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021',
        version: 'embedded', build: 0, source: 'embedded', entryBytes: 250223,
      })},
    },
    runProto: () => {
      const bytes = Event.encode({ type: 'event', id: 'dart-1793650500000000', name: 'host.response', response: {
        requestId: 'guest-1', ok: true, result: asProtoStruct({
          entryFormat: 'quickjs-bytecode',
          runtimeAbi: 'quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021',
          version: 'embedded', build: 0, source: 'embedded', entryBytes: 250223,
        }),
      }}).finish();
      const decoded = Event.toObject(Event.decode(bytes), structPlainOptions);
      const response = decoded.response;
      return { type: decoded.type, id: decoded.id, name: decoded.name,
        payload: { requestId: response.requestId, ok: response.ok,
          result: fromProtoStruct(response.result) } };
    },
  },
  pointer: {
    json: { type: 'event', id: 'dart-1793650500000000', name: 'input.pointer',
      payload: { phase: 'move', id: 2, x: 180.25, y: 390.5 } },
    runProto: () => {
      const bytes = Event.encode({ type: 'event', id: 'dart-1793650500000000', name: 'input.pointer',
        pointer: { phase: 2, id: 2, x: 180.25, y: 390.5 } }).finish();
      const decoded = Event.toObject(Event.decode(bytes), structPlainOptions);
      const pointer = decoded.pointer;
      return { type: decoded.type, id: decoded.id, name: decoded.name, payload: {
        phase: String(pointer.phase).toLowerCase() === 'move' ? 'move' : String(pointer.phase).toLowerCase(), id: pointer.id, x: pointer.x, y: pointer.y,
      }};
    },
    pointerJson: { phase: 'move', id: 2, x: 180.25, y: 390.5 },
  },
};

function bytesFor(name, test) {
  if (name === 'pointer') return Event.encode({ type: 'event', id: 'dart-1793650500000000', name: 'input.pointer', pointer: { phase: 2, id: 2, x: 180.25, y: 390.5 } }).finish().length;
  return Event.encode(test.proto).finish().length;
}
function measure(fn, n, sampleCount) {
  const samples = [];
  let sink;
  for (let sample = 0; sample < sampleCount; sample++) {
    const start = Date.now();
    for (let i = 0; i < n; i++) sink = fn();
    samples.push((Date.now() - start) * 1e6 / n);
  }
  samples.sort((a, b) => a - b);
  return { median_ns_pair: samples[Math.floor(samples.length / 2)], samples_ns_pair: samples, sink: sink && typeof sink === 'object' ? Object.keys(sink).length : 0 };
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}
function runCase(name, n = 6000, sampleCount = 7, warmup = 2000) {
  const test = cases[name];
  if (!test) throw new Error('unknown case ' + name);
  const normalized = test.runProto();
  if (JSON.stringify(stable(normalized)) !== JSON.stringify(stable(test.json))) {
    throw new Error(name + ' protobuf roundtrip did not preserve JSON shape: ' + JSON.stringify(normalized));
  }
  const jsonText = JSON.stringify(test.json);
  for (let i = 0; i < warmup; i++) {
    JSON.parse(jsonText);
    test.runProto();
  }
  const jsonResult = measure(() => JSON.parse(JSON.stringify(test.json)), n, sampleCount);
  const protoResult = measure(test.runProto, n, sampleCount);
  const pbBytes = bytesFor(name, test);
  const result = { case: name, iterations_per_sample: n, warmup_iterations: warmup,
    sample_count: sampleCount, json_bytes: jsonText.length, protobuf_bytes: pbBytes,
    production_pointer_duplex_bytes: name === 'pointer' ? 16 : undefined,
    json_roundtrip: jsonResult, protobuf_encode_decode_and_map: protoResult };
  if (typeof pocket !== 'undefined' && typeof pocket._emit === 'function') {
    pocket._emit(JSON.stringify({ type: 'event', name: 'proto.bench', payload: result }));
  } else {
    globalThis.__POCKET_BENCH_RESULTS__ ??= [];
    globalThis.__POCKET_BENCH_RESULTS__.push(result);
  }
  return result;
}
globalThis.__pocketProtoBenchRun = runCase;


if (typeof pocket === 'undefined' || typeof pocket._emit !== 'function') {
  console.log(JSON.stringify(globalThis.__POCKET_BENCH_RESULTS__ ?? [], null, 2));
}
