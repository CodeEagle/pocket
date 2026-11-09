#!/usr/bin/env python3
"""Run file-based PocketArchive regressions against the compiled native driver."""

from __future__ import annotations

import base64
import hashlib
import json
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo
import stat
import zlib


FIXTURES = Path(__file__).parent / "fixtures"


def load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def decode_fixture(fixture: dict[str, object], path: Path) -> None:
    encoded = fixture["archiveBase64"]
    assert isinstance(encoded, str)
    path.write_bytes(base64.b64decode(encoded, validate=True))


def write_oversized_7z_header(source: Path, destination: Path) -> None:
    """Make a sparse 7z whose declared next-header buffer exceeds the native cap."""
    archive = bytearray(source.read_bytes())
    if archive[:6] != bytes.fromhex("377abcaf271c"):
        raise AssertionError("oversized-header source is not a 7z fixture")
    next_header_offset = struct.unpack_from("<Q", archive, 12)[0]
    oversized_header_size = 64 * 1024 * 1024 + 1
    struct.pack_into("<Q", archive, 20, oversized_header_size)
    struct.pack_into("<I", archive, 8, zlib.crc32(archive[12:32]))
    header_start = 32 + next_header_offset
    with destination.open("wb") as output:
        output.write(archive[:header_start])
        output.truncate(header_start + oversized_header_size)


def invoke(
    driver: Path,
    archive: Path,
    stage: Path,
    max_bytes: int,
    password: str | None = None,
) -> tuple[int, str]:
    command = [str(driver), str(archive), str(stage), str(max_bytes)]
    if password is not None:
        command.append(password)
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    line = next((line for line in result.stdout.splitlines() if line.startswith("result=")), "")
    if not line:
        raise AssertionError(
            f"native driver produced no result line (exit={result.returncode}): "
            f"{result.stdout}{result.stderr}"
        )
    values = dict(part.split("=", 1) for part in line.split())
    return result.returncode, values["error"]


def require_success(
    driver: Path,
    archive: Path,
    stage: Path,
    max_bytes: int,
    expected_file: Path,
    expected_sha256: str,
    password: str | None = None,
) -> None:
    code, error = invoke(driver, archive, stage, max_bytes, password)
    if code != 0 or error != "none":
        raise AssertionError(f"expected success, received exit={code} error={error}")
    digest = hashlib.sha256(expected_file.read_bytes()).hexdigest()
    if digest != expected_sha256:
        raise AssertionError(f"output hash mismatch for {expected_file.name}")


def require_rejected(
    driver: Path,
    archive: Path,
    stage: Path,
    max_bytes: int,
    expected_error: str,
    *,
    password: str | None = None,
    require_empty_stage: bool = True,
) -> None:
    code, error = invoke(driver, archive, stage, max_bytes, password)
    if code == 0 or error != expected_error:
        raise AssertionError(
            f"expected error={expected_error}, received exit={code} error={error}"
        )
    if require_empty_stage and any(stage.iterdir()):
        raise AssertionError(f"rejected archive wrote files into {stage}")


def add_pass(message: str) -> None:
    print(f"PASS {message}")


