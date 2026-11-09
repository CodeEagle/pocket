# FFI plugin CMake entry point; the shared native source also builds for Android.
cmake_minimum_required(VERSION 3.14)
set(PROJECT_NAME "pocket_live2d")
project(${PROJECT_NAME} LANGUAGES CXX)

add_subdirectory("${CMAKE_CURRENT_SOURCE_DIR}/../src" "${CMAKE_CURRENT_BINARY_DIR}/shared")

set(pocket_live2d_bundled_libraries
  ${pocket_live2d_bundled_libraries}
  PARENT_SCOPE
)
