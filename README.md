# Pocket

这个目录只有两个入口：

| 目录 | 用途 |
| --- | --- |
| [`sdk/`](sdk/README.md) | 可复用的 Flutter/QuickJS SDK、JS UI、Native runtime、编译器、Editor 和 CLI。 |
| [`demo/`](demo/README.md) | 完整 Showcase。Flutter 工程直接放在 `demo/`，JS/TS 工程集中在 `demo/js/`。 |

要把 Pocket 集成到其他项目，从 SDK 开始：

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
bun pocket.ts init /path/to/my-app --sdk-root "$PWD"
```

要运行 Showcase：

```sh
cd /Volumes/ORICO/Development/Github/pocket/demo
flutter pub get
flutter run -d 4D366210-290E-46DB-8BC6-3C5233700409
```

如果只修改 Showcase 的 JS：

```sh
cd /Volumes/ORICO/Development/Github/pocket/demo/js
bun run build
```

Flutter 宿主只负责字节码加载、DrawList 绘制、系统输入、生命周期和已注册的原生能力；页面、状态、路由、转场和组件组合都由 `demo/js/` 编写。构建产物是 QuickJS 字节码 `app.qjbc` 和资源包 `app.pak`，运行时不会回退到 JS 源码。

详细说明：[`sdk/README.md`](sdk/README.md)、[`demo/README.md`](demo/README.md)、[`sdk/docs/SDK_INTEGRATION.md`](sdk/docs/SDK_INTEGRATION.md)。
