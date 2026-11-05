//! Binary TLV message bridge (`PFBV`, magic `0xB1`) and direct QuickJS value
//! marshaling between JS (`rquickjs::Value`), Rust, and Dart FFI (`Uint8List`).
//!
//! This replaces intermediate `JSON.stringify` / `serde_json` / `JSON.parse`
//! passes on the JS <-> Rust <-> Dart event, RPC, stream, and offload channels
//! Legacy JSON exports are explicit tooling boundaries, not SDK fallbacks.

#[cfg(not(target_arch = "wasm32"))]
pub use crate::binary_offload::{decode_offload_completion, encode_offload_request};

use rquickjs::object::Property;
use rquickjs::{Array, ArrayBuffer, Ctx, FromJs, Object, TypedArray, Value};
use serde_json::{Map as JsonMap, Number as JsonNumber, Value as JsonValue};


/// Leading magic byte identifying a binary TLV message packet (`0xB1` is never
/// a valid leading UTF-8 byte or JSON character, making wire packets
/// self-describing alongside legacy UTF-8 JSON strings).
pub const BINARY_MESSAGE_MAGIC: u8 = 0xB1;

/// Leading magic byte identifying a binary offload request/completion record.
pub const OFFLOAD_BINARY_MAGIC: u8 = 0xB2;

pub const TAG_NULL: u8 = 0x00;
pub const TAG_FALSE: u8 = 0x01;
pub const TAG_TRUE: u8 = 0x02;
pub const TAG_INT64: u8 = 0x03;
pub const TAG_FLOAT64: u8 = 0x04;
pub const TAG_STRING: u8 = 0x05;
pub const TAG_BYTES: u8 = 0x06;
pub const TAG_ARRAY: u8 = 0x07;
pub const TAG_OBJECT: u8 = 0x08;

const MAX_DEPTH: usize = 32;
const MAX_NODES: usize = 1_000_000;
const MAX_SAFE_JS_INT: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Default)]
pub struct BinaryEnvelopeMeta {
    pub msg_type: Option<String>,
    pub method: Option<String>,
    pub name: Option<String>,
}

impl BinaryEnvelopeMeta {
    pub fn effective_method(&self) -> &str {
        self.method
            .as_deref()
            .or(self.name.as_deref())
            .unwrap_or_default()
    }

    pub fn is_response(&self) -> bool {
        self.msg_type.as_deref() == Some("response")
    }

    pub fn is_input(&self) -> bool {
        matches!(
            self.effective_method(),
            "input.pointer"
                | "input.buttons"
                | "input.axes"
                | "input.axis"
                | "input.axis.relative"
                | "input.motion"
                | "input.text"
        )
    }
}

struct EncoderState {
    bytes: Vec<u8>,
    max_bytes: usize,
    nodes: usize,
    ancestors: Vec<usize>,
}

impl EncoderState {
    fn new(max_bytes: usize) -> Self {
        let mut bytes = Vec::with_capacity(128);
        bytes.push(BINARY_MESSAGE_MAGIC);
        Self {
            bytes,
            max_bytes,
            nodes: 0,
            ancestors: Vec::with_capacity(16),
        }
    }

    fn ensure_capacity(&self, additional: usize) -> Result<(), String> {
        if self.bytes.len().saturating_add(additional) > self.max_bytes {
            return Err("bridge message exceeds byte limit".to_owned());
        }
        Ok(())
    }

    fn push_u8(&mut self, value: u8) -> Result<(), String> {
        self.ensure_capacity(1)?;
        self.bytes.push(value);
        Ok(())
    }

    fn push_u32(&mut self, value: u32) -> Result<(), String> {
        self.ensure_capacity(4)?;
        self.bytes.extend_from_slice(&value.to_le_bytes());
        Ok(())
    }

