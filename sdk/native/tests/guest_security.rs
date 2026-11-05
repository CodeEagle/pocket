use pocket_flutter::{
    pocket_configure_guest_security, pocket_create, pocket_destroy, pocket_enable_auxiliary,
    pocket_eval, pocket_frame, pocket_last_error,
};
use std::ffi::{CStr, CString};

unsafe fn last_error(handle: *mut pocket_flutter::HostState) -> String {
    CStr::from_ptr(pocket_last_error(handle))
        .to_string_lossy()
        .into_owned()
}

unsafe fn configure(handle: *mut pocket_flutter::HostState, json: &str) -> i32 {
    let json = CString::new(json).unwrap();
    pocket_configure_guest_security(handle, json.as_ptr())
}

#[test]
fn default_policy_keeps_eval_function_and_prototype_behavior() {
    let handle = pocket_create(320.0, 240.0);
    let source = CString::new(
        r#"
          if (eval('1 + 1') !== 2) throw new Error('eval changed');
          if (Function('return 2')() !== 2) throw new Error('Function changed');
          Object.prototype.__pocketDefaultProbe = 7;
          if (({}).__pocketDefaultProbe !== 7) throw new Error('prototype changed');
          globalThis.frame = () => {};
        "#,
    )
    .unwrap();
    unsafe {
        assert_eq!(pocket_eval(handle, source.as_ptr()), 0, "{}", last_error(handle));
        let frame = pocket_frame(handle, 0.0);
        assert!(!frame.is_null(), "{}", last_error(handle));
        pocket_destroy(handle);
    }
}

