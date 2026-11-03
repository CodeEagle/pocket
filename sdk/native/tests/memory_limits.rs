use std::ffi::{CStr, CString};

use pocket_flutter::{
    bytecode, pocket_create_with_memory_limits, pocket_destroy, pocket_eval, pocket_frame,
    pocket_last_error, pocket_load, pocket_load_bytecode,
};
use pocket_spec::BINDING_GENERATION;
use rquickjs::{Context, Runtime};

const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;
const PAK_MAGIC: u32 = 0x4b50_4344;

fn empty_pak() -> Vec<u8> {
    let mut pak = vec![0u8; 32];
    pak[0..4].copy_from_slice(&PAK_MAGIC.to_le_bytes());
    pak[4..6].copy_from_slice(&1u16.to_le_bytes());
    pak[12..16].copy_from_slice(&32u32.to_le_bytes());
    pak[16..20].copy_from_slice(&32u32.to_le_bytes());
    pak[20..24].copy_from_slice(&32u32.to_le_bytes());
    pak[24..28].copy_from_slice(&32u32.to_le_bytes());
    pak
}

fn compile_script_bytecode(source: &[u8]) -> Vec<u8> {
    use rquickjs::qjs;

    let runtime = Runtime::new().unwrap();
    let context = Context::full(&runtime).unwrap();
    let payload = context.with(|ctx| unsafe {
        let input = CString::new(source).unwrap();
        let name = CString::new("memory-limits-fixture.js").unwrap();
        let value = qjs::JS_Eval(
            ctx.as_raw().as_ptr(),
            input.as_ptr(),
            source.len() as _,
            name.as_ptr(),
            (qjs::JS_EVAL_TYPE_GLOBAL | qjs::JS_EVAL_FLAG_STRICT | qjs::JS_EVAL_FLAG_COMPILE_ONLY)
                as i32,
        );
        assert_ne!(qjs::JS_VALUE_GET_NORM_TAG(value), qjs::JS_TAG_EXCEPTION);
        let mut length = 0;
        let buffer = qjs::JS_WriteObject(
            ctx.as_raw().as_ptr(),
            &mut length,
            value,
            (qjs::JS_WRITE_OBJ_BYTECODE
                | qjs::JS_WRITE_OBJ_STRIP_SOURCE
                | qjs::JS_WRITE_OBJ_STRIP_DEBUG) as i32,
        );
        assert!(!buffer.is_null());
        let bytes = std::slice::from_raw_parts(buffer, length as usize).to_vec();
        qjs::js_free(ctx.as_raw().as_ptr(), buffer.cast());
        qjs::JS_FreeValue(ctx.as_raw().as_ptr(), value);
        bytes
    });
    bytecode::encode(
        bytecode::BytecodeKind::Script,
        bytecode::DEFAULT_FLAGS,
        BINDING_GENERATION,
        60,
        source,
        &payload,
    )
    .unwrap()
}

unsafe fn last_error(handle: *mut pocket_flutter::HostState) -> String {
    let pointer = pocket_last_error(handle);
    if pointer.is_null() {
        return "<null>".to_owned();
    }
    CStr::from_ptr(pointer).to_string_lossy().into_owned()
}

#[test]
fn invalid_limits_return_diagnosable_destroyable_handles() {
    let invalid_heap = pocket_create_with_memory_limits(80.0, 80.0, 1, 60, 1, 0);
    assert!(!invalid_heap.is_null());
    let error = unsafe { last_error(invalid_heap) };
    assert!(error.contains("heapLimitBytes"), "{error}");
    unsafe { pocket_destroy(invalid_heap) };

    let invalid_pak = pocket_create_with_memory_limits(80.0, 80.0, 1, 60, 64 * MIB, 512 * MIB + 1);
    assert!(!invalid_pak.is_null());
    let error = unsafe { last_error(invalid_pak) };
    assert!(error.contains("maxPakBytes"), "{error}");
    unsafe { pocket_destroy(invalid_pak) };

    // u64 is intentionally wider than the native usize/configuration range;
    // it must remain a structured error rather than an accidental wrap.
    let overflow = pocket_create_with_memory_limits(80.0, 80.0, 1, 60, u64::MAX, 0);
    assert!(!overflow.is_null());
    let error = unsafe { last_error(overflow) };
    assert!(error.contains("heapLimitBytes"), "{error}");
    unsafe { pocket_destroy(overflow) };
}