def run(driver_arg: str) -> None:
    driver = Path(driver_arg).resolve()
    if not driver.is_file():
        raise SystemExit(f"native smoke driver does not exist: {driver}")

    with tempfile.TemporaryDirectory(prefix="pocket-archive-regression-") as temp:
        root = Path(temp)

        for name in ("lzma2_progress.json", "lzma2_distance_one.json"):
            fixture = load_json(FIXTURES / name)
            archive = root / name.replace(".json", ".7z")
            stage = root / f"{archive.stem}-stage"
            stage.mkdir()
            decode_fixture(fixture, archive)
            expected_file = stage / "payload.bin"
            require_success(
                driver,
                archive,
                stage,
                2 * 1024 * 1024,
                expected_file,
                str(fixture["payloadSha256"]),
            )
            add_pass(f"7z solid LZMA2 fixture {archive.stem}")

        limit_fixture = load_json(FIXTURES / "lzma2_progress.json")
        limited_archive = root / "over-limit.7z"
        decode_fixture(limit_fixture, limited_archive)
        limited_stage = root / "over-limit-stage"
        limited_stage.mkdir()
        require_rejected(
            driver,
            limited_archive,
            limited_stage,
            1024,
            "unsafe-or-over-limit-entries",
        )
        add_pass("7z output quota rejected before writing")

        oversized_header_archive = root / "oversized-header.7z"
        write_oversized_7z_header(limited_archive, oversized_header_archive)
        oversized_header_stage = root / "oversized-header-stage"
        oversized_header_stage.mkdir()
        require_rejected(
            driver,
            oversized_header_archive,
            oversized_header_stage,
            2 * 1024 * 1024,
            "7z-header-allocation-limit",
        )
        add_pass("7z declared header allocation cap enforced")

        encrypted_fixture = load_json(FIXTURES / "encrypted_zip.json")
        encrypted_archive = root / "encrypted.zip"
        decode_fixture(encrypted_fixture, encrypted_archive)
        zip_name = str(encrypted_fixture["fileName"])
        encrypted_stage = root / "encrypted-stage"
        encrypted_stage.mkdir()
        expected_file = encrypted_stage / zip_name
        require_success(
            driver,
            encrypted_archive,
            encrypted_stage,
            1024,
            expected_file,
            str(encrypted_fixture["payloadSha256"]),
            str(encrypted_fixture["password"]),
        )
        add_pass("encrypted ZIP accepted with its password")

        wrong_password_stage = root / "wrong-password-stage"
        wrong_password_stage.mkdir()
        require_rejected(
            driver,
            encrypted_archive,
            wrong_password_stage,
            1024,
            "wrong-password",
            password="incorrect-test-password",
            require_empty_stage=False,
        )
        add_pass("encrypted ZIP rejected with a wrong password")

        malicious_archives: list[tuple[str, Path]] = []
        traversal = root / "traversal.zip"
        with ZipFile(traversal, "w", compression=ZIP_DEFLATED) as archive:
            archive.writestr("../escape.txt", b"blocked")
        malicious_archives.append(("ZIP traversal path", traversal))

        duplicates = root / "casefold-duplicates.zip"
        with ZipFile(duplicates, "w", compression=ZIP_DEFLATED) as archive:
            archive.writestr("Folder/A.txt", b"first")
            archive.writestr("folder/a.txt", b"second")
        malicious_archives.append(("ZIP casefold duplicate", duplicates))

        symlinks = root / "symlink.zip"
        symlink_entry = ZipInfo("link-to-outside")
        symlink_entry.create_system = 3
        symlink_entry.external_attr = (stat.S_IFLNK | 0o777) << 16
        with ZipFile(symlinks, "w") as archive:
            archive.writestr(symlink_entry, "../../escape.txt")
        malicious_archives.append(("ZIP symlink", symlinks))

        for index, (label, archive_path) in enumerate(malicious_archives):
            stage = root / f"malicious-stage-{index}"
            stage.mkdir()
            require_rejected(driver, archive_path, stage, 1024, "unsafe-entries")
            add_pass(f"{label} rejected")
        if (root / "escape.txt").exists():
            raise AssertionError("ZIP traversal created an outside file")

        quota_archive = root / "zip-over-limit.zip"
        with ZipFile(quota_archive, "w", compression=ZIP_DEFLATED) as archive:
            archive.writestr("payload.bin", b"x" * 2048)
        quota_stage = root / "zip-over-limit-stage"
        quota_stage.mkdir()
        require_rejected(driver, quota_archive, quota_stage, 1024, "unsafe-entries")
        add_pass("ZIP output quota rejected before writing")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {Path(sys.argv[0]).name} NATIVE_SMOKE_DRIVER")
    run(sys.argv[1])
