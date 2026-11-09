# Lantern v4 resource admission budget

## Frozen Guest artifact

The v4 high-resolution Lantern Guest PAK is 69,193,344 bytes
(about 65.99 MiB), SHA-256
8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08.
Its QJBC is 1,073,341 bytes, SHA-256
e03750c154c8fcaa4ef8b05f37f314a09e2e754ed628a249360c9c406b3bc176.
The source and artifact metadata are retained in
[release-artifacts.json](../.pocket-build/lantern-v4-scaled-20261108/release-artifacts.json).

The PAK contains the complete Lantern resource set, including original
2048×2048 Live2D texture pages and the prepared transparent parallax image.
The size is the packaged PAK byte count; it is not a measurement of decoded
texture memory or process RSS.

## Admission failure and fix

The first real macOS showcase attempt used the default 64 MiB PAK ceiling
(67,108,864 bytes). Guest startup rejected the PAK before the title screen:

> PocketRuntimeException: pak admission: 69193344 bytes exceeds memory_limits.maxPakBytes 67108864

The failure is preserved in
/tmp/pocket-model-v4-startup-diagnostic.log. The PAK exceeds that ceiling by
2,084,480 bytes (about 1.99 MiB); the failure is an admission check, not a
model decoder or rendering failure.

The Lantern consumer now has an explicit 72 MiB ceiling
(75,497,472 bytes) in both configuration boundaries:

- demo/lib/main.dart sets PocketAppConfig memoryLimits for pocket.demo.lantern
  to heapLimitBytes 128 MiB and maxPakBytes 72 MiB.
- demo/js/pocket.system.json sets the Lantern catalog memory policy to
  heapLimitBytes 128 MiB and maxPakBytes 75,497,472.

Both values must permit the package. Changing only the Flutter-native policy
left the JavaScript catalog's 64 MiB check in place, so the app could still be
rejected before it opened. Other Showcase apps retain their existing limits;
this is a Lantern-specific setting, not a global increase.

After both boundaries were aligned, the staged system UI package was rebuilt:
QJBC SHA-256 9eb55672c651b76ad9f95fb57c32f7eb82995cd25aa696bba898c2d1a307cbff
and PAK SHA-256
5955143ed323987400f8db937ccf96f9206be94e5259479c8688b0710c7a4fba.
Its artifact record is
[release-artifacts.json](../.pocket-build/lantern-v4-systemui-budget72-20261108/release-artifacts.json).
The real macOS model showcase then opened with the high-resolution Guest.
This verifies package admission and model startup for that host build; it does
not establish a memory or cold-start budget.

The 72 MiB PAK ceiling leaves 6,304,128 bytes (about 6.01 MiB) below the
configured admission limit for future packaged assets. It is a hard package
size allowance, not a claim that the running process uses only 72 MiB.

## Separate memory and platform gates

The Lantern heap limit remains 128 MiB. It was not raised to make the PAK
pass. The application and host still have to satisfy heap admission and actual
runtime behavior independently of maxPakBytes. The PAK's compressed/encoded
size does not equal decoded 2048-square RGBA texture memory.

The real macOS DPR 1/2 model matrix is documented in
[LANTERN_MODEL_FRAMING.md](LANTERN_MODEL_FRAMING.md). It proves real model
startup and rendering at the tested dimensions after the policy correction.
It does not prove stable RSS, repeated model-entry memory, cold-start time,
whole-game frame budgets, Android/iOS/Windows/Web admission, or physical
device behavior. The rebuilt system package and Lantern Guest must be
re-created for a platform before claiming that platform's runtime acceptance.

The final parallax image still requires a separate real-Flutter pixel check.
Texture preparation, PAK inclusion, and successful Guest startup are not by
themselves evidence that its foreground pixels were decoded and composited
correctly.
