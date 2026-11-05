use pocket_flutter::{pocket_create, pocket_destroy, pocket_eval, pocket_frame, pocket_last_error};
use std::ffi::{CStr, CString};

unsafe fn evaluate(handle: *mut pocket_flutter::HostState, source: &str) {
    let source = CString::new(source).unwrap();
    assert_eq!(
        pocket_eval(handle, source.as_ptr()),
        0,
        "{}",
        CStr::from_ptr(pocket_last_error(handle)).to_string_lossy()
    );
}

#[test]
fn actual_quickjs_emit_rejects_large_nested_and_malformed_batches_before_queueing() {
    let handle = pocket_create(320.0, 480.0);
    unsafe {
        evaluate(
            handle,
            r#"
          const packet = events => JSON.stringify({type:'event',name:'stream.batch',payload:{events}});
          const item = {method:'stream.data',params:{streamId:'guest-1',data:1}};
          const expect = (value, message) => { if (!value) throw new Error(message); };
          expect(!pocket._emit(packet(Array(257).fill(item))), 'batch count');
          expect(!pocket._emit(packet([{method:'ignored',name:'stream.batch',params:{events:[]}}])), 'nested alias');
          expect(!pocket._emit(JSON.stringify({name:'ignored',method:'stream.batch',params:{events:Array(257).fill(item)}})), 'outer alias');
          expect(!pocket._emit(JSON.stringify({name:'stream.batch',params:{events:Array(257).fill(item)},payload:{events:[]}})), 'params precedence');
          expect(!pocket._emit(JSON.stringify({name:'large',payload:{value:'x'.repeat(256*1024)}})), 'message bytes');
          expect(!pocket._emit('not json'), 'invalid json');
          expect(!pocket._emit('[]'), 'non object');
          expect(pocket._emit(packet(Array(256).fill(item))), 'at count boundary');
          globalThis.frame = () => {};
        "#,
        );
        let frame = serde_json::from_slice::<serde_json::Value>(
            CStr::from_ptr(pocket_frame(handle, 17.0)).to_bytes(),
        )
        .unwrap();
        assert_eq!(frame["events"].as_array().unwrap().len(), 1);
        assert_eq!(
            frame["events"][0]["payload"]["events"]
                .as_array()
                .unwrap()
                .len(),
            256
        );
        pocket_destroy(handle);
    }
}

#[test]
fn actual_quickjs_emit_bounds_pending_count_and_recovers_after_frame_drain() {
    let handle = pocket_create(320.0, 480.0);
    unsafe {
        evaluate(
            handle,
            r#"
          globalThis.accepted = 0;
          for (let i=0;i<2000;i++) if (pocket._emit('{"name":"probe"}')) accepted++;
          if (accepted !== 1024) throw new Error('pending count '+accepted);
          globalThis.frame = () => {};
        "#,
        );
        let frame: serde_json::Value =
            serde_json::from_slice(CStr::from_ptr(pocket_frame(handle, 17.0)).to_bytes()).unwrap();
        assert_eq!(frame["events"].as_array().unwrap().len(), 1024);
        evaluate(
            handle,
            "if (!pocket._emit('{\"name\":\"after-drain\"}')) throw Error('not recovered');",
        );
        let frame: serde_json::Value =
            serde_json::from_slice(CStr::from_ptr(pocket_frame(handle, 17.0)).to_bytes()).unwrap();
        assert_eq!(frame["events"][0]["name"], "after-drain");
        pocket_destroy(handle);
    }
}

#[test]
fn actual_quickjs_emit_bounds_aggregate_bytes_and_preserves_accepted_packets() {
    let handle = pocket_create(320.0, 480.0);
    unsafe {
        evaluate(
            handle,
            r#"
          const line = JSON.stringify({name:'bulk',payload:{text:'x'.repeat(200*1024)}});
          let accepted = 0;
          for (let i=0;i<20;i++) if (pocket._emit(line)) accepted++;
          if (accepted !== 5) throw Error('aggregate bytes '+accepted);
          globalThis.frame = () => {};
        "#,
        );
        let frame: serde_json::Value =
            serde_json::from_slice(CStr::from_ptr(pocket_frame(handle, 17.0)).to_bytes()).unwrap();
        assert_eq!(frame["events"].as_array().unwrap().len(), 5);
        evaluate(
            handle,
            "if (!pocket._emit('{\"name\":\"after-byte-drain\"}')) throw Error('not recovered');",
        );
        assert!(!pocket_frame(handle, 17.0).is_null());
        assert!(CStr::from_ptr(pocket_last_error(handle))
            .to_bytes()
            .is_empty());
        pocket_destroy(handle);
    }
}
