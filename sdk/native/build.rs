use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn cargo_home() -> PathBuf {
    env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".cargo")))
        .expect("CARGO_HOME or HOME must be set")
}

fn locked_version(manifest: &Path, package: &str) -> String {
    let lock = manifest.join("Cargo.lock");
    let source = fs::read_to_string(&lock).expect("native Cargo.lock is required");
    let mut in_package = false;
    for line in source.lines() {
        if line == "[[package]]" {
            in_package = false;
        } else if line == format!("name = \"{package}\"") {
            in_package = true;
        } else if in_package {
            if let Some(version) = line
                .strip_prefix("version = \"")
                .and_then(|v| v.strip_suffix('"'))
            {
                return version.to_owned();
            }
        }
    }
    panic!("{package} is missing from {}", lock.display());
}

fn quickjs_include(manifest: &Path) -> PathBuf {
    let version = locked_version(manifest, "rquickjs-sys");
    let source_root = cargo_home().join("registry/src");
    for registry in fs::read_dir(&source_root)
        .unwrap_or_else(|error| panic!("cannot inspect {}: {error}", source_root.display()))
    {
        let registry = registry.expect("registry entry").path();
        let candidate = registry
            .join(format!("rquickjs-sys-{version}"))
            .join("quickjs");
        if candidate.join("quickjs.h").is_file() {
            return candidate;
        }
    }
    panic!(
        "rquickjs-sys {version} source is unavailable under {}; cargo must fetch the locked crate before building pocket_worker",
        source_root.display()
    );
}

