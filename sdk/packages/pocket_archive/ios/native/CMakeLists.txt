cmake_minimum_required(VERSION 3.18)
project(pocket_archive_native LANGUAGES C CXX)

include(${CMAKE_CURRENT_LIST_DIR}/pocket_archive_sources.cmake)
include(${CMAKE_CURRENT_LIST_DIR}/7zip_sources.cmake)
set(POCKET_ARCHIVE_CORE_SOURCES
  ${POCKET_ARCHIVE_SOURCES}
  ${POCKET_ARCHIVE_7ZIP_SOURCES}
)

add_library(pocket_archive_core STATIC ${POCKET_ARCHIVE_CORE_SOURCES})
target_include_directories(pocket_archive_core
  PUBLIC
    ${CMAKE_CURRENT_LIST_DIR}
    ${CMAKE_CURRENT_LIST_DIR}/7zip
)
target_compile_features(pocket_archive_core PUBLIC cxx_std_17)
target_compile_definitions(pocket_archive_core PRIVATE Z7_EXTRACT_ONLY)
set_target_properties(pocket_archive_core PROPERTIES
  POSITION_INDEPENDENT_CODE ON
  C_VISIBILITY_PRESET hidden
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN ON
)
target_compile_options(pocket_archive_core PRIVATE
  -O2
  -ffunction-sections
  -fdata-sections
)

option(POCKET_ARCHIVE_BUILD_SMOKE_TEST
  "Build the native ZIP/7z extraction smoke driver" OFF)

if(POCKET_ARCHIVE_BUILD_SMOKE_TEST)
  add_executable(pocket_archive_smoke tests/pocket_archive_smoke.cpp)
  add_dependencies(pocket_archive_smoke pocket_archive_core)
  target_compile_features(pocket_archive_smoke PRIVATE cxx_std_17)
  target_include_directories(pocket_archive_smoke PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}/src)
  if(APPLE)
    target_link_libraries(pocket_archive_smoke PRIVATE
      pocket_archive_core
      "-Wl,-force_load,$<TARGET_FILE:pocket_archive_core>")
  else()
    target_link_libraries(pocket_archive_smoke PRIVATE
      "-Wl,--whole-archive"
      pocket_archive_core
      "-Wl,--no-whole-archive")
  endif()
endif()
