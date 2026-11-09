#include "worker_bridge.h"

#include "pocket/worker.h"
#include "pocket/worker_quickjs.h"
#include "quickjs.h"

#include <float.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The browser host owns HTTP/device I/O. It is intentionally the only native
 * boundary exposed by this facade; no browser source-eval or importScripts
 * fallback exists. On wasm these declarations become imports from the named
 * module. Weak native defaults keep C unit tests linkable without a browser. */
#if defined(__wasm__)
#define PWEB_IMPORT(module, name)                                             \
  __attribute__((import_module(module), import_name(name)))
extern int32_t pocket_web_worker_operation(
    uint32_t operation, uint32_t handle, uint32_t request, uint32_t opcode,
    const uint8_t *payload, size_t length, size_t capacity)
    PWEB_IMPORT("pocket_web_worker", "operation");
extern double pocket_web_worker_now_micros(void)
    PWEB_IMPORT("pocket_web_worker", "now_micros");
#else
__attribute__((weak)) int32_t pocket_web_worker_operation(
    uint32_t operation, uint32_t handle, uint32_t request, uint32_t opcode,
    const uint8_t *payload, size_t length, size_t capacity) {
  (void)operation;
  (void)handle;
  (void)request;
  (void)opcode;
  (void)payload;
  (void)length;
  (void)capacity;
  return POCKET_WORKER_UNSUPPORTED;
}
__attribute__((weak)) double pocket_web_worker_now_micros(void) { return 0; }
#endif

enum {
  PWEB_OPERATION_OPEN = 0,
  PWEB_OPERATION_START = 1,
  PWEB_OPERATION_CANCEL = 2,
  PWEB_OPERATION_CLOSE = 3,
  PWEB_OPERATION_WRITE = 4,
  PWEB_OPERATION_VALIDATE = 5,
};

enum { PWEB_MAX_REQUESTS = POCKET_WORKER_MAX_REQUESTS };
enum { PWEB_DEFAULT_HEAP = 16u * 1024u * 1024u };
/* QuickJS's managed recursion budget, not the wasm linear/native C stack.
 * Match the UI realm's 512 KiB budget inside the linked 1 MiB WASM stack.
 * A budget larger than the current stack pointer underflows QuickJS's
 * unsigned stack limit and rejects every call. */
enum { PWEB_DEFAULT_STACK = 512u * 1024u };

typedef struct pweb_worker pweb_worker;

typedef struct {
  pweb_worker *owner;
  uint32_t kind;
} pweb_driver_context;

typedef struct {
  uint32_t request;
  uint32_t handle;
  unsigned active;
} pweb_request_slot;

struct pweb_worker {
  /* These arrays are owned by the bridge so pocket_worker's borrowed node
   * table remains valid until the core is destroyed. Node names remain
   * borrowed from the caller as documented in worker_bridge.h. */
  pocket_worker_node *nodes;
  pocket_worker_driver *drivers;
  pweb_driver_context *driver_contexts;
  size_t node_count;

  pocket_worker *core;
  pocket_worker_quickjs *realm;
  uint32_t generation;
  uint32_t sequence;
  uint64_t latched_now;
  unsigned has_latched_now;
  unsigned booted;
  unsigned failed;
  char error[256];
  pweb_request_slot requests[PWEB_MAX_REQUESTS];
};

static void set_error(pweb_worker *w, const char *message) {
  if (!w)
    return;
  snprintf(w->error, sizeof w->error, "%s",
           message && *message ? message : "worker realm fault");
}

static void capture_js_error(pweb_worker *w, const char *fallback) {
  if (!w || !w->realm) {
    set_error(w, fallback);
    return;
  }
  JSContext *context = pocket_worker_quickjs_context(w->realm);
  if (!context) {
    set_error(w, fallback);
    return;
  }
  JSValue exception = JS_GetException(context);
  const char *message = JS_ToCString(context, exception);
  if (message && *message)
    set_error(w, message);
  else
    set_error(w, fallback);
  if (message)
    JS_FreeCString(context, message);
  JS_FreeValue(context, exception);
}

