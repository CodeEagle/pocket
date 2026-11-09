# Flutter FFI plugin shared build for Android and Windows.
cmake_minimum_required(VERSION 3.10)
project(pocket_live2d LANGUAGES CXX)

get_filename_component(PACKAGE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
if(NOT CUBISM_SDK_ROOT)
  set(CUBISM_SDK_ROOT "${PACKAGE_ROOT}/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5")
endif()

set(CUBISM_INCLUDE_DIR "${CUBISM_SDK_ROOT}/Core/include")
set(POCKET_LIVE2D_SOURCE "${PACKAGE_ROOT}/native/src/pocket_live2d_core.cpp")
set(POCKET_LIVE2D_INCLUDE "${PACKAGE_ROOT}/native/include")
if(NOT EXISTS "${CUBISM_INCLUDE_DIR}/Live2DCubismCore.h")
  message(FATAL_ERROR "Cubism Core header missing. Run scripts/bootstrap_cubism_core.sh after accepting the official development terms.")
endif()

if(ANDROID)
  if(NOT ANDROID_ABI STREQUAL "arm64-v8a")
    message(FATAL_ERROR "Pocket Live2D currently supports Android arm64-v8a only; got ${ANDROID_ABI}.")
  endif()
  set(CUBISM_CORE_LIBRARY "${CUBISM_SDK_ROOT}/Core/lib/android/arm64-v8a/libLive2DCubismCore.a")
  if(NOT EXISTS "${CUBISM_CORE_LIBRARY}")
    message(FATAL_ERROR "Android arm64-v8a Cubism Core archive missing from ${CUBISM_SDK_ROOT}.")
  endif()
  add_library(pocket_live2d SHARED "${POCKET_LIVE2D_SOURCE}")
  target_include_directories(pocket_live2d PRIVATE "${POCKET_LIVE2D_INCLUDE}" "${CUBISM_INCLUDE_DIR}")
  # The official Android Core archive writes through Android's native logger.
  # Keep that platform dependency explicit so the shared FFI bridge resolves it
  # at link time instead of relying on an app's other plugins to pull it in.
  target_link_libraries(pocket_live2d PRIVATE "${CUBISM_CORE_LIBRARY}" log)
  target_compile_features(pocket_live2d PRIVATE cxx_std_17)
  set_target_properties(pocket_live2d PROPERTIES OUTPUT_NAME "pocket_live2d")
elseif(WIN32)
  if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "Pocket Live2D currently supports Windows x86_64 only.")
  endif()
  set(CUBISM_CORE_IMPORT_LIBRARY "${CUBISM_SDK_ROOT}/Core/dll/windows/x86_64/Live2DCubismCore.lib")
  set(CUBISM_CORE_DLL "${CUBISM_SDK_ROOT}/Core/dll/windows/x86_64/Live2DCubismCore.dll")
  if(NOT EXISTS "${CUBISM_CORE_IMPORT_LIBRARY}" OR NOT EXISTS "${CUBISM_CORE_DLL}")
    message(FATAL_ERROR "Windows x86_64 Cubism Core import library or DLL missing from ${CUBISM_SDK_ROOT}.")
  endif()
  add_library(cubism_core SHARED IMPORTED GLOBAL)
  set_target_properties(cubism_core PROPERTIES
    IMPORTED_IMPLIB "${CUBISM_CORE_IMPORT_LIBRARY}"
    IMPORTED_LOCATION "${CUBISM_CORE_DLL}")
  add_library(pocket_live2d SHARED "${POCKET_LIVE2D_SOURCE}")
  target_include_directories(pocket_live2d PRIVATE "${POCKET_LIVE2D_INCLUDE}" "${CUBISM_INCLUDE_DIR}")
  target_link_libraries(pocket_live2d PRIVATE cubism_core)
  target_compile_features(pocket_live2d PRIVATE cxx_std_17)
  set_target_properties(pocket_live2d PROPERTIES OUTPUT_NAME "pocket_live2d")
  add_custom_command(TARGET pocket_live2d POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CUBISM_CORE_DLL}" "$<TARGET_FILE_DIR:pocket_live2d>")
  set(pocket_live2d_bundled_libraries
    "$<TARGET_FILE:pocket_live2d>"
    "${CUBISM_CORE_DLL}"
    PARENT_SCOPE)
else()
  message(FATAL_ERROR "pocket_live2d native target supports Android arm64-v8a and Windows x86_64.")
endif()
