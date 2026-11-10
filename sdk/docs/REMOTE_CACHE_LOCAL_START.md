# 远程容器 Host Bootstrap 缓存优先（本地化启动）

## 接入范围与源码调查

2026-11-10。按源码优先原则简要检查保留母工程 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`（排除 `pocket_host/`）：

- `lib/main.dart:8-18` 与 `lib/ui/mini_app_host_page.dart:15-30` 在 `runApp` 时直接挂载本地视图，没有远程 Host Bootstrap 文档缓存实现。
- `docs/04_BIDIRECTIONAL_FFI_WASM_AND_YOOASSET_HOTUPDATE.md` 仅描述包清单/分块 SHA-256 校验与 `ActiveManifest` 原子切换，未包含固定应用索引或不可变 Host 描述符缓存。

此前 `PocketSession.initialize(cacheFirst: true)` 已经支持先挂载本地已验证的 `lastGood` 签名包、再于后台拉取更新；但 FunApp 的 `TryFunPocketRemoteContainer._load` 在挂载 `PocketSystemHost.fromHostConfig` 之前无条件等待网络 `PocketHostConfig.load(uri)`，导致已缓存的远程容器每次打开仍受制于索引、Host 描述符与引导资源（`app.bytecode.json` / `guest-manifest.json`）的 HTTP 请求。

## 架构与实现边界

在复用既有加载器与本地文件系统/信任边界的前提下，为 `PocketHostConfig.load`（及 `loadFromEnvironment`）增加可选 `cacheFirst: false` 参数，未新增第二套包更新器或版本准入状态机：

1. **缓存范围与键值隔离**：
   - 存储在 `trustAnchorDirectory`（默认 `ApplicationSupportDirectory`）下的 `pocket-host-cache/` 目录。
   - 按规范化入口 URL（去除 fragment，保留完整 origin、路径与 query 选择器）隔离最新已验证条目，并按 `source + rootPayloadSha256` 隔离不可变根包对应的历史 Host 描述符条目。
   - 缓存内容包含已验证的 Host 描述符文档、内联引导资源（`bootstrapMetadataJson` / `bootstrapManifestJson`）、固定包索引目录列表 `catalog` 及当前选中项 `selectedCatalogEntry`。
2. **严格本地复核与损坏回退**：
   - `cacheFirst: true` 命中本地缓存文件时，在发起任何 HTTP 请求前执行与网络加载一致的校验：URL/HTTP 白名单、`baseUri` 同源校验、`bootstrapAssets` 声明大小与 SHA-256 逐项复核、`PocketHostConfig.fromJson` schema/子包校验，以及 `pocket-host-trust.json` 信任锚点比对。
   - 若指定 `requiredRootPayloadSha256`，仅匹配对应 `rootPayloadSha256` 的缓存描述符；绝不回退或混用其他根哈希的缓存。
   - 缓存缺失、JSON/文件损坏、引导资源哈希不匹配或超出大小上限时，自动清理损坏缓存并回退到原有网络加载；但**信任锚点不匹配（`trust anchor changed`）绝不静默放行**，直接抛出 `FormatException`。
3. **原子写入、取消安全与容量上限**：
   - 网络加载并完成引导资源与信任锚点验证后，通过临时文件写入 + `rename` 原子落盘；支持 `PocketCancellationToken` 取消并清理临时文件；缓存目录最多保留最近 16 个条目（`_hostCacheMaxEntries = 16`）。
4. **单一状态机与跨代目录对齐**：
   - Host Bootstrap 缓存不探测或校验 `PocketPackageStore`，包签名、版本下限与 staged 候选选择仍完全由 `PocketSession.initialize(cacheFirst: true)` 独占负责。
   - FunApp `TryFunPocketRemoteContainer` 在初始 `_load` 与 `reloadHostConfig` 中传入 `cacheFirst: true`：首次冷启动走网络并写入缓存；后续打开直接从本地缓存返回 `PocketHostConfig` 并立即挂载 `PocketSystemHost(cacheFirst: true)`。若后台准备好新根包并在下一次打开时挂载，或当前已挂载根哈希对应的描述符已缓存，均按 `requiredRootPayloadSha256` 精确解析，未缓存的新根哈希则回退网络拉取对应不可变描述符。

## 验证证据

- **SDK Host Config 回归（Flutter 3.47.9）**：
  - `test/pocket_host_config_test.dart`：覆盖冷启动落盘、关闭 loopback HTTP 服务器后 `PocketHostConfig.load(..., cacheFirst: true)` 零网络请求完成加载并完整保留 `bootstrapMetadataJson` / `bootstrapManifestJson`、按 `requiredRootPayloadSha256` 离线精确命中历史描述符、未缓存根哈希回退网络、HTTP 白名单拦截、缓存内容篡改自动回退网络重拉、以及信任锚点冲突拒绝放行。
- **FunApp 容器回归（Flutter 3.35.7）**：
  - `common_lib/packages/tryfun_pocket/test/remote_loading_test.dart`：覆盖 `TryFunPocketRemoteContainer` 冷启动缓存后关闭 HTTP 服务器，再次挂载容器零网络请求完成 Host 配置加载并保留引导资源，`catalogLoader` 按 `requiredRootPayloadSha256` 零网络命中已缓存历史描述符，未知根哈希不误用旧缓存并走网络请求。
