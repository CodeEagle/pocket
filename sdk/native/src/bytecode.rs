//! PocketJS QuickJS bytecode envelope.
//!
//! The bytes after [`HEADER_LEN`] are the object stream emitted by the same
//! QuickJS build that owns the native guest.  This is deliberately not a
//! compressed JavaScript format: the runtime must hand the payload directly
//! to `JS_ReadObject` and then `JS_EvalFunction` (or `Module::load`).

use pocketjs_core::sha256::sha256;
use rquickjs::qjs;
use std::ffi::CStr;
use std::fmt;

pub const MAGIC: [u8; 4] = *b"PJBC";
pub const FORMAT_VERSION: u16 = 1;
pub const HEADER_LEN: usize = 124;
pub const ENTRY_FORMAT: &str = "quickjs-bytecode";

/// The bytecode format is endian-stable. QuickJS-ng 0.15 treats the old
/// `JS_WRITE_OBJ_BSWAP` bit as obsolete and transparently writes portable
/// bytecode, so this flag records the contract rather than a host pointer
/// layout.
pub const FLAG_LITTLE_ENDIAN: u8 = 1 << 0;
pub const FLAG_STRICT: u8 = 1 << 1;
pub const FLAG_STRIP_SOURCE: u8 = 1 << 2;
pub const FLAG_STRIP_DEBUG: u8 = 1 << 3;
pub const KNOWN_FLAGS: u8 = FLAG_LITTLE_ENDIAN | FLAG_STRICT | FLAG_STRIP_SOURCE | FLAG_STRIP_DEBUG;
pub const DEFAULT_FLAGS: u8 =
    FLAG_LITTLE_ENDIAN | FLAG_STRICT | FLAG_STRIP_SOURCE | FLAG_STRIP_DEBUG;

/// QuickJS-ng's serialized-bytecode version in the pinned `rquickjs-sys`
/// source. It is included in the engine ABI fingerprint and intentionally
/// kept explicit so a QuickJS update requires an ABI review.
pub const QUICKJS_BYTECODE_VERSION: u8 = 26;

/// A script is the current Bun IIFE output. A module is supported for future
/// bundle formats and is loaded through rquickjs's Module API at runtime.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum BytecodeKind {
    Script = 1,
    Module = 2,
}

impl TryFrom<u8> for BytecodeKind {
    type Error = BytecodeError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Script),
            2 => Ok(Self::Module),
            other => Err(BytecodeError::UnsupportedKind(other)),
        }
    }
}

/// Expected host contract for a bytecode artifact.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BytecodeExpectation {
    pub kind: BytecodeKind,
    pub binding_generation: u32,
    pub tick_hz: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BytecodeArtifact<'a> {
    pub kind: BytecodeKind,
    pub flags: u8,
    pub binding_generation: u32,
    pub tick_hz: u32,
    pub engine_abi: [u8; 32],
    pub source_sha256: [u8; 32],
    pub payload_sha256: [u8; 32],
    pub payload: &'a [u8],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BytecodeError {
    TooShort(usize),
    BadMagic,
    UnsupportedVersion(u16),
    InvalidHeaderLength(u16),
    UnsupportedKind(u8),
    UnknownFlags(u8),
    InvalidLength {
        declared: u64,
        actual: usize,
    },
    EmptyPayload,
    SourceDigestMismatch,
    PayloadDigestMismatch,
    EngineAbiMismatch,
    BindingMismatch {
        expected: u32,
        actual: u32,
    },
    TickHzMismatch {
        expected: u32,
        actual: u32,
    },
    KindMismatch {
        expected: BytecodeKind,
        actual: BytecodeKind,
    },
    NonCanonicalFlags(u8),
}

impl fmt::Display for BytecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooShort(size) => write!(f, "bytecode envelope is truncated ({size} bytes)"),
            Self::BadMagic => f.write_str("bytecode envelope magic mismatch"),
            Self::UnsupportedVersion(version) => {
                write!(f, "unsupported bytecode envelope version {version}")
            }
            Self::InvalidHeaderLength(length) => {
                write!(f, "invalid bytecode envelope header length {length}")
            }
            Self::UnsupportedKind(kind) => write!(f, "unsupported bytecode kind {kind}"),
            Self::UnknownFlags(flags) => write!(f, "unknown bytecode envelope flags 0x{flags:02x}"),
            Self::InvalidLength { declared, actual } => write!(
                f,
                "bytecode payload length {declared} does not match envelope ({actual} bytes)"
            ),
            Self::EmptyPayload => f.write_str("bytecode payload is empty"),
            Self::SourceDigestMismatch => f.write_str("bytecode source digest is invalid"),
            Self::PayloadDigestMismatch => f.write_str("bytecode payload digest is invalid"),
            Self::EngineAbiMismatch => f.write_str("bytecode QuickJS ABI mismatch"),
            Self::BindingMismatch { expected, actual } => write!(
                f,
                "bytecode binding generation mismatch (expected {expected}, got {actual})"
            ),
            Self::TickHzMismatch { expected, actual } => {
                write!(
                    f,
                    "bytecode tick rate mismatch (expected {expected}, got {actual})"
                )
            }
            Self::KindMismatch { expected, actual } => {
                write!(
                    f,
                    "bytecode kind mismatch (expected {expected:?}, got {actual:?})"
                )
            }
            Self::NonCanonicalFlags(flags) => {
                write!(f, "non-canonical bytecode flags 0x{flags:02x}")
            }
        }
    }
}