static uint64_t valid_time(double value) {
  /* JS numbers are exact for integers through 2^53-1. Keeping the same bound
   * as the worker runtime avoids silently changing a deadline while crossing
   * the browser ABI. */
  if (!isfinite(value) || value < 0 || value > 9007199254740991.0 ||
      floor(value) != value)
    return 0;
  return (uint64_t)value;
}

static uint64_t bridge_now(void *opaque) {
  pweb_worker *w = (pweb_worker *)opaque;
  if (w && w->has_latched_now)
    return w->latched_now;
  double value = pocket_web_worker_now_micros();
  return valid_time(value);
}

static pweb_request_slot *request_slot(pweb_worker *w, uint32_t request) {
  if (!w || !request)
    return NULL;
  for (size_t i = 0; i < PWEB_MAX_REQUESTS; i++)
    if (w->requests[i].active && w->requests[i].request == request)
      return &w->requests[i];
  return NULL;
}

static pweb_request_slot *reserve_request(pweb_worker *w, uint32_t request,
                                          uint32_t handle) {
  if (!w || !request || !handle || request_slot(w, request))
    return NULL;
  for (size_t i = 0; i < PWEB_MAX_REQUESTS; i++) {
    pweb_request_slot *slot = &w->requests[i];
    if (!slot->active) {
      *slot = (pweb_request_slot){.request = request,
                                  .handle = handle,
                                  .active = 1};
      return slot;
    }
  }
  return NULL;
}

static void clear_request(pweb_request_slot *slot) {
  if (slot)
    *slot = (pweb_request_slot){0};
}

static void clear_requests_for_handle(pweb_worker *w, uint32_t handle) {
  if (!w || !handle)
    return;
  for (size_t i = 0; i < PWEB_MAX_REQUESTS; i++)
    if (w->requests[i].active && w->requests[i].handle == handle)
      clear_request(&w->requests[i]);
}

static int32_t driver_open(void *opaque, pocket_worker *core, uint32_t handle,
                           const uint8_t *payload, size_t length) {
  (void)core;
  pweb_driver_context *driver = (pweb_driver_context *)opaque;
  if (!driver || !driver->owner)
    return POCKET_WORKER_INVALID;
  /* The node kind is carried in opcode; descriptor bytes retain the official
   * worker contract (I2C/UART binary or HTTP JSON) without a bridge wrapper. */
  return pocket_web_worker_operation(PWEB_OPERATION_OPEN, handle, 0,
                                     driver->kind, payload, length, 0);
}

static int32_t driver_start(void *opaque, pocket_worker *core, uint32_t handle,
                            uint32_t request, uint32_t opcode,
                            const uint8_t *payload, size_t length,
                            size_t capacity) {
  (void)core;
  pweb_driver_context *driver = (pweb_driver_context *)opaque;
  if (!driver || !driver->owner)
    return POCKET_WORKER_INVALID;
  pweb_request_slot *slot =
      reserve_request(driver->owner, request, handle);
  if (!slot)
    return POCKET_WORKER_BUSY;
  int32_t status = pocket_web_worker_operation(
      PWEB_OPERATION_START, handle, request, opcode, payload, length,
      capacity);
  if (status != POCKET_WORKER_OK)
    clear_request(slot);
  return status;
}

static int32_t driver_write(void *opaque, pocket_worker *core, uint32_t handle,
                            const uint8_t *payload, size_t length) {
  (void)core;
  pweb_driver_context *driver = (pweb_driver_context *)opaque;
  if (!driver || !driver->owner)
    return POCKET_WORKER_INVALID;
  return pocket_web_worker_operation(PWEB_OPERATION_WRITE, handle, 0, 0,
                                     payload, length, 0);
}

