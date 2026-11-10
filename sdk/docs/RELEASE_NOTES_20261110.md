# Remote startup and MiniApp integration — 2026-11-10

## Delivered behavior

- Verified cached packages open without a download presentation. Background preparation keeps the current page intact; a later open admits the staged package.
- Host descriptors are cached against their source and signed root identity. A new root selects its matching catalog rather than retaining an older catalog.
- SystemUI can request `system.container.close`. The Showcase Home header exposes the exit action; FunApp renders the container without its own navigation bar.
- The diagnostic badge measures Flutter `FrameTiming`, including Release builds. The implementation is shared by the SDK and Demo.
- MiniApps receive initial system presets before their first admitted frame. Page navigation reserves the leading host back area; sheet navigation reserves the trailing close area.
- The Showcase restores saved appearance before drawing its business UI. Missing or rejected storage still completes startup with the existing default appearance.
- Optional Showcase apps are installed only when their real trusted compositor surfaces exist. Both the published three-child host and complete local host remain supported.
- Editor publication can explicitly reuse a separately owned, verified child release. Lantern retains one publication owner.

## Consumer delivery

The Showcase fixed test index currently selects `0.1.0-test.9`; its Lantern child is `0.1.0-test.5`. Profile `test.7` and Lobby `test.8` have been activated and visually confirmed on iPhone. Older cached child pages remain visible until reopened after their replacement has finished downloading.

The updated FunApp Release was installed with application data preserved. Its final Runner passed the Pocket ABI and intiface export check. The user confirmed that shaking the phone inside Pocket no longer opens the host Inspector. Debug navigation retains the Pocket entry and removes the separate Lantern shortcuts.

## Validation and limits

- Actual pinned QuickJS bytecode/native input tests cover Home exit, unchanged-update behavior, restored dark/light appearance and storage failure, page/sheet navigation, and Lantern safe areas.
- iPhone confirmation covers Lantern's full-screen background, Profile/Lobby navigation reserves, and suppression of the host shake gesture. Saved-dark first-entry behavior has automated native coverage; a separate physical first-entry confirmation has not been recorded.
- Local `agy` Argon Medium reviews found no remaining blocking issues in these changes. The modal-route shake edge case found during review was fixed before installation.
- Web SDK distribution is exported from the committed source snapshot and verified separately. A source package is not an npm publication or a deployed website.

## Release build follow-up

The `sdk-v0.1.2` CI run stopped before publication because the Demo Flutter lockfile did not match the repository-pinned Flutter 3.47.9. The lockfile is regenerated with that exact toolchain and checked again with `--enforce-lockfile`; the release workflow keeps the strict lock check. The corrected distribution advances to 0.1.3 and uses a new immutable release tag.

## Detailed records

- [Cached startup and Home exit](CACHE_NO_REFRESH_HOME_EXIT.md)
- [Host descriptor cache](REMOTE_CACHE_LOCAL_START.md)
- [Flutter FPS](FLUTTER_FPS.md)
- [MiniApp presets and presentation](MINIAPP_PRESETS_AND_PRESENTATION.md)
- [First business draw and saved appearance](DEMO_THEME_FIRST_DRAW.md)
- [Lantern safe areas](VISUAL_NOVEL_MOBILE_SAFE_AREA.md)
- [External publication ownership](EXTERNAL_PUBLISHED_PACKAGES.md)
- [FunApp container integration](FUNAPP_CONTAINER_ENTRY.md)
- [FunApp native dependency updates](FUNAPP_NATIVE_UPDATE.md)
- [Web SDK export](WEB_SDK_EXPORT.md)
