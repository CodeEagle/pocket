# Rust worktree cache policy

This note records the Rust cache layout used by the isolated Pocket worktrees
(2026-11-04). It is a cache policy and recovery reference; it is not a
request to remove existing build artifacts.

## Toolchain and cache layout

The selected combination is:

| component | observed value |
| --- | --- |
| Cargo | `1.101.0` (`huacnlee/cargo 0.102.0-9`) |
| rustc | `1.99.1` |
| rustup | `1.28.2` |
| sccache | `0.19.0` |
| rustc wrapper | `/opt/homebrew/bin/sccache` |

`~/.cargo` is a symlink to `/Volumes/ORICO/dev-tools/cargo`. The external
directory holds the shared `config.toml` and Cargo's `.global-cache` database,
with build artifacts under `~/.cargo/targets/`. The fork shares repository
artifacts (including incremental caches) across its worktrees, and registry/Git
dependencies across projects. Public executables/libraries remain available
under `./target` through hard links. The sccache store is separate, at
`/Volumes/ORICO/mac-caches/sccache`, with a 2 GiB maximum.

The active Cargo configuration is:

```toml
[build]
rustc-wrapper = "/opt/homebrew/bin/sccache"

[build.gc]
max-size = "8 GiB"
shared-max-size = "8 GiB"
max-unused = "1 day"
shared-max-unused = "7 days"
frequency = "1 hour"
enabled = true

[env]
SCCACHE_ALLOW_INCREMENTAL = "1"
```

Cargo's own `CARGO_FORK_AUTO_UPDATE` and `CARGO_DEV_CRANELIFT` switches must
be present **before Cargo starts**. A Cargo `[env]` entry only supplies child
processes and cannot disable those host features. The installed `bin/cargo`
is therefore a small launch policy shared by shell and GUI callers:

```sh
#!/bin/sh
export CARGO_FORK_AUTO_UPDATE=0
export CARGO_DEV_CRANELIFT=0
exec /Volumes/ORICO/dev-tools/cargo/bin/cargo.huacnlee "$@"
```

`cargo.huacnlee` is the unchanged upstream executable retained via a hard link
before atomically installing the launcher; `cargo.rustup` remains the original
rustup proxy. This does not alter the upstream binary or Rust toolchain. The
same launcher covers a caller whose parent environment lacks these variables.
Do not put either host switch back into `[env]`. A manual fork reinstall can
replace the launcher; reapply this launch policy afterwards. Automated fork
updates are disabled by the actual startup environment.

Verification with both variables explicitly removed from the caller:
`env -u CARGO_FORK_AUTO_UPDATE -u CARGO_DEV_CRANELIFT /bin/sh -x ~/.cargo/bin/cargo --version`
shows both exports before `exec` and the unchanged fork version. Cross-worktree
cache validation still uses the same fork executable and sccache configuration.

`SCCACHE_ALLOW_INCREMENTAL=1` permits sccache to cache eligible dependency
compiler invocations. Incremental workspace compiler invocations remain incremental and are not
sccache hits; Cargo itself manages the shared incremental artifacts. The
setting is an allowance, not a guarantee that every invocation is cacheable.

## GC and worktree rules

The Cargo GC values `8 GiB` and `8 GiB` are cleanup targets for the local and
shared cache pools, respectively; they are not a total-disk hard limit. The
sccache 2 GiB limit is independent. Keep these rules when building from an
isolated worktree:

- Do not run `cargo clean`.
- Do not set or redirect `CARGO_TARGET_DIR`.
- Use Cargo's repository/worktree-aware cache identities; do not add a second
  target redirection layer on top of them.

## Recorded smoke and inventory

The recorded smoke baseline for a second isolated worktree was
`worktreeFresh = 0.03 s` (the value supplied by the main run). The full-disk
inventory at `/private/tmp/pocket-rust-disk-inventory-20261104.json` found 26
`target` directories totalling `19,040,556 KiB` (`18.16 GiB`). Those entries
were intentionally left in place; no inventory cleanup or target deletion was
performed.

## Restoring rustup selection

The huacnlee Cargo install retains the previous rustup Cargo executable as
`~/.cargo/bin/cargo.rustup` (the observed binary reports Cargo `1.99.1`). To
use that saved executable without changing the installation, probe it directly:

```sh
"$HOME/.cargo/bin/cargo.rustup" --version
```

Use the audited installer's uninstall operation to restore that launcher:

```sh
sh /Volumes/ORICO/mac-caches/tmp/pocket-cargo-install-20261104.sh --uninstall
cargo --version
```

The installer replaces the launcher with the saved rustup proxy. The retained
`cargo.huacnlee` binary may be kept as a reversible backup; it is not on the
normal Cargo entry path after restoring rustup.

This does not require changing the default Rust toolchain or clearing any
worktree override. Do not remove existing caches as part of recovery.

Sources: [huacnlee/cargo](https://github.com/huacnlee/cargo),
[sccache Rust behavior](https://github.com/mozilla/sccache/blob/main/docs/Rust.md),
[sccache configuration](https://github.com/mozilla/sccache/blob/main/docs/Configuration.md).
