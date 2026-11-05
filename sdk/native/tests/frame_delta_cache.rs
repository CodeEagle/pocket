use pocket_flutter::{
    pocket_create, pocket_destroy, pocket_eval, pocket_frame, pocket_frame_delta_binary,
    pocket_send,
};
use std::ffi::{CStr, CString};

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
