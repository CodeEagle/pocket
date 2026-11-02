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
    for dart_file in dart_files:
        rel = dart_file.relative_to(DEMOROOT)
        if dart_file.name != "main.dart":
            errors.append(f"forbidden extra Dart file in demo host: {rel}")
            continue
        lines = dart_file.read_text(errors="replace").splitlines()
        if len(lines) > 50:
            errors.append(f"demo main.dart exceeds thin host limit (max 50 lines, got {len(lines)}): {rel}")
        source = "\n".join(lines)
        for pattern in [r"Navigator\.", r"\bCounter\b", r"case\s+['\"]View\.", r"PocketUiNode", r"\bStatefulWidget\b", r"\bsetState\b"]:
            if re.search(pattern, source):
                errors.append(f"Flutter demo owns application behavior ({pattern}): {rel}")
if (DEMOROOT / "pubspec.yaml").exists() and "assets/app.js" in (DEMOROOT / "pubspec.yaml").read_text():
    errors.append("demo host ships JS source instead of bytecode-only entry")

if errors:
    raise SystemExit("\n".join(errors))
print("Architecture boundary passed: SDK/demo entries are present; SDK has no demo dependency or legacy business renderer.")
