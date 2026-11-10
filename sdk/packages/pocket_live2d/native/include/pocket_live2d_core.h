#ifndef POCKET_LIVE2D_CORE_H
#define POCKET_LIVE2D_CORE_H

#include <stddef.h>
#include <stdint.h>

#if defined(__GNUC__)
#define POCKET_LIVE2D_EXPORT __attribute__((visibility("default"), used))
#elif defined(_WIN32)
#define POCKET_LIVE2D_EXPORT __declspec(dllexport)
#else
#define POCKET_LIVE2D_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct PocketLive2dModel PocketLive2dModel;

typedef enum PocketLive2dStatus {
  POCKET_LIVE2D_OK = 0,
  POCKET_LIVE2D_INVALID_ARGUMENT = 1,
  POCKET_LIVE2D_INVALID_MOC = 2,
  POCKET_LIVE2D_UNSUPPORTED_MOC_VERSION = 3,
  POCKET_LIVE2D_ALLOCATION_FAILED = 4,
  POCKET_LIVE2D_PARAMETER_NOT_FOUND = 5,
  POCKET_LIVE2D_INTERNAL_ERROR = 6,
  POCKET_LIVE2D_UNSUPPORTED_OFFSCREEN = 7
} PocketLive2dStatus;

typedef struct PocketLive2dCanvasInfo {
  float width_pixels;
  float height_pixels;
  float origin_x_pixels;
  float origin_y_pixels;
  float pixels_per_unit;
} PocketLive2dCanvasInfo;

typedef struct PocketLive2dParameterInfo {
  const char* id;
  float minimum;
  float maximum;
  float default_value;
  float value;
} PocketLive2dParameterInfo;

typedef struct PocketLive2dPartInfo {
  const char* id;
  float default_opacity;
} PocketLive2dPartInfo;

typedef struct PocketLive2dDrawableInfo {
  const char* id;
  int texture_index;
  int draw_order;
  int render_order;
  int blend_mode;
  uint8_t constant_flags;
  uint8_t dynamic_flags;
  float opacity;
  int vertex_count;
  int index_count;
  int mask_count;
  const float* positions_xy_pixels;
  const float* uvs;
  const uint16_t* indices;
  const int32_t* mask_indices;
  const float* multiply_color_rgba;
  const float* screen_color_rgba;
  const uint8_t* pms1_bytes;
  int pms1_byte_count;
} PocketLive2dDrawableInfo;

/*
 * Creates a Core model from caller-owned MOC3 bytes. The bytes are copied into
 * Core-aligned memory and kept alive until destroy. Error text is optional.
 */
POCKET_LIVE2D_EXPORT PocketLive2dModel* pocket_live2d_model_create(
    const uint8_t* moc3_bytes,
    size_t moc3_size,
    char* error_buffer,
    size_t error_capacity);

/* Frees csmModel storage before its backing csmMoc storage. Safe for NULL. */
POCKET_LIVE2D_EXPORT void pocket_live2d_model_destroy(PocketLive2dModel* model);

POCKET_LIVE2D_EXPORT uint32_t pocket_live2d_core_version(void);
POCKET_LIVE2D_EXPORT int32_t pocket_live2d_moc_version(const PocketLive2dModel* model);
POCKET_LIVE2D_EXPORT int32_t pocket_live2d_model_get_canvas(
    const PocketLive2dModel* model,
    PocketLive2dCanvasInfo* output);
POCKET_LIVE2D_EXPORT size_t pocket_live2d_model_native_bytes(
    const PocketLive2dModel* model);

POCKET_LIVE2D_EXPORT int32_t pocket_live2d_model_get_parameter_count(const PocketLive2dModel* model);
POCKET_LIVE2D_EXPORT int32_t pocket_live2d_model_get_parameter(
    const PocketLive2dModel* model,
    int32_t index,
    PocketLive2dParameterInfo* output);
POCKET_LIVE2D_EXPORT int32_t pocket_live2d_model_get_part_count(const PocketLive2dModel* model);
POCKET_LIVE2D_EXPORT int32_t pocket_live2d_model_get_part(
    const PocketLive2dModel* model,
    int32_t index,
    PocketLive2dPartInfo* output);
POCKET_LIVE2D_EXPORT int32_t pocket_live2d_model_reset_to_defaults(
    PocketLive2dModel* model);
POCKET_LIVE2D_EXPORT int32_t pocket_live2d_model_set_parameter(
    PocketLive2dModel* model,
    const char* id,
    float value);
POCKET_LIVE2D_EXPORT int32_t pocket_live2d_model_set_part_opacity(
    PocketLive2dModel* model,
    const char* id,
    float opacity);

/* Runs the official Core deformation pass and refreshes copied drawable data. */
POCKET_LIVE2D_EXPORT int32_t pocket_live2d_model_update(PocketLive2dModel* model);
/* Runs the official Core deformation pass and packs PMS1 mesh bytes per drawable. */
POCKET_LIVE2D_EXPORT int32_t pocket_live2d_model_update_with_placement(
    PocketLive2dModel* model,
    double dx,
    double dy,
    double scale,
    double model_opacity);
POCKET_LIVE2D_EXPORT int32_t pocket_live2d_model_get_drawable_count(const PocketLive2dModel* model);
POCKET_LIVE2D_EXPORT int32_t pocket_live2d_model_get_drawable(
    const PocketLive2dModel* model,
    int32_t index,
    PocketLive2dDrawableInfo* output);

POCKET_LIVE2D_EXPORT const char* pocket_live2d_status_message(int32_t status);

#ifdef __cplusplus
}
#endif

#endif
