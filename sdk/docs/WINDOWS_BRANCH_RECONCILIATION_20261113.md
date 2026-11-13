# Windows 0.1.1 branch reconciliation

The retired branch `build/windows-0.1.1-20261106` ends at
`0247e3040b9366ff9b4b349eead218ab9d10bdd9`. Its eleven commits were not
ancestors of main because the implementation was incorporated through reorganized
commits rather than a merge of the original branch.

## Source and retained behavior

Compared the branch tip with main's successor
`1dbd4fe30add1e360b77e03e26ae36a82fbda469` (cross-platform release workflow),
then checked the current main `878c107ee53ab9a871bbf03fd1469db336d8eb89`.
The successor already retains the Windows compiler/bootstrap, Node doctor,
native package verification, MSBuild invocation and distributed Studio companion
loading. Current `.github/workflows/toolchain.yml` keeps Rust 1.98.1 and the
explicit Windows SDK 10.0.26100.0 MSBuild property.

The entire branch-tip/successor comparison has only fifteen changed paths with
rename detection. These are later release workflow, documentation, update-host
and mounted-catalog fixes, Node minimum-version correction, and associated tests.
`sdk/scripts/tests/windows_package_smoke.mjs` became
`sdk/scripts/tests/platform_package_smoke.mjs` (84% similarity), extending the
same native-addon, real bytecode/input/frame and Studio lifecycle acceptance to
both release platforms. The temporary `windows-consumer-check.yml`, tied to the
old branch and an earlier artifact run, was replaced by the formal release gate.
Restoring it would reintroduce an obsolete workflow.

No runtime implementation changes are necessary. Reconcile the original branch
using an `ours` merge: preserve the current main tree and add this audit record,
while recording the original branch tip as a merge parent. This preserves every
original commit in main's history before deleting the remote branch.

## Validation and limits

On macOS, ran the following with `POCKET_SOURCE_BUILD=1`, Bun 1.4.4 and the
isolated `sdk/scripts/test_js.ts` runner; all four suites passed:

- `sdk/scripts/tests/prebuilt_tools.test.ts`
- `sdk/scripts/tests/package_toolchain.test.ts`
- `sdk/scripts/tests/export_web_sdk.test.ts`
- `sdk/scripts/tests/native_probe_path.test.ts`

This reconciliation does not claim a fresh Windows build or BLE hardware test.
`sdk/docs/WINDOWS_BUILD.md` retains the historical Windows CI evidence, including
consumer run `42205580194` at `0247e30`, and its hardware acceptance limitations.
No parent-demo capability was implemented or migrated in this history cleanup.
