use pocket_flutter::{
    pocket_create, pocket_destroy, pocket_eval, pocket_frame, pocket_frame_binary,
    pocket_frame_delta_binary, pocket_frame_delta_binary_v2, pocket_resize_viewport,
    pocket_send,
};
use std::ffi::{CStr, CString};

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

fn copy_frame(pointer: *const u8, length: u64) -> Vec<u8> {
    assert!(!pointer.is_null());
    unsafe { std::slice::from_raw_parts(pointer, length as usize).to_vec() }
}

#[derive(Debug)]
struct ParsedPacket {
    magic: [u8; 4],
    sequence: u64,
    resources: Vec<(String, Vec<u8>)>,
    released: Vec<String>,
}

fn read_bytes(bytes: &[u8], offset: &mut usize) -> Vec<u8> {
    let length = read_u32(bytes, *offset) as usize;
    *offset += 4;
    let end = *offset + length;
    let value = bytes[*offset..end].to_vec();
    *offset = end;
    value
}

fn read_string(bytes: &[u8], offset: &mut usize) -> String {
    String::from_utf8(read_bytes(bytes, offset)).unwrap()
}

fn skip_op(bytes: &[u8], offset: &mut usize) {
    let tag = bytes[*offset];
    *offset += 1 + 32; // tag + geometry + clip
    match tag {
        0 => *offset += 4,
        1 => *offset += 8,
        2 => *offset += 12,
        3 => *offset += 36,
        4 => {
            let _ = read_string(bytes, offset);
            *offset += 4 + 24 + 24;
        }
        5 => {
            let _ = read_string(bytes, offset);
            *offset += 8;
            let has_slot = bytes[*offset] != 0;
            *offset += 1 + usize::from(has_slot) + 1;
        }
        6 => {
            let _ = read_string(bytes, offset);
            let has_uv = bytes[*offset] != 0;
            *offset += 1 + if has_uv { 16 } else { 0 };
            let has_color = bytes[*offset] != 0;
            *offset += 1 + if has_color { 4 } else { 0 };
        }
        7 | 8 => {
            let _ = read_string(bytes, offset);
            let _ = read_string(bytes, offset);
            *offset += if tag == 7 { 5 } else { 2 };
        }
        other => panic!("unknown PFB1 op tag {other}"),
    }
}

fn parse_pfb1(bytes: &[u8]) -> ParsedPacket {
    assert_eq!(&bytes[..4], b"PFB1");
    let mut offset = 24;
    let op_count = read_u32(bytes, offset) as usize;
    offset += 4;
    for _ in 0..op_count {
        skip_op(bytes, &mut offset);
    }
    let event_count = read_u32(bytes, offset) as usize;
    offset += 4;
    for _ in 0..event_count {
        let _ = read_bytes(bytes, &mut offset);
    }
    let resource_count = read_u32(bytes, offset) as usize;
    offset += 4;
    let mut resources = Vec::with_capacity(resource_count);
    for _ in 0..resource_count {
        let asset = read_string(bytes, &mut offset);
        offset += 8 + 4 + 4 + 4 + 1; // revision, dimensions, PSM, filter
        let pixels = read_bytes(bytes, &mut offset);
        let has_palette = bytes[offset] != 0;
        offset += 1;
        if has_palette {
            let _ = read_bytes(bytes, &mut offset);
        }
        resources.push((asset, pixels));
    }
    let released_count = read_u32(bytes, offset) as usize;
    offset += 4;
    let mut released = Vec::with_capacity(released_count);
    for _ in 0..released_count {
        released.push(read_string(bytes, &mut offset));
    }
    if bytes[offset] != 0 {
        offset += 1 + 8;
        let auxiliary_count = read_u32(bytes, offset) as usize;
        offset += 4;
        for _ in 0..auxiliary_count {
            skip_op(bytes, &mut offset);
        }
    } else {
        offset += 1;
    }
    assert_eq!(offset, bytes.len(), "trailing PFB1 bytes");
    ParsedPacket {
        magic: *b"PFB1",
        sequence: read_u64(bytes, 8),
        resources,
        released,
    }
}

fn parse_packet(bytes: &[u8]) -> ParsedPacket {
    match &bytes[..4] {
        b"PFB1" => parse_pfb1(bytes),
        b"PFP1" => {
            let payload_length = read_u32(bytes, 24) as usize;
            let mut packet = parse_pfb1(&bytes[28..28 + payload_length]);
            packet.magic = *b"PFP1";
            packet
        }
        magic => panic!("unknown packet magic {magic:?}"),
    }
}

