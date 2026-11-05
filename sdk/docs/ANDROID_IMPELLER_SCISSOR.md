# Android Impeller 矩形裁剪消融记录

本文记录 Android 真机上 Flutter 3.35.7 / Impeller Vulkan 的一次渲染卡顿定位。它只描述
DrawList 的矩形裁剪抗锯齿消融，不代表关闭裁剪、关闭 Impeller 或切换到 Skia。

## 结论

当前 [`PocketCanvasPainter`](../packages/pocket_flutter/lib/src/pocket_view_painter.dart#L330-L341)
对 DrawOp 的矩形 `op.clip` 使用：

```dart
canvas.clipRect(
  Rect.fromLTWH(clip.x, clip.y, clip.width, clip.height),
  doAntiAlias: false,
);
```

这保留了所有 `SCISSOR`/`SCISSOR_POP` 的裁剪边界、嵌套恢复、绘制顺序，以及 image、tint、
triangle 和 surface 的绘制；只把矩形裁剪从带边缘抗锯齿改为硬裁剪。圆角绘制
(`PocketRoundedOp`)、gradient、普通/纹理 triangle、文本和 image 的既有抗锯齿/滤波路径
没有被关闭；image 的 `filterQuality` 与 tint 也没有改变。生产文件位置是
`sdk/packages/pocket_flutter/lib/src/pocket_view_painter.dart:330-341`。

在同一台 MAA_AN00（SM7550）、同一 Flutter 3.35.7、同一 Impeller Vulkan Showcase 场景的
**Profile `FrameTiming.rasterDuration` 采样**中，这一消融将 raster 从约 56ms 降到约 3ms。
它是目前最小且有设备数据支持的修改；没有关闭
Impeller、没有切换 Skia、没有删除 clip，也没有删除 image/tint。

## DrawList 合同与来源

固定上游合同 [`spec.ts`](../.cache/pocketjs/contracts/spec/spec.ts#L1447-L1453)
定义：

- `SCISSOR` 是三字操作 `op, xy, wh`，push 一个矩形裁剪；
- core 已将矩形与所有外层 scissor 求交，backend 只需设置收到的矩形；
- `SCISSOR_POP` 恢复上一层，栈为空时恢复 screen；
- core 保证 `SCISSOR`/`SCISSOR_POP` 成对平衡。

因此该合同表达的是矩形硬裁剪状态，而不是圆角或任意路径边缘。`doAntiAlias:false` 不会
改变合同中的矩形、深度或恢复行为。

旧 demo 的 source-first 对照结果：

| 来源 | 观察到的实现 | 对当前迁移的意义 |
| --- | --- | --- |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:403-406,3215-3222,3258-3262,3935-3937` | 旧宿主用 `ClipRRect`/`CustomPaint` 组合，并在路径/弧线/图片 painter 上保留 `isAntiAlias:true` 或高质量滤波；没有逐 DrawOp `SCISSOR` painter | 说明圆角、路径和 image 的 AA 不能被本轮矩形 scissor 消融误伤；旧 UI 没有可直接搬回的 per-op clip 修复 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/perf_monitor.dart:22-29,84-120` | 旧监控通过 `SchedulerBinding.addTimingsCallback` 读取 UI/raster，并维护 FPS/jank 历史；它不是 renderer/backend 设置 | 只复用“Profile FrameTiming 与 raster 分开测量”的口径，不把旧 HUD 的 FPS 预填或阈值当成 GPU 结论 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/native/pocket_runtime_multi.c:82-93,341-365,439-470` | 旧 native runtime 维护 `target_fps`、dirty mask 和 drawlist buffer/frame step；文件没有 `SCISSOR`、`clipRect` 或 `antiAlias` 的 per-op 实现 | 证明旧 runtime 没有等价的矩形 scissor 修复；它只能作为 native 调度/DrawList 来源对照 |
| `sdk/.cache/pocketjs/devices/gles/pocket-gles/src/geometry.rs:53-81,245-285` | 当前 pinned GLES backend 将 core 已求交的 clip 作为整数 `Clip` 状态分批，并让 `SCISSOR`/`SCISSOR_POP` 不改变绘制顺序 | 这是合同层面的硬矩形 scissor 证据，不是旧 demo Flutter painter 的第二套实现 |

旧 demo 没有找到与当前 `doAntiAlias` 完全相同的 Flutter 参数设置，也没有找到可直接
复用的 Android Impeller Vulkan 性能基线；本次不是另起一套裁剪协议，而是按固定合同、
当前 pinned GLES 的硬 scissor 语义和真机消融对现有 painter 做最小适配。

## 真机消融数据

下表为 MAA_AN00（SM7550）、Flutter 3.35.7、Impeller Vulkan、同一 Showcase 场景的
**Profile `FrameTiming.rasterDuration`**；单位为毫秒。Release 包的系统
SurfaceFlinger 间隔另见下方验收章节，不能把两种口径混成一列。

| 变体 | 帧数 | raster median | raster p95 | 解释 |
| --- | ---: | ---: | ---: | --- |
| 原始 Pocket 基线 | 99 | 48.645 | 60.545 | 较早 Pocket 运行基线，作为历史参照 |
| 当前同场景基线 | 154 | 56.451 | 61.226 | `doAntiAlias` 仍为默认值；该场景首页实际为 0 个 triangle，`no-triangles` 与它等价，不能当作有效 triangle 消融 |
| no-clips | 467 | 2.909 | 4.294 | 删除/绕过 clips 的诊断对照，不是可接受产品修复；只用于证明裁剪路径相关 |
| noimages | 156 | 57.193 | 60.085 | 仅移除 image 的诊断对照，仍慢 |
| notint | 37 | 56.317 | 58.780 | 仅移除 tint 的诊断对照，仍慢；样本量小 |
| **保留 clip + `doAntiAlias:false`** | **483** | **3.084** | **3.978** | Profile 诊断包已验证；保留 image/tint/clip 等内容；Release 另以 SurfaceFlinger 采样 |
| 纯 Flutter | 309 | 2.226 | 3.480 | 渲染宿主对照，不包含 Pocket DrawList 内容 |

`no-clips` 仅用于消融，不能被误写成最终实现。最终变体仍发送并执行矩形 clip，改变的
只有 `Canvas.clipRect` 的抗锯齿选项。

## 复现步骤

以下步骤用于重新获得同口径的设备数据；每个临时消融应在隔离的临时副本或临时补丁中
进行，不能把 `no-clips` 诊断变体作为生产代码提交：

1. 固定仓库源码、Flutter 3.35.7 和 Impeller Vulkan；不要用 `--enable-impeller=false`
   或 Skia 作为“修复”对照。检查生产 painter 中的 `clipRect(..., doAntiAlias: false)`。
2. **Profile raster 采样**：在 `demo/` 构建同一 Showcase Profile 包：

   ```sh
   flutter build apk --profile --target-platform android-arm64 --target=lib/main.dart
   ```

   安装到同一台 MAA_AN00 后进入同一页面和同一负载；每个变体使用相同安装、启动、
   预热和采样时长。先排空启动/首帧和 shader 冷启动，再记录帧数与
   `FrameTiming.rasterDuration` 的 median/p95。Profile trace 可同时保留 Perfetto，
   但不要把 `AcquireNextDrawable` 单个 slice 当成 raster 或物理屏幕 FPS。
3. 依次对照：原始默认矩形 clip、临时绕过 clip 的 `no-clips`、`doAntiAlias:false`、
   以及纯 Flutter 场景。`noimages`/`notint` 可作为定位对照，但要标注其样本数较小。
4. 在 `doAntiAlias:false` 版本上检查圆角、image 边缘、tint、nested scissor、surface/
   texture 顺序；确认只改变矩形 clip 边界的抗锯齿，不把缺少边缘 AA 误记为删除 clip。
5. **Release SurfaceFlinger 验收**：再构建正式 release 包：

   ```sh
   flutter build apk --release --target-platform android-arm64 --target=lib/main.dart
   ```

   覆盖安装到同一台 MAA_AN00（保留 data），正常启动并确认日志仍为 Impeller Vulkan、
   包无 `DEBUGGABLE`。Release 这一阶段只采 SurfaceFlinger 的有效相邻间隔和屏幕表现，
   不把 Profile 的 Flutter `FrameTiming` raster 数值冒充成 Release raster 数据。

之所以不能把矩形裁剪改回 Flutter 默认 `doAntiAlias:true`：DrawList 合同已经保证这是
core 求交后的矩形屏幕边界；设备实测恢复默认 AA 会把 raster 从约 3ms 拉回约 56ms。
这不是为了追求名义 FPS 而牺牲圆角/image 质量；圆角和 image 的 AA/滤波仍由各自绘制
分支保留，只有合同定义的硬矩形 scissor 关闭边缘覆盖计算。

## Release 真机验收结果

MAA_AN00 上使用上述 arm64 Release APK 覆盖安装（保留已有 data）后，正常启动没有额外
`--ez` 参数；日志确认使用 Impeller Vulkan，包标记无 `DEBUGGABLE`。同一 Showcase 页面
截图显示 Flutter 60 FPS：`/tmp/pocket-android-release-impeller-fixed.png`。

系统 SurfaceFlinger 取最后 100 帧，得到 98 个有效相邻间隔：

| 运行 | 有效间隔 | median | p90 |
| --- | ---: | ---: | ---: |
| Release `doAntiAlias:false` | 98 | 16.707ms | 16.709ms |
| 原 baseline profile | 98 | 66.793ms | 66.827ms |

这说明正式包的系统呈现节奏已回到约 60Hz；它是 Release SurfaceFlinger 间隔证据，不替代
Profile Flutter raster duration，也不把 `AcquireNextDrawable` 单独解释为驱动缺陷。

## `AcquireNextDrawable` 的解释边界

此前 Vulkan trace 中的 `AcquireNextDrawable` 等待与约 56ms raster 同时出现；在关闭矩形
clip 抗锯齿后 raster 回到约 3ms。这支持“GPU/raster 队列积压或 drawable acquisition
等待被前序绘制工作拖长”的解释。

但 `AcquireNextDrawable` 是等待/同步区段，不是单独的厂商驱动故障证明。它可能包含 GPU
队列回压、surface 可用性、显示同步或前序命令完成等待；不能仅凭这个 slice 宣称
SM7550 驱动有 bug。应结合同一场景的 raster、SurfaceFlinger/Perfetto 和冷/热 shader
窗口解释。

## 验收边界

本轮 Release 已确认：

1. image、tint、nested scissor、surface/texture 的视觉边界和绘制顺序保持；
2. Profile 诊断包的 raster 维持约 `3.084ms / 3.978ms` median/p95 设备基线方向；
3. SurfaceFlinger 有效间隔为 `16.707ms / 16.709ms`，没有把 present/compositor 等待
   直接等同 Flutter raster；
4. 始终保持 Impeller Vulkan，没有使用 Skia fallback，也没有升级 Flutter engine。

本文件中的数据来自本轮设备消融；不外推为所有 Android GPU、所有场景或固定 FPS 保证。
