#ifndef POCKET_WEB_WORKER_BRIDGE_H
#define POCKET_WEB_WORKER_BRIDGE_H

/*
 * Browser boundary for the pinned PocketJS worker realm.
 *
 * The bridge accepts the already validated QuickJS bytecode payload emitted by
 * build_guest. It deliberately has no source-evaluation entry point: the
 * browser worker must load the same QJBC ABI as the native host.
 *
 * pweb_node.name is borrowed until pweb_worker_destroy returns. The caller
 * keeps the strings (normally Rust CString values) alive for that interval.
 */
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const char *name;
  uint32_t kind;
} pweb_node;

/* Returns NULL when the node table, generation, or allocation is invalid. */
void *pweb_worker_create(const pweb_node *nodes, size_t node_count,
                         uint32_t generation);

/* Loads one validated QJBC payload. Source text is never accepted. */
int pweb_worker_boot(void *worker, const uint8_t *payload, size_t length);

/* Runs one bounded worker turn: 1=turn, 0=idle/throttled, -1=fault. */
int pweb_worker_step(void *worker, double now_micros);

/* Returns the next absolute deadline in microseconds, or -1 when idle. */
double pweb_worker_deadline(void *worker);

/* Ingress/egress operations retain the pinned core's bounded queues. */
int pweb_worker_receive(void *worker, uint32_t channel, const uint8_t *bytes,
                        size_t length);
int pweb_worker_take(void *worker, uint32_t channel, uint8_t *out,
                     size_t capacity);
int pweb_worker_emit(void *worker, uint32_t request, uint32_t kind,
                     int32_t status, double offset, const uint8_t *payload,
                     size_t length);
int pweb_worker_finish(void *worker, uint32_t request, uint32_t handle,
                       int32_t status, double offset);

/* Returns the most recent bootstrap/realm fault, or a stable empty string. */
const char *pweb_worker_error(void *worker);

/* Stops the core, closes browser resources, then destroys the realm.
 * Returns POCKET_WORKER_OK on reclamation, or POCKET_WORKER_BUSY when a
 * provider still owns a native resource; callers must retain the handle and
 * borrowed node names and retry after the provider revokes that resource. */
int pweb_worker_destroy(void *worker);

#ifdef __cplusplus
}
#endif

#endif