impl std::error::Error for BytecodeError {}

/// The ABI descriptor is hashed at compile and runtime instead of placing a
/// version string with ambiguous length/padding in every artifact. The
/// QuickJS version is read from the linked C engine, so changing the engine
/// source/build or the bytecode flags changes the digest and is rejected.
pub fn engine_abi() -> [u8; 32] {
    let version = unsafe { qjs::JS_GetVersion() };
    let version = if version.is_null() {
        b"<missing>".as_slice()
    } else {
        unsafe { CStr::from_ptr(version) }.to_bytes()
    };
    let mut descriptor = Vec::with_capacity(128);
    descriptor.extend_from_slice(b"pocketjs-qjs-bytecode/v1\0");
    descriptor.extend_from_slice(b"quickjs-ng\0");
    descriptor.extend_from_slice(version);
    descriptor.push(0);
    descriptor.push(QUICKJS_BYTECODE_VERSION);
    descriptor.extend_from_slice(
        &(qjs::JS_WRITE_OBJ_BYTECODE
            | qjs::JS_WRITE_OBJ_STRIP_SOURCE
            | qjs::JS_WRITE_OBJ_STRIP_DEBUG)
            .to_le_bytes(),
    );
    descriptor.extend_from_slice(&qjs::JS_READ_OBJ_BYTECODE.to_le_bytes());
    descriptor.push(if cfg!(target_endian = "little") {
        b'l'
    } else {
        b'b'
    });
    sha256(&descriptor)
}

fn hex_digest(digest: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(64);
    for byte in digest {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex_digest(sha256(bytes))
}

/// Stable manifest value for this exact linked QuickJS serialization ABI.
/// Package admission compares this string before passing a bytecode payload
/// to native; the envelope repeats the binary digest for an independent check.
pub fn runtime_abi() -> String {
    format!(
        "quickjs-bytecode-v{FORMAT_VERSION}:{}",
        hex_digest(engine_abi())
    )
}

pub fn engine_abi_hex() -> String {
    hex_digest(engine_abi())
}

/// Wrap a serialized QuickJS object in the deterministic envelope.
pub fn encode(
    kind: BytecodeKind,
    flags: u8,
    binding_generation: u32,
    tick_hz: u32,
    source: &[u8],
    payload: &[u8],
) -> Result<Vec<u8>, BytecodeError> {
    if payload.is_empty() {
        return Err(BytecodeError::EmptyPayload);
    }
    if flags & !KNOWN_FLAGS != 0 {
        return Err(BytecodeError::UnknownFlags(flags & !KNOWN_FLAGS));
    }
    if flags != DEFAULT_FLAGS {
        return Err(BytecodeError::NonCanonicalFlags(flags));
    }
    let payload_len = u64::try_from(payload.len()).map_err(|_| BytecodeError::InvalidLength {
        declared: payload.len() as u64,
        actual: payload.len(),
    })?;
    let mut output = Vec::with_capacity(HEADER_LEN + payload.len());
    output.extend_from_slice(&MAGIC);
    output.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    output.extend_from_slice(&(HEADER_LEN as u16).to_le_bytes());
    output.push(kind as u8);
    output.push(flags);
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&binding_generation.to_le_bytes());
    output.extend_from_slice(&tick_hz.to_le_bytes());
    output.extend_from_slice(&engine_abi());
    output.extend_from_slice(&sha256(source));
    output.extend_from_slice(&payload_len.to_le_bytes());
    output.extend_from_slice(&sha256(payload));
    debug_assert_eq!(output.len(), HEADER_LEN);
    output.extend_from_slice(payload);
    Ok(output)
}

