param(
  [switch] $SkipPrepare
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'build_native_windows.ps1 must run on Windows with the MSVC toolchain.'
}

$sdkRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cargoManifest = Join-Path $sdkRoot 'native/Cargo.toml'
$target = 'x86_64-pc-windows-msvc'
$sourceDll = Join-Path $sdkRoot "native/target/$target/release/pocket_flutter.dll"
$destinationDirectory = Join-Path $sdkRoot 'packages/pocket_flutter/windows/bin'
$destinationDll = Join-Path $destinationDirectory 'pocket_flutter.dll'

if (-not $SkipPrepare) {
  Push-Location $sdkRoot
  try {
    & python scripts/prepare_upstream.py
    if ($LASTEXITCODE -ne 0) { throw 'Pinned PocketJS preparation failed.' }
  } finally {
    Pop-Location
  }
}

$previousRustFlags = $env:RUSTFLAGS
try {
  $env:RUSTFLAGS = (($previousRustFlags + ' -C target-feature=+crt-static').Trim())
  & cargo build --locked --release --target $target --manifest-path $cargoManifest --lib
  if ($LASTEXITCODE -ne 0) { throw 'Pocket Windows FFI runtime build failed.' }
} finally {
  $env:RUSTFLAGS = $previousRustFlags
}

if (-not (Test-Path -LiteralPath $sourceDll -PathType Leaf)) {
  throw "Cargo succeeded but did not produce the expected runtime DLL: $sourceDll"
}

New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
Copy-Item -LiteralPath $sourceDll -Destination $destinationDll -Force
if (-not (Test-Path -LiteralPath $destinationDll -PathType Leaf)) {
  throw "Could not install the Pocket Windows FFI runtime: $destinationDll"
}

Write-Output "Built and installed Pocket Windows FFI runtime: $destinationDll"
