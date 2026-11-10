//! Helpers for the opt-in PFP1 frame-delta transport.
//!
//! The native runtime owns the complete PFB1 encoder.  This module deliberately
//! knows nothing about DrawOps or resources: it only computes a stable
//! prefix/suffix splice and wraps an already encoded PFB1 payload.  Keeping the
//! protocol arithmetic separate makes it possible to exercise insertion,
//! deletion, ordering, and empty-operation cases without a mock renderer.

/// Little-endian magic for the PFP1 frame-delta envelope (`"PFP1"`).
pub(crate) const MAGIC: u32 = u32::from_le_bytes(*b"PFP1");
/// Fixed PFP1 header size: magic (4) + base sequence (8) + four u32 fields.
pub(crate) const HEADER_BYTES: usize = 28;

/// A sequence splice that transforms `base` into `result`:
///
/// ```text
/// base    = prefix + deleted + suffix
/// result  = prefix + inserted + suffix
/// ```
///
/// The caller can derive the inserted range from `prefix_count` and
/// `resulting_len - prefix_count - suffix_count`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Splice {
    pub(crate) prefix_count: usize,
    pub(crate) delete_count: usize,
    pub(crate) suffix_count: usize,
}

/// Find the largest common ordered prefix and suffix.  Equality is delegated to
/// the element type's `PartialEq`; the frame path uses the typed `FrameOp`
/// implementation, so no probabilistic hash is involved and clips, geometry,
/// colours, text, and metadata all participate in equality.
pub(crate) fn common_splice<T: PartialEq>(base: &[T], result: &[T]) -> Splice {
    let mut prefix_count = 0;
    while prefix_count < base.len()
        && prefix_count < result.len()
        && base[prefix_count] == result[prefix_count]
    {
        prefix_count += 1;
    }

    let mut suffix_count = 0;
    while prefix_count + suffix_count < base.len()
        && prefix_count + suffix_count < result.len()
        && base[base.len() - suffix_count - 1] == result[result.len() - suffix_count - 1]
    {
        suffix_count += 1;
    }

    Splice {
        prefix_count,
        delete_count: base.len() - prefix_count - suffix_count,
        suffix_count,
    }
}

/// Build a PFP1 envelope around a complete PFB1 payload. The caller only uses
/// this when the common splice has retained operations: the fixed 28-byte
/// envelope is smaller than the bytes removed by that splice. This helper
/// validates fixed-width fields and performs no compression.
pub(crate) fn encode(
    base_sequence: u64,
    splice: Splice,
    resulting_op_count: usize,
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    let prefix_count = u32::try_from(splice.prefix_count)
        .map_err(|_| "frame delta prefix count exceeds u32".to_owned())?;
    let delete_count = u32::try_from(splice.delete_count)
        .map_err(|_| "frame delta delete count exceeds u32".to_owned())?;
    let resulting_op_count = u32::try_from(resulting_op_count)
        .map_err(|_| "frame delta resulting operation count exceeds u32".to_owned())?;
    let embedded_payload_length = u32::try_from(payload.len())
        .map_err(|_| "frame delta embedded payload exceeds u32".to_owned())?;

    let mut bytes = Vec::with_capacity(HEADER_BYTES + payload.len());
    bytes.extend_from_slice(&MAGIC.to_le_bytes());
    bytes.extend_from_slice(&base_sequence.to_le_bytes());
    bytes.extend_from_slice(&prefix_count.to_le_bytes());
    bytes.extend_from_slice(&delete_count.to_le_bytes());
    bytes.extend_from_slice(&resulting_op_count.to_le_bytes());
    bytes.extend_from_slice(&embedded_payload_length.to_le_bytes());
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{common_splice, encode, HEADER_BYTES, MAGIC};

    #[test]
    fn splice_preserves_order_for_insert_delete_and_edge_changes() {
        let base = ["a", "b", "c", "d"];
        assert_eq!(
            common_splice(&base, &["a", "b", "x", "c", "d"]),
            super::Splice {
                prefix_count: 2,
                delete_count: 0,
                suffix_count: 2,
            }
        );
        assert_eq!(
            common_splice(&base, &["a", "c", "d"]),
            super::Splice {
                prefix_count: 1,
                delete_count: 1,
                suffix_count: 2,
            }
        );
        assert_eq!(
            common_splice(&base, &["x", "b", "c", "d"]),
            super::Splice {
                prefix_count: 0,
                delete_count: 1,
                suffix_count: 3,
            }
        );
        assert_eq!(
            common_splice(&base, &["a", "b", "c", "x"]),
            super::Splice {
                prefix_count: 3,
                delete_count: 1,
                suffix_count: 0,
            }
        );
    }

    #[test]
    fn empty_result_and_header_are_fixed_width() {
        let splice = common_splice::<u8>(&[1, 2], &[]);
        let bytes = encode(17, splice, 0, b"PFB1").unwrap();
        assert_eq!(HEADER_BYTES, 28);
        assert_eq!(bytes.len(), HEADER_BYTES + 4);
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), MAGIC);
        assert_eq!(u64::from_le_bytes(bytes[4..12].try_into().unwrap()), 17);
        assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(bytes[16..20].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(bytes[20..24].try_into().unwrap()), 0);
        assert_eq!(
            u32::from_le_bytes(bytes[24..HEADER_BYTES].try_into().unwrap()),
            4
        );
        assert_eq!(&bytes[HEADER_BYTES..], b"PFB1");
    }
}