    fn push_i64(&mut self, value: i64) -> Result<(), String> {
        self.ensure_capacity(8)?;
        self.bytes.extend_from_slice(&value.to_le_bytes());
        Ok(())
    }

    fn push_f64(&mut self, value: f64) -> Result<(), String> {
        if !value.is_finite() {
            return Err("bridge number must be finite".to_owned());
        }
        self.ensure_capacity(8)?;
        self.bytes.extend_from_slice(&value.to_le_bytes());
        Ok(())
    }

    fn push_bytes(&mut self, slice: &[u8]) -> Result<(), String> {
        let len = u32::try_from(slice.len()).map_err(|_| "byte slice too large".to_owned())?;
        self.ensure_capacity(4usize.saturating_add(slice.len()))?;
        self.bytes.extend_from_slice(&len.to_le_bytes());
        self.bytes.extend_from_slice(slice);
        Ok(())
    }

    fn push_str(&mut self, text: &str) -> Result<(), String> {
        self.push_bytes(text.as_bytes())
    }
}

fn js_raw_ptr(value: &Value<'_>) -> usize {
    // QuickJS uses a tagged u64 on 32-bit targets (including Wasm), and a
    // tagged union on 64-bit targets. Match JS_VALUE_GET_PTR in quickjs.h.
    #[cfg(target_pointer_width = "32")]
    { value.as_raw() as u32 as usize }
    #[cfg(target_pointer_width = "64")]
    { unsafe { value.as_raw().u.ptr as usize } }
}

fn extract_js_bytes<'js>(ctx: &Ctx<'js>, value: &Value<'js>) -> Option<Vec<u8>> {
    if let Ok(buffer) = ArrayBuffer::from_js(ctx, value.clone()) {
        return buffer.as_bytes().map(|slice| slice.to_vec());
    }
    let object = value.as_object()?;
    if !object.is_typed_array::<u8>() {
        return None;
    }
    if let Ok(typed) = TypedArray::<u8>::from_value(value.clone()) {
        return typed.as_bytes().map(|slice| slice.to_vec());
    }
    None
}

fn is_plain_js_object<'js>(ctx: &Ctx<'js>, value: &Value<'js>) -> bool {
    if !value.is_object() || value.is_array() || value.is_function() || value.is_null() {
        return false;
    }
    extract_js_bytes(ctx, value).is_none()
}

fn js_string_prop<'js>(object: &Object<'js>, key: &str) -> Option<String> {
    let val: Value<'js> = object.get(key).ok()?;
    val.as_string()?.to_string().ok()
}

fn is_js_batch_event<'js>(object: &Object<'js>) -> bool {
    js_string_prop(object, "method").as_deref() == Some("stream.batch")
        || js_string_prop(object, "name").as_deref() == Some("stream.batch")
}

fn validate_js_bridge_batch<'js>(
    ctx: &Ctx<'js>,
    root: &Object<'js>,
    max_batch_events: usize,
) -> bool {
    if !is_js_batch_event(root) {
        return true;
    }
    let params_val: Value<'js> = match root.get::<_, Value<'js>>("params") {
        Ok(val) if !val.is_undefined() => val,
        _ => match root.get::<_, Value<'js>>("payload") {
            Ok(val) => val,
            Err(_) => return false,
        },
    };
    if !is_plain_js_object(ctx, &params_val) {
        return false;
    }
    let Some(params_obj) = params_val.as_object() else {
        return false;
    };
    let Ok(events_val) = params_obj.get::<_, Value<'js>>("events") else {
        return false;
    };
    let Some(events_arr) = events_val.as_array() else {
        return false;
    };
    let len = events_arr.len();
    if len > max_batch_events {
        return false;
    }
    for index in 0..len {
        let Ok(item) = events_arr.get::<Value<'js>>(index) else {
            return false;
        };
        if !is_plain_js_object(ctx, &item) {
            return false;
        }
        let Some(item_obj) = item.as_object() else {
            return false;
        };
        if is_js_batch_event(item_obj) {
            return false;
        }
    }
    true
}

