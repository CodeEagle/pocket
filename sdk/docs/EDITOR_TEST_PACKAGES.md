# Editor 测试包与模拟器热更新

Editor 的测试发布复用现有 `packageArtifacts`、Ed25519 签名和 `PocketUpdateCoordinator`，不另做更新协议，也不绕过 build 防重放。

1. 首次在 Editor 选择设备并 Run。部署命令由受信服务端注入当前 Editor 的更新 URL、Ed25519 公钥及 `editor_<projectId>` 隔离存储命名空间；无私钥进入 App。
2. 编辑 JS，保存并 Build，再发布测试包。请求为 `POST /api/projects/:id/publish`，JSON `{ "channel": "test" }`。
3. 在模拟器 Showcase 的 Host → Updates 点击 Check，再 Apply。宿主验证签名、ABI、哈希和 build 后重载真实 QJBC，不需要重新构建 Flutter。
4. 后续重复编辑、构建、发布与 Check/Apply。原发布接口 `{}`/`{ "channel": "release" }` 保留既有版本语义。

测试包的 build 高于当前构建配置、字节码元数据、已发布 payload 和测试发布计数；version 为 `<配置版本>-test.<build>`。测试计数单独持久保存，不因源码保存清理 publish 状态或普通 release 发布而丢失。测试发布不改消费者 pocket.json/editor.json 的正式 release identity。

iOS 模拟器及本机桌面继续使用 loopback。真机和 Android Run 会在选中的局域网 IPv4 地址上启动只读更新下载端点（默认复用 Editor 端口、绑定不同 IP），只提供 `/updates/` 下的已发布文件；编辑、Codex 和部署 API 不在这个端点开放。手机与电脑需能通过局域网互通。更新 URL、公钥、存储命名空间和精确 HTTP 调试主机在 Run 时传入 App；私钥不进入 App。HTTP 例外仅对 debug 生效，release 仍要求安全传输。

多网卡时可由启动环境 `POCKET_EDITOR_UPDATE_HOST` 指定本机局域网 IPv4，`POCKET_EDITOR_UPDATE_PORT` 可指定只读下载端口。没有可用地址或端口不能绑定时，部署应报错，而不是再安装缺少更新配置的 App。旧安装未携带这些编译参数，需要先用更新后的 Editor 重新 Run 一次；之后 Build → Publish test package → App Check → Apply 即可。

来源与适配：旧 `pocketjs_flutter_demo/pocket_host/editor` 的签名发布/host.json 链路此前已迁移到 `sdk/editor/server.ts`；本轮继续复用已保留的构建、签名发布与 `demo/integration_test/editor_update_check_test.dart`、`update_lifecycle_test.dart` 验证思路。新增部分仅为已缺失的部署公钥配置传递、测试包单调 build 与测试发布入口，不引入第二套下载或验证器。

回归：`sdk/editor/test/editor_server.test.ts` 用客户端获取的公钥验证连续测试包签名及 build 递增，确保原配置不被改变；`devices.test.ts` 验证实际 argv 的公钥与更新 URL；`demo/integration_test/editor_test_package_update_test.dart` 通过真实 JS Check/Apply 验证原生 guest 更换和重启后仍激活已发布版本，测试存储与交互 namespace 分离。

本轮实际验收：iPhone 18 Pro / iOS 27.2 模拟器，临时 Editor 8793 发布 `0.1.0-test.2`（build 2），通过 public host.json 注入编译参数运行上述集成测试；实际 UI Check → Apply → native Guest key 改变 → active 版本匹配 → 重启后 active 仍匹配，`1 passed`，总耗时约 1m24s。未清理交互 Editor 存储；测试仅删除 `editor_smoke_*` 自己的命名空间。


## 真机未配置修复（2026-11-04）

根因是 `updateConfig` 对真机直接返回 undefined，部署 argv 缺少
`POCKET_UPDATE_*`。修复复用既有签名包、Dart coordinator 和相对 blob/bundle
URL，仅补充物理设备的只读下载地址和编译配置。没有新增另一套更新器。
保留父项目（排除 pocket_host）只存在内存型 C Syslib AOT 切换，未提供可复用的
签名 HTTP 下载端点；参见 `native/pocket_runtime_multi.c:1215–1343` 与
`lib/core/pocketjs_bundle_runner.dart:1781–1832`。

实际验证：`update_endpoint`、`devices`、`editor_server` 共 20 个测试通过，
包含物理设备 argv、共享签名发布接口与只读路径隔离。SDK 配置测试在默认
环境和 `POCKET_UPDATE_DEBUG_HTTP_HOST=192.168.50.230` 下分别 2 pass，
相关 Dart analyze 无问题。用临时只读 listener 实际访问
`http://192.168.50.230:8792`，读取当前 `0.1.0-test.3` 并通过公钥签名校验，
下载 181567 bytes bundle 并验证 SHA-256；Editor API/health/keys 均返回 404，
检查后已关闭临时 listener。8792 服务已加载新部署代码。未自动重新安装
用户真机或执行 Apply；手机连通性和系统本地网络授权需在重新 Run 后验证。