static void driver_cancel(void *opaque, pocket_worker *core, uint32_t handle,
                          uint32_t request) {
  pweb_driver_context *driver = (pweb_driver_context *)opaque;
  if (!driver || !driver->owner)
    return;
  /* Invalidate before calling the host so an already queued fetch callback
   * cannot publish a late event after cancellation. */
  pweb_request_slot *slot = request_slot(driver->owner, request);
  clear_request(slot);
  (void)pocket_web_worker_operation(PWEB_OPERATION_CANCEL, handle, request, 0,
                                    NULL, 0, 0);
  /* pocket_worker_cancel leaves a started request terminal but not
   * native_done. The browser operation is synchronous at this boundary, so
   * complete it after abort/revoke returns. The core preserves its terminal
   * UNKNOWN status while this call releases the native ownership slot; late
   * browser callbacks are rejected because the bridge slot was cleared above.
   */
  (void)pocket_worker_complete(core, request, POCKET_WORKER_CANCELLED, NULL, 0);
}

static int32_t driver_close(void *opaque, pocket_worker *core,
                            uint32_t handle) {
  (void)core;
  pweb_driver_context *driver = (pweb_driver_context *)opaque;
  if (!driver || !driver->owner)
    return POCKET_WORKER_INVALID;
  /* A close revokes every request belonging to the resource. The browser host
   * must abort those operations before returning OK. */
  clear_requests_for_handle(driver->owner, handle);
  return pocket_web_worker_operation(PWEB_OPERATION_CLOSE, handle, 0, 0, NULL,
                                     0, 0);
}

static int32_t driver_validate(void *opaque, pocket_worker *core,
                               uint32_t handle, uint32_t opcode,
                               const uint8_t *payload, size_t length,
                               size_t capacity) {
  (void)core;
  pweb_driver_context *driver = (pweb_driver_context *)opaque;
  if (!driver || !driver->owner)
    return POCKET_WORKER_INVALID;
  return pocket_web_worker_operation(PWEB_OPERATION_VALIDATE, handle, 0,
                                     opcode, payload, length, capacity);
}

static int bridge_node_init(pweb_worker *w, const pweb_node *input,
                            size_t index) {
  pweb_driver_context *context = &w->driver_contexts[index];
  pocket_worker_driver *driver = &w->drivers[index];
  pocket_worker_node *node = &w->nodes[index];
  if (!input->name || !*input->name || !input->kind)
    return 0;
  *context = (pweb_driver_context){.owner = w, .kind = input->kind};
  *driver = (pocket_worker_driver){
      .struct_size = sizeof *driver,
      .context = context,
      .open = driver_open,
      .start = driver_start,
      .write = driver_write,
      .cancel = driver_cancel,
      .close = driver_close,
      .validate = driver_validate,
  };
  *node = (pocket_worker_node){.struct_size = sizeof *node,
                               .kind = input->kind,
                               .name = input->name,
                               .driver = driver};
  return 1;
}