fn patch_once(source: &str, marker: &str, insertion: &str, label: &str) -> String {
    if source.matches(marker).count() != 1 {
        panic!("pinned worker {label} patch marker changed; review the adapter against the pinned PocketJS revision");
    }
    source.replace(marker, insertion)
}

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    println!(
        "cargo:rerun-if-changed={}",
        manifest.join("Cargo.toml").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        manifest.join("Cargo.lock").display()
    );
    let upstream = manifest.join("../.cache/pocketjs/engine/worker");
    let include = quickjs_include(&manifest);
    println!(
        "cargo:rerun-if-changed={}",
        include.join("quickjs.h").display()
    );
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let adapted = out.join("pocket_worker");
    fs::create_dir_all(&adapted).expect("create adapted worker source directory");

    for relative in [
        "src/worker.c",
        "src/quickjs_ui.c",
        "src/runner.c",
        "include/pocket/worker.h",
        "include/pocket/worker_protocol.h",
        "include/pocket/worker_quickjs.h",
        "include/pocket/worker_runner.h",
        "include/pocket/worker_ui.h",
    ] {
        let source = upstream.join(relative);
        println!("cargo:rerun-if-changed={}", source.display());
        let destination = adapted.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).expect("create worker include directory");
        }
        fs::copy(&source, &destination).unwrap_or_else(|error| {
            panic!(
                "cannot copy pinned worker source {}: {error}",
                source.display()
            )
        });
    }

    let quickjs_source = upstream.join("src/quickjs.c");
    println!("cargo:rerun-if-changed={}", quickjs_source.display());
    let quickjs = fs::read_to_string(&quickjs_source).expect("read pinned worker quickjs.c");
    let quickjs = patch_once(
        &quickjs,
        "static JSValue context_value(pocket_worker_quickjs *g,",
        r#"/* Pocket's package loader validates the envelope and passes only the
 * matching rquickjs-sys payload here. This is the same QuickJS C ABI used by
 * the runner's context; production worker bundles are never evaluated as JS. */
int32_t pocket_worker_quickjs_eval_bytecode(pocket_worker_quickjs *g,
                                             const uint8_t *bytes,
                                             size_t length) {
  if (!g || g->fault || !bytes || !length)
    return -1;
  g->turn_started = now(g);
  g->turn_started_cpu = cpu_now(g);
  g->turn_active = 1;
  JSValue object = JS_ReadObject(g->context, bytes, length,
                                 JS_READ_OBJ_BYTECODE);
  if (JS_IsException(object))
    return failed(g);
  JSValue result = JS_EvalFunction(g->context, object);
  if (JS_IsException(result))
    return failed(g);
  JS_FreeValue(g->context, result);
  if (!g->booted) {
    g->window_start = now(g);
    g->spent = 0;
  }
  g->turn_active = 0;
  return 0;
}

static JSValue context_value(pocket_worker_quickjs *g,"#,
        "worker QuickJS bytecode loader",
    );
    let quickjs = patch_once(
        &quickjs,
        "  uint64_t window_start, spent, resume_at;",
        "  uint64_t window_start, spent, resume_at, turn_started, turn_started_cpu;\n  uint32_t turn_active, turn_timed_out;",
        "worker turn deadline state",
    );
    let quickjs = patch_once(
        &quickjs,
        "  if (set(c, value, \"generation\",\n          JS_NewUint32(c, pocket_worker_generation(g->config.worker))) < 0 ||\n      set(c, value, \"sequence\", JS_NewUint32(c, ++g->sequence)) < 0 ||",
        "  if (set(c, value, \"generation\", JS_NewUint32(c, input->generation)) < 0 ||\n      set(c, value, \"sequence\", JS_NewUint32(c, input->sequence)) < 0 ||",
        "worker recorded turn context fields",
    );
    let quickjs = patch_once(
        &quickjs,
        "static uint64_t now(pocket_worker_quickjs *g) {\n  return g->config.now_micros(g->config.context);\n}",
        "static uint64_t now(pocket_worker_quickjs *g) {\n  return g->config.now_micros(g->config.context);\n}\nstatic uint64_t cpu_now(pocket_worker_quickjs *g) {\n  return g->config.cpu_now_micros\n             ? g->config.cpu_now_micros(g->config.context)\n             : now(g);\n}",
        "worker physical CPU clock",
    );
    let quickjs = patch_once(
        &quickjs,
        "static int interrupt(JSRuntime *rt, void *opaque) {\n  (void)rt;\n  pocket_worker_quickjs *g = opaque;\n  return g->fault || atomic_load(&g->interrupted);\n}",
        "static int interrupt(JSRuntime *rt, void *opaque) {\n  (void)rt;\n  pocket_worker_quickjs *g = opaque;\n  if (g->fault || atomic_load(&g->interrupted))\n    return 1;\n  if (g->turn_active && g->config.turn_budget_micros &&\n      cpu_now(g) - g->turn_started_cpu >= g->config.turn_budget_micros) {\n    g->turn_timed_out = 1;\n    return 1;\n  }\n  return 0;\n}",
        "worker turn deadline interrupt",
    );
    let quickjs = patch_once(
        &quickjs,
        "  const char *message = JS_ToCString(g->context, e);\n  snprintf(g->error, sizeof g->error, \"%s\",\n           message ? message : \"worker realm fault\");",
        "  const char *message = JS_ToCString(g->context, e);\n  if (g->turn_timed_out)\n    snprintf(g->error, sizeof g->error, \"worker turn exceeded %u us\",\n             g->config.turn_budget_micros);\n  else\n    snprintf(g->error, sizeof g->error, \"%s\",\n             message ? message : \"worker realm fault\");\n  g->turn_active = 0;",
        "worker turn deadline error",
    );
    let quickjs = patch_once(
        &quickjs,
        "  if (g->config.quota_micros) {\n    began = now(g);\n    if (began < g->window_start ||\n        began - g->window_start >= g->config.window_micros) {\n      g->window_start = began;\n      g->spent = 0;\n      g->resume_at = 0;\n    }\n    if (g->spent >= g->config.quota_micros) {\n      g->resume_at = g->window_start + g->config.window_micros;\n      return 0;\n    }\n  }",
        "  if (g->config.quota_micros) {\n    began = now(g);\n    if (began < g->window_start ||\n        began - g->window_start >= g->config.window_micros) {\n      g->window_start = began;\n      g->spent = 0;\n      g->resume_at = 0;\n    }\n    uint64_t candidate_resume = g->window_start + g->config.window_micros;\n    uint64_t trace_value = g->spent >= g->config.quota_micros\n                               ? candidate_resume\n                               : 0;\n    if (g->config.trace_turn &&\n        g->config.trace_turn(g->config.context, POCKET_WORKER_TRACE_DEFERRED,\n                             (pocket_worker_context *)input, NULL, 0,\n                             trace_value != 0, 0, candidate_resume,\n                             &trace_value) != 0) {\n      snprintf(g->error, sizeof g->error, \"worker trace quota admission failed\");\n      g->fault = 1;\n      pocket_worker_shutdown(g->config.worker);\n      return -1;\n    }\n    if (trace_value == UINT64_MAX) {\n      /* Replay selected a recorded turn.begin after advancing the virtual\n       * clock. Re-evaluate this window at the recorded timestamp. */\n      began = now(g);\n      if (began < g->window_start ||\n          began - g->window_start >= g->config.window_micros) {\n        g->window_start = began;\n        g->spent = 0;\n        g->resume_at = 0;\n      }\n    } else if (trace_value) {\n      g->resume_at = trace_value;\n      return 0;\n    }\n  }",
        "worker deterministic quota boundary",
    );
    let quickjs = patch_once(
        &quickjs,
        "  pocket_worker_dispatch(g->config.worker);",
        "  pocket_worker_context *turn = (pocket_worker_context *)input;\n  turn->generation = pocket_worker_generation(g->config.worker);\n  turn->sequence = ++g->sequence;\n  if (g->config.trace_turn &&\n      g->config.trace_turn(g->config.context, POCKET_WORKER_TRACE_BEFORE_STEP,\n                           turn, NULL, 0, 0, 0, 0, NULL) != 0) {\n    snprintf(g->error, sizeof g->error, \"worker trace turn.begin failed\");\n    g->fault = 1;\n    pocket_worker_shutdown(g->config.worker);\n    return -1;\n  }\n  g->turn_started = now(g);\n  g->turn_started_cpu = cpu_now(g);\n  g->turn_active = 1;\n  pocket_worker_dispatch(g->config.worker);",
        "worker traced turn start",
    );
    let quickjs = patch_once(
        &quickjs,
        "  size_t count =\n      pocket_worker_observe(g->config.worker, g->facts, g->config.max_facts,\n                            g->bytes, g->config.max_bytes);",
        "  if (g->config.trace_turn &&\n      g->config.trace_turn(g->config.context, POCKET_WORKER_TRACE_BEFORE_FACTS,\n                           (pocket_worker_context *)input, NULL, 0, 0, 0, 0,\n                           NULL) != 0) {\n    snprintf(g->error, sizeof g->error, \"worker trace before facts failed\");\n    g->fault = 1;\n    pocket_worker_shutdown(g->config.worker);\n    return -1;\n  }\n  size_t count =\n      pocket_worker_observe(g->config.worker, g->facts, g->config.max_facts,\n                            g->bytes, g->config.max_bytes);\n  if (count == (size_t)-1) {\n    snprintf(g->error, sizeof g->error, \"worker trace facts failed\");\n    g->fault = 1;\n    pocket_worker_shutdown(g->config.worker);\n    return -1;\n  }",
        "worker observed facts trace boundary",
    );
    let quickjs = patch_once(
        &quickjs,
        "    JS_RunGC(g->runtime);\n    if (g->config.quota_micros)",
        "    JS_RunGC(g->runtime);\n    g->turn_active = 0;\n    uint64_t trace_value = 0;\n    if (g->config.trace_turn &&\n        g->config.trace_turn(g->config.context, POCKET_WORKER_TRACE_IDLE,\n                             (pocket_worker_context *)input, g->facts, count,\n                             0, now(g) - g->turn_started, 0,\n                             &trace_value) != 0) {\n      snprintf(g->error, sizeof g->error, \"worker trace idle end failed\");\n      g->fault = 1;\n      pocket_worker_shutdown(g->config.worker);\n      return -1;\n    }\n    if (g->config.quota_micros)",
        "worker turn deadline idle",
    );
    let quickjs = patch_once(
        &quickjs,
        "pocket_worker_quickjs *\npocket_worker_quickjs_create(const pocket_worker_quickjs_config *config) {",
        r#"static JSValue trace_scalar_op(JSContext *c, JSValueConst self, int argc,
                                JSValueConst *args, int magic, JSValue *data) {
  (void)self;
  (void)magic;
  if (argc < 2)
    return JS_ThrowTypeError(c, "missing scalar trace arguments");
  size_t token_size = 0;
  uint8_t *token = JS_GetArrayBuffer(c, &token_size, data[0]);
  pocket_worker_quickjs *g = NULL;
  if (token && token_size == sizeof g)
    memcpy(&g, token, sizeof g);
  if (!g || g->fault)
    return JS_ThrowInternalError(c, "inactive worker trace clock");
  const char *name = JS_ToCString(c, args[0]);
  if (!name)
    return JS_EXCEPTION;
  double value;
  if (JS_ToFloat64(c, &value, args[1]) < 0) {
    JS_FreeCString(c, name);
    return JS_EXCEPTION;
  }
  if (g->config.trace_scalar &&
      g->config.trace_scalar(g->config.context, name, value, &value) != 0) {
    JS_FreeCString(c, name);
    return JS_ThrowInternalError(c, "worker trace scalar mismatch");
  }
  JS_FreeCString(c, name);
  return JS_NewFloat64(c, value);
}
static int32_t install_trace_clock(pocket_worker_quickjs *g) {
  static const char source[] =
      "(function(){\n"
      "const traceScalar=globalThis.__pocketTraceScalar;\n"
      "delete globalThis.__pocketTraceScalar;\n"
      "const NativeDate=globalThis.Date, nativeNow=NativeDate.now, nativeRandom=Math.random;\n"
      "const tracedNow=()=>traceScalar('date.now',nativeNow());\n"
      "Math.random=function(){return traceScalar('math.random',nativeRandom());};\n"
      "const TracedDate=function(...args){if(!new.target)return new NativeDate(tracedNow()).toString();"
      "if(args.length===0)return new NativeDate(tracedNow());"
      "return Reflect.construct(NativeDate,args,new.target===TracedDate?NativeDate:new.target); };\n"
      "Object.setPrototypeOf(TracedDate,NativeDate);TracedDate.prototype=NativeDate.prototype;"
      "TracedDate.now=tracedNow;TracedDate.parse=NativeDate.parse;TracedDate.UTC=NativeDate.UTC;"
      "globalThis.Date=TracedDate;})();";
  JSValue result = JS_Eval(g->context, source, sizeof source - 1,
                           "<worker trace clock>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result))
    return failed(g);
  JS_FreeValue(g->context, result);
  return 0;
}
pocket_worker_quickjs *
pocket_worker_quickjs_create(const pocket_worker_quickjs_config *config) {"#,
        "worker deterministic time and random shim",
    );
    let quickjs = patch_once(
        &quickjs,
        "fail:\n  pocket_worker_quickjs_destroy(g);\n  return NULL;\n}",
        "fail:\n  if (!g->error[0])\n    snprintf(g->error, sizeof g->error, \"worker realm initialization failed\");\n  g->fault = 1;\n  /* Keep the partially initialized realm until the runner reports its error\n   * and tears it down on the owner task. This preserves QuickJS's diagnostic\n   * instead of collapsing every bootstrap failure into an allocation error. */\n  return g;\n}",
        "worker realm bootstrap diagnostics",
    );
    let quickjs = patch_once(
        &quickjs,
        "  if (set(g->context, global, \"__pocketWorker\", host) < 0) {\n    JS_FreeValue(g->context, global);\n    goto fail;\n  }",
        "  if (set(g->context, global, \"__pocketWorker\", host) < 0) {\n    JS_FreeValue(g->context, global);\n    goto fail;\n  }\n  if (g->config.trace_scalar &&\n      set(g->context, global, \"__pocketTraceScalar\",\n          JS_NewCFunctionData(g->context, trace_scalar_op, 2, 0, 1,\n                              &g->token)) < 0) {\n    JS_FreeValue(g->context, global);\n    goto fail;\n  }",
        "worker trace scalar binding",
    );
    let quickjs = patch_once(
        &quickjs,
        "  if (config->mount && config->mount(config->context, g->context) != 0)\n    goto fail;",
        "  if (config->mount && config->mount(config->context, g->context) != 0)\n    goto fail;\n  if (g->config.trace_scalar && install_trace_clock(g) != 0)\n    goto fail;",
        "worker trace clock install",
    );
    let quickjs = patch_once(
        &quickjs,
        "  return 1;\nfailed_turn:",
        "  g->turn_active = 0;\n  uint64_t trace_value = 0;\n  if (g->config.trace_turn &&\n      g->config.trace_turn(g->config.context, POCKET_WORKER_TRACE_END,\n                           (pocket_worker_context *)input, g->facts, count, 1,\n                           now(g) - g->turn_started, 0,\n                           &trace_value) != 0) {\n    snprintf(g->error, sizeof g->error, \"worker trace turn.end failed\");\n    g->fault = 1;\n    pocket_worker_shutdown(g->config.worker);\n    return -1;\n  }\n  return 1;\nfailed_turn:",
        "worker turn deadline end",
    );
    let quickjs = patch_once(
        &quickjs,
        "  int32_t status;\n  if (op == OPEN) {",
        "  int32_t status;\n  const char *trace_name = NULL;\n  uint64_t trace_deadline = 0, trace_period = 0;\n  if (op == OPEN) {",
        "worker operation trace context",
    );
    let quickjs = patch_once(
        &quickjs,
        "    status = pocket_worker_open(g->config.worker, id, name, bytes, length);\n    JS_FreeCString(c, name);",
        "    trace_name = name;\n    status = pocket_worker_open(g->config.worker, id, name, bytes, length);",
        "worker open trace descriptor lifetime",
    );
    let quickjs = patch_once(
        &quickjs,
        "    status = pocket_worker_timer(g->config.worker, id, deadline, period);",
        "    trace_deadline = deadline;\n    trace_period = period;\n    status = pocket_worker_timer(g->config.worker, id, deadline, period);",
        "worker timer trace values",
    );
    let quickjs = patch_once(
        &quickjs,
        "    status = direction > 1 ? POCKET_WORKER_INVALID\n                           : pocket_worker_channel(g->config.worker, id,\n                                                   snapshot, limit, capacity);",
        "    code = snapshot;\n    trace_period = limit;\n    status = direction > 1 ? POCKET_WORKER_INVALID\n                           : pocket_worker_channel(g->config.worker, id,\n                                                   snapshot, limit, capacity);",
        "worker channel declaration trace values",
    );
    let quickjs = patch_once(
        &quickjs,
        "  result = JS_NewInt32(c, status);\ndone:\n  JS_FreeValue(c, buffer);\n  return result;",
        "  if (g->config.trace_operation &&\n      g->config.trace_operation(g->config.context, (uint32_t)op, id, code,\n                               trace_name, bytes, length, trace_deadline,\n                               trace_period, capacity, direction, status) != 0) {\n    result = JS_ThrowInternalError(c, \"worker trace operation failed\");\n    goto done;\n  }\n  result = JS_NewInt32(c, status);\ndone:\n  JS_FreeValue(c, buffer);\n  if (trace_name)\n    JS_FreeCString(c, trace_name);\n  return result;",
        "worker operation trace event",
    );
    let quickjs = patch_once(
        &quickjs,
        "static JSValue operation(JSContext *c, JSValueConst self, int argc,",
        "static int trace_before_operation(pocket_worker_quickjs *g,\n                                   uint32_t operation) {\n  return g->config.trace_boundary\n             ? g->config.trace_boundary(g->config.context,\n                                        POCKET_WORKER_TRACE_BEFORE_OPERATION,\n                                        operation)\n             : 0;\n}\nstatic JSValue operation(JSContext *c, JSValueConst self, int argc,",
        "worker operation ordering gate",
    );
    let quickjs = patch_once(
        &quickjs,
        "    trace_name = name;\n    status = pocket_worker_open(g->config.worker, id, name, bytes, length);",
        "    trace_name = name;\n    if (trace_before_operation(g, (uint32_t)op) != 0) {\n      JS_ThrowInternalError(c, \"worker trace operation order mismatch\");\n      goto done;\n    }\n    status = pocket_worker_open(g->config.worker, id, name, bytes, length);",
        "worker open pre-operation gate",
    );
    let quickjs = patch_once(
        &quickjs,
        "    status = pocket_worker_submit(g->config.worker, id, code, bytes, length,\n                                  capacity);",
        "    if (trace_before_operation(g, (uint32_t)op) != 0) {\n      JS_ThrowInternalError(c, \"worker trace operation order mismatch\");\n      goto done;\n    }\n    status = pocket_worker_submit(g->config.worker, id, code, bytes, length,\n                                  capacity);",
        "worker submit pre-operation gate",
    );
    let quickjs = patch_once(
        &quickjs,
        "    status = op == WRITE\n                 ? pocket_worker_write(g->config.worker, id, bytes, length)\n                 : pocket_worker_publish(g->config.worker, id, bytes, length);",
        "    if (trace_before_operation(g, (uint32_t)op) != 0) {\n      JS_ThrowInternalError(c, \"worker trace operation order mismatch\");\n      goto done;\n    }\n    status = op == WRITE\n                 ? pocket_worker_write(g->config.worker, id, bytes, length)\n                 : pocket_worker_publish(g->config.worker, id, bytes, length);",
        "worker write and publish pre-operation gate",
    );
    let quickjs = patch_once(
        &quickjs,
        "    trace_deadline = deadline;\n    trace_period = period;\n    status = pocket_worker_timer(g->config.worker, id, deadline, period);",
        "    trace_deadline = deadline;\n    trace_period = period;\n    if (trace_before_operation(g, (uint32_t)op) != 0) {\n      JS_ThrowInternalError(c, \"worker trace operation order mismatch\");\n      goto done;\n    }\n    status = pocket_worker_timer(g->config.worker, id, deadline, period);",
        "worker timer pre-operation gate",
    );
    let quickjs = patch_once(
        &quickjs,
        "    code = snapshot;\n    trace_period = limit;\n    status = direction > 1 ? POCKET_WORKER_INVALID\n                           : pocket_worker_channel(g->config.worker, id,\n                                                   snapshot, limit, capacity);",
        "    code = snapshot;\n    trace_period = limit;\n    if (trace_before_operation(g, (uint32_t)op) != 0) {\n      JS_ThrowInternalError(c, \"worker trace operation order mismatch\");\n      goto done;\n    }\n    status = direction > 1 ? POCKET_WORKER_INVALID\n                           : pocket_worker_channel(g->config.worker, id,\n                                                   snapshot, limit, capacity);",
        "worker channel declaration pre-operation gate",
    );
    let quickjs = patch_once(
        &quickjs,
        "  } else\n    status = op == CANCEL ? pocket_worker_cancel(g->config.worker, id)\n                          : pocket_worker_close(g->config.worker, id);",
        "  } else {\n    if (trace_before_operation(g, (uint32_t)op) != 0) {\n      JS_ThrowInternalError(c, \"worker trace operation order mismatch\");\n      goto done;\n    }\n    status = op == CANCEL ? pocket_worker_cancel(g->config.worker, id)\n                          : pocket_worker_close(g->config.worker, id);\n  }",
        "worker cancel and close pre-operation gate",
    );
    fs::write(adapted.join("src/quickjs.c"), quickjs).expect("write adapted quickjs.c");

    let quickjs_header = adapted.join("include/pocket/worker_quickjs.h");
    let header = fs::read_to_string(&quickjs_header).expect("read adapted worker_quickjs.h");
    let header = patch_once(
        &header,
        "typedef struct {\n  uint32_t struct_size;\n  pocket_worker *worker;",
        r#"enum {
  POCKET_WORKER_TRACE_BEFORE_STEP = 1,
  POCKET_WORKER_TRACE_BEFORE_FACTS = 2,
  POCKET_WORKER_TRACE_IDLE = 3,
  POCKET_WORKER_TRACE_END = 4,
  POCKET_WORKER_TRACE_DEFERRED = 5,
  POCKET_WORKER_TRACE_BEFORE_OPERATION = 6
};
typedef int32_t (*pocket_worker_trace_turn_fn)(void *, uint32_t,
    pocket_worker_context *, const pocket_worker_fact *, size_t, int32_t,
    uint64_t, uint64_t, uint64_t *);
typedef int32_t (*pocket_worker_trace_boundary_fn)(void *, uint32_t, uint32_t);
typedef int32_t (*pocket_worker_trace_operation_fn)(void *, uint32_t, uint32_t,
    uint32_t, const char *, const uint8_t *, size_t, uint64_t, uint64_t,
    uint32_t, uint32_t, int32_t);
typedef int32_t (*pocket_worker_trace_scalar_fn)(void *, const char *, double,
                                                double *);
typedef struct {
  uint32_t struct_size;
  pocket_worker *worker;"#,
        "worker trace callback ABI",
    );
    let header = patch_once(
        &header,
        "  uint32_t max_jobs, max_facts, max_bytes;",
        "  uint32_t max_jobs, max_facts, max_bytes, turn_budget_micros;",
        "worker turn deadline config",
    );
    let header = patch_once(
        &header,
        "  const JSMallocFunctions *allocator;\n  void *allocator_context;",
        "  const JSMallocFunctions *allocator;\n  void *allocator_context;\n  uint64_t (*cpu_now_micros)(void *);\n  pocket_worker_trace_turn_fn trace_turn;\n  pocket_worker_trace_boundary_fn trace_boundary;\n  pocket_worker_trace_operation_fn trace_operation;\n  pocket_worker_trace_scalar_fn trace_scalar;",
        "worker trace callback config",
    );
    let header = patch_once(
        &header,
        "int32_t pocket_worker_quickjs_eval(pocket_worker_quickjs *, const char *,\n                                   size_t, const char *);",
        "int32_t pocket_worker_quickjs_eval(pocket_worker_quickjs *, const char *,\n                                   size_t, const char *);\nint32_t pocket_worker_quickjs_eval_bytecode(pocket_worker_quickjs *, const uint8_t *, size_t);",
        "worker QuickJS header bytecode loader",
    );
    fs::write(quickjs_header, header).expect("write adapted worker_quickjs.h");

    let worker_header = adapted.join("include/pocket/worker.h");
    let header = fs::read_to_string(&worker_header).expect("read adapted worker.h");
    let header = patch_once(
        &header,
        "typedef struct {\n  uint32_t struct_size, generation;\n  const pocket_worker_node *nodes;",
        "typedef int32_t (*pocket_worker_trace_fact_fn)(void *, uint32_t, uint32_t, uint32_t, uint32_t, int32_t, uint64_t, const uint8_t *, size_t);\ntypedef int32_t (*pocket_worker_trace_facts_fn)(void *, const pocket_worker_fact *, size_t);\ntypedef struct {\n  uint32_t struct_size, generation;\n  const pocket_worker_node *nodes;",
        "worker fact trace callback type",
    );
    let header = patch_once(
        &header,
        "  uint64_t (*now_micros)(void *);\n} pocket_worker_config;",
        "  uint64_t (*now_micros)(void *);\n  pocket_worker_trace_fact_fn trace_fact;\n  pocket_worker_trace_facts_fn trace_facts;\n} pocket_worker_config;",
        "worker core fact trace callback",
    );
    let header = patch_once(
        &header,
        "int32_t pocket_worker_emit(pocket_worker *, uint32_t, uint32_t, int32_t,\n                           uint64_t, const uint8_t *, size_t);",
        "int32_t pocket_worker_emit(pocket_worker *, uint32_t, uint32_t, int32_t,\n                           uint64_t, const uint8_t *, size_t);\nint32_t pocket_worker_emit_request(pocket_worker *, uint32_t, uint32_t, uint32_t, int32_t, uint64_t, const uint8_t *, size_t);",
        "worker request-aware emit",
    );
    fs::write(&worker_header, header).expect("write adapted worker.h trace callback");

    let runner_source = upstream.join("src/runner.c");
    let runner = fs::read_to_string(&runner_source).expect("read pinned worker runner.c");
    let runner = patch_once(
        &runner,
        "if (pocket_worker_quickjs_eval(r->realm, c->source, c->source_size,\n                                 \"worker.js\") != 0)",
        "if (pocket_worker_quickjs_eval_bytecode(\n          r->realm, (const uint8_t *)c->source, c->source_size) != 0)",
        "worker runner bytecode entry",
    );
    let runner = patch_once(
        &runner,
        "  if (!r->realm) {\n    fail(r, \"worker realm allocation failed\");\n    return r;\n  }",
        "  if (!r->realm) {\n    fail(r, \"worker realm allocation failed\");\n    return r;\n  }\n  if (pocket_worker_quickjs_error(r->realm)[0]) {\n    fail(r, pocket_worker_quickjs_error(r->realm));\n    return r;\n  }",
        "worker runner realm bootstrap diagnostic",
    );
    let runner = patch_once(
        &runner,
        "    pocket_worker_context context = {.struct_size = sizeof context,\n                                     .now_micros = now(r)};\n    int32_t result = pocket_worker_quickjs_step(r->realm, &context);",
        "    if (r->config.pause_wait)\n      r->config.pause_wait(r->config.context);\n    if (atomic_load(&r->stopping))\n      break;\n    pocket_worker_context context = {.struct_size = sizeof context,\n                                     .now_micros = now(r)};\n    int32_t result = pocket_worker_quickjs_step(r->realm, &context);",
        "worker runner pause gate",
    );
    let runner = patch_once(
        &runner,
        "while (pocket_worker_destroy(r->core) == POCKET_WORKER_BUSY)\n      wait_until(r, now(r) + 1000);",
        "while (pocket_worker_destroy(r->core) == POCKET_WORKER_BUSY)\n      wait_until(r, UINT64_MAX);",
        "worker teardown wake wait",
    );
    fs::write(adapted.join("src/runner.c"), runner).expect("write adapted runner.c");

    let runner_header = adapted.join("include/pocket/worker_runner.h");
    let header = fs::read_to_string(&runner_header).expect("read adapted worker_runner.h");
    let header = patch_once(
        &header,
        "  void (*wait)(void *, uint64_t deadline_micros);\n",
        "  void (*wait)(void *, uint64_t deadline_micros);\n  /* Park at a turn boundary while the host scheduler is suspended. */\n  void (*pause_wait)(void *);\n",
        "worker runner pause callback ABI",
    );
    fs::write(runner_header, header).expect("write adapted worker_runner.h");

    for relative in ["src/worker.c", "src/quickjs_ui.c"] {
        fs::copy(upstream.join(relative), adapted.join(relative)).expect("copy worker source");
    }
    let worker_header = adapted.join("include/pocket/worker.h");
    let header = fs::read_to_string(&worker_header).expect("read adapted worker.h");
    let header = patch_once(
        &header,
        "int32_t pocket_worker_channel_take(pocket_worker *, uint32_t, uint8_t *,\n                                   size_t);",
        "int32_t pocket_worker_channel_take(pocket_worker *, uint32_t, uint8_t *,\n                                   size_t);\nint pocket_worker_channel_output_pending(pocket_worker *, uint32_t);",
        "worker channel output demand ABI",
    );
    fs::write(&worker_header, header).expect("write adapted worker.h");

    let worker_source = adapted.join("src/worker.c");
    let source = fs::read_to_string(&worker_source).expect("read adapted worker.c");
    let source = patch_once(
        &source,
        "  channel channels[POCKET_WORKER_MAX_CHANNELS];\n};\nstatic atomic_uint next_id = ATOMIC_VAR_INIT(1);\nstatic uint32_t allocate_id(void) {\n  unsigned id = atomic_load_explicit(&next_id, memory_order_relaxed);\n  while (id < INT_MAX) {\n    if (atomic_compare_exchange_weak_explicit(\n            &next_id, &id, id + 1, memory_order_relaxed, memory_order_relaxed))\n      return id;\n  }\n  return 0;\n}",
        "  channel channels[POCKET_WORKER_MAX_CHANNELS];\n  uint32_t next_id;\n};\nstatic uint32_t allocate_id(pocket_worker *w) {\n  if (!w || !w->next_id || w->next_id >= INT_MAX)\n    return 0;\n  return w->next_id++;\n}",
        "worker core-local deterministic IDs",
    );
    let source = patch_once(
        &source,
        "  if (w)\n    w->config = *c;",
        "  if (w) {\n    w->config = *c;\n    w->next_id = 1;\n  }",
        "worker per-core ID initialization",
    );
    let source = patch_once(
        &source,
        "uint32_t id = r ? allocate_id() : 0;",
        "uint32_t id = r ? allocate_id(w) : 0;",
        "worker per-core resource ID allocation",
    );
    let source = patch_once(
        &source,
        "uint32_t id = q ? allocate_id() : 0;",
        "uint32_t id = q ? allocate_id(w) : 0;",
        "worker per-core request ID allocation",
    );
    let source = patch_once(
        &source,
        "int32_t pocket_worker_emit(pocket_worker *w, uint32_t handle, uint32_t kind,\n                           int32_t status, uint64_t offset, const uint8_t *data,\n                           size_t length) {",
        "static int32_t worker_emit(pocket_worker *w, uint32_t handle, uint32_t request_id, uint32_t kind,\n                           int32_t status, uint64_t offset, const uint8_t *data,\n                           size_t length) {",
        "worker request-aware emit implementation",
    );
    let source = patch_once(
        &source,
        "  w->event_count++;\n  unlock(w);\n  wake(w);\n  return POCKET_WORKER_OK;\n}\nint32_t pocket_worker_end",
        "  w->event_count++;\n  if (w->config.trace_fact)\n    w->config.trace_fact(w->config.context, 1, handle, request_id, kind,\n                         status, offset, data, length);\n  unlock(w);\n  wake(w);\n  return POCKET_WORKER_OK;\n}\nint32_t pocket_worker_emit(pocket_worker *w, uint32_t handle, uint32_t kind,\n                           int32_t status, uint64_t offset, const uint8_t *data,\n                           size_t length) {\n  return worker_emit(w, handle, 0, kind, status, offset, data, length);\n}\nint32_t pocket_worker_emit_request(pocket_worker *w, uint32_t handle,\n                                   uint32_t request_id, uint32_t kind,\n                                   int32_t status, uint64_t offset,\n                                   const uint8_t *data, size_t length) {\n  return worker_emit(w, handle, request_id, kind, status, offset, data, length);\n}\nint32_t pocket_worker_end",
        "worker emit trace before wake",
    );
    let source = patch_once(
        &source,
        "                                 .kind = kind,\n                                 .handle = handle,\n                                 .status = status,",
        "                                 .kind = kind,\n                                 .handle = handle,\n                                 .request = request_id,\n                                 .status = status,",
        "worker stream fact request identity",
    );
    let source = patch_once(
        &source,
        "  reclaim(q);\n  unlock(w);\n  wake(w);\n  return POCKET_WORKER_OK;\n}\nint32_t pocket_worker_cancel",
        "  reclaim(q);\n  if (w->config.trace_fact)\n    w->config.trace_fact(w->config.context, 2, handle, id, 0, status, offset,\n                         NULL, 0);\n  unlock(w);\n  wake(w);\n  return POCKET_WORKER_OK;\n}\nint32_t pocket_worker_cancel",
        "worker finish trace before wake",
    );
    let source = patch_once(
        &source,
        "void pocket_worker_shutdown(pocket_worker *w) {",
        r#"int pocket_worker_channel_output_pending(pocket_worker *w, uint32_t id) {
  if (!w || !id)
    return 0;
  int pending = 0;
  lock(w);
  for (size_t i = 0; i < POCKET_WORKER_MAX_CHANNELS; i++) {
    channel *c = &w->channels[i];
    if (c->id == id && c->outgoing && c->count) {
      pending = 1;
      break;
    }
  }
  unlock(w);
  return pending;
}
void pocket_worker_shutdown(pocket_worker *w) {"#,
        "worker channel output demand query",
    );
    let source = patch_once(
        &source,
        "  w->observe_phase = (w->observe_phase + 1) % 6;\n  w->observe_index++;\n  unlock(w);\n  return count;",
        "  w->observe_phase = (w->observe_phase + 1) % 6;\n  w->observe_index++;\n  int32_t trace_status = w->config.trace_facts\n                             ? w->config.trace_facts(w->config.context, out, count)\n                             : 0;\n  unlock(w);\n  return trace_status == 0 ? count : SIZE_MAX;",
        "worker observation trace commit under core lock",
    );
    fs::write(&worker_source, source).expect("write adapted worker.c");

    let ui_source = adapted.join("src/quickjs_ui.c");
    let source = fs::read_to_string(&ui_source).expect("read adapted quickjs_ui.c");
    let source = patch_once(
        &source,
        "  JSValue token, namespace;\n  ui_mirror mirrors[POCKET_WORKER_MAX_CHANNELS];",
        "  JSValue token, namespace;\n  void *trace_context;\n  pocket_worker_ui_trace_fn trace;\n  ui_mirror mirrors[POCKET_WORKER_MAX_CHANNELS];",
        "worker UI trace bridge state",
    );
    let source = patch_once(
        &source,
        "enum { UI_CONFIGURE, UI_PUBLISH, UI_OBSERVE };",
        "enum { UI_CONFIGURE, UI_PUBLISH, UI_OBSERVE };\nenum { UI_TRACE_PUBLISH_BEFORE = 1, UI_TRACE_PUBLISH_AFTER = 2, UI_TRACE_LATCH = 3 };",
        "worker UI trace phases",
    );
    let source = patch_once(
        &source,
        "    int32_t result = pocket_worker_receive(\n        bridge->worker, id, payload ? payload + offset : NULL, length);\n    JS_FreeValue(c, buffer);\n    return JS_NewInt32(c, result);",
        "    const uint8_t *record = payload ? payload + offset : NULL;\n    if (bridge->trace &&\n        bridge->trace(bridge->trace_context, UI_TRACE_PUBLISH_BEFORE, id,\n                      record, length, NULL, 0, 0, 0, 0) != 0) {\n      JS_FreeValue(c, buffer);\n      return JS_ThrowInternalError(c, \"worker UI trace order mismatch\");\n    }\n    int32_t result = pocket_worker_receive(bridge->worker, id, record, length);\n    if (bridge->trace &&\n        bridge->trace(bridge->trace_context, UI_TRACE_PUBLISH_AFTER, id,\n                      record, length, NULL, 0, 0, 0, result) != 0) {\n      JS_FreeValue(c, buffer);\n      return JS_ThrowInternalError(c, \"worker UI trace publish mismatch\");\n    }\n    JS_FreeValue(c, buffer);\n    return JS_NewInt32(c, result);",
        "worker UI channel publish trace",
    );
    let source = patch_once(
        &source,
        "pocket_worker_ui *pocket_worker_ui_attach(JSContext *c, pocket_worker *worker) {",
        "pocket_worker_ui *pocket_worker_ui_attach(JSContext *c, pocket_worker *worker,\n                                                     void *trace_context,\n                                                     pocket_worker_ui_trace_fn trace) {",
        "worker UI attach trace context",
    );
    let source = patch_once(
        &source,
        "  bridge->context = c;\n  bridge->worker = worker;",
        "  bridge->context = c;\n  bridge->worker = worker;\n  bridge->trace_context = trace_context;\n  bridge->trace = trace;",
        "worker UI trace callback setup",
    );
    let source = patch_once(
        &source,
        "int32_t pocket_worker_ui_latch(pocket_worker_ui *bridge) {",
        "int32_t pocket_worker_ui_latch(pocket_worker_ui *bridge,\n                                    void *trace_context,\n                                    pocket_worker_ui_trace_fn trace) {\n  int traced_mirror = 0;",
        "worker UI latch trace context",
    );
    let source = patch_once(
        &source,
        "  uint32_t snapshot, count;",
        "  uint32_t snapshot, count, pending;",
        "worker UI pending channel mirror",
    );
    let source = patch_once(
        &source,
        "  if (!mirror->snapshot)\n      mirror->count = 0;\n    uint32_t limit = mirror->snapshot ? 1 : POCKET_WORKER_MAX_EVENTS;\n    for (uint32_t n = 0; n < limit; n++) {",
        "  if (!mirror->snapshot && !mirror->pending)\n      mirror->count = 0;\n    uint32_t limit = mirror->snapshot ? 1 : POCKET_WORKER_MAX_EVENTS;\n    uint32_t first = mirror->snapshot ? 0 : mirror->count;\n    for (uint32_t n = first; n < limit; n++) {",
        "worker UI retain unconsumed channel records",
    );
    let source = patch_once(
        &source,
        "      mirror->count = n + 1;\n    }\n  }\n  JSContext *c = bridge->context;",
        "      mirror->count = n + 1;\n      mirror->pending = 1;\n    }\n    if (trace && mirror->bytes) {\n      traced_mirror = 1;\n      if (trace(trace_context, UI_TRACE_LATCH, i + 1, mirror->bytes, 0,\n                mirror->lengths, mirror->count, POCKET_WORKER_MAX_PAYLOAD,\n                mirror->snapshot, POCKET_WORKER_OK) != 0)\n        return POCKET_WORKER_FAILED;\n    }\n  }\n  if (trace && !traced_mirror &&\n      trace(trace_context, UI_TRACE_LATCH, 0, NULL, 0, NULL, 0,\n            POCKET_WORKER_MAX_PAYLOAD, 0, POCKET_WORKER_OK) != 0)\n    return POCKET_WORKER_FAILED;\n  JSContext *c = bridge->context;",
        "worker UI pending channel latch trace",
    );
    let source = patch_once(
        &source,
        "void pocket_worker_ui_detach(pocket_worker_ui *bridge) {",
        r#"int32_t pocket_worker_ui_has_pending_output(pocket_worker_ui *bridge) {
  if (!bridge)
    return 0;
  for (uint32_t i = 0; i < POCKET_WORKER_MAX_CHANNELS; i++)
    if (bridge->mirrors[i].pending)
      return 1;
  return 0;
}
void pocket_worker_ui_mark_frame_consumed(pocket_worker_ui *bridge) {
  if (!bridge)
    return;
  for (uint32_t i = 0; i < POCKET_WORKER_MAX_CHANNELS; i++)
    bridge->mirrors[i].pending = 0;
}
void pocket_worker_ui_detach(pocket_worker_ui *bridge) {"#,
        "worker UI channel demand ABI",
    );
    fs::write(&ui_source, source).expect("write adapted quickjs_ui.c");

    let ui_header = adapted.join("include/pocket/worker_ui.h");
    let header = fs::read_to_string(&ui_header).expect("read adapted worker_ui.h");
    let header = patch_once(
        &header,
        "typedef struct pocket_worker_ui pocket_worker_ui;",
        "typedef struct pocket_worker_ui pocket_worker_ui;\ntypedef int32_t (*pocket_worker_ui_trace_fn)(void *, uint32_t, uint32_t, const uint8_t *, size_t, const uint32_t *, uint32_t, uint32_t, uint32_t, int32_t);",
        "worker UI trace callback type",
    );
    let header = patch_once(
        &header,
        "pocket_worker_ui *pocket_worker_ui_attach(JSContext *, pocket_worker *);",
        "pocket_worker_ui *pocket_worker_ui_attach(JSContext *, pocket_worker *, void *, pocket_worker_ui_trace_fn);",
        "worker UI attach trace ABI",
    );
    let header = patch_once(
        &header,
        "int32_t pocket_worker_ui_latch(pocket_worker_ui *);",
        "int32_t pocket_worker_ui_latch(pocket_worker_ui *, void *, pocket_worker_ui_trace_fn);",
        "worker UI latch trace ABI",
    );
    let header = patch_once(
        &header,
        "int32_t pocket_worker_ui_latch(pocket_worker_ui *, void *, pocket_worker_ui_trace_fn);",
        "int32_t pocket_worker_ui_latch(pocket_worker_ui *, void *, pocket_worker_ui_trace_fn);\nint32_t pocket_worker_ui_has_pending_output(pocket_worker_ui *);\nvoid pocket_worker_ui_mark_frame_consumed(pocket_worker_ui *);",
        "worker UI channel demand declarations",
    );
    fs::write(ui_header, header).expect("write adapted worker_ui.h");
    println!("cargo:rerun-if-changed={}", include.display());
    cc::Build::new()
        .std("c11")
        .include(&include)
        .include(adapted.join("include"))
        .file(adapted.join("src/worker.c"))
        .file(adapted.join("src/quickjs.c"))
        .file(adapted.join("src/quickjs_ui.c"))
        .file(adapted.join("src/runner.c"))
        .compile("pocket_worker");
}