/// Encode a QuickJS `Value` (must be a root Object) directly into a `0xB1`
/// Binary TLV buffer while enforcing message byte and batch limits.
pub fn encode_js_message<'js>(
    value: Value<'js>,
    max_bytes: usize,
    max_batch_events: usize,
) -> Result<Vec<u8>, String> {
    let ctx = value.ctx().clone();
    if !is_plain_js_object(&ctx, &value) {
        return Err("bridge packet must be a plain object".to_owned());
    }
    let Some(root_obj) = value.as_object() else {
        return Err("bridge packet must be an object".to_owned());
    };
    if !validate_js_bridge_batch(&ctx, root_obj, max_batch_events) {
        return Err("invalid stream.batch packet".to_owned());
    }
    let mut state = EncoderState::new(max_bytes);
    encode_js_value(&ctx, &mut state, &value, 0)?;
    Ok(state.bytes)
}

fn encode_js_value<'js>(
    ctx: &Ctx<'js>,
    state: &mut EncoderState,
    value: &Value<'js>,
    depth: usize,
) -> Result<(), String> {
    state.nodes += 1;
    if state.nodes > MAX_NODES || depth > MAX_DEPTH {
        return Err("bridge value exceeded depth or node limit".to_owned());
    }
    if value.is_null() || value.is_undefined() {
        return state.push_u8(TAG_NULL);
    }
    if let Some(boolean) = value.as_bool() {
        return state.push_u8(if boolean { TAG_TRUE } else { TAG_FALSE });
    }
    if let Some(integer) = value.as_int() {
        state.push_u8(TAG_INT64)?;
        return state.push_i64(integer as i64);
    }
    if let Some(number) = value.as_number() {
        if !number.is_finite() {
            return Err("bridge number must be finite".to_owned());
        }
        if number.fract() == 0.0
            && (-MAX_SAFE_JS_INT..=MAX_SAFE_JS_INT).contains(&number)
            && !(number == 0.0 && number.is_sign_negative())
        {
            state.push_u8(TAG_INT64)?;
            return state.push_i64(number as i64);
        }
        state.push_u8(TAG_FLOAT64)?;
        return state.push_f64(number);
    }
    if let Some(js_str) = value.as_string() {
        let text = js_str
            .to_string()
            .map_err(|_| "invalid UTF-8 string in bridge value".to_owned())?;
        state.push_u8(TAG_STRING)?;
        return state.push_str(&text);
    }
    if value.is_function() || value.is_symbol() || value.is_big_int() {
        return Err("unsupported JS value type in bridge packet".to_owned());
    }
    if let Some(raw_bytes) = extract_js_bytes(ctx, value) {
        state.push_u8(TAG_BYTES)?;
        return state.push_bytes(&raw_bytes);
    }
    let ptr = js_raw_ptr(value);
    if state.ancestors.contains(&ptr) {
        return Err("circular reference in bridge value".to_owned());
    }
    state.ancestors.push(ptr);
    let result = if let Some(array) = value.as_array() {
        let len = array.len();
        let count = u32::try_from(len).map_err(|_| "array too large".to_owned())?;
        state.push_u8(TAG_ARRAY)?;
        state.push_u32(count)?;
        for index in 0..len {
            let item: Value<'js> = array
                .get(index)
                .map_err(|_| "failed reading array element".to_owned())?;
            if item.is_function() || item.is_symbol() || item.is_big_int() {
                return Err("unsupported element in bridge array".to_owned());
            }
            encode_js_value(ctx, state, &item, depth + 1)?;
        }
        Ok(())
    } else if let Some(object) = value.as_object() {
        state.push_u8(TAG_OBJECT)?;
        let count_offset = state.bytes.len();
        state.push_u32(0)?;
        let mut count = 0u32;
        for prop_res in object.props::<String, Value<'js>>() {
            let (key, prop_val) =
                prop_res.map_err(|_| "failed reading object property".to_owned())?;
            if prop_val.is_undefined() || prop_val.is_function() || prop_val.is_symbol() {
                continue;
            }
            count = count
                .checked_add(1)
                .ok_or_else(|| "object has too many properties".to_owned())?;
            state.push_str(&key)?;
            encode_js_value(ctx, state, &prop_val, depth + 1)?;
        }
        state.bytes[count_offset..count_offset + 4].copy_from_slice(&count.to_le_bytes());
        Ok(())
    } else {
        Err("unsupported JS value in bridge packet".to_owned())
    };
    state.ancestors.pop();
    result
}

