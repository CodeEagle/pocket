#!/usr/bin/env python3
"""Bootstrap the pinned PocketJS engine used by the minimal Flutter host.

The extracted cache is intentionally ignored. A clean checkout can recreate it
from the verified archive, while a developer checkout may populate it with a
clone/copy before running this script to avoid downloading the large archive.
"""

from __future__ import annotations

import hashlib
import io
from pathlib import Path
import subprocess
import tarfile
import urllib.request


REVISION = "99924de47c62fa36f526a8791055d91cbbdb3836"
ARCHIVE_SHA256 = "82d5d72ca242b5827379e0e7a53114bc9ee2093af0a9306336a5def543708cba"

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache" / "pocketjs"
MARKER = CACHE / ".pocketjs-revision"

# Only patches that affect the native guest/core contract are applied here.
# Browser-host and catalog/demo patches stay out of this host's bootstrap.
PATCHES = (
    ("guest-rquickjs-stack-size.patch", "guest stack size"),
    ("guest-execution-budget.patch", "guest execution budget"),
    ("guest-rquickjs-bytecode.patch", "guest QuickJS bytecode"),
    ("tex-quad-fractional-coverage.patch", "TEX_QUAD coverage"),
    ("rgba-tileset.patch", "RGBA TILESET"),
    ("rgba-filter-helpers.patch", "RGBA filter helper"),
)


def extract_archive() -> None:
    url = f"https://codeload.github.com/pocket-nexus/pocketjs/tar.gz/{REVISION}"
    print(f"Downloading pinned PocketJS {REVISION} …")
    with urllib.request.urlopen(url, timeout=120) as response:
        archive = response.read()
    digest = hashlib.sha256(archive).hexdigest()
    if digest != ARCHIVE_SHA256:
        raise SystemExit(f"PocketJS archive hash mismatch: {digest}")
    CACHE.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
        for member in package.getmembers():
            relative = Path(*Path(member.name).parts[1:])
            if not relative.parts:
                continue
            if relative.is_absolute() or ".." in relative.parts:
                raise SystemExit(f"Unsafe archive entry: {member.name}")
            # The upstream archive contains documentation links (including an
            # AGENTS.md link). Never follow them into the checkout; no linked
            # entry is required by the native engine.
            if member.issym() or member.islnk():
                continue
            target = CACHE / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                source = package.extractfile(member)
                if source is None:
                    raise SystemExit(f"Unable to read archive entry: {member.name}")
                target.write_bytes(source.read())
    MARKER.write_text(REVISION + "\n", encoding="utf-8")


def apply_patch(filename: str, label: str) -> None:
    patch_path = ROOT / "native" / "patches" / filename
    if not patch_path.is_file():
        raise SystemExit(f"Missing required {label} patch: {patch_path}")
    command = ["patch", "--batch", "--fuzz=0", "-p1"]
    patch_bytes = patch_path.read_bytes()
    forward = subprocess.run(
        [*command, "--forward", "--dry-run"],
        cwd=CACHE,
        input=patch_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if forward.returncode == 0:
        subprocess.run([*command, "--forward"], cwd=CACHE, input=patch_bytes, check=True)
        print(f"PocketJS {label}: applied")
        return
    reverse = subprocess.run(
        [*command, "--reverse", "--dry-run"],
        cwd=CACHE,
        input=patch_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if reverse.returncode == 0:
        print(f"PocketJS {label}: already present")
        return
    # Another pinned contract patch may have inserted lines between this
    # patch's context lines. In that case reverse dry-run cannot recognize a
    # complete application; verify every non-empty added line before failing.
    patch_text = patch_bytes.decode("utf-8")
    sections: dict[str, list[str]] = {}
    current_target: str | None = None
    for line in patch_text.splitlines():
        if line.startswith("+++ b/"):
            current_target = line[6:].strip()
            if current_target not in sections:
                sections[current_target] = []
        elif line.startswith("+") and not line.startswith("+++"):
            added_line = line[1:]
            if added_line and current_target:
                sections[current_target].append(added_line)

    if sections:
        all_matched = True
        for target_name, added_lines in sections.items():
            if not added_lines:
                continue
            target = CACHE / target_name
            if not target.is_file():
                all_matched = False
                break
            body = target.read_text(encoding="utf-8")
            if not all(added_line in body for added_line in added_lines):
                all_matched = False
                break
        if all_matched:
            print(f"PocketJS {label}: already present (content check)")
            return
    detail = forward.stdout.decode("utf-8", errors="replace").strip()
    raise SystemExit(f"{label} patch overlaps the pinned source; refusing overwrite:\n{detail}")


def main() -> None:
    if not MARKER.is_file() or MARKER.read_text(encoding="utf-8").strip() != REVISION:
        extract_archive()
    else:
        print(f"PocketJS {REVISION}: cache ready")
    for filename, label in PATCHES:
        apply_patch(filename, label)


if __name__ == "__main__":
    main()
