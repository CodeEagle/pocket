Pocket Live2D Windows FFI target
================================

The CMake entry point builds the adapter for x86_64 and links the official
Cubism Core DLL/import library from the ignored SDK cache. Run
`scripts/bootstrap_cubism_core.sh` first. CMake bundles `pocket_live2d.dll`
and the matching `Live2DCubismCore.dll` beside the app. ARM64 Windows is not
provided by the pinned Native R5 archive.