/// Encode a validated `serde_json::Value` into a `0xB1` Binary TLV buffer.
pub fn encode_json_to_binary(value: &JsonValue, max_bytes: usize) -> Result<Vec<u8>, String> {
    if !value.is_object() {
        return Err("bridge packet must be a plain object".to_owned());
    }
    let mut state = EncoderState::new(max_bytes);
    encode_json_value(&mut state, value, 0)?;
    Ok(state.bytes)
}

fn encode_json_value(
    state: &mut EncoderState,
    value: &JsonValue,
    depth: usize,
) -> Result<(), String> {
    state.nodes += 1;
    if state.nodes > MAX_NODES || depth > MAX_DEPTH {
        return Err("JSON value exceeded depth or node limit".to_owned());
    }
    match value {
        JsonValue::Null => state.push_u8(TAG_NULL),
        JsonValue::Bool(boolean) => state.push_u8(if *boolean { TAG_TRUE } else { TAG_FALSE }),
        JsonValue::Number(num) => {
            if let Some(i) = num.as_i64() {
                state.push_u8(TAG_INT64)?;
                state.push_i64(i)
            } else if let Some(u) = num.as_u64() {
                if let Ok(i) = i64::try_from(u) {
                    state.push_u8(TAG_INT64)?;
                    state.push_i64(i)
                } else {
                    state.push_u8(TAG_FLOAT64)?;
                    state.push_f64(u as f64)
                }
            } else if let Some(f) = num.as_f64() {
                state.push_u8(TAG_FLOAT64)?;
                state.push_f64(f)
            } else {
                Err("invalid JSON number".to_owned())
            }
        }
        JsonValue::String(text) => {
            state.push_u8(TAG_STRING)?;
            state.push_str(text)
        }
        JsonValue::Array(items) => {
            let count = u32::try_from(items.len()).map_err(|_| "array too large".to_owned())?;
            state.push_u8(TAG_ARRAY)?;
            state.push_u32(count)?;
            for item in items {
                encode_json_value(state, item, depth + 1)?;
            }
            Ok(())
        }
        JsonValue::Object(map) => {
            let count = u32::try_from(map.len()).map_err(|_| "object too large".to_owned())?;
            state.push_u8(TAG_OBJECT)?;
            state.push_u32(count)?;
            for (key, val) in map {
                state.push_str(key)?;
                encode_json_value(state, val, depth + 1)?;
            }
            Ok(())
        }
    }
}

struct BinaryReader<'a> {
    data: &'a [u8],
    offset: usize,
    nodes: usize,
}

impl<'a> BinaryReader<'a> {
    fn new(data: &'a [u8]) -> Result<Self, String> {
        if data.first().copied() != Some(BINARY_MESSAGE_MAGIC) {
            return Err("invalid binary bridge magic".to_owned());
        }
        Ok(Self {
            data,
            offset: 1,
            nodes: 0,
        })
    }

    fn require(&self, len: usize) -> Result<(), String> {
        if len > self.data.len().saturating_sub(self.offset) {
            return Err("truncated binary bridge message".to_owned());
        }
        Ok(())
    }