void *pweb_worker_create(const pweb_node *input, size_t node_count,
                         uint32_t generation) {
  if ((node_count && !input) || !generation ||
      node_count > SIZE_MAX / sizeof(pocket_worker_node) ||
      node_count > SIZE_MAX / sizeof(pocket_worker_driver) ||
      node_count > SIZE_MAX / sizeof(pweb_driver_context))
    return NULL;
  pweb_worker *w = calloc(1, sizeof *w);
  if (!w)
    return NULL;
  w->generation = generation;
  w->node_count = node_count;
  if (node_count) {
    w->nodes = calloc(node_count, sizeof *w->nodes);
    w->drivers = calloc(node_count, sizeof *w->drivers);
    w->driver_contexts = calloc(node_count, sizeof *w->driver_contexts);
    if (!w->nodes || !w->drivers || !w->driver_contexts)
      goto fail;
    for (size_t i = 0; i < node_count; i++)
      if (!bridge_node_init(w, &input[i], i))
        goto fail;
  }

  pocket_worker_config core_config = {
      .struct_size = sizeof core_config,
      .generation = generation,
      .nodes = w->nodes,
      .node_count = node_count,
      .context = w,
      /* Browser calls are serialized on the owning Worker; no second lock or
       * blocking wake primitive is needed. */
      .lock = NULL,
      .unlock = NULL,
      .wake = NULL,
      .now_micros = bridge_now,
  };
  w->core = pocket_worker_create(&core_config);
  if (!w->core)
    goto fail;

  pocket_worker_quickjs_config realm_config = {
      .struct_size = sizeof realm_config,
      .worker = w->core,
      .heap_limit = PWEB_DEFAULT_HEAP,
      .stack_limit = PWEB_DEFAULT_STACK,
      .max_jobs = 64,
      .max_facts = 16,
      .max_bytes = 8192,
      .window_micros = 0,
      .quota_micros = 0,
      .context = w,
      .now_micros = bridge_now,
      /* quickjs.c installs __pocketWorker itself. No UI namespace is mounted
       * in this independent realm. */
      .mount = NULL,
      .allocator = NULL,
      .allocator_context = NULL,
  };
  w->realm = pocket_worker_quickjs_create(&realm_config);
  if (!w->realm) {
    set_error(w, "cannot create QuickJS worker realm");
    goto fail;
  }
  return w;

fail:
  if (w->realm)
    pocket_worker_quickjs_destroy(w->realm);
  if (w->core)
    (void)pocket_worker_destroy(w->core);
  free(w->driver_contexts);
  free(w->drivers);
  free(w->nodes);
  free(w);
  return NULL;
}

int pweb_worker_boot(void *opaque, const uint8_t *payload, size_t length) {
  pweb_worker *w = (pweb_worker *)opaque;
  if (!w || !w->realm || w->failed || w->booted || !payload || !length)
    return POCKET_WORKER_INVALID;
  JSContext *context = pocket_worker_quickjs_context(w->realm);
  if (!context)
    return POCKET_WORKER_FAILED;
  /* JS_ReadObject/JS_EvalFunction is the same bytecode path as the native
   * build.rs adapter. It consumes QJBC only and never calls JS_Eval. */
  JS_UpdateStackTop(JS_GetRuntime(context));
  JSValue object = JS_ReadObject(context, payload, length, JS_READ_OBJ_BYTECODE);
  if (JS_IsException(object)) {
    capture_js_error(w, "invalid QuickJS bytecode");
    w->failed = 1;
    pocket_worker_shutdown(w->core);
    return POCKET_WORKER_FAILED;
  }
  JSValue result = JS_EvalFunction(context, object);
  if (JS_IsException(result)) {
    capture_js_error(w, "QuickJS worker bootstrap failed");
    w->failed = 1;
    pocket_worker_shutdown(w->core);
    return POCKET_WORKER_FAILED;
  }
  JS_FreeValue(context, result);
  w->booted = 1;
  return POCKET_WORKER_OK;
}

int pweb_worker_step(void *opaque, double now_micros) {
  pweb_worker *w = (pweb_worker *)opaque;
  if (!w || !w->realm || !w->booted || w->failed)
    return POCKET_WORKER_FAILED;
  uint64_t now = valid_time(now_micros);
  if (!now && now_micros != 0)
    return POCKET_WORKER_INVALID;
  pocket_worker_context context = {
      .struct_size = sizeof context,
      .generation = w->generation,
      .sequence = ++w->sequence,
      .now_micros = now,
      .utc_micros = 0,
      .wall_generation = 0,
      .wall_error_micros = 0,
      .wall_source = NULL,
  };
  w->latched_now = now;
  w->has_latched_now = 1;
  int result = pocket_worker_quickjs_step(w->realm, &context);
  w->has_latched_now = 0;
  if (result < 0) {
    const char *message = pocket_worker_quickjs_error(w->realm);
    set_error(w, message && *message ? message : "QuickJS worker turn failed");
    w->failed = 1;
    return POCKET_WORKER_FAILED;
  }
  return result;
}

