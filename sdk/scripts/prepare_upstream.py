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
    ("guest-exception-diagnostics.patch", "guest exception diagnostics"),
    ("guest-exception-diagnostics-tests.patch", "guest exception diagnostics tests"),
    ("tex-quad-fractional-coverage.patch", "TEX_QUAD coverage"),
    ("rgba-tileset.patch", "RGBA TILESET"),
    ("rgba-filter-helpers.patch", "RGBA filter helper"),
    ("demand-scheduler.patch", "demand scheduler"),
    ("offload-cancel.patch", "offload provider cancellation"),
)

# Later patches can intentionally supersede one earlier diff hunk. The
# per-file patcher still requires every other file section to match in either
# direction; these markers are only for that declared overlap.
SUPERSEDED_PATCH_MARKERS = {
    "guest stack size": {
        "engine/guest-rquickjs/src/lib.rs": (
            "// Keep QuickJS's stack guard bounded while allowing the generated",
            "// Solid mount graph to resolve its initial reactive styles.",
            "runtime.set_max_stack_size(4 * 1024 * 1024);",
        ),
    },
    "guest execution budget": {
        "engine/guest-rquickjs/src/lib.rs": (
            # The diagnostics patch deliberately replaces several execution-
            # budget hunks. Accept that overlap only when the complete final
            # contract is present: every guest entry resets its own 5s/250ms
            # turn, the host-side pending-job drain checks the same deadline,
            # and shutdown clears both deadline and interruption state.
            "fn initialize(\n        &mut self,\n        ops: OpContext,\n        environment: &GuestEnvironment<'_>,\n    ) -> Result<(), RuntimeError> {",
            "self.begin_turn(Duration::from_secs(5));\n        let context = self.remember(Context::full(&runtime))?;",
            "fn begin_turn(&self, duration: Duration) {\n        self.turn_interrupted.store(false, Ordering::Release);\n        *self.turn_deadline.lock().unwrap() = Some(Instant::now() + duration);\n    }",
            "fn evaluate(&mut self, code: &[u8]) -> Result<(), RuntimeError> {\n        self.begin_turn(Duration::from_secs(5));",
            "fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {\n        self.begin_turn(Duration::from_millis(250));",
            'runtime.set_interrupt_handler(Some(Box::new(move || {',
            'self.turn_deadline.lock().unwrap().is_some_and(|end| Instant::now() >= end)',
            'interrupted.store(true, Ordering::Release);',
            'while runtime.is_job_pending() {',
            'self.turn_interrupted.store(true, Ordering::Release);\n                    self.last_error = Some(',
            'fn shutdown(&mut self) {\n        *self.turn_deadline.lock().unwrap() = None;\n        self.turn_interrupted.store(false, Ordering::Release);',
        ),
    },
    "guest QuickJS bytecode": {
        "engine/guest-rquickjs/src/lib.rs": (
            "pub fn evaluate_bytecode(&mut self, bytecode: &[u8], tick_hz: u32)",
            "qjs::JS_ReadObject(",
            "qjs::JS_EvalFunction(ctx.as_raw().as_ptr(), value)",
        ),
    },
    "demand scheduler": {
        "framework/src/offload.ts": (
            "const eventDriven = () =>",
            "registerServicePump(() => next.step(), () => next.needsPump());",
        ),
    },
}

FINAL_CONTRACTS = {
    "framework/src/services.ts": (
        "export function registerServicePump(pump: ServicePump, pending: PendingWork = () => true): () => void {",
        "export function hasPendingServiceWork(): boolean",
        "type PendingWork = () => boolean;",
    ),
    "framework/src/offload.ts": (
        "const eventDriven = () =>",
        "registerServicePump(() => next.step(), () => next.needsPump());",
        "ops as OffloadOps & { cancel?:",
        "if (item.sent) (ops as OffloadOps",
    ),
}


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


def patch_sections(patch_bytes: bytes) -> list[tuple[str, bytes]]:
    """Split a unified diff into independently verifiable file sections."""
    lines = patch_bytes.splitlines(keepends=True)
    starts: list[int] = []
    for index, line in enumerate(lines):
        if line.startswith(b"diff --git "):
            starts.append(index)
        elif line.startswith(b"--- ") and (
            index + 1 < len(lines) and lines[index + 1].startswith(b"+++ ")
        ):
            if not starts or not any(
                lines[position].startswith(b"diff --git ")
                for position in range(starts[-1], index + 1)
            ):
                starts.append(index)
    if not starts:
        raise SystemExit("Patch has no unified-diff file sections")

    sections: list[tuple[str, bytes]] = []
    for slot, start in enumerate(starts):
        end = starts[slot + 1] if slot + 1 < len(starts) else len(lines)
        section = b"".join(lines[start:end])
        target: str | None = None
        for line in lines[start:end]:
            if line.startswith(b"+++ b/"):
                target = line[6:].decode("utf-8").strip()
                break
            if line.startswith(b"--- a/"):
                target = line[6:].decode("utf-8").strip()
        if target is None:
            raise SystemExit("Patch section does not identify a target file")
        sections.append((target, section))
    return sections