    fn u8(&mut self) -> Result<u8, String> {
        self.require(1)?;
        let val = self.data[self.offset];
        self.offset += 1;
        Ok(val)
    }

    fn u32(&mut self) -> Result<u32, String> {
        self.require(4)?;
        let bytes: [u8; 4] = self.data[self.offset..self.offset + 4]
            .try_into()
            .map_err(|_| "truncated u32".to_owned())?;
        self.offset += 4;
        Ok(u32::from_le_bytes(bytes))
    }

    fn i64(&mut self) -> Result<i64, String> {
        self.require(8)?;
        let bytes: [u8; 8] = self.data[self.offset..self.offset + 8]
            .try_into()
            .map_err(|_| "truncated i64".to_owned())?;
        self.offset += 8;
        Ok(i64::from_le_bytes(bytes))
    }

    fn f64(&mut self) -> Result<f64, String> {
        self.require(8)?;
        let bytes: [u8; 8] = self.data[self.offset..self.offset + 8]
            .try_into()
            .map_err(|_| "truncated f64".to_owned())?;
        self.offset += 8;
        let val = f64::from_le_bytes(bytes);
        if !val.is_finite() {
            return Err("non-finite f64 in binary bridge message".to_owned());
        }
        Ok(val)
    }

    fn bytes(&mut self) -> Result<&'a [u8], String> {
        let len = self.u32()? as usize;
        self.require(len)?;
        let slice = &self.data[self.offset..self.offset + len];
        self.offset += len;
        Ok(slice)
    }

    fn str(&mut self) -> Result<&'a str, String> {
        let slice = self.bytes()?;
        std::str::from_utf8(slice).map_err(|_| "invalid UTF-8 in binary bridge message".to_owned())
    }

    fn finish(&self) -> Result<(), String> {
        if self.offset != self.data.len() {
            return Err("trailing bytes in binary bridge message".to_owned());
        }
        Ok(())
    }

    fn step_node(&mut self, depth: usize) -> Result<(), String> {
        self.nodes += 1;
        if self.nodes > MAX_NODES || depth > MAX_DEPTH {
            return Err("binary bridge message exceeded depth or node limit".to_owned());
        }
        Ok(())
    }
}

/// Validate a `0xB1` binary message buffer and extract top-level routing fields
/// (`type`, `method`, `name`) without allocating a `serde_json::Value` tree.
pub fn inspect_binary_envelope(bytes: &[u8]) -> Result<BinaryEnvelopeMeta, String> {
    let mut reader = BinaryReader::new(bytes)?;
    reader.step_node(0)?;
    let root_tag = reader.u8()?;
    if root_tag != TAG_OBJECT {
        return Err("binary bridge message root must be an object".to_owned());
    }
    let count = reader.u32()? as usize;
    if count > MAX_NODES {
        return Err("binary bridge object has too many keys".to_owned());
    }
    let mut meta = BinaryEnvelopeMeta::default();
    for _ in 0..count {
        let key = reader.str()?;
        match key {
            "type" | "method" | "name" => {
                reader.step_node(1)?;
                let tag = reader.u8()?;
                if tag == TAG_STRING {
                    let value = reader.str()?.to_owned();
                    match key {
                        "type" => meta.msg_type = Some(value),
                        "method" => meta.method = Some(value),
                        "name" => meta.name = Some(value),
                        _ => unreachable!(),
                    }
                } else {
                    skip_tagged_value(&mut reader, tag, 1)?;
                }
            }
            _ => {
                reader.step_node(1)?;
                let tag = reader.u8()?;
                skip_tagged_value(&mut reader, tag, 1)?;
            }
        }
    }
    reader.finish()?;
    Ok(meta)
}