/// Parse and cryptographically validate an envelope. This does not apply the
/// host-specific binding/tick/kind expectation; use [`validate`] before
/// handing the payload to QuickJS.
pub fn parse(bytes: &[u8]) -> Result<BytecodeArtifact<'_>, BytecodeError> {
    if bytes.len() < HEADER_LEN {
        return Err(BytecodeError::TooShort(bytes.len()));
    }
    if bytes[..4] != MAGIC {
        return Err(BytecodeError::BadMagic);
    }
    let version = u16::from_le_bytes([bytes[4], bytes[5]]);
    if version != FORMAT_VERSION {
        return Err(BytecodeError::UnsupportedVersion(version));
    }
    let header_len = u16::from_le_bytes([bytes[6], bytes[7]]);
    if usize::from(header_len) != HEADER_LEN {
        return Err(BytecodeError::InvalidHeaderLength(header_len));
    }
    let kind = BytecodeKind::try_from(bytes[8])?;
    let flags = bytes[9];
    if flags & !KNOWN_FLAGS != 0 {
        return Err(BytecodeError::UnknownFlags(flags & !KNOWN_FLAGS));
    }
    let binding_generation = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
    let tick_hz = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
    let engine_abi: [u8; 32] = bytes[20..52].try_into().unwrap();
    let source_sha256: [u8; 32] = bytes[52..84].try_into().unwrap();
    let payload_len = u64::from_le_bytes(bytes[84..92].try_into().unwrap());
    let payload_sha256: [u8; 32] = bytes[92..124].try_into().unwrap();
    let actual_payload_len = bytes.len() - HEADER_LEN;
    if payload_len != actual_payload_len as u64 {
        return Err(BytecodeError::InvalidLength {
            declared: payload_len,
            actual: actual_payload_len,
        });
    }
    if actual_payload_len == 0 {
        return Err(BytecodeError::EmptyPayload);
    }
    let payload = &bytes[HEADER_LEN..];
    if sha256(payload) != payload_sha256 {
        return Err(BytecodeError::PayloadDigestMismatch);
    }
    Ok(BytecodeArtifact {
        kind,
        flags,
        binding_generation,
        tick_hz,
        engine_abi,
        source_sha256,
        payload_sha256,
        payload,
    })
}

/// Apply the host contract and current linked QuickJS ABI checks. A caller
/// must invoke this before `JS_ReadObject`; no source fallback is permitted.
pub fn validate(
    bytes: &[u8],
    expected: BytecodeExpectation,
) -> Result<BytecodeArtifact<'_>, BytecodeError> {
    let artifact = parse(bytes)?;
    if artifact.flags != DEFAULT_FLAGS {
        return Err(BytecodeError::NonCanonicalFlags(artifact.flags));
    }
    if artifact.engine_abi != engine_abi() {
        return Err(BytecodeError::EngineAbiMismatch);
    }
    if artifact.kind != expected.kind {
        return Err(BytecodeError::KindMismatch {
            expected: expected.kind,
            actual: artifact.kind,
        });
    }
    if artifact.binding_generation != expected.binding_generation {
        return Err(BytecodeError::BindingMismatch {
            expected: expected.binding_generation,
            actual: artifact.binding_generation,
        });
    }
    if artifact.tick_hz != expected.tick_hz {
        return Err(BytecodeError::TickHzMismatch {
            expected: expected.tick_hz,
            actual: artifact.tick_hz,
        });
    }
    Ok(artifact)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trip_and_digest() {
        let source = b"globalThis.frame = function() {};";
        let payload = b"quickjs bytecode";
        let bytes = encode(BytecodeKind::Script, DEFAULT_FLAGS, 12, 60, source, payload).unwrap();
        let parsed = validate(
            &bytes,
            BytecodeExpectation {
                kind: BytecodeKind::Script,
                binding_generation: 12,
                tick_hz: 60,
            },
        )
        .unwrap();
        assert_eq!(parsed.payload, payload);
        assert_eq!(parsed.source_sha256, sha256(source));
    }

    #[test]
    fn payload_mutation_is_rejected_before_execution() {
        let mut bytes = encode(
            BytecodeKind::Script,
            DEFAULT_FLAGS,
            12,
            60,
            b"source",
            b"payload",
        )
        .unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        assert_eq!(parse(&bytes), Err(BytecodeError::PayloadDigestMismatch));
    }

    #[test]
    fn truncation_and_contract_mismatches_are_rejected() {
        let bytes = encode(
            BytecodeKind::Script,
            DEFAULT_FLAGS,
            12,
            60,
            b"source",
            b"payload",
        )
        .unwrap();
        assert_eq!(
            parse(&bytes[..HEADER_LEN - 1]),
            Err(BytecodeError::TooShort(HEADER_LEN - 1))
        );

        let mut wrong_engine = bytes.clone();
        wrong_engine[20] ^= 1;
        assert_eq!(
            validate(
                &wrong_engine,
                BytecodeExpectation {
                    kind: BytecodeKind::Script,
                    binding_generation: 12,
                    tick_hz: 60,
                },
            ),
            Err(BytecodeError::EngineAbiMismatch)
        );
        assert_eq!(
            validate(
                &bytes,
                BytecodeExpectation {
                    kind: BytecodeKind::Script,
                    binding_generation: 99,
                    tick_hz: 60,
                },
            ),
            Err(BytecodeError::BindingMismatch {
                expected: 99,
                actual: 12,
            })
        );
        assert_eq!(
            validate(
                &bytes,
                BytecodeExpectation {
                    kind: BytecodeKind::Script,
                    binding_generation: 12,
                    tick_hz: 120,
                },
            ),
            Err(BytecodeError::TickHzMismatch {
                expected: 120,
                actual: 60,
            })
        );
    }
}
