//! Native offload records; the object codec is also shared with Wasm.
use crate::binary_bridge::OFFLOAD_BINARY_MAGIC;
use crate::offload::OffloadProviderRequest;

/// Encode an `OffloadProviderRequest` into a compact `0xB2` binary record.
///
/// Layout:
/// - `u8` magic (`0xB2`)
/// - `u32` generation LE
/// - `u32` session LE
/// - `u64` id LE
/// - `u64` timeout_micros LE
/// - `u32` method_len LE + UTF-8 method bytes
/// - `u32` payload_len LE + UTF-8 payload bytes
pub fn encode_offload_request(request: &OffloadProviderRequest) -> Vec<u8> {
    let method_bytes = request.method.as_bytes();
    let payload_bytes = request.payload.as_bytes();
    let mut out =
        Vec::with_capacity(1 + 4 + 4 + 8 + 8 + 4 + method_bytes.len() + 4 + payload_bytes.len());
    out.push(OFFLOAD_BINARY_MAGIC);
    out.extend_from_slice(&request.generation.to_le_bytes());
    out.extend_from_slice(&request.session.to_le_bytes());
    out.extend_from_slice(&request.id.to_le_bytes());
    out.extend_from_slice(&(request.timeout.as_micros() as u64).to_le_bytes());
    out.extend_from_slice(&(method_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(method_bytes);
    out.extend_from_slice(&(payload_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(payload_bytes);
    out
}

/// Decode a `0xB2` binary offload completion record from Dart.
///
/// Layout:
/// - `u8` magic (`0xB2`)
/// - `u32` generation LE
/// - `u32` session LE
/// - `u64` id LE
/// - `u8` status (`1 = Ok(payload)`, `0 = Err(error)`)
/// - `u32` text_len LE + UTF-8 text bytes
pub fn decode_offload_completion(bytes: &[u8]) -> Option<(u32, u32, u64, Result<String, String>)> {
    if bytes.len() < 22 || bytes.len() > 16384 || bytes[0] != OFFLOAD_BINARY_MAGIC {
        return None;
    }
    let generation = u32::from_le_bytes(bytes[1..5].try_into().ok()?);
    let session = u32::from_le_bytes(bytes[5..9].try_into().ok()?);
    let id = u64::from_le_bytes(bytes[9..17].try_into().ok()?);
    let status = bytes[17];
    let text_len = u32::from_le_bytes(bytes[18..22].try_into().ok()?) as usize;
    if 22usize.checked_add(text_len)? != bytes.len() {
        return None;
    }
    let text = std::str::from_utf8(&bytes[22..22 + text_len])
        .ok()?
        .to_owned();
    let result = match status {
        1 => Ok(text),
        0 => Err(text),
        _ => return None,
    };
    Some((generation, session, id, result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    #[test]
    fn offload_binary_record_roundtrips() {
        let req = OffloadProviderRequest {
            generation: 1,
            session: 7,
            id: 99,
            method: "crypto.hash".to_owned(),
            payload: r#"{"data":"abc"}"#.to_owned(),
            timeout: Duration::from_millis(2500),
        };
        let encoded = encode_offload_request(&req);
        assert_eq!(encoded[0], OFFLOAD_BINARY_MAGIC);

        let mut completion = Vec::new();
        completion.push(OFFLOAD_BINARY_MAGIC);
        completion.extend_from_slice(&1u32.to_le_bytes());
        completion.extend_from_slice(&7u32.to_le_bytes());
        completion.extend_from_slice(&99u64.to_le_bytes());
        completion.push(1);
        let payload = br#"{"digest":"deadbeef"}"#;
        completion.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        completion.extend_from_slice(payload);

        let (gen, sess, id, res) = decode_offload_completion(&completion).unwrap();
        assert_eq!((gen, sess, id), (1, 7, 99));
        assert_eq!(res.unwrap(), r#"{"digest":"deadbeef"}"#);
    }
}