fn skip_tagged_value(reader: &mut BinaryReader<'_>, tag: u8, depth: usize) -> Result<(), String> {
    match tag {
        TAG_NULL | TAG_FALSE | TAG_TRUE => Ok(()),
        TAG_INT64 => reader.i64().map(|_| ()),
        TAG_FLOAT64 => reader.f64().map(|_| ()),
        TAG_STRING => reader.str().map(|_| ()),
        TAG_BYTES => reader.bytes().map(|_| ()),
        TAG_ARRAY => {
            let count = reader.u32()? as usize;
            if count > MAX_NODES {
                return Err("binary array count too large".to_owned());
            }
            for _ in 0..count {
                reader.step_node(depth + 1)?;
                let child_tag = reader.u8()?;
                skip_tagged_value(reader, child_tag, depth + 1)?;
            }
            Ok(())
        }
        TAG_OBJECT => {
            let count = reader.u32()? as usize;
            if count > MAX_NODES {
                return Err("binary object count too large".to_owned());
            }
            for _ in 0..count {
                let _ = reader.str()?;
                reader.step_node(depth + 1)?;
                let child_tag = reader.u8()?;
                skip_tagged_value(reader, child_tag, depth + 1)?;
            }
            Ok(())
        }
        other => Err(format!("unknown binary bridge value tag 0x{other:02x}")),
    }
}

/// Decode a `0xB1` Binary TLV buffer into a `serde_json::Value`.
pub fn decode_to_json(bytes: &[u8]) -> Result<JsonValue, String> {
    let mut reader = BinaryReader::new(bytes)?;
    let value = decode_json_value(&mut reader, 0)?;
    if !value.is_object() {
        return Err("binary bridge root must be an object".to_owned());
    }
    reader.finish()?;
    Ok(value)
}

fn decode_json_value(reader: &mut BinaryReader<'_>, depth: usize) -> Result<JsonValue, String> {
    reader.step_node(depth)?;
    let tag = reader.u8()?;
    match tag {
        TAG_NULL => Ok(JsonValue::Null),
        TAG_FALSE => Ok(JsonValue::Bool(false)),
        TAG_TRUE => Ok(JsonValue::Bool(true)),
        TAG_INT64 => Ok(JsonValue::Number(JsonNumber::from(reader.i64()?))),
        TAG_FLOAT64 => {
            let val = reader.f64()?;
            let num = JsonNumber::from_f64(val)
                .ok_or_else(|| "non-finite float in binary value".to_owned())?;
            Ok(JsonValue::Number(num))
        }
        TAG_STRING => Ok(JsonValue::String(reader.str()?.to_owned())),
        TAG_BYTES => {
            let slice = reader.bytes()?;
            Ok(JsonValue::Array(
                slice
                    .iter()
                    .map(|byte| JsonValue::Number(JsonNumber::from(*byte)))
                    .collect(),
            ))
        }
        TAG_ARRAY => {
            let count = reader.u32()? as usize;
            if count > MAX_NODES {
                return Err("binary array count too large".to_owned());
            }
            let mut items = Vec::with_capacity(count.min(256));
            for _ in 0..count {
                items.push(decode_json_value(reader, depth + 1)?);
            }
            Ok(JsonValue::Array(items))
        }
        TAG_OBJECT => {
            let count = reader.u32()? as usize;
            if count > MAX_NODES {
                return Err("binary object count too large".to_owned());
            }
            let mut map = JsonMap::with_capacity(count.min(64));
            for _ in 0..count {
                let key = reader.str()?.to_owned();
                let val = decode_json_value(reader, depth + 1)?;
                map.insert(key, val);
            }
            Ok(JsonValue::Object(map))
        }
        other => Err(format!("unknown binary bridge value tag 0x{other:02x}")),
    }
}

/// Decode a `0xB1` Binary TLV buffer directly into a QuickJS `Value` on `ctx`.
pub fn decode_to_js<'js>(ctx: &Ctx<'js>, bytes: &[u8]) -> Result<Value<'js>, String> {
    let mut reader = BinaryReader::new(bytes)?;
    let value = decode_js_value(ctx, &mut reader, 0)?;
    reader.finish()?;
    Ok(value)
}

