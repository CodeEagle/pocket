# SDK 源码导览

`/Volumes/ORICO/Development/Github/pocket/sdk` 是可复用实现的唯一入口；
`../demo` 只是它的 Showcase 消费者。阅读 SDK 时按下面的顺序即可。

## 先看三个入口

| 文件 | 作用 |
| --- | --- |
| `lib/pocket_sdk.dart` | 外部 Flutter 项目导入的 `PocketApp`、`PocketGuest`、配置和 session API。 |
| `pocket.ts` | 新建工程、构建 QuickJS 字节码、准备 iOS/Android 原生工程和启动 Editor。 |
| `packages/pocket_ui/src/index.ts` | JS/TSX 组件库的公共入口；页面、主题、导航和表单由 JS 组合。 |

## SDK 运行链

```text
consumer app.tsx
  → sdk/packages/pocket_ui
  → sdk/scripts/build_guest.ts + pinned PocketJS compiler
  → app.qjbc + app.pak
  → sdk/native QuickJS/PocketJS runtime
  → sdk/packages/pocket_flutter PocketView
  → Flutter Canvas / system TextField / registered native plugins
```

宿主加载构建时生成的 QuickJS 字节码，不把 JS 源码作为运行期 fallback。Flutter
只负责绘制、资源、生命周期、系统输入和明确注册的原生能力；业务页面、状态、路由、
转场和组件组合属于 JS。

## 目录地图

```text
sdk/
├── lib/pocket_sdk.dart       # Flutter 公共 SDK 入口
├── pubspec.yaml              # package:pocket_sdk
├── pocket.ts                 # 唯一 CLI：init / build / editor
├── packages/
│   ├── pocket_flutter/       # PocketView、字节码加载、绘制、IME、平台纹理
│   ├── pocket_hardware/      # iOS/Android 硬件 provider 与权限/能力协议
│   ├── pocket_services/      # 更新、签名、缓存、插件生命周期
│   └── pocket_ui/            # @pocket/ui JS 组件、mobile、responsive、glass
├── native/                   # Rust FFI、QuickJS runtime、字节码编译器
├── scripts/                  # 上游准备、guest 构建、native 构建、签包和检查
├── editor/                   # 本地源码编辑、编译、签名发布服务
├── docs/                     # API、来源、验证、性能和迁移记录
└── migrations/               # 旧实现源归档和迁移清单
```

`.cache/`、`.pocket-build/`、`native/target/`、Pods 和 Flutter build 都是生成内容，
不属于 SDK 源码入口。`sdk/docs/SDK_INTEGRATION.md` 说明如何把 SDK 集成进已有
Flutter 项目；`sdk/docs/VALIDATION.md` 说明哪些能力已经真实验证、哪些仍有限制。

## 常用命令

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
bun pocket.ts init /path/to/my-app --sdk-root "$PWD"
bun pocket.ts build /path/to/my-app --sdk-root "$PWD" --platform=ios-sim
python3 scripts/check_architecture.py
bash scripts/editor_service.sh start
```

`pocket.ts init` 生成的工程是独立消费者，不会复制 `demo`。Demo 的 JS 构建从
`/Volumes/ORICO/Development/Github/pocket/demo/js` 执行。Editor 也从 SDK 的
公共模板创建项目；Demo 的页面和状态不属于 SDK 公共 API。
