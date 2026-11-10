#include "pocket_live2d_core.h"

#include <Live2DCubismCore.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <new>
#include <string>
#include <vector>
#if defined(_WIN32)
#include <malloc.h>
#else
#include <dlfcn.h>
#endif

struct PocketLive2dDrawableStorage {
  std::string id;
  int texture_index = -1;
  int draw_order = 0;
  int render_order = 0;
  int blend_mode = 0;
  uint8_t constant_flags = 0;
  uint8_t dynamic_flags = 0;
  float opacity = 1.0f;
  std::vector<float> positions_xy_pixels;
  std::vector<float> uvs;
  std::vector<uint16_t> indices;
  std::vector<uint32_t> indices_u32;
  std::vector<int32_t> mask_indices;
  float multiply_color_rgba[4] = {1, 1, 1, 1};
  float screen_color_rgba[4] = {0, 0, 0, 1};
  std::vector<uint8_t> pms1_bytes;
};

struct PocketLive2dModel {
  uint8_t* moc_memory = nullptr;
  size_t moc_size = 0;
  size_t model_size = 0;
  void* model_memory = nullptr;
  csmMoc* moc = nullptr;
  csmModel* model = nullptr;
  csmMocVersion moc_version = csmMocVersion_Unknown;
  PocketLive2dCanvasInfo canvas{};
  std::vector<float> default_parameter_values;
  std::vector<float> default_part_opacities;
  std::vector<PocketLive2dDrawableStorage> drawables;
};

namespace {

using PocketIsPerfSamplingEnabledFn = uint32_t (*)(void);
using PocketRecordLive2dUpdateNsFn = void (*)(uint64_t);

struct PerfHooks {
  PocketIsPerfSamplingEnabledFn is_enabled = nullptr;
  PocketRecordLive2dUpdateNsFn record_ns = nullptr;
};

const PerfHooks& get_perf_hooks() {
  static const PerfHooks hooks = []() {
    PerfHooks resolved{};
#if !defined(_WIN32)
    resolved.is_enabled = reinterpret_cast<PocketIsPerfSamplingEnabledFn>(
        dlsym(RTLD_DEFAULT, "pocket_is_perf_sampling_enabled"));
    resolved.record_ns = reinterpret_cast<PocketRecordLive2dUpdateNsFn>(
        dlsym(RTLD_DEFAULT, "pocket_record_live2d_update_ns"));
#endif
    return resolved;
  }();
  return hooks;
}

struct ScopedLive2dPerfTimer {
  const PerfHooks& hooks;
  bool active = false;
  std::chrono::steady_clock::time_point start{};

  ScopedLive2dPerfTimer() : hooks(get_perf_hooks()) {
    if (hooks.is_enabled != nullptr && hooks.record_ns != nullptr && hooks.is_enabled() != 0) {
      active = true;
      start = std::chrono::steady_clock::now();
    }
  }

  ~ScopedLive2dPerfTimer() {
    if (active) {
      const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::steady_clock::now() - start);
      if (elapsed.count() > 0) {
        hooks.record_ns(static_cast<uint64_t>(elapsed.count()));
      }
    }
  }
};

void set_error(char* output, size_t capacity, const char* message) {
  if (output == nullptr || capacity == 0) return;
  const size_t length = std::min(capacity - 1, std::strlen(message));
  std::memcpy(output, message, length);
  output[length] = '\0';
}

bool aligned_allocate(void** output, size_t alignment, size_t size) {
  if (output == nullptr || size == 0) return false;
  *output = nullptr;
#if defined(_WIN32)
  *output = _aligned_malloc(size, alignment);
  return *output != nullptr;
#else
  return posix_memalign(output, alignment, size) == 0 && *output != nullptr;
#endif
}

void aligned_release(void* memory) {
#if defined(_WIN32)
  _aligned_free(memory);
#else
  std::free(memory);
#endif
}

int find_parameter(const PocketLive2dModel* model, const char* id) {
  if (model == nullptr || model->model == nullptr || id == nullptr) return -1;
  const int count = csmGetParameterCount(model->model);
  const char** ids = csmGetParameterIds(model->model);
  if (count < 0 || ids == nullptr) return -1;
  for (int index = 0; index < count; ++index) {
    if (ids[index] != nullptr && std::strcmp(ids[index], id) == 0) return index;
  }
  return -1;
}