fn decode_js_value<'js>(
    ctx: &Ctx<'js>,
    reader: &mut BinaryReader<'_>,
    depth: usize,
) -> Result<Value<'js>, String> {
    reader.step_node(depth)?;
    let tag = reader.u8()?;
    match tag {
        TAG_NULL => Ok(Value::new_null(ctx.clone())),
        TAG_FALSE => Ok(Value::new_bool(ctx.clone(), false)),
        TAG_TRUE => Ok(Value::new_bool(ctx.clone(), true)),
        TAG_INT64 => {
            let val = reader.i64()?;
            if let Ok(i32_val) = i32::try_from(val) {
                Ok(Value::new_int(ctx.clone(), i32_val))
            } else {
                Ok(Value::new_float(ctx.clone(), val as f64))
            }
        }
        TAG_FLOAT64 => Ok(Value::new_float(ctx.clone(), reader.f64()?)),
        TAG_STRING => {
            let text = reader.str()?;
            rquickjs::String::from_str(ctx.clone(), text)
                .map(rquickjs::String::into_value)
                .map_err(|error| error.to_string())
        }
        TAG_BYTES => {
            let slice = reader.bytes()?;
            TypedArray::<u8>::new_copy(ctx.clone(), slice)
                .map(TypedArray::into_value)
                .map_err(|error| error.to_string())
        }
        TAG_ARRAY => {
            let count = reader.u32()? as usize;
            if count > MAX_NODES {
                return Err("binary array count too large".to_owned());
            }
            let array = Array::new(ctx.clone()).map_err(|error| error.to_string())?;
            for index in 0..count {
                let child = decode_js_value(ctx, reader, depth + 1)?;
                array.set(index, child).map_err(|error| error.to_string())?;
            }
            Ok(array.into_value())
        }
        TAG_OBJECT => {
            let count = reader.u32()? as usize;
            if count > MAX_NODES {
                return Err("binary object count too large".to_owned());
            }
            let object = Object::new(ctx.clone()).map_err(|error| error.to_string())?;
            for _ in 0..count {
                let key = reader.str()?;
                let child = decode_js_value(ctx, reader, depth + 1)?;
                object
                    .prop(key, Property::from(child).configurable().enumerable().writable())
                    .map_err(|error| error.to_string())?;
            }
            Ok(object.into_value())
        }
        other => Err(format!("unknown binary bridge value tag 0x{other:02x}")),
    }
}