double pweb_worker_deadline(void *opaque) {
  pweb_worker *w = (pweb_worker *)opaque;
  if (!w || !w->realm || w->failed)
    return -1.0;
  uint64_t deadline = pocket_worker_quickjs_deadline(w->realm);
  return deadline == UINT64_MAX ? -1.0 : (double)deadline;
}

int pweb_worker_receive(void *opaque, uint32_t channel, const uint8_t *bytes,
                        size_t length) {
  pweb_worker *w = (pweb_worker *)opaque;
  if (!w || !w->core || w->failed)
    return POCKET_WORKER_INVALID;
  return pocket_worker_receive(w->core, channel, bytes, length);
}

int pweb_worker_take(void *opaque, uint32_t channel, uint8_t *out,
                     size_t capacity) {
  pweb_worker *w = (pweb_worker *)opaque;
  if (!w || !w->core || w->failed)
    return POCKET_WORKER_INVALID;
  return pocket_worker_channel_take(w->core, channel, out, capacity);
}

int pweb_worker_emit(void *opaque, uint32_t request, uint32_t kind,
                     int32_t status, double offset, const uint8_t *payload,
                     size_t length) {
  pweb_worker *w = (pweb_worker *)opaque;
  if (!w || !w->core || w->failed)
    return POCKET_WORKER_INVALID;
  pweb_request_slot *slot = request_slot(w, request);
  uint64_t native_offset = valid_time(offset);
  if (!slot || (!native_offset && offset != 0))
    return POCKET_WORKER_INVALID;
  /* pocket_worker_emit is the canonical bounded event queue. A BUSY result is
   * surfaced to the browser so its reader pauses and retries after step(). */
  return pocket_worker_emit(w->core, slot->handle, kind, status,
                            native_offset, payload, length);
}

int pweb_worker_finish(void *opaque, uint32_t request, uint32_t handle,
                       int32_t status, double offset) {
  pweb_worker *w = (pweb_worker *)opaque;
  if (!w || !w->core || w->failed)
    return POCKET_WORKER_INVALID;
  pweb_request_slot *slot = request_slot(w, request);
  uint64_t native_offset = valid_time(offset);
  if (!slot || slot->handle != handle || (!native_offset && offset != 0))
    return POCKET_WORKER_INVALID;
  int32_t result = pocket_worker_finish(w->core, handle, request, status,
                                        native_offset);
  if (result == POCKET_WORKER_OK)
    clear_request(slot);
  return result;
}

const char *pweb_worker_error(void *opaque) {
  pweb_worker *w = (pweb_worker *)opaque;
  if (!w)
    return "missing worker";
  if (w->error[0])
    return w->error;
  if (w->realm)
    return pocket_worker_quickjs_error(w->realm);
  return "";
}

int pweb_worker_destroy(void *opaque) {
  pweb_worker *w = (pweb_worker *)opaque;
  if (!w)
    return POCKET_WORKER_INVALID;
  if (w->realm)
    pocket_worker_quickjs_interrupt(w->realm);
  if (w->core) {
    pocket_worker_shutdown(w->core);
    pocket_worker_dispatch(w->core);
    /* Browser close() is synchronous with respect to the WASM bridge. A
     * provider that reports BUSY is not safe to reclaim; preserve the realm
     * rather than freeing memory while a host callback can still arrive. */
    int32_t result = pocket_worker_destroy(w->core);
    if (result == POCKET_WORKER_BUSY) {
      for (unsigned attempt = 0; attempt < 8 && result == POCKET_WORKER_BUSY;
           attempt++) {
        pocket_worker_dispatch(w->core);
        result = pocket_worker_destroy(w->core);
      }
    }
    if (result == POCKET_WORKER_BUSY) {
      set_error(w, "browser worker resources remained busy during destroy");
      return POCKET_WORKER_BUSY;
    }
    w->core = NULL;
  }
  if (w->realm)
    pocket_worker_quickjs_destroy(w->realm);
  free(w->driver_contexts);
  free(w->drivers);
  free(w->nodes);
  free(w);
  return POCKET_WORKER_OK;
}
