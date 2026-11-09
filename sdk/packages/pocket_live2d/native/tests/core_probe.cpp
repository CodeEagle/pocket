#include "pocket_live2d_core.h"

#include <Live2DCubismCore.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

namespace {

struct DrawableCopy {
  int texture_index;
  int render_order;
  int blend_mode;
  uint8_t constant_flags;
  uint8_t dynamic_flags;
  std::vector<float> positions;
  std::vector<float> uvs;
  std::vector<uint16_t> indices;
  std::vector<int32_t> masks;
};

std::vector<uint8_t> read_file(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) throw std::runtime_error("could not open MOC3 file: " + path);
  return std::vector<uint8_t>(std::istreambuf_iterator<char>(file), {});
}

std::vector<DrawableCopy> copy_drawables(PocketLive2dModel* model) {
  const int count = pocket_live2d_model_get_drawable_count(model);
  if (count <= 0) throw std::runtime_error("Core model contains no drawables");
  std::vector<DrawableCopy> result;
  result.reserve(static_cast<size_t>(count));
  for (int index = 0; index < count; ++index) {
    PocketLive2dDrawableInfo drawable{};
    if (pocket_live2d_model_get_drawable(model, index, &drawable) != POCKET_LIVE2D_OK) {
      throw std::runtime_error("could not read drawable metadata");
    }
    if (drawable.vertex_count < 0 || drawable.index_count < 0 || drawable.mask_count < 0 ||
        (drawable.vertex_count > 0 &&
         (drawable.positions_xy_pixels == nullptr || drawable.uvs == nullptr)) ||
        (drawable.index_count > 0 && drawable.indices == nullptr) ||
        (drawable.mask_count > 0 && drawable.mask_indices == nullptr)) {
      throw std::runtime_error("Core returned an invalid drawable mesh buffer");
    }
    DrawableCopy copy{
      drawable.texture_index,
      drawable.render_order,
      drawable.blend_mode,
      drawable.constant_flags,
      drawable.dynamic_flags,
      std::vector<float>(drawable.positions_xy_pixels, drawable.positions_xy_pixels + drawable.vertex_count * 2),
      std::vector<float>(drawable.uvs, drawable.uvs + drawable.vertex_count * 2),
      std::vector<uint16_t>(drawable.indices, drawable.indices + drawable.index_count),
      std::vector<int32_t>(),
    };
    if (drawable.mask_count > 0) {
      if (drawable.mask_indices == nullptr) throw std::runtime_error("masked drawable had no mask index array");
      copy.masks.assign(drawable.mask_indices, drawable.mask_indices + drawable.mask_count);
    }
    for (const auto vertex_index : copy.indices) {
      if (vertex_index >= drawable.vertex_count) throw std::runtime_error("Core returned an out-of-range mesh index");
    }
    result.push_back(std::move(copy));
  }
  return result;
}

struct Metrics {
  uint32_t core_version;
  int32_t moc_version;
  PocketLive2dCanvasInfo canvas;
  int parameter_count;
  int drawable_count;
  int masked_drawable_count;
  int inverted_mask_drawable_count;
  int non_normal_blend_drawable_count;
  size_t native_bytes;
  size_t index_count;
  size_t vertex_count;
  size_t moved_vertex_count;
  double max_vertex_delta;
  bool reset_restored_defaults;
};