/// Convert a `serde_json::Value` directly into a QuickJS `Value` on `ctx`
/// without serializing to JSON text or calling `JSON.parse` in QuickJS.
pub fn json_to_js<'js>(ctx: &Ctx<'js>, value: &JsonValue) -> Result<Value<'js>, String> {
    match value {
        JsonValue::Null => Ok(Value::new_null(ctx.clone())),
        JsonValue::Bool(boolean) => Ok(Value::new_bool(ctx.clone(), *boolean)),
        JsonValue::Number(num) => {
            if let Some(i) = num.as_i64() {
                if let Ok(i32_val) = i32::try_from(i) {
                    return Ok(Value::new_int(ctx.clone(), i32_val));
                }
                return Ok(Value::new_float(ctx.clone(), i as f64));
            }
            if let Some(f) = num.as_f64() {
                return Ok(Value::new_float(ctx.clone(), f));
            }
            Err("invalid JSON number".to_owned())
        }
        JsonValue::String(text) => rquickjs::String::from_str(ctx.clone(), text)
            .map(rquickjs::String::into_value)
            .map_err(|error| error.to_string()),
        JsonValue::Array(items) => {
            let array = Array::new(ctx.clone()).map_err(|error| error.to_string())?;
            for (index, item) in items.iter().enumerate() {
                let child = json_to_js(ctx, item)?;
                array.set(index, child).map_err(|error| error.to_string())?;
            }
            Ok(array.into_value())
        }
        JsonValue::Object(map) => {
            let object = Object::new(ctx.clone()).map_err(|error| error.to_string())?;
            for (key, item) in map {
                let child = json_to_js(ctx, item)?;
                object
                    .prop(
                        key.as_str(),
                        Property::from(child).configurable().enumerable().writable(),
                    )
                    .map_err(|error| error.to_string())?;
            }
            Ok(object.into_value())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rquickjs::{Context, Runtime};
    use serde_json::json;

    #[test]
    fn binary_tlv_roundtrips_json_and_quickjs_values_with_uint8array() {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        context.with(|ctx| {
            let js_val: Value = ctx
                .eval(
                    r#"({
                        type: "event",
                        id: "evt-1",
                        name: "stream.data",
                        ignoredUndefined: undefined,
                        ignoredFunc: function() {},
                        payload: {
                            streamId: "guest-1",
                            count: 42,
                            largeInt: 9007199254740991,
                            ratio: 3.14159,
                            active: true,
                            empty: null,
                            tags: ["alpha", "中😀"],
                            bytes: new Uint8Array([1, 2, 255, 0, 128])
                        }
                    })"#,
                )
                .unwrap();

            let encoded = encode_js_message(js_val, 256 * 1024, 256).unwrap();
            assert_eq!(encoded[0], BINARY_MESSAGE_MAGIC);

            let meta = inspect_binary_envelope(&encoded).unwrap();
            assert_eq!(meta.msg_type.as_deref(), Some("event"));
            assert_eq!(meta.effective_method(), "stream.data");
            assert!(!meta.is_response());
            assert!(!meta.is_input());

            let decoded_js = decode_to_js(&ctx, &encoded).unwrap();
            ctx.globals().set("__decoded", decoded_js).unwrap();
            let verified: bool = ctx
                .eval(
                    r#"
                    __decoded.type === "event" &&
                    __decoded.id === "evt-1" &&
                    __decoded.name === "stream.data" &&
                    !("ignoredUndefined" in __decoded) &&
                    !("ignoredFunc" in __decoded) &&
                    __decoded.payload.streamId === "guest-1" &&
                    __decoded.payload.count === 42 &&
                    __decoded.payload.largeInt === 9007199254740991 &&
                    Math.abs(__decoded.payload.ratio - 3.14159) < 1e-9 &&
                    __decoded.payload.active === true &&
                    __decoded.payload.empty === null &&
                    __decoded.payload.tags[1] === "中😀" &&
                    (__decoded.payload.bytes instanceof Uint8Array) &&
                    __decoded.payload.bytes.length === 5 &&
                    __decoded.payload.bytes[2] === 255
                    "#,
                )
                .unwrap();
            assert!(verified);

            let decoded_json = decode_to_json(&encoded).unwrap();
            assert_eq!(decoded_json["name"], "stream.data");
            assert_eq!(decoded_json["payload"]["count"], 42);
            assert_eq!(decoded_json["payload"]["bytes"], json!([1, 2, 255, 0, 128]));
        });
    }

    #[test]
    fn binary_tlv_rejects_cycles_non_finite_and_invalid_batches() {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        context.with(|ctx| {
            let cyclic: Value = ctx.eval("const a = { name: 'x' }; a.self = a; a").unwrap();
            assert!(encode_js_message(cyclic, 256 * 1024, 256).is_err());

            let nan_val: Value = ctx.eval("({ name: 'x', v: NaN })").unwrap();
            assert!(encode_js_message(nan_val, 256 * 1024, 256).is_err());

            let bad_batch: Value = ctx
                .eval("({ name: 'stream.batch', payload: { events: [{ name: 'stream.batch', params: { events: [] } }] } })")
                .unwrap();
            assert!(encode_js_message(bad_batch, 256 * 1024, 256).is_err());
        });
    }


}