#[test]
fn package_admission_is_per_runtime_and_rejected_before_reload_reset() {
    let source = CString::new("globalThis.frame = function() {}; ").unwrap();
    let pak = empty_pak();
    let oversized = vec![0u8; pak.len() + 1];

    let rejected = pocket_create_with_memory_limits(80.0, 80.0, 1, 60, 8 * MIB, 16);
    assert_eq!(
        unsafe { pocket_load(rejected, source.as_ptr(), pak.as_ptr(), pak.len()) },
        -1
    );
    let error = unsafe { last_error(rejected) };
    assert!(error.contains("maxPakBytes"), "{error}");
    unsafe { pocket_destroy(rejected) };

    // A configured heap is the total budget, not the legacy heap plus PAK
    // allowance. This admission check also happens before PAK parsing.
    let heap_rejected = pocket_create_with_memory_limits(80.0, 80.0, 1, 60, 4 * MIB, 0);
    let over_heap = vec![0u8; (4 * MIB + 1) as usize];
    assert_eq!(
        unsafe {
            pocket_load(
                heap_rejected,
                source.as_ptr(),
                over_heap.as_ptr(),
                over_heap.len(),
            )
        },
        -1
    );
    let error = unsafe { last_error(heap_rejected) };
    assert!(error.contains("heapLimitBytes"), "{error}");
    unsafe { pocket_destroy(heap_rejected) };

    let loaded = pocket_create_with_memory_limits(80.0, 80.0, 1, 60, 8 * MIB, pak.len() as u64);
    assert_eq!(
        unsafe { pocket_load(loaded, source.as_ptr(), pak.as_ptr(), pak.len()) },
        0,
        "{}",
        unsafe { last_error(loaded) }
    );
    assert!(!unsafe { pocket_frame(loaded, 16.0) }.is_null());

    // The admission check is before reset_host_for_load: this failure must not
    // destroy the already loaded realm or its frame contract.
    assert_eq!(
        unsafe { pocket_load(loaded, source.as_ptr(), oversized.as_ptr(), oversized.len(),) },
        -1
    );
    let error = unsafe { last_error(loaded) };
    assert!(error.contains("maxPakBytes"), "{error}");
    assert!(!unsafe { pocket_frame(loaded, 16.0) }.is_null());
    unsafe { pocket_destroy(loaded) };
}

#[test]
fn real_qjbc_load_obeys_package_cap_before_reload_reset() {
    let source = b"globalThis.frame = function() {};";
    let bytecode = compile_script_bytecode(source);
    let pak = empty_pak();
    let handle = pocket_create_with_memory_limits(80.0, 80.0, 1, 60, 32 * MIB, pak.len() as u64);
    assert!(unsafe { last_error(handle) }.is_empty());

    assert_eq!(
        unsafe {
            pocket_load_bytecode(
                handle,
                bytecode.as_ptr(),
                bytecode.len(),
                pak.as_ptr(),
                pak.len(),
            )
        },
        0,
        "real QJBC load failed: {}",
        unsafe { last_error(handle) }
    );
    assert!(!unsafe { pocket_frame(handle, 16.0) }.is_null());

    let oversized_pak = vec![0u8; pak.len() + 1];
    assert_eq!(
        unsafe {
            pocket_load_bytecode(
                handle,
                bytecode.as_ptr(),
                bytecode.len(),
                oversized_pak.as_ptr(),
                oversized_pak.len(),
            )
        },
        -1
    );
    let error = unsafe { last_error(handle) };
    assert!(error.contains("maxPakBytes"), "{error}");
    assert!(!unsafe { pocket_frame(handle, 16.0) }.is_null());
    unsafe { pocket_destroy(handle) };
}

#[test]
fn quickjs_heap_oom_does_not_change_an_independent_runtime() {
    let large_allocation = CString::new(
        "globalThis.heapProbe = new ArrayBuffer(8 * 1024 * 1024); globalThis.frame = function() {};",
    )
    .unwrap();
    let limited = pocket_create_with_memory_limits(80.0, 80.0, 1, 60, 4 * MIB, 0);
    let independent_32m = pocket_create_with_memory_limits(80.0, 80.0, 1, 60, 32 * MIB, 0);
    let independent_64m = pocket_create_with_memory_limits(80.0, 80.0, 1, 60, 64 * MIB, 0);
    assert!(unsafe { last_error(limited) }.is_empty());
    assert!(unsafe { last_error(independent_32m) }.is_empty());
    assert!(unsafe { last_error(independent_64m) }.is_empty());

    // The same single native allocation succeeds under both ample budgets.
    assert_eq!(
        unsafe { pocket_eval(independent_32m, large_allocation.as_ptr()) },
        0,
        "32 MiB runtime rejected ArrayBuffer: {}",
        unsafe { last_error(independent_32m) }
    );
    assert_eq!(
        unsafe { pocket_eval(independent_64m, large_allocation.as_ptr()) },
        0,
        "64 MiB runtime rejected ArrayBuffer: {}",
        unsafe { last_error(independent_64m) }
    );
    assert!(!unsafe { pocket_frame(independent_32m, 16.0) }.is_null());

    assert_eq!(
        unsafe { pocket_eval(limited, large_allocation.as_ptr()) },
        -1
    );
    let error = unsafe { last_error(limited) };
    assert!(
        error.to_ascii_lowercase().contains("out of memory")
            || error.to_ascii_lowercase().contains("allocation"),
        "QuickJS OOM should be diagnosable, got: {error}"
    );

    // The independent VM was already loaded before the failing allocation and
    // remains usable after it.
    assert!(!unsafe { pocket_frame(independent_32m, 16.0) }.is_null());

    unsafe {
        pocket_destroy(limited);
        pocket_destroy(independent_32m);
        pocket_destroy(independent_64m);
    }
}
