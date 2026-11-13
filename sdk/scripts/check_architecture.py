#!/usr/bin/env python3
"""Guard the two-entry layout: SDK is reusable, demo is its consumer."""

from pathlib import Path
import re

SDKROOT = Path(__file__).resolve().parents[1]
REPOROOT = SDKROOT.parent
DEMOROOT = REPOROOT / "demo"
DEMO_JS = DEMOROOT / "js"
errors: list[str] = []

sdk_required = [
    "lib/pocket_sdk.dart",
    "pubspec.yaml",
    "native/src/lib.rs",
    "native/src/bytecode.rs",
    "packages/pocket_flutter/lib/src/pocket_runtime.dart",
    "packages/pocket_services/lib/pocket_services.dart",
    "packages/pocket_hardware/lib/pocket_hardware.dart",
    "packages/pocket_ui/src/index.ts",
    "scripts/prepare_upstream.py",
    "scripts/build_guest.ts",
    "pocket.ts",
]
demo_required = [
    "js/app.tsx",
    "js/pocket.json",
    "js/manifest.json",
    "lib/main.dart",
    "pubspec.yaml",
]
for name in sdk_required:
    if not (SDKROOT / name).is_file():
        errors.append(f"missing SDK entry: {name}")
for name in demo_required:
    if not (DEMOROOT / name).is_file():
        errors.append(f"missing demo entry: {name}")

legacy_names = {
    "pocketjs_bundle_runner.dart", "pocket_ui_components.dart",
    "pocket_game_container.dart", "pocket_navigation.dart",
    "pocket_game_config.dart", "pocket_plugin.dart", "pocket_update.dart",
    "pocket_runtime_multi.c",
}
for base in [SDKROOT / "lib", SDKROOT / "packages/pocket_flutter", SDKROOT / "native/src"]:
    if not base.exists():
        continue
    for path in base.rglob("*"):
        if path.name in legacy_names:
            errors.append(f"non-minimal module: {path.relative_to(REPOROOT)}")

# Native hardware is an explicit consumer dependency, never a core transitive one.
if re.search(r"^  pocket_hardware:", (SDKROOT / "pubspec.yaml").read_text(), re.M):
    errors.append("core SDK must not statically depend on optional hardware")
if "package:pocket_hardware/" in (SDKROOT / "lib/pocket_sdk.dart").read_text():
    errors.append("core SDK must not re-export optional hardware")

hardware_modules = {"camera", "bluetooth", "sensors", "location", "biometrics", "weather"}
optional_packages = {f"pocket_{name}" for name in hardware_modules} | {"pocket_permissions", "pocket_dio", "pocket_clipboard"}
for package in optional_packages:
    if re.search(rf"^  {package}:", (SDKROOT / "pubspec.yaml").read_text(), re.M):
        errors.append(f"core SDK must not statically depend on optional {package}")
for name in hardware_modules:
    package = SDKROOT / f"packages/pocket_{name}"
    dependencies = (package / "pubspec.yaml").read_text()
    for other in hardware_modules - {name}:
        if re.search(rf"^  pocket_{other}:", dependencies, re.M):
            errors.append(f"pocket_{name} must not pull in unrelated pocket_{other}")
    if re.search(r"^  pocket_hardware:", dependencies, re.M):
        errors.append(f"pocket_{name} must not depend on the hardware aggregate")
for base in ("pocket_hardware_core", "pocket_hardware"):
    if re.search(r"^  plugin:", (SDKROOT / f"packages/{base}/pubspec.yaml").read_text(), re.M):
        errors.append(f"{base} must not retain a second native hardware implementation")

