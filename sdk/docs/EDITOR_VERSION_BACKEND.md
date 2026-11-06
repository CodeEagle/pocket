# Editor version backend

The Editor owns local publishing and the version inventory. Flutter continues
to consume the existing signed Pocket update protocol; there is no second
updater or application policy state machine in Dart.

## Source and retained behavior

Source-first inspection of the retained
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding
`pocket_host/`, found no Editor version service to migrate. This change extends
the reusable SDK implementation instead. The retained
`lib/core/pocketjs_bundle_runner.dart` and `lib/main.dart` use the former
bundle/syslib hot-update integration; their example release controls are not
copied into Dart. The current SDK already owns signed package preparation,
mounting and lifecycle, so this change reuses those boundaries:

- `editor/server.ts`: current-revision build gate, project APIs, root and mini-app
  resource snapshots, persistent development signing key and host templates.
- `scripts/build_guest.ts`: the pinned PocketJS compiler and bytecode pipeline.
- `scripts/package_update.ts`: signed manifests and content-addressed artifacts.
- `editor/update_endpoint.ts`: read-only public artifact transport, separate from
  the loopback Editor mutation API and signing material.
- `editor/client/editor.js`: the existing publish action and version drawer.
- `editor/preview.ts`: the existing installed-catalog compositor handle allocation,
  reused against the saved build snapshot when producing host descriptors.

The mutable `test` and `stable` routes remain the entry points for consumers.
Test publishing advances the build counter; stable publishing uses the build
declared by the project. The version drawer uses the same publish actions and
server inventory rather than maintaining a second release model in the browser.

## Version records

Each successful publish records the source revision, channel, version, build,
publish time, signing identity, archive and all package identities. The signed
artifacts are retained separately from the mutable channel entry points. History
links use a legal, immutable package-version segment in the existing public
route, so the host configuration can address them through the normal update
client.

The fixed channel index follows new publications. Its version records point to
immutable signed manifests and host descriptors. Mini-app bootstrap URLs remain
pinned to the matching release because their hashes describe those exact bytes.
Native update routing and persistent storage derive from the caller's fixed
index URL, so remote descriptor fields cannot switch channels or reset the
anti-rollback store. At runtime configuration, the host selects the child catalog
by the mounted, verified root payload hash before replacing the registry.
The existing runtime configuration request is the native boundary for refreshing
child registrations and compositor handles; JS keeps routing, state and UI
composition. The registry is not selected merely because a newer directory
record appeared while an older root is still mounted.

All root and child packages must finish packaging before the release inventory
is committed. An unsuccessful package operation leaves the previously published
slot available. The inventory is persisted with a same-directory atomic rename
and loaded again when the service starts.

Stable releases reject a lower build and reject changed content at an existing
build. Re-publishing identical content is idempotent; a different signing time
alone does not create a new release. Test releases advance automatically.

## One-click offline package

The test and stable version rows each expose a single download icon next to
the concrete published version. The icon downloads that release's complete
`.tar.gz` archive: root package, every mini app, signed manifests,
content-addressed resource blobs and host/bootstrap metadata. It never
publishes or changes the channel pointer.

Historical releases retain their original archives. An older download never
repackages the latest resources: every root and child keeps the version/build
recorded at that publication.

The offline packaging API also remains available for a saved successful build.
It preserves the current slots, history, build counters and published status,
and requires source/resources matching the build. The version panel uses the
specific release archive rather than a second current-build download action.

## 局域网 App 的单一接入地址

版本面板只展示一个固定更新入口，并提供“一键复制”：

```text
http://<LAN_IP>:<port>/test/pocket/<hostVersion>/<package>/latest.json
```

`hostVersion` 是宿主版本，`package` 是主包 ID。入口不包含具体业务包版本。
该 `latest.json` 是版本目录，记录最新版本和同一宿主、包、渠道的历史版本，
每版关联当次发布的主包和 mini app。它由已有发布记录生成，不另存一份目录状态。
`stable` 渠道使用同样结构的 `/stable/pocket/.../latest.json`。

容器只需一个参数；Editor 启动已接入热更的设备时也只传此参数：

```sh
flutter run --dart-define=POCKET_HOST_CONFIG_URL='http://<LAN_IP>:<port>/test/pocket/<hostVersion>/<package>/latest.json'
```

SDK 启动时先读取目录，选择最新版本并解析该版本的配置、关联 mini app 和资源。
现有 `PocketUpdateCoordinator.prepare()` 的每次更新检查也会重新读取固定目录，
不是仅在启动时解析一次；本次下载的资源地址始终基于本次选中的具体签名清单。
目录里的相对地址基于入口 URL 解析，无需额外输入子包地址，也无需手动拼接版本。
每版配置和 bootstrap 元数据固定到对应发布内容，后续发布不会把旧版元数据换成新版。
具体版本路径下的签名 `latest.json` 仍交给现有签名更新器处理；它与固定入口的
版本目录通过 schema 区分，不能互相当作清单解析。

Editor 管理 API 仍绑定本机；LAN 只提供目录、配置和已签名更新产物，
不开放编辑、发布 API 或签名私钥。局域网 HTTP 用于调试宿主，
发布版宿主继续遵循 SDK 的 HTTPS 要求。配置引导不能在后续更新中
静默替换已有信任公钥，关联子包沿用固定入口已信任的签名身份。
包下载仍经过现有签名、ABI、hash 和防回退检查。远程根包也使用
`downloadOnOpen`，实际下载、验证并运行目录选中的主包。

## Validation

`bun editor/test/editor_live_probe.ts` creates an isolated workspace and uses the
real pinned compiler. It publishes a signed update over HTTP, verifies its
signature, downloads every referenced blob, reconstructs the PAK, and compares
the bytecode and PAK hashes with the build artifacts. An invalid subsequent
source build must fail without changing the published manifest. The probe also
publishes consecutive test versions and restarts the service to check persisted
history and immutable downloads. This checks compilation and artifact transport;
it does not claim to execute the bytecode
inside Flutter.

Use `bun test editor/test/editor_server.test.ts editor/test/update_endpoint.test.ts`
for service and public transport regressions. Service fixtures inject explicit
synthetic bytecode and are not runtime-execution evidence.

`bun test editor/test/version_management_ui.test.ts` runs the actual Editor
client in Playwright Chromium. It clicks the test and stable publish buttons,
checks the request bodies and automatic refresh, and verifies that a failed
inventory refresh clears the previously displayed slots and history.

The coordinator regressions cover successive signed releases through one fixed
index without recreating the coordinator, relative blob resolution at a different
path depth, index/manifest mismatch, cross-origin rejection and anti-rollback.
The existing granular and bundle download tests exercise the same resolved
manifest base. Signature, plugin and trust-policy admission regressions remain
on the original coordinator and verifier.