Metrics run_once(const std::vector<uint8_t>& bytes) {
  char error[512] = {};
  PocketLive2dModel* model = pocket_live2d_model_create(bytes.data(), bytes.size(), error, sizeof(error));
  if (model == nullptr) throw std::runtime_error(std::string("Core model creation failed: ") + error);
  try {
    PocketLive2dCanvasInfo canvas{};
    if (pocket_live2d_model_get_canvas(model, &canvas) != POCKET_LIVE2D_OK) {
      throw std::runtime_error("Core canvas read failed");
    }
    const auto before = copy_drawables(model);
    bool found_angle_x = false;
    const int parameter_count = pocket_live2d_model_get_parameter_count(model);
    for (int index = 0; index < parameter_count; ++index) {
      PocketLive2dParameterInfo parameter{};
      if (pocket_live2d_model_get_parameter(model, index, &parameter) != POCKET_LIVE2D_OK) {
        throw std::runtime_error("Core parameter read failed");
      }
      if (parameter.id != nullptr && std::string(parameter.id) == "ParamAngleX") {
        if (pocket_live2d_model_set_parameter(model, parameter.id, parameter.maximum) != POCKET_LIVE2D_OK) {
          throw std::runtime_error("Core parameter write failed");
        }
        found_angle_x = true;
        break;
      }
    }
    if (!found_angle_x) throw std::runtime_error("sample model does not expose ParamAngleX");
    if (pocket_live2d_model_update(model) != POCKET_LIVE2D_OK) throw std::runtime_error("Core deformation update failed");
    const auto after = copy_drawables(model);
    if (before.size() != after.size()) throw std::runtime_error("drawable count changed unexpectedly");

    Metrics metrics{
      pocket_live2d_core_version(),
      pocket_live2d_moc_version(model),
      canvas,
      parameter_count,
      static_cast<int>(after.size()),
      0,
      0,
      0,
      pocket_live2d_model_native_bytes(model),
      0,
      0,
      0,
      0.0,
      false,
    };
    for (size_t drawable_index = 0; drawable_index < after.size(); ++drawable_index) {
      const auto& left = before[drawable_index];
      const auto& right = after[drawable_index];
      if (left.positions.size() != right.positions.size()) throw std::runtime_error("vertex count changed unexpectedly");
      if (left.uvs != right.uvs || left.indices != right.indices || left.masks != right.masks) {
        throw std::runtime_error("Cubism static UV/index/mask topology changed after parameter update");
      }
      metrics.index_count += right.indices.size();
      metrics.vertex_count += right.positions.size() / 2;
      if (!right.masks.empty()) ++metrics.masked_drawable_count;
      if ((right.constant_flags & csmIsInvertedMask) != 0) ++metrics.inverted_mask_drawable_count;
      if ((right.blend_mode & 0xFF) != csmColorBlendType_Normal || ((right.blend_mode >> 8) & 0xFF) != csmAlphaBlendType_Over) {
        ++metrics.non_normal_blend_drawable_count;
      }
      for (size_t component = 0; component < right.positions.size(); ++component) {
        const double delta = std::abs(static_cast<double>(right.positions[component] - left.positions[component]));
        if (delta > 0.001) ++metrics.moved_vertex_count;
        metrics.max_vertex_delta = std::max(metrics.max_vertex_delta, delta);
      }
    }
    if (metrics.max_vertex_delta <= 0.001 || metrics.moved_vertex_count == 0) {
      throw std::runtime_error("ParamAngleX did not produce changed Core mesh coordinates");
    }
    if (pocket_live2d_model_reset_to_defaults(model) != POCKET_LIVE2D_OK ||
        pocket_live2d_model_update(model) != POCKET_LIVE2D_OK) {
      throw std::runtime_error("Core default reset failed");
    }
    const auto restored = copy_drawables(model);
    for (size_t drawable_index = 0; drawable_index < before.size(); ++drawable_index) {
      if (before[drawable_index].uvs != restored[drawable_index].uvs ||
          before[drawable_index].indices != restored[drawable_index].indices ||
          before[drawable_index].masks != restored[drawable_index].masks) {
        throw std::runtime_error("Core default reset changed static Drawable topology");
      }
      if (before[drawable_index].positions.size() != restored[drawable_index].positions.size()) {
        throw std::runtime_error("default reset changed the mesh buffer size");
      }
      for (size_t component = 0; component < before[drawable_index].positions.size(); ++component) {
        if (std::abs(static_cast<double>(before[drawable_index].positions[component] -
                                         restored[drawable_index].positions[component])) > 0.001) {
          throw std::runtime_error("Core default reset did not restore initial mesh coordinates");
        }
      }
    }
    metrics.reset_restored_defaults = true;
    pocket_live2d_model_destroy(model);
    return metrics;
  } catch (...) {
    pocket_live2d_model_destroy(model);
    throw;
  }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << "usage: pocket_live2d_core_probe MODEL.moc3 [--repeat N]\n";
    return 2;
  }
  int repeat = 1;
  for (int index = 2; index + 1 < argc; ++index) {
    if (std::string(argv[index]) == "--repeat") repeat = std::max(1, std::stoi(argv[index + 1]));
  }
  try {
    const auto bytes = read_file(argv[1]);
    Metrics metrics{};
    for (int iteration = 0; iteration < repeat; ++iteration) metrics = run_once(bytes);
    std::cout << "{\"coreVersion\":" << metrics.core_version
              << ",\"mocVersion\":" << metrics.moc_version
              << ",\"canvas\":{" << "\"widthPixels\":" << metrics.canvas.width_pixels
              << ",\"heightPixels\":" << metrics.canvas.height_pixels
              << ",\"originX\":" << metrics.canvas.origin_x_pixels
              << ",\"originY\":" << metrics.canvas.origin_y_pixels
              << ",\"pixelsPerUnit\":" << metrics.canvas.pixels_per_unit << "}"
              << ",\"parameters\":" << metrics.parameter_count
              << ",\"drawables\":" << metrics.drawable_count
              << ",\"vertices\":" << metrics.vertex_count
              << ",\"indices\":" << metrics.index_count
              << ",\"maskedDrawables\":" << metrics.masked_drawable_count
              << ",\"invertedMaskDrawables\":" << metrics.inverted_mask_drawable_count
              << ",\"nonNormalBlendDrawables\":" << metrics.non_normal_blend_drawable_count
              << ",\"accountedNativeBytes\":" << metrics.native_bytes
              << ",\"movedVertexComponents\":" << metrics.moved_vertex_count
              << ",\"maxVertexDeltaPixels\":" << metrics.max_vertex_delta
              << ",\"resetRestoredDefaults\":" << (metrics.reset_restored_defaults ? "true" : "false")
              << ",\"createdUpdatedDestroyedModels\":" << repeat << "}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