def run_patch(target: str, section: bytes, *, reverse: bool = False, dry_run: bool = True) -> subprocess.CompletedProcess[bytes]:
    # GNU patch otherwise auto-detects a reversed diff even when --reverse was
    # explicitly requested. That makes an unapplied patch look "already
    # present" and let the bootstrap skip it. --forward disables that fallback
    # for both directions, so a successful dry run proves the requested
    # direction actually matches.
    command = ["patch", "--batch", "--fuzz=0", "--forward", "-p1"]
    if reverse:
        command.append("--reverse")
    if dry_run:
        command.append("--dry-run")
    result = subprocess.run(
        command,
        cwd=CACHE,
        input=section,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    # `patch` still exits zero when --forward skips a previously applied hunk
    # (and with --batch it can also skip a missing file). Treat those reports
    # as a failed directional match instead of trusting its status alone.
    output = result.stdout.lower()
    skipped = (
        b"ignored" in output
        or b"previously applied" in output
        or b"no file to patch" in output
        or b"skipping" in output
        or b" failed" in output
    )
    if result.returncode == 0 and skipped:
        return subprocess.CompletedProcess(result.args, 1, result.stdout, result.stderr)
    return result


def file_has_markers(target_name: str, markers: tuple[str, ...]) -> bool:
    target = CACHE / target_name
    if not target.is_file():
        return False
    content = target.read_text(encoding="utf-8")
    return all(marker in content for marker in markers)


def apply_patch(filename: str, label: str) -> None:
    patch_path = ROOT / "native" / "patches" / filename
    if not patch_path.is_file():
        raise SystemExit(f"Missing required {label} patch: {patch_path}")
    patch_bytes = patch_path.read_bytes()
    superseded = SUPERSEDED_PATCH_MARKERS.get(label, {})
    applied = 0
    already = 0
    for target, section in patch_sections(patch_bytes):
        reverse = run_patch(target, section, reverse=True)
        if reverse.returncode == 0:
            already += 1
            continue

        forward = run_patch(target, section)
        if forward.returncode == 0:
            result = run_patch(target, section, dry_run=False)
            if result.returncode != 0:
                detail = result.stdout.decode("utf-8", errors="replace").strip()
                raise SystemExit(f"{label} patch failed while applying {target}:\n{detail}")
            reverse = run_patch(target, section, reverse=True)
            if reverse.returncode != 0:
                detail = reverse.stdout.decode("utf-8", errors="replace").strip()
                raise SystemExit(f"{label} patch did not verify after applying {target}:\n{detail}")
            applied += 1
            continue

        markers = superseded.get(target)
        if markers and file_has_markers(target, markers):
            already += 1
            print(f"PocketJS {label}: accepted superseded hunk in {target} by explicit contract markers")
            continue

        detail = forward.stdout.decode("utf-8", errors="replace").strip()
        raise SystemExit(
            f"{label} patch is neither fully applicable nor fully present in {target}; "
            f"refusing a partial match:\n{detail}"
        )

    if applied and already:
        print(f"PocketJS {label}: applied {applied} file section(s), verified {already} already-present section(s)")
    elif applied:
        print(f"PocketJS {label}: applied")
    else:
        print(f"PocketJS {label}: already present in {already} file section(s)")


def verify_final_contracts() -> None:
    for target, markers in FINAL_CONTRACTS.items():
        if not file_has_markers(target, markers):
            raise SystemExit(
                f"Pinned PocketJS integration contract is incomplete in {target}; "
                "recheck prepare_upstream patches against the pinned revision"
            )


def main() -> None:
    if not MARKER.is_file() or MARKER.read_text(encoding="utf-8").strip() != REVISION:
        extract_archive()
    else:
        print(f"PocketJS {REVISION}: cache ready")
    for filename, label in PATCHES:
        apply_patch(filename, label)
    verify_final_contracts()


if __name__ == "__main__":
    main()