int find_part(const PocketLive2dModel* model, const char* id) {
  if (model == nullptr || model->model == nullptr || id == nullptr) return -1;
  const int count = csmGetPartCount(model->model);
  const char** ids = csmGetPartIds(model->model);
  if (count < 0 || ids == nullptr) return -1;
  for (int index = 0; index < count; ++index) {
    if (ids[index] != nullptr && std::strcmp(ids[index], id) == 0) return index;
  }
  return -1;
}

int32_t copy_drawables(
    PocketLive2dModel* owner,
    bool initialize_topology,
    double dx = 0.0,
    double dy = 0.0,
    double scale = 1.0,
    double model_opacity = 1.0) {
  csmModel* model = owner->model;
  const int count = csmGetDrawableCount(model);
  const csmVector2** positions = csmGetDrawableVertexPositions(model);
  const csmVector2** uvs = csmGetDrawableVertexUvs(model);
  const int* vertex_counts = csmGetDrawableVertexCounts(model);
  const unsigned short** indices = csmGetDrawableIndices(model);
  const int* index_counts = csmGetDrawableIndexCounts(model);
  const int* texture_indices = csmGetDrawableTextureIndices(model);
  const int* draw_orders = csmGetDrawableDrawOrders(model);
  const int* render_orders = csmGetRenderOrders(model);
  const int* blend_modes = csmGetDrawableBlendModes(model);
  const float* opacities = csmGetDrawableOpacities(model);
  const int* mask_counts = csmGetDrawableMaskCounts(model);
  const int** masks = csmGetDrawableMasks(model);
  const csmFlags* constant_flags = csmGetDrawableConstantFlags(model);
  const csmFlags* dynamic_flags = csmGetDrawableDynamicFlags(model);
  const csmVector4* multiply_colors = csmGetDrawableMultiplyColors(model);
  const csmVector4* screen_colors = csmGetDrawableScreenColors(model);
  const char** ids = csmGetDrawableIds(model);

  if (count < 0 || positions == nullptr || uvs == nullptr || vertex_counts == nullptr ||
      indices == nullptr || index_counts == nullptr || texture_indices == nullptr ||
      draw_orders == nullptr || render_orders == nullptr || blend_modes == nullptr ||
      opacities == nullptr || mask_counts == nullptr || masks == nullptr ||
      constant_flags == nullptr || dynamic_flags == nullptr || multiply_colors == nullptr ||
      screen_colors == nullptr || ids == nullptr) {
    return POCKET_LIVE2D_INTERNAL_ERROR;
  }

  if (owner->drawables.size() != static_cast<size_t>(count)) owner->drawables.resize(count);
  for (int index = 0; index < count; ++index) {
    const int vertex_count = vertex_counts[index];
    const int index_count = index_counts[index];
    const int mask_count = mask_counts[index];
    if (vertex_count < 0 || index_count < 0 || mask_count < 0 ||
        (vertex_count > 0 && (positions[index] == nullptr || uvs[index] == nullptr)) ||
        (index_count > 0 && indices[index] == nullptr) ||
        (mask_count > 0 && masks[index] == nullptr)) {
      return POCKET_LIVE2D_INTERNAL_ERROR;
    }

    auto& drawable = owner->drawables[static_cast<size_t>(index)];
    drawable.id = ids[index] == nullptr ? "" : ids[index];
    drawable.texture_index = texture_indices[index];
    drawable.draw_order = draw_orders[index];
    drawable.render_order = render_orders[index];
    drawable.blend_mode = blend_modes[index];
    drawable.constant_flags = constant_flags[index];
    drawable.dynamic_flags = dynamic_flags[index];
    drawable.opacity = opacities[index];
    drawable.positions_xy_pixels.resize(static_cast<size_t>(vertex_count) * 2);
    if (initialize_topology) {
      drawable.uvs.resize(static_cast<size_t>(vertex_count) * 2);
      if (index_count > 0) {
        drawable.indices.assign(indices[index], indices[index] + index_count);
        drawable.indices_u32.resize(static_cast<size_t>(index_count));
        for (int i = 0; i < index_count; ++i) {
          if (indices[index][i] >= vertex_count) {
            return POCKET_LIVE2D_INTERNAL_ERROR;
          }
          drawable.indices_u32[static_cast<size_t>(i)] =
              static_cast<uint32_t>(indices[index][i]);
        }
      } else {
        drawable.indices.clear();
        drawable.indices_u32.clear();
      }
      if (vertex_count >= 1 && vertex_count <= 16384 &&
          index_count >= 3 && index_count <= 98304 &&
          index_count % 3 == 0) {
        const size_t pms1_len = 16 + static_cast<size_t>(vertex_count) * 16 +
                                static_cast<size_t>(index_count) * 4;
        drawable.pms1_bytes.resize(pms1_len);
        std::memcpy(
            drawable.pms1_bytes.data() + 16 + static_cast<size_t>(vertex_count) * 16,
            drawable.indices_u32.data(),
            static_cast<size_t>(index_count) * 4);
      } else {
        drawable.pms1_bytes.clear();
      }
      drawable.mask_indices.resize(static_cast<size_t>(mask_count));
    } else if (drawable.uvs.size() != static_cast<size_t>(vertex_count) * 2 ||
               drawable.indices.size() != static_cast<size_t>(index_count) ||
               drawable.mask_indices.size() != static_cast<size_t>(mask_count)) {
      // Cubism documents UVs, indices, and masks as static Drawable data.
      // Topology changing within one loaded MOC would invalidate consumers'
      // cached references, so fail the frame instead of mixing generations.
      return POCKET_LIVE2D_INTERNAL_ERROR;
    }
    const bool has_pms1 = !drawable.pms1_bytes.empty();
    float* pms1_vertices = nullptr;
    if (has_pms1) {
      const double clamped_opacity = std::max(
          0.0,
          std::min(1.0, static_cast<double>(drawable.opacity) * model_opacity));
      const uint32_t opacity_byte =
          static_cast<uint32_t>(std::floor(clamped_opacity * 255.0 + 0.5));
      const uint32_t header[4] = {
          0x31534d50U,
          static_cast<uint32_t>(vertex_count),
          static_cast<uint32_t>(index_count),
          (opacity_byte << 24) | 0x00ffffffU,
      };
      std::memcpy(drawable.pms1_bytes.data(), header, sizeof(header));
      pms1_vertices = reinterpret_cast<float*>(drawable.pms1_bytes.data() + 16);
    }
    for (int vertex = 0; vertex < vertex_count; ++vertex) {
      const size_t offset = static_cast<size_t>(vertex) * 2;
      // Core model coordinates are unit coordinates. The canvas origin is in
      // pixels; convert into a top-left-origin local pixel space for renderers.
      const float px =
          positions[index][vertex].X * owner->canvas.pixels_per_unit + owner->canvas.origin_x_pixels;
      const float py =
          owner->canvas.origin_y_pixels - positions[index][vertex].Y * owner->canvas.pixels_per_unit;
      drawable.positions_xy_pixels[offset] = px;
      drawable.positions_xy_pixels[offset + 1] = py;
      float uv_x;
      float uv_y;
      if (initialize_topology) {
        uv_x = uvs[index][vertex].X;
        uv_y = uvs[index][vertex].Y;
        drawable.uvs[offset] = uv_x;
        drawable.uvs[offset + 1] = uv_y;
      } else {
        uv_x = drawable.uvs[offset];
        uv_y = drawable.uvs[offset + 1];
      }
      if (pms1_vertices != nullptr) {
        const size_t v_offset = static_cast<size_t>(vertex) * 4;
        pms1_vertices[v_offset] = static_cast<float>(dx + static_cast<double>(px) * scale);
        pms1_vertices[v_offset + 1] = static_cast<float>(dy + static_cast<double>(py) * scale);
        pms1_vertices[v_offset + 2] = uv_x;
        pms1_vertices[v_offset + 3] = static_cast<float>(1.0 - static_cast<double>(uv_y));
      }
    }
    if (initialize_topology) {
      for (int mask = 0; mask < mask_count; ++mask) {
        drawable.mask_indices[static_cast<size_t>(mask)] = masks[index][mask];
      }
    }
    drawable.multiply_color_rgba[0] = multiply_colors[index].X;
    drawable.multiply_color_rgba[1] = multiply_colors[index].Y;
    drawable.multiply_color_rgba[2] = multiply_colors[index].Z;
    drawable.multiply_color_rgba[3] = multiply_colors[index].W;
    drawable.screen_color_rgba[0] = screen_colors[index].X;
    drawable.screen_color_rgba[1] = screen_colors[index].Y;
    drawable.screen_color_rgba[2] = screen_colors[index].Z;
    drawable.screen_color_rgba[3] = screen_colors[index].W;
  }
  return POCKET_LIVE2D_OK;
}