sdk_production = [SDKROOT / "lib", SDKROOT / "packages"]
source_roots = [*sdk_production, SDKROOT / "native/src", SDKROOT / "scripts", DEMO_JS, DEMOROOT / "lib"]
source_suffixes = {".dart", ".ts", ".tsx", ".rs"}
legacy_root_path = re.compile(
    r'''["'`](?:[^"'`]*[/\\])?(?:guest|host)/[^\s"'`]+["'`]'''
    r'''|["'`][^"'`]*pocket/(?:guest|host)/[^\s"'`]+["'`]'''
)
for base in source_roots:
    if not base.exists():
        continue
    for path in base.rglob("*"):
        if "node_modules" in path.parts or not path.is_file() or path.suffix not in source_suffixes:
            continue
        source = path.read_text(errors="replace")
        if re.search(r"(?:import|export|path\s*=).*?(?:PocketTemplates|PocketPlugins|PocketEditor|TryJoyMono|/Volumes/)", source):
            errors.append(f"absolute/sibling source dependency: {path.relative_to(REPOROOT)}")
        if path.is_relative_to(sdk_production[0]) or path.is_relative_to(sdk_production[1]):
            if re.search(r"(?:import|export)\s+[^;]*(?:demo/|\.\./demo/|/demo/)", source):
                errors.append(f"SDK depends on demo internals: {path.relative_to(REPOROOT)}")
            if legacy_root_path.search(source):
                errors.append(f"SDK depends on legacy guest/host root: {path.relative_to(REPOROOT)}")
        if "simulateWatchdogCheck" in source or "PocketSyslibAotBundle" in source:
            errors.append(f"legacy simulation: {path.relative_to(REPOROOT)}")

demo_lib = DEMOROOT / "lib"
if demo_lib.exists():
    dart_files = sorted(demo_lib.rglob("*.dart"))
    flutter_diagnostic_name = "flutter_frame_monitor.dart"
    for dart_file in dart_files:
        rel = dart_file.relative_to(DEMOROOT)
        rel_to_lib = dart_file.relative_to(demo_lib).as_posix()
        if rel_to_lib == "main.dart":
            lines = dart_file.read_text(errors="replace").splitlines()
            # A System host also declares trusted compiled asset paths for child apps.
            # Keep one thin entry; this budget includes that static configuration.
            if len(lines) > 100:
                errors.append(f"demo main.dart exceeds thin host limit (max 100 lines, got {len(lines)}): {rel}")
            source = "\n".join(lines)
            for pattern in [r"Navigator\.", r"\bCounter\b", r"case\s+['\"]View\.", r"PocketUiNode", r"\bStatefulWidget\b", r"\bsetState\b"]:
                if re.search(pattern, source):
                    errors.append(f"Flutter demo owns application behavior ({pattern}): {rel}")
            continue
        if rel_to_lib != flutter_diagnostic_name:
            errors.append(f"forbidden extra Dart file in demo host: {rel}")
            continue
        source = dart_file.read_text(errors="replace")
        # Allow only the shared frame-monitor compatibility re-export from pocket_flutter.
        sanitized = re.sub(
            r"^\s*export\s+['\"]package:pocket_flutter/pocket_flutter\.dart['\"]\s+show\s+FlutterFrameMonitor\b[^;]*;",
            "",
            source,
            flags=re.M | re.S,
        )
        if re.search(r"^\s*(?:import|export)\s+['\"]package:pocket_[^'\"]+['\"]", sanitized, re.M):
            errors.append(f"Flutter diagnostic must not import Pocket SDK or host packages: {rel}")
        if re.search(r"^\s*(?:import|export)\s+['\"](?:\.\.?/)*main\.dart['\"]", source, re.M):
            errors.append(f"Flutter diagnostic must not import the business host entry: {rel}")
if (DEMOROOT / "pubspec.yaml").exists() and "assets/app.js" in (DEMOROOT / "pubspec.yaml").read_text():
    errors.append("demo host ships JS source instead of bytecode-only entry")

if errors:
    raise SystemExit("\n".join(errors))
print("Architecture boundary passed: SDK/demo entries are present; SDK has no demo dependency or legacy business renderer.")
