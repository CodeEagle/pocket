cmake_minimum_required(VERSION 3.22.1)
project(pocket_archive_android LANGUAGES C CXX)

set(POCKET_ARCHIVE_NATIVE_ROOT "${CMAKE_CURRENT_LIST_DIR}/../ios/native")
add_subdirectory(
  "${POCKET_ARCHIVE_NATIVE_ROOT}"
  "${CMAKE_CURRENT_BINARY_DIR}/pocket_archive_core")

add_library(pocket_archive SHARED src/main/cpp/pocket_archive_jni.cpp)
target_compile_features(pocket_archive PRIVATE cxx_std_17)
target_compile_options(pocket_archive PRIVATE
  -O2
  -ffunction-sections
  -fdata-sections
)
target_include_directories(pocket_archive PRIVATE
  "${POCKET_ARCHIVE_NATIVE_ROOT}/src"
)

# The upstream ZIP decoder registers codecs in static constructors; keep its
# selected registry objects when folding the shared core into the JNI library.
target_link_libraries(pocket_archive PRIVATE
  "-Wl,--whole-archive"
  pocket_archive_core
  "-Wl,--no-whole-archive"
  android
  log
)
target_link_options(pocket_archive PRIVATE
  "-Wl,--gc-sections"
  "-Wl,-z,max-page-size=16384"
)