int32_t copy_model_defaults(PocketLive2dModel* owner) {
  const int parameter_count = csmGetParameterCount(owner->model);
  const float* parameter_defaults = csmGetParameterDefaultValues(owner->model);
  float* parameters = csmGetParameterValues(owner->model);
  const int part_count = csmGetPartCount(owner->model);
  float* part_opacities = csmGetPartOpacities(owner->model);
  if (parameter_count < 0 || part_count < 0 ||
      (parameter_count > 0 && (parameter_defaults == nullptr || parameters == nullptr)) ||
      (part_count > 0 && part_opacities == nullptr)) {
    return POCKET_LIVE2D_INTERNAL_ERROR;
  }
  if (parameter_count > 0) {
    owner->default_parameter_values.assign(parameter_defaults, parameter_defaults + parameter_count);
    std::copy(owner->default_parameter_values.begin(), owner->default_parameter_values.end(), parameters);
  }
  if (part_count > 0) {
    owner->default_part_opacities.assign(part_opacities, part_opacities + part_count);
  }
  return POCKET_LIVE2D_OK;
}

int32_t check_renderer_requirements(const PocketLive2dModel* owner) {
  const int offscreen_count = csmGetOffscreenCount(owner->model);
  if (offscreen_count < 0) return POCKET_LIVE2D_INTERNAL_ERROR;
  if (offscreen_count > 0) return POCKET_LIVE2D_UNSUPPORTED_OFFSCREEN;
  return POCKET_LIVE2D_OK;
}

}  // namespace