#[test]
fn unchanged_delta_keeps_full_cache_and_does_not_suppress_transient_events() {
    let handle = pocket_create(320.0, 480.0);
    let source = CString::new(r#"
      let mounted = false;
      globalThis.frame = () => {
        if (mounted) return;
        mounted = true;
        const node = ui.createNode(0);
        ui.setProp(node, 1, 40); ui.setProp(node, 2, 24);
        ui.setProp(node, 64, 0xff336699); ui.insertBefore(1, node, 0);
      };
      globalThis.__pocketEvent = () => pocket._emit(JSON.stringify({name:'probe.transient',payload:{value:42}}));
    "#).unwrap();
    unsafe {
        assert_eq!(pocket_eval(handle, source.as_ptr()), 0);
        let mut length = 0;
        assert!(!pocket_frame_delta_binary(handle, 17.0, &mut length).is_null());
        assert!(pocket_frame_delta_binary(handle, 17.0, &mut length).is_null());
        assert_eq!(length, 0);
        let message =
            CString::new(r#"{"type":"event","name":"probe.input","payload":{}}"#).unwrap();
        assert_eq!(pocket_send(handle, message.as_ptr()), 0);
        let output = pocket_frame_delta_binary(handle, 0.0, &mut length);
        assert!(!output.is_null());
        let bytes = std::slice::from_raw_parts(output, length as usize);
        assert!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()) > 0);
        assert!(bytes
            .windows(b"probe.transient".len())
            .any(|w| w == b"probe.transient"));
        assert!(pocket_frame_delta_binary(handle, 17.0, &mut length).is_null());
        let complete: serde_json::Value =
            serde_json::from_slice(CStr::from_ptr(pocket_frame(handle, 17.0)).to_bytes()).unwrap();
        assert!(!complete["ops"].as_array().unwrap().is_empty());
        assert!(complete["events"].as_array().unwrap().is_empty());
        pocket_destroy(handle);
    }
}

