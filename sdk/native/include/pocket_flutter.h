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

int32_t pocket_eval(HostState *handle, const char *source);
int32_t pocket_load(HostState *handle, const char *source,
                    const uint8_t *pak, size_t pak_len);
int32_t pocket_load_bytecode(HostState *handle, const uint8_t *bytecode,
                             size_t bytecode_len, const uint8_t *pak,
                             size_t pak_len);

/* The returned string is borrowed and remains valid until the next host call. */
const char *pocket_last_error(HostState *handle);
void pocket_destroy(HostState *handle);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* POCKET_FLUTTER_H */
