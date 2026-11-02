# 独立版本说明

当前最终工程位于 `/Volumes/ORICO/Development/Github/pocket`。其中 `sdk/` 是
可集成实现，`demo/` 是 Showcase 入口。它由 `pocketjs_flutter_demo/pocket_host`
复制而来，原目录保留为来源副本，旧 `pocket_flutter_poc` 的历史源码归档已在审计清理时移除；保留的参考工程是父目录 pocketjs_flutter_demo，当前构建不依赖它。

复制时保留了正式源码、测试、文档、Showcase 字节码资产、Flutter 插件静态库，
以及本地 Editor workspace 的项目和签名材料，使当前 `0.1.1` 更新链可以继续验证。
Editor 私钥只用于本机本地服务，不属于发布包，不能提交或上传。

以下内容刻意没有作为最终源码目录迁移：`.dart_tool/`、Flutter `build/`、Pods、
`.cache/pocketjs/node_modules` 等依赖缓存、`native/target` 编译缓存、临时 `.pocket-build` 构建产物、
日志和模拟器输出。首次在新目录使用时按 README 执行固定上游准备、Bun 安装、
native/JS 构建和 `flutter pub get`，这些路径会在本地重建。

迁移后快速检查：

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
python3 scripts/prepare_upstream.py
bun install
python3 scripts/check_architecture.py
cd ../demo/js && bun install && bun run build
cd .. && flutter pub get && flutter analyze
```

Editor 本地服务使用 `bash scripts/editor_service.sh start|status|stop`。服务默认只
绑定 loopback；退出登录或重启后需要重新 `start`。Duo 原生构建仍要求 Xcode/iOS
SDK 27.1+，运行最低 iOS 版本为 15.0。

固定上游源文件已保留在 `.cache/pocketjs`，可按 revision 校验和重建；只复制了
已验证的两个静态库、字节码编译器及 native probe，没有复制 Rust 中间产物。
历史迁移校验清单已随归档清理，不属于当前验证入口。以下迁移测试记录描述当时环境，不代表当前提交已通过。

独立验证已完成：新目录在没有编译器 node_modules 的情况下安装依赖并生成
235139-byte qjbc / 333472-byte PAK；真实 native probe、mobile 几何断言、
架构边界及 Flutter analyze 通过。修复了 `build_guest.ts` 过早静态加载编译器的
问题，CLI/Editor 共享流程现在先准备上游与安装依赖，再加载 JSX transformer。

Editor 已从旧目录的 launchd job 切换到此目录，URL 继续使用
`http://127.0.0.1:8790`，保留 revision 18 / 0.1.1 的签名信任链。
本目录已初始化独立 Git 仓库，尚未提交；`.cache`、构建产物和 Editor 私钥保持忽略。

最终设备验证：从新目录 `demo/` 执行 `flutter run -d 4D366210-290E-46DB-8BC6-3C5233700409` 已构建并启动 Duo；Flutter 的 package_config、Generated.xcconfig、环境脚本均未引用旧目录。当前 iOS XCFramework 提供 device/Apple-Silicon simulator arm64 slice，podspec 会为 simulator 排除未提供的 x86_64 slice；Intel simulator 不是支持目标。新路径 Editor 的实际重新编译也通过。
