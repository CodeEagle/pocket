cmake_minimum_required(VERSION 3.20)
project(pocket_live2d_core LANGUAGES CXX)

if(NOT APPLE)
  message(FATAL_ERROR "The reproducible Core adapter/probe currently supports macOS only.")
endif()
if(NOT CMAKE_OSX_ARCHITECTURES)
  set(CMAKE_OSX_ARCHITECTURES arm64)
endif()
if(NOT CUBISM_SDK_ROOT)
  get_filename_component(PACKAGE_ROOT "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
  set(CUBISM_SDK_ROOT "${PACKAGE_ROOT}/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5")
endif()

set(CUBISM_INCLUDE_DIR "${CUBISM_SDK_ROOT}/Core/include")
set(CUBISM_CORE_LIBRARY "${CUBISM_SDK_ROOT}/Core/lib/macos/arm64/libLive2DCubismCore.a")
if(NOT EXISTS "${CUBISM_INCLUDE_DIR}/Live2DCubismCore.h" OR NOT EXISTS "${CUBISM_CORE_LIBRARY}")
  message(FATAL_ERROR "CUBISM_SDK_ROOT does not contain the official macOS arm64 Core header and archive.")
endif()

add_library(pocket_live2d_core STATIC src/pocket_live2d_core.cpp)
target_include_directories(pocket_live2d_core PUBLIC include PRIVATE "${CUBISM_INCLUDE_DIR}")
target_compile_features(pocket_live2d_core PUBLIC cxx_std_17)
target_link_libraries(pocket_live2d_core PUBLIC "${CUBISM_CORE_LIBRARY}")
set_target_properties(pocket_live2d_core PROPERTIES POSITION_INDEPENDENT_CODE ON)

# Local FFI integration tests use the same C ABI as the Flutter plugin, loaded
# dynamically from this developer build. It is never copied into package source.
add_library(pocket_live2d_ffi SHARED src/pocket_live2d_core.cpp)
target_include_directories(pocket_live2d_ffi PRIVATE include "${CUBISM_INCLUDE_DIR}")
target_compile_features(pocket_live2d_ffi PRIVATE cxx_std_17)
target_link_libraries(pocket_live2d_ffi PRIVATE "${CUBISM_CORE_LIBRARY}")
set_target_properties(pocket_live2d_ffi PROPERTIES OUTPUT_NAME "pocket_live2d_ffi")

add_executable(pocket_live2d_core_probe tests/core_probe.cpp)
target_include_directories(pocket_live2d_core_probe PRIVATE "${CUBISM_INCLUDE_DIR}")
target_link_libraries(pocket_live2d_core_probe PRIVATE pocket_live2d_core)
target_compile_features(pocket_live2d_core_probe PRIVATE cxx_std_17)
target_compile_options(pocket_live2d_core_probe PRIVATE -Wall -Wextra -Wpedantic)
