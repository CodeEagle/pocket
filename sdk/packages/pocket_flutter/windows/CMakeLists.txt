# Pocket's Windows runtime is built by scripts/build_native_windows.ps1 and
# bundled beside the Flutter runner as a Dart FFI library.
get_filename_component(POCKET_FLUTTER_PACKAGE_DIR "${CMAKE_CURRENT_LIST_DIR}" REALPATH)
set(POCKET_FLUTTER_WINDOWS_DLL "${POCKET_FLUTTER_PACKAGE_DIR}/bin/pocket_flutter.dll")

if(NOT WIN32)
  message(FATAL_ERROR "pocket_flutter/windows can only be configured for Windows")
endif()

if(NOT EXISTS "${POCKET_FLUTTER_WINDOWS_DLL}")
  message(FATAL_ERROR
    "Pocket Windows FFI runtime is missing: ${POCKET_FLUTTER_WINDOWS_DLL}. "
    "Build it with sdk/scripts/build_native_windows.ps1 before building the Flutter app.")
endif()

set(pocket_flutter_bundled_libraries
  "${POCKET_FLUTTER_WINDOWS_DLL}"
  PARENT_SCOPE
)