extern "C" {

PocketLive2dModel* pocket_live2d_model_create(
    const uint8_t* bytes,
    size_t size,
    char* error_buffer,
    size_t error_capacity) {
  set_error(error_buffer, error_capacity, "");
  if (bytes == nullptr || size == 0 || size > UINT32_MAX) {
    set_error(error_buffer, error_capacity, "MOC3 bytes and a 32-bit-compatible size are required");
    return nullptr;
  }

  PocketLive2dModel* owner = nullptr;
  try {
    owner = new PocketLive2dModel();
    owner->moc_size = size;
    if (!aligned_allocate(reinterpret_cast<void**>(&owner->moc_memory), csmAlignofMoc, size)) {
      set_error(error_buffer, error_capacity, "Could not allocate Core-aligned MOC memory");
      pocket_live2d_model_destroy(owner);
      return nullptr;
    }
    std::memcpy(owner->moc_memory, bytes, size);
    owner->moc_version = csmGetMocVersion(owner->moc_memory, static_cast<unsigned int>(size));
    if (owner->moc_version == csmMocVersion_Unknown ||
        owner->moc_version > csmGetLatestMocVersion() ||
        !csmHasMocConsistency(owner->moc_memory, static_cast<unsigned int>(size))) {
      set_error(error_buffer, error_capacity, "MOC3 version or consistency check failed");
      pocket_live2d_model_destroy(owner);
      return nullptr;
    }
    owner->moc = csmReviveMocInPlace(owner->moc_memory, static_cast<unsigned int>(size));
    if (owner->moc == nullptr) {
      set_error(error_buffer, error_capacity, "Cubism Core could not revive the MOC3 data");
      pocket_live2d_model_destroy(owner);
      return nullptr;
    }
    owner->model_size = csmGetSizeofModel(owner->moc);
    if (owner->model_size == 0 || !aligned_allocate(&owner->model_memory, csmAlignofModel, owner->model_size)) {
      set_error(error_buffer, error_capacity, "Could not allocate Core-aligned model memory");
      pocket_live2d_model_destroy(owner);
      return nullptr;
    }
    std::memset(owner->model_memory, 0, owner->model_size);
    owner->model = csmInitializeModelInPlace(owner->moc, owner->model_memory, static_cast<unsigned int>(owner->model_size));
    if (owner->model == nullptr) {
      set_error(error_buffer, error_capacity, "Cubism Core could not initialize the model");
      pocket_live2d_model_destroy(owner);
      return nullptr;
    }
    csmVector2 canvas_size{};
    csmVector2 canvas_origin{};
    float pixels_per_unit = 0.0f;
    csmReadCanvasInfo(owner->model, &canvas_size, &canvas_origin, &pixels_per_unit);
    owner->canvas = {canvas_size.X, canvas_size.Y, canvas_origin.X, canvas_origin.Y, pixels_per_unit};
    if (!std::isfinite(pixels_per_unit) || pixels_per_unit <= 0.0f) {
      set_error(error_buffer, error_capacity, "Cubism Core returned invalid canvas information");
      pocket_live2d_model_destroy(owner);
      return nullptr;
    }
    if (copy_model_defaults(owner) != POCKET_LIVE2D_OK) {
      set_error(error_buffer, error_capacity, "Could not read Cubism Core model defaults");
      pocket_live2d_model_destroy(owner);
      return nullptr;
    }
    csmResetDrawableDynamicFlags(owner->model);
    csmUpdateModel(owner->model);
    const int32_t renderer_status = check_renderer_requirements(owner);
    if (renderer_status != POCKET_LIVE2D_OK) {
      set_error(error_buffer, error_capacity,
                renderer_status == POCKET_LIVE2D_UNSUPPORTED_OFFSCREEN
                    ? "MOC requires offscreen compositing that the Pocket renderer does not support"
                    : "Could not inspect Core rendering requirements");
      pocket_live2d_model_destroy(owner);
      return nullptr;
    }
    if (copy_drawables(owner, true) != POCKET_LIVE2D_OK) {
      set_error(error_buffer, error_capacity, "Could not read Core drawable data");
      pocket_live2d_model_destroy(owner);
      return nullptr;
    }
    return owner;
  } catch (const std::bad_alloc&) {
    set_error(error_buffer, error_capacity, "Memory allocation failed while creating the Core model");
  } catch (...) {
    set_error(error_buffer, error_capacity, "Unexpected failure while creating the Core model");
  }
  pocket_live2d_model_destroy(owner);
  return nullptr;
}

void pocket_live2d_model_destroy(PocketLive2dModel* owner) {
  if (owner == nullptr) return;
  if (owner->model_memory != nullptr) aligned_release(owner->model_memory);
  if (owner->moc_memory != nullptr) aligned_release(owner->moc_memory);
  owner->model_memory = nullptr;
  owner->moc_memory = nullptr;
  delete owner;
}

uint32_t pocket_live2d_core_version(void) { return csmGetVersion(); }

int32_t pocket_live2d_moc_version(const PocketLive2dModel* model) {
  return model == nullptr ? POCKET_LIVE2D_INVALID_ARGUMENT : static_cast<int32_t>(model->moc_version);
}

int32_t pocket_live2d_model_get_canvas(const PocketLive2dModel* model, PocketLive2dCanvasInfo* output) {
  if (model == nullptr || output == nullptr) return POCKET_LIVE2D_INVALID_ARGUMENT;
  *output = model->canvas;
  return POCKET_LIVE2D_OK;
}

size_t pocket_live2d_model_native_bytes(const PocketLive2dModel* owner) {
  if (owner == nullptr) return 0;
  size_t bytes = sizeof(PocketLive2dModel) + owner->moc_size + owner->model_size;
  bytes += owner->default_parameter_values.capacity() * sizeof(float);
  bytes += owner->default_part_opacities.capacity() * sizeof(float);
  bytes += owner->drawables.capacity() * sizeof(PocketLive2dDrawableStorage);
  for (const auto& drawable : owner->drawables) {
    bytes += drawable.id.capacity() + 1;
    bytes += drawable.positions_xy_pixels.capacity() * sizeof(float);
    bytes += drawable.uvs.capacity() * sizeof(float);
    bytes += drawable.indices.capacity() * sizeof(uint16_t);
    bytes += drawable.indices_u32.capacity() * sizeof(uint32_t);
    bytes += drawable.mask_indices.capacity() * sizeof(int32_t);
    bytes += drawable.pms1_bytes.capacity();
  }
  return bytes;
}

int32_t pocket_live2d_model_get_parameter_count(const PocketLive2dModel* model) {
  if (model == nullptr || model->model == nullptr) return POCKET_LIVE2D_INVALID_ARGUMENT;
  return csmGetParameterCount(model->model);
}

int32_t pocket_live2d_model_get_parameter(const PocketLive2dModel* owner, int32_t index, PocketLive2dParameterInfo* output) {
  if (owner == nullptr || owner->model == nullptr || output == nullptr) return POCKET_LIVE2D_INVALID_ARGUMENT;
  const int count = csmGetParameterCount(owner->model);
  if (index < 0 || index >= count) return POCKET_LIVE2D_INVALID_ARGUMENT;
  const char** ids = csmGetParameterIds(owner->model);
  const float* minimums = csmGetParameterMinimumValues(owner->model);
  const float* maximums = csmGetParameterMaximumValues(owner->model);
  const float* defaults = csmGetParameterDefaultValues(owner->model);
  const float* values = csmGetParameterValues(owner->model);
  if (ids == nullptr || minimums == nullptr || maximums == nullptr || defaults == nullptr || values == nullptr) return POCKET_LIVE2D_INTERNAL_ERROR;
  *output = {ids[index], minimums[index], maximums[index], defaults[index], values[index]};
  return POCKET_LIVE2D_OK;
}

int32_t pocket_live2d_model_get_part_count(const PocketLive2dModel* owner) {
  if (owner == nullptr || owner->model == nullptr) return -1;
  return csmGetPartCount(owner->model);
}

int32_t pocket_live2d_model_get_part(const PocketLive2dModel* owner, int32_t index, PocketLive2dPartInfo* output) {
  if (owner == nullptr || owner->model == nullptr || output == nullptr) return POCKET_LIVE2D_INVALID_ARGUMENT;
  const int count = csmGetPartCount(owner->model);
  if (index < 0 || index >= count || static_cast<size_t>(index) >= owner->default_part_opacities.size()) return POCKET_LIVE2D_INVALID_ARGUMENT;
  const char** ids = csmGetPartIds(owner->model);
  if (ids == nullptr || ids[index] == nullptr) return POCKET_LIVE2D_INTERNAL_ERROR;
  *output = {ids[index], owner->default_part_opacities[index]};
  return POCKET_LIVE2D_OK;
}

int32_t pocket_live2d_model_reset_to_defaults(PocketLive2dModel* owner) {
  ScopedLive2dPerfTimer timer;
  if (owner == nullptr || owner->model == nullptr) return POCKET_LIVE2D_INVALID_ARGUMENT;
  float* parameters = csmGetParameterValues(owner->model);
  float* part_opacities = csmGetPartOpacities(owner->model);
  if ((!owner->default_parameter_values.empty() && parameters == nullptr) ||
      (!owner->default_part_opacities.empty() && part_opacities == nullptr)) {
    return POCKET_LIVE2D_INTERNAL_ERROR;
  }
  if (!owner->default_parameter_values.empty()) {
    std::copy(owner->default_parameter_values.begin(), owner->default_parameter_values.end(), parameters);
  }
  if (!owner->default_part_opacities.empty()) {
    std::copy(owner->default_part_opacities.begin(), owner->default_part_opacities.end(), part_opacities);
  }
  return POCKET_LIVE2D_OK;
}

int32_t pocket_live2d_model_set_parameter(PocketLive2dModel* owner, const char* id, float value) {
  ScopedLive2dPerfTimer timer;
  if (owner == nullptr || owner->model == nullptr || id == nullptr || !std::isfinite(value)) return POCKET_LIVE2D_INVALID_ARGUMENT;
  const int index = find_parameter(owner, id);
  if (index < 0) return POCKET_LIVE2D_PARAMETER_NOT_FOUND;
  float* values = csmGetParameterValues(owner->model);
  if (values == nullptr) return POCKET_LIVE2D_INTERNAL_ERROR;
  values[index] = value;
  return POCKET_LIVE2D_OK;
}

int32_t pocket_live2d_model_set_part_opacity(PocketLive2dModel* owner, const char* id, float opacity) {
  ScopedLive2dPerfTimer timer;
  if (owner == nullptr || owner->model == nullptr || id == nullptr || !std::isfinite(opacity)) return POCKET_LIVE2D_INVALID_ARGUMENT;
  const int index = find_part(owner, id);
  if (index < 0) return POCKET_LIVE2D_PARAMETER_NOT_FOUND;
  float* values = csmGetPartOpacities(owner->model);
  if (values == nullptr) return POCKET_LIVE2D_INTERNAL_ERROR;
  values[index] = opacity;
  return POCKET_LIVE2D_OK;
}

int32_t pocket_live2d_model_update(PocketLive2dModel* owner) {
  return pocket_live2d_model_update_with_placement(owner, 0.0, 0.0, 1.0, 1.0);
}

int32_t pocket_live2d_model_update_with_placement(
    PocketLive2dModel* owner,
    double dx,
    double dy,
    double scale,
    double model_opacity) {
  ScopedLive2dPerfTimer timer;
  if (owner == nullptr || owner->model == nullptr ||
      !std::isfinite(dx) || !std::isfinite(dy) ||
      !std::isfinite(scale) || scale <= 0.0 ||
      !std::isfinite(model_opacity) || model_opacity < 0.0 || model_opacity > 1.0) {
    return POCKET_LIVE2D_INVALID_ARGUMENT;
  }
  csmResetDrawableDynamicFlags(owner->model);
  csmUpdateModel(owner->model);
  return copy_drawables(owner, false, dx, dy, scale, model_opacity);
}

int32_t pocket_live2d_model_get_drawable_count(const PocketLive2dModel* model) {
  if (model == nullptr) return POCKET_LIVE2D_INVALID_ARGUMENT;
  return static_cast<int32_t>(model->drawables.size());
}

int32_t pocket_live2d_model_get_drawable(const PocketLive2dModel* owner, int32_t index, PocketLive2dDrawableInfo* output) {
  if (owner == nullptr || output == nullptr || index < 0 || static_cast<size_t>(index) >= owner->drawables.size()) return POCKET_LIVE2D_INVALID_ARGUMENT;
  const auto& drawable = owner->drawables[static_cast<size_t>(index)];
  *output = {
      drawable.id.c_str(),
      drawable.texture_index,
      drawable.draw_order,
      drawable.render_order,
      drawable.blend_mode,
      drawable.constant_flags,
      drawable.dynamic_flags,
      drawable.opacity,
      static_cast<int>(drawable.positions_xy_pixels.size() / 2),
      static_cast<int>(drawable.indices.size()),
      static_cast<int>(drawable.mask_indices.size()),
      drawable.positions_xy_pixels.empty() ? nullptr : drawable.positions_xy_pixels.data(),
      drawable.uvs.empty() ? nullptr : drawable.uvs.data(),
      drawable.indices.empty() ? nullptr : drawable.indices.data(),
      drawable.mask_indices.empty() ? nullptr : drawable.mask_indices.data(),
      drawable.multiply_color_rgba,
      drawable.screen_color_rgba,
      drawable.pms1_bytes.empty() ? nullptr : drawable.pms1_bytes.data(),
      static_cast<int>(drawable.pms1_bytes.size()),
  };
  return POCKET_LIVE2D_OK;
}

const char* pocket_live2d_status_message(int32_t status) {
  switch (status) {
    case POCKET_LIVE2D_OK: return "ok";
    case POCKET_LIVE2D_INVALID_ARGUMENT: return "invalid argument";
    case POCKET_LIVE2D_INVALID_MOC: return "invalid MOC3 data";
    case POCKET_LIVE2D_UNSUPPORTED_MOC_VERSION: return "unsupported MOC3 version";
    case POCKET_LIVE2D_ALLOCATION_FAILED: return "allocation failed";
    case POCKET_LIVE2D_PARAMETER_NOT_FOUND: return "parameter or part not found";
    case POCKET_LIVE2D_INTERNAL_ERROR: return "Core returned invalid model data";
    case POCKET_LIVE2D_UNSUPPORTED_OFFSCREEN: return "MOC requires unsupported offscreen compositing";
    default: return "unknown Pocket Live2D error";
  }
}

}  // extern "C"
