#ifndef POCKET_FLUTTER_H
#define POCKET_FLUTTER_H

/*
 * Minimal C ABI for the Pocket Flutter native guest runtime.
 *
 * The handle is opaque and must be destroyed with pocket_destroy.  All byte
 * counts are bytes.  The memory-limit constructor is intentionally immutable:
 * a runtime cannot be downgraded while a guest is executing.
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct HostState HostState;

HostState *pocket_create(double width, double height);
HostState *pocket_create_with_density(double width, double height,
                                      uint32_t raster_density);
HostState *pocket_create_with_density_and_tick_hz(double width, double height,
                                                  uint32_t raster_density,
                                                  uint32_t tick_hz);

/*
 * heap_limit_bytes is the total QuickJS heap budget, including the bytes
 * copied into globalThis.__pak.  max_pak_bytes is checked against the actual
 * package before native assets or a guest realm are mounted.
 *
 * A zero value means "no override" for that field.  With both values zero,
 * the legacy default (16 MiB plus the PAK length) is retained.  Zero never
 * means an unlimited heap.
 */
HostState *pocket_create_with_memory_limits(double width, double height,
                                            uint32_t raster_density,
                                            uint32_t tick_hz,
                                            uint64_t heap_limit_bytes,
                                            uint64_t max_pak_bytes);

/* Optional host-only policy, configured once before load/eval. JSON fields:
 * hardenBuiltins (boolean, default false), maxNodes/maxDrawOps (1..1000000).
 * Returns 0 on success; reload preserves the policy. Unknown fields fail. */
int32_t pocket_configure_guest_security(HostState *handle,
                                         const char *config_json);

int32_t pocket_eval(HostState *handle, const char *source);
int32_t pocket_load(HostState *handle, const char *source,
                    const uint8_t *pak, size_t pak_len);
int32_t pocket_load_bytecode(HostState *handle, const uint8_t *bytecode,
                             size_t bytecode_len, const uint8_t *pak,
                             size_t pak_len);
const char *pocket_frame(HostState *handle, double delta_ms);
const char *pocket_frame_delta(HostState *handle, double delta_ms);
const uint8_t *pocket_frame_binary(HostState *handle, double delta_ms,
                                   uint64_t *out_byte_length);
const uint8_t *pocket_frame_delta_binary(HostState *handle, double delta_ms,
                                         uint64_t *out_byte_length);
const uint8_t *pocket_frame_delta_binary_v2(HostState *handle, double delta_ms,
                                            uint64_t base_frame,
                                            uint64_t *out_byte_length);
int32_t pocket_send(HostState *handle, const char *message);
int32_t pocket_send_binary(HostState *handle, const uint8_t *message,
                           size_t message_len);
const uint8_t *pocket_offload_take_binary(HostState *handle, uint32_t cancelled,
                                          uint64_t *out_byte_length);
int32_t pocket_offload_complete_binary(HostState *handle, const uint8_t *record,
                                       size_t record_len);

/* Opt-in performance sampling gate and per-stage microsecond attribution.
 * Order of out_timings[8]: js_tick, live2d_update, live2d_emit, relayout,
 * draw_decode, splice, encode, other. */
void pocket_set_perf_sampling_enabled(uint32_t enabled);
uint32_t pocket_is_perf_sampling_enabled(void);
void pocket_record_live2d_update_ns(uint64_t nanos);
uint32_t pocket_last_frame_stage_timings_us(const HostState *handle,
                                            uint64_t *out_timings);

/* The returned string is borrowed and remains valid until the next host call. */
const char *pocket_last_error(HostState *handle);
void pocket_destroy(HostState *handle);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* POCKET_FLUTTER_H */
