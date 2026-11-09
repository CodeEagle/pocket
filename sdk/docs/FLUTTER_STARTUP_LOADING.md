# Flutter 容器的 SDK 启动 Loading

## 接入范围与来源

`PocketApp`、嵌入现有Flutter页面的 `PocketGuest` 和底层 `PocketView` 都支持 `loadingBuilder`。不传时仍有默认加载提示；传入时可以用宿主自己的图片和排版展示相同的真实阶段数据，无需修改Demo，也无需再维护一套启动状态。

保留父工程（排除`pocket_host/`）的 `lib/main.dart:8` 立即runApp，首帧后才预热；`lib/ui/mini_app_host_page.dart:57` 直接挂载渲染面，没有可移植的资源Loading API。当前SDK原本在 `PocketSession.ready` 前有包下载/校验提示，之后PocketView只有转圈。这个ready仅表示可以挂载运行时，不能当作游戏首帧已准备好。本改动适配现有会话与资源解码边界，不增加Dart业务状态机或新的native通信通道。

## 公共 API

```dart
PocketGuest(
  config: config,
  loadingBuilder: (context, progress) {
    final message = switch (progress.stage) {
      PocketStartupStage.preparingPackage => '正在准备应用资源…',
      PocketStartupStage.startingRuntime => '正在启动引擎、读取运行资源…',
      PocketStartupStage.decodingInitialResources => '正在解码首帧图片…',
      PocketStartupStage.applyingDisplayGeometry => '正在适配屏幕、准备首帧…',
    };
    final done = progress.resourcesDecoded;
    final total = progress.resourcesTotal;
    return Center(
      child: Text(
        done != null && total != null
            ? '$message\n$done / $total'
            : message,
      ),
    );
  },
)
```

同一参数可传给 `PocketApp` 或直接传给 `package:pocket_flutter` 的 `PocketView`。类型 `PocketLoadingBuilder`、`PocketStartupProgress`、`PocketStartupStage` 从SDK公共入口导出。示例只展示字段消费方式；接入方可以在builder里替换为自己的图片Loading画面。Builder只负责渲染，不应发起另一套加载或改变游戏业务状态。

## 数据含义与边界

- `preparingPackage`：读取现有 `PocketSession.stage`（`packageStage`）与下载事实。`downloadedBytes`/`totalBytes`只有宿主已知时才提供；未知总量不补假百分比。
- `startingRuntime`：真实运行时创建、资源包读取与原生首帧加载边界。同步FFI内部没有细粒度进度ABI，因此不报告虚构的解包/脚本执行百分比。
- `decodingInitialResources`：初始DrawList及auxiliary DrawList引用的去重图片/纹理资源，按现有解码future完成事实计数。计数属于当前首帧/几何资源批次，后续几何帧可能引用新的资源并开始新批次；它不是整个PAK、所有剧情图片或未来动态资源的累计进度。
- `applyingDisplayGeometry`：消费当前安全区/显示几何并取得零时间布局帧；该帧新引用的资源仍经过现有首帧解码门。

Loading沿用PocketView原有的`_loading`准入门，只有实际资源与安全区布局准备好后才由原有onReady结束；不因为Session.ready或controller已经绑定就提前显示游戏。错误、资源超时和销毁沿用原有路径，不用成功占位替代。

SDK Loading负责JS游戏画面出现前的运行资源；游戏画面出现后的语言、存档等业务准备仍由JS自己的Loading负责。二者不共用或复制业务状态。Flutter容器的大小与安全区传递保持现有渲染面，不用Loading外套尺寸不同的视口。

## 验证

- Flutter 3.47.9：上层自定义builder、默认兼容、错误优先和透传测试 **4/4通过**；首帧资源、视口、安全区、销毁、超时、生命周期、idle/timer回归 **39/39通过**。受控解码验证 `0/2→1/2`，失败资源不会计为完成，也不会打开onReady门。窄容器默认提示的排版溢出已在回归中发现并修正。
- 固定buildGuest编译的真实QJBC与原生Core：**1/1通过且未跳过**，验证自定义Loading随onReady消失、真实pointer输入使场景PNG由红变绿，并保持场景截取边界。
- 原始日志和哈希：`sdk/.pocket-build/sdk-loading-20261109/acceptance.json`；上层依赖环境见 `sdk/.pocket-build/flutter-startup-loading-20261109/manifest.json`。上层原有忽略package config指向Flutter 3.35.7，测试前离线刷新为3.47.9兼容依赖，测试后恢复原pubspec.lock；不声称旧锁定依赖已被这次测试覆盖。底层package锁文件未改变。

物理手机的冷启动耗时、整个PAK内部原生细分进度及后续动态资源Loading不计作本次验收。当前是SDK源码补全；接入App需要引用更新后的SDK并重新构建安装才能看到变化。