#[test]
fn policy_rejects_unknown_second_and_late_configuration() {
    let handle = pocket_create(320.0, 240.0);
    unsafe {
        assert_eq!(configure(handle, r#"{"maxDrawOps":1,"extra":true}"#), -1);
        assert!(last_error(handle).contains("unknown field"));
        assert_eq!(configure(handle, r#"{"maxNodes":null}"#), -1);
        assert!(last_error(handle).contains("positive integer"));
        assert_eq!(configure(handle, r#"{"maxDrawOps":1}"#), 0, "{}", last_error(handle));
        assert_eq!(configure(handle, r#"{}"#), -1);
        assert!(last_error(handle).contains("already configured"));
        let source = CString::new("globalThis.frame = () => {};").unwrap();
        assert_eq!(pocket_eval(handle, source.as_ptr()), 0, "{}", last_error(handle));
        assert_eq!(configure(handle, r#"{"hardenBuiltins":true}"#), -1);
        assert!(last_error(handle).contains("before guest load/eval"));
        pocket_destroy(handle);
    }
}

#[test]
fn hardening_blocks_all_string_constructor_paths_and_preserves_error_subclasses() {
    let handle = pocket_create(320.0, 240.0);
    unsafe {
        assert_eq!(
            configure(handle, r#"{"hardenBuiltins":true}"#),
            0,
            "{}",
            last_error(handle)
        );
    }
    let source = CString::new(
        r#"
          const blocked = (fn) => {
            try { fn(); return false; } catch (_) { return true; }
          };
          const checks = [
            blocked(() => eval('1 + 1')),
            blocked(() => Function('return 1')),
            blocked(() => (function () {}).constructor('return 1')),
            blocked(() => Function.prototype.constructor('return 1')),
            blocked(() => Object.getPrototypeOf(async function () {}).constructor('return 1')),
            blocked(() => Object.getPrototypeOf(function* () {}).constructor('return 1')),
            blocked(() => Object.getPrototypeOf(async function* () {}).constructor('return 1')),
          ];
          if (!checks.every(Boolean)) throw new Error('constructor hardening incomplete');
          try { Object.prototype.__pocketPollution = 1; } catch (_) {}
          if (Object.prototype.hasOwnProperty('__pocketPollution')) throw new Error('prototype pollution');
          class CustomError extends Error {
            constructor() { super('ok'); this.name = 'CustomError'; }
            toString() { return 'custom-error'; }
          }
          const error = new CustomError();
          if (error.toString() !== 'custom-error' || error.name !== 'CustomError') {
            throw new Error('Error subclass compatibility');
          }
          pocket._emit(JSON.stringify({name:'security.hardened',payload:{checks:checks.length}}));
          globalThis.frame = () => {};
        "#,
    )
    .unwrap();
    unsafe {
        assert_eq!(pocket_eval(handle, source.as_ptr()), 0, "{}", last_error(handle));
        let frame = pocket_frame(handle, 0.0);
        assert!(!frame.is_null(), "{}", last_error(handle));
        let json = CStr::from_ptr(frame).to_string_lossy();
        assert!(json.contains("security.hardened"), "{json}");
        pocket_destroy(handle);
    }
}

#[test]
fn node_quota_is_sticky_when_caught_and_destroy_releases_capacity() {
    let exceeded = pocket_create(320.0, 240.0);
    unsafe {
        assert_eq!(configure(exceeded, r#"{"maxNodes":1}"#), 0);
    }
    let source = CString::new(
        r#"
          const first = ui.createNode(0);
          try { ui.createNode(0); } catch (_) {}
          globalThis.frame = () => {};
        "#,
    )
    .unwrap();
    unsafe {
        assert_eq!(pocket_eval(exceeded, source.as_ptr()), -1);
        assert!(last_error(exceeded).contains("node quota exceeded"));
        let frame = pocket_frame(exceeded, 0.0);
        assert!(!frame.is_null());
        assert!(last_error(exceeded).contains("node quota exceeded"));
        pocket_destroy(exceeded);
    }

    let reusable = pocket_create(320.0, 240.0);
    unsafe {
        assert_eq!(configure(reusable, r#"{"maxNodes":1}"#), 0);
    }
    let source = CString::new(
        r#"
          const first = ui.createNode(0);
          ui.destroyNode(first);
          const second = ui.createNode(0);
          if (!second) throw new Error('destroy did not release quota');
          // The non-configurable wrapper must remain the callable binding.
          try { ui.createNode = () => 0; } catch (_) {}
          globalThis.frame = () => {};
        "#,
    )
    .unwrap();
    unsafe {
        assert_eq!(pocket_eval(reusable, source.as_ptr()), 0, "{}", last_error(reusable));
        pocket_destroy(reusable);
    }
}

#[test]
fn draw_quota_rejects_primary_and_auxiliary_output_atomically() {
    let handle = pocket_create(320.0, 240.0);
    unsafe {
        assert_eq!(configure(handle, r#"{"maxDrawOps":1}"#), 0);
        assert_eq!(pocket_enable_auxiliary(handle, 80.0, 80.0), 0, "{}", last_error(handle));
    }
    let source = CString::new(
        r#"
          const primary = ui.createNode(0);
          ui.setProp(primary, 1, 32); ui.setProp(primary, 2, 32);
          ui.setProp(primary, 64, 0xff336699); ui.insertBefore(1, primary, 0);
          const auxiliary = ui.createNode(0);
          ui.setProp(auxiliary, 1, 32); ui.setProp(auxiliary, 2, 32);
          ui.setProp(auxiliary, 64, 0xff993366);
          ui.insertBefore(ui.__auxiliarySurface.root, auxiliary, 0);
          globalThis.frame = () => {};
        "#,
    )
    .unwrap();
    unsafe {
        assert_eq!(pocket_eval(handle, source.as_ptr()), 0, "{}", last_error(handle));
        let frame = pocket_frame(handle, 0.0);
        assert!(!frame.is_null());
        assert!(last_error(handle).contains("draw operation quota exceeded"));
        // Sticky fatal state prevents a later poll from publishing partial
        // output after the first over-budget attempt.
        let _ = pocket_frame(handle, 0.0);
        assert!(last_error(handle).contains("draw operation quota exceeded"));
        pocket_destroy(handle);
    }
}