#[test]
fn v2_splices_one_changed_rect_and_validates_base_and_generation() {
    let handle = pocket_create(640.0, 480.0);
    let source = CString::new(
        r#"
      const rects = [];
      let mounted = false;
      globalThis.frame = () => {
        if (mounted) return;
        mounted = true;
        for (let i = 0; i < 100; i++) {
          const node = ui.createNode(0);
          ui.setProp(node, 1, 16);
          ui.setProp(node, 2, 16);
          ui.setProp(node, 24, 1);
          ui.setProp(node, 28, 4 + (i % 10) * 24);
          ui.setProp(node, 25, 4 + Math.floor(i / 10) * 24);
          ui.setProp(node, 64, 0xff204060 + i);
          ui.insertBefore(1, node, 0);
          rects.push(node);
        }
      };
      globalThis.__pocketEvent = (raw) => {
        const packet = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (packet.name === 'bump') {
          ui.setProp(rects[50], 64, 0xffcc6633);
          pocket._emit(JSON.stringify({name:'v2.bump',payload:{ok:true}}));
        }
      };
    "#,
    )
    .unwrap();
    unsafe {
        assert_eq!(pocket_eval(handle, source.as_ptr()), 0);
        let mut length = 0u64;
        let first_ptr = pocket_frame_delta_binary_v2(handle, 16.0, 0, &mut length);
        let first = copy_frame(first_ptr, length);
        assert_eq!(&first[..4], b"PFB1");
        let first_sequence = read_u64(&first, 8);
        assert!(first_sequence > 0);
        assert_eq!(read_u32(&first, 24), 100);

        // Zero-byte idle probes keep the caller's published sequence. The
        // native diagnostic counter may advance internally, but the next
        // changed frame still accepts this exact base.
        length = 123;
        assert!(pocket_frame_delta_binary_v2(handle, 0.0, first_sequence, &mut length).is_null());
        assert_eq!(length, 0);

        let bump = CString::new(r#"{"type":"event","name":"bump","payload":{}}"#).unwrap();
        assert_eq!(pocket_send(handle, bump.as_ptr()), 0);
        let patch_ptr = pocket_frame_delta_binary_v2(handle, 0.0, first_sequence, &mut length);
        let patch = copy_frame(patch_ptr, length);
        assert_eq!(&patch[..4], b"PFP1");
        assert_eq!(read_u64(&patch, 4), first_sequence);
        assert_eq!(read_u32(&patch, 20), 100);
        assert!(read_u32(&patch, 16) <= 99);
        let embedded_length = read_u32(&patch, 24) as usize;
        assert_eq!(patch.len(), 28 + embedded_length);
        let embedded = &patch[28..];
        assert_eq!(&embedded[..4], b"PFB1");
        assert_eq!(read_u32(embedded, 24), 1);
        assert!(patch.windows(b"v2.bump".len()).any(|w| w == b"v2.bump"));
        assert!(
            patch.len() < first.len(),
            "patch must beat the 100-rect full frame"
        );

        // A stale base never splices against whatever happens to be retained;
        // it receives a full PFB1 frame that can establish a new baseline.
        let stale_ptr = pocket_frame_delta_binary_v2(handle, 0.0, 0, &mut length);
        let stale = copy_frame(stale_ptr, length);
        assert_eq!(&stale[..4], b"PFB1");
        assert_eq!(read_u32(&stale, 24), 100);

        // Re-evaluating a guest invalidates the retained DrawOps generation.
        // Even when the caller repeats the latest sequence, the next result is
        // a complete frame rather than a delta against the old realm.
        let reload = CString::new("globalThis.frame = () => {}; ").unwrap();
        assert_eq!(pocket_eval(handle, reload.as_ptr()), 0);
        let reloaded_ptr =
            pocket_frame_delta_binary_v2(handle, 0.0, read_u64(&stale, 8), &mut length);
        let reloaded = copy_frame(reloaded_ptr, length);
        assert_eq!(&reloaded[..4], b"PFB1");
        pocket_destroy(handle);
    }
}

#[test]
fn v2_resync_replays_dropped_texture_replacement_and_release() {
    const SOURCE: &str = r#"
      const node = ui.createNode(2);
      let texture = ui.uploadTexture(new Uint8Array([255, 0, 0, 255]), 1, 1, 3);
      ui.setProp(node, 1, 32); ui.setProp(node, 2, 32);
      ui.setImage(node, texture); ui.insertBefore(1, node, 0);
      globalThis.frame = () => {};
      globalThis.__pocketEvent = (raw) => {
        const packet = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (packet.name === 'replace') {
          texture = ui.uploadTexture(new Uint8Array([0, 255, 0, 255]), 1, 1, 3);
          ui.setImage(node, texture);
        }
        if (packet.name === 'release') ui.setImage(node, -1);
      };
    "#;

    // An ordinary in-order replacement still carries only the changed
    // resource, and the following idle probe remains the zero-byte marker.
    let mut handle = pocket_create(320.0, 240.0);
    unsafe {
        let source = CString::new(SOURCE).unwrap();
        assert_eq!(pocket_eval(handle, source.as_ptr()), 0);
        let mut length = 0u64;
        // Legacy full-frame calls still publish only newly observed resources;
        // they do not become an implicit v2 acknowledgement or force every
        // texture into each editor/full probe.
        let legacy_first = parse_packet(&copy_frame(
            pocket_frame_binary(handle, 0.0, &mut length),
            length,
        ));
        assert_eq!(legacy_first.resources.len(), 1);
        let legacy_cached = parse_packet(&copy_frame(
            pocket_frame_binary(handle, 0.0, &mut length),
            length,
        ));
        assert!(legacy_cached.resources.is_empty());
        let first = parse_packet(&copy_frame(
            pocket_frame_delta_binary_v2(handle, 0.0, 0, &mut length),
            length,
        ));
        assert_eq!(first.magic, *b"PFB1");
        assert_eq!(first.resources.len(), 1);
        assert_eq!(first.resources[0].1, vec![255, 0, 0, 255]);
        let base = first.sequence;

        let replace = CString::new(r#"{"type":"event","name":"replace","payload":{}}"#)
            .unwrap();
        assert_eq!(pocket_send(handle, replace.as_ptr()), 0);
        let update = parse_packet(&copy_frame(
            pocket_frame_delta_binary_v2(handle, 0.0, base, &mut length),
            length,
        ));
        assert!(update.magic == *b"PFP1" || update.magic == *b"PFB1");
        assert_eq!(update.resources.len(), 1);
        assert_eq!(update.resources[0].1, vec![0, 255, 0, 255]);
        let updated_base = update.sequence;
        length = 99;
        assert!(pocket_frame_delta_binary_v2(handle, 0.0, updated_base, &mut length).is_null());
        assert_eq!(length, 0);
        pocket_destroy(handle);
    }

    // Drop the replacement packet while the caller still owns the first
    // frame. A stale-base full PFB1 must contain the current green pixels and
    // the release record for the red asset's baseline, even though native has
    // already consumed the replacement delta.
    handle = pocket_create(320.0, 240.0);
    unsafe {
        let source = CString::new(SOURCE).unwrap();
        assert_eq!(pocket_eval(handle, source.as_ptr()), 0);
        let mut length = 0u64;
        let first = parse_packet(&copy_frame(
            pocket_frame_delta_binary_v2(handle, 0.0, 0, &mut length),
            length,
        ));
        let base = first.sequence;
        let old_asset = first.resources[0].0.clone();

        let replace = CString::new(r#"{"type":"event","name":"replace","payload":{}}"#)
            .unwrap();
        assert_eq!(pocket_send(handle, replace.as_ptr()), 0);
        let _dropped_replacement = copy_frame(
            pocket_frame_delta_binary_v2(handle, 0.0, base, &mut length),
            length,
        );

        let resync_replacement = parse_packet(&copy_frame(
            pocket_frame_delta_binary_v2(handle, 0.0, base, &mut length),
            length,
        ));
        assert_eq!(resync_replacement.magic, *b"PFB1");
        assert_eq!(resync_replacement.resources.len(), 1);
        assert_eq!(resync_replacement.resources[0].1, vec![0, 255, 0, 255]);
        assert!(
            resync_replacement
                .released
                .iter()
                .any(|asset| asset == &old_asset),
            "replacement resync must release the caller baseline asset"
        );

        let release = CString::new(r#"{"type":"event","name":"release","payload":{}}"#)
            .unwrap();
        assert_eq!(pocket_send(handle, release.as_ptr()), 0);
        let resync_release = parse_packet(&copy_frame(
            pocket_frame_delta_binary_v2(handle, 0.0, base, &mut length),
            length,
        ));
        assert_eq!(resync_release.magic, *b"PFB1");
        assert!(
            resync_release.resources.is_empty(),
            "released scene must have no resources"
        );
        assert!(
            resync_release
                .released
                .iter()
                .any(|asset| asset == &old_asset),
            "stale full resync must release the caller baseline asset"
        );
        pocket_destroy(handle);
    }

}

#[test]
fn v2_resize_preserves_resource_ack_for_dropped_release() {
    const SOURCE: &str = r#"
      const node = ui.createNode(2);
      const texture = ui.uploadTexture(new Uint8Array([255, 0, 0, 255]), 1, 1, 3);
      ui.setProp(node, 1, 32); ui.setProp(node, 2, 32);
      ui.setImage(node, texture); ui.insertBefore(1, node, 0);
      globalThis.frame = () => {};
      globalThis.__pocketEvent = (raw) => {
        const packet = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (packet.name === 'release') ui.setImage(node, -1);
      };
    "#;

    let handle = pocket_create(320.0, 240.0);
    unsafe {
        let source = CString::new(SOURCE).unwrap();
        assert_eq!(pocket_eval(handle, source.as_ptr()), 0);
        let mut length = 0u64;
        let first = parse_packet(&copy_frame(
            pocket_frame_delta_binary_v2(handle, 0.0, 0, &mut length),
            length,
        ));
        assert_eq!(first.magic, *b"PFB1");
        assert_eq!(first.resources.len(), 1);
        let base = first.sequence;
        let asset = first.resources[0].0.clone();

        // Resize invalidates native DrawOps, but the caller still owns the
        // decoded frame at `base`. The next v2 call must therefore acknowledge
        // that resource baseline while returning a full frame.
        assert_eq!(pocket_resize_viewport(handle, 360.0, 240.0), 0);
        let release = CString::new(r#"{"type":"event","name":"release","payload":{}}"#)
            .unwrap();
        assert_eq!(pocket_send(handle, release.as_ptr()), 0);

        // Simulate a dropped packet: native has consumed the release, but the
        // caller still requests from the last frame it actually retained.
        let dropped = parse_packet(&copy_frame(
            pocket_frame_delta_binary_v2(handle, 0.0, base, &mut length),
            length,
        ));
        assert_eq!(dropped.magic, *b"PFB1");
        assert!(dropped.resources.is_empty());
        assert!(dropped.released.iter().any(|entry| entry == &asset));

        // The release tombstone must remain recoverable from the confirmed
        // baseline after the first full packet was dropped.
        let recovered = parse_packet(&copy_frame(
            pocket_frame_delta_binary_v2(handle, 0.0, base, &mut length),
            length,
        ));
        assert_eq!(recovered.magic, *b"PFB1");
        assert!(recovered.resources.is_empty());
        assert!(
            recovered.released.iter().any(|entry| entry == &asset),
            "resize resync must replay the caller-baseline release"
        );
        pocket_destroy(handle);
    }
}
