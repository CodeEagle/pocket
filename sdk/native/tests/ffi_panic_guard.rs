use pocket_flutter::{
    pocket_create, pocket_destroy, pocket_duplex_channel_acquire, pocket_duplex_endpoint_acquire,
    pocket_duplex_step, pocket_eval, pocket_frame, pocket_frame_binary, pocket_frame_delta,
    pocket_frame_delta_binary, pocket_frame_delta_binary_v2, pocket_last_error,
    pocket_last_frame_stage_timings_us, pocket_next_wake_delay_ms, pocket_offload_has_replies,
    pocket_offload_take, pocket_offload_take_binary, pocket_send, pocket_send_binary,
    pocket_test_trigger_panic,
};
use std::ffi::{CStr, CString};

unsafe fn last_error_string(handle: *mut pocket_flutter::HostState) -> String {
    let ptr = pocket_last_error(handle);
    assert!(!ptr.is_null());
    CStr::from_ptr(ptr).to_string_lossy().into_owned()
}

#[test]
fn ffi_panic_does_not_abort_poisons_instance_and_leaves_sibling_unaffected() {
    let poisoned = pocket_create(320.0, 480.0);
    let sibling = pocket_create(320.0, 480.0);
    assert!(!poisoned.is_null());
    assert!(!sibling.is_null());

    unsafe {
        let init_js = CString::new("globalThis.frame = () => {};").unwrap();
        assert_eq!(pocket_eval(poisoned, init_js.as_ptr()), 0);
        assert_eq!(pocket_eval(sibling, init_js.as_ptr()), 0);

        // Trigger a Rust panic inside the FFI guard on `poisoned`.
        assert_eq!(pocket_test_trigger_panic(poisoned), -1);

        let err = last_error_string(poisoned);
        assert!(
            err.contains("native panic in pocket_test_trigger_panic"),
            "expected panic message in last_error, got: {err}"
        );
        assert!(
            err.contains("simulated FFI panic for catch_unwind verification"),
            "expected panic payload in last_error, got: {err}"
        );

        // Subsequent calls on the poisoned instance must return error sentinels
        // cleanly and preserve the panic error message.
        assert_eq!(pocket_eval(poisoned, init_js.as_ptr()), -1);
        assert!(pocket_frame(poisoned, 16.0).is_null());
        assert!(pocket_frame_delta(poisoned, 16.0).is_null());

        let mut out_len = 999u64;
        assert!(pocket_frame_binary(poisoned, 16.0, &mut out_len).is_null());
        assert_eq!(out_len, 0);

        out_len = 999u64;
        assert!(pocket_frame_delta_binary(poisoned, 16.0, &mut out_len).is_null());
        assert_eq!(out_len, 0);

        out_len = 999u64;
        assert!(pocket_frame_delta_binary_v2(poisoned, 16.0, 0, &mut out_len).is_null());
        assert_eq!(out_len, 0);

        let msg = CString::new(r#"{"type":"event","name":"ping","payload":{}}"#).unwrap();
        assert_eq!(pocket_send(poisoned, msg.as_ptr()), -1);
        assert_eq!(pocket_send_binary(poisoned, [1u8, 2, 3].as_ptr(), 3), -1);
        assert_eq!(pocket_duplex_step(poisoned), -1);
        assert!(pocket_duplex_channel_acquire(poisoned).is_null());
        assert!(pocket_duplex_endpoint_acquire(poisoned).is_null());
        assert_eq!(pocket_next_wake_delay_ms(poisoned), -1.0);
        assert!(pocket_offload_take(poisoned, 0).is_null());

        out_len = 999u64;
        assert!(pocket_offload_take_binary(poisoned, 0, &mut out_len).is_null());
        assert_eq!(out_len, 0);
        assert_eq!(pocket_offload_has_replies(poisoned), 0);

        let mut timings = [0u64; 8];
        assert_eq!(
            pocket_last_frame_stage_timings_us(poisoned, timings.as_mut_ptr()),
            0
        );

        // `pocket_last_error` still returns the original panic message.
        let err_after = last_error_string(poisoned);
        assert_eq!(err_after, err);

        // Meanwhile, the sibling HostState instance remains completely healthy.
        let sibling_js = CString::new(
            r#"
            pocket._emit(JSON.stringify({name:'sibling.ok',payload:{alive:true}}));
            globalThis.frame = () => {};
            "#,
        )
        .unwrap();
        assert_eq!(pocket_eval(sibling, sibling_js.as_ptr()), 0);
        let sibling_frame_ptr = pocket_frame(sibling, 16.0);
        assert!(!sibling_frame_ptr.is_null());
        let sibling_frame: serde_json::Value =
            serde_json::from_slice(CStr::from_ptr(sibling_frame_ptr).to_bytes()).unwrap();
        assert_eq!(sibling_frame["events"][0]["name"], "sibling.ok");
        assert!(last_error_string(sibling).is_empty());

        // Destroying both poisoned and healthy instances succeeds without aborting.
        pocket_destroy(poisoned);
        pocket_destroy(sibling);
    }
}
