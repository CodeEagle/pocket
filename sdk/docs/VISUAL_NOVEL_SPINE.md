# Pocket Spine 运行时适配调查

调查日期：2026-11-07
运行时：Esoteric Software `@esotericsoftware/spine-core` **4.3.13**。`4.3.13` 由 npm registry 的 `npm view` 核实，包的 license metadata 是 `LicenseRef-LICENSE`；Spine 官方说明 spine-ts 4.3 runtime 读取 Spine Editor 4.3.xx 的导出数据。

## 结论

官方 `spine-core` 是 JS/TS 骨骼数据加载、动画状态、world transform 和 CPU clipping 的核心运行库，可在无 DOM 的环境里使用。Pocket 只需要此核心，不需要引入官方 WebGL、Canvas、CanvasKit、Pixi 或 Player backend；几何结果由 Pocket adapter 转成帧网格，让已有 Pocket renderer 负责纹理、布局和绘制。

保留父 Flutter demo `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`（全文检索和文件名检索均排除 `pocket_host/`）未找到 Spine、Live2D、Skeleton 或 DragonBones 实现或资源。因此这不是迁移现存骨骼 renderer；适配复用官方 Spine runtime，并把结果接到 Pocket 现有 DrawOp/native mesh 边界。

## 官方来源与运行边界

- Spine 官方 [`spine-ts` 4.3 README](https://github.com/EsotericSoftware/spine-runtimes/blob/4.3/spine-ts/README.md) 将 `spine-core` 定义为加载和处理 skeleton 的核心模块，其他模块再提供 WebGL、Canvas、CanvasKit、Pixi、Three.js、Player 等 backend。README 写明 runtime 与 4.3.xx 数据兼容，并把使用说明指向核心 API 文档。
- 已安装模块只含 JS ESM、`.d.ts` 和 Spine 官方授权文件，没有运行时依赖；`TextureAtlas`、`SkeletonJson`、`SkeletonBinary`、`AnimationState`、`SkeletonClipping`、`MeshAttachment`、`RegionAttachment` 和 `SkeletonRendererCore` 等均由官方包提供。本 adapter 使用前三类加载/状态 API、Skeleton 的 world transform、attachments 的 world vertex API 和官方 `SkeletonClipping`；不会实现 JSON/binary parser 或三角裁切器。
- 官方 [`SkeletonClipping` 4.3 源码](https://github.com/EsotericSoftware/spine-runtimes/blob/4.3/spine-ts/spine-core/src/SkeletonClipping.ts) 与 [`SkeletonRendererCore` 4.3 源码](https://github.com/EsotericSoftware/spine-runtimes/blob/4.3/spine-ts/spine-core/src/SkeletonRendererCore.ts) 是 mesh / clipping 的行为依据。Pocket 侧不复用 SkeletonRendererCore 的 Canvas/WebGL 绘制，而是取其核心几何计算行为。

### Spine 授权边界

Spine runtime 源码公开可读不代表它是 MIT、BSD 或其他 OSI 开源授权。官方 npm metadata 为 `LicenseRef-LICENSE`，运行时授权由 [Spine Runtimes License Agreement](https://esotericsoftware.com/licenses/Spine-Runtimes-License-Agreement.pdf) 和 [Spine Editor License Agreement 第 2 节](https://esotericsoftware.com/spine-editor-license)约束，不应作为免费开源依赖对外描述。

- Editor License §2.1 允许集成或制作 runtime 衍生作品的条件包括：每个产品都在 runtime 之外增加“significant and primary functionality”，且集成时持有有效 Spine Editor license。
- Editor License §2.2 允许在产品中发布集成的 runtime，但随产品提供的文档或其他材料必须包含 Runtimes License Agreement，且集成时需有有效 Editor license。§2.3/§2.4 规定第三方再修改、适配、开发或创建包含 runtime 的衍生产品也需要自己的有效 Editor license。官方 README 还说明，SDK / toolkit 方案需要明确告知使用者各自的 Spine license 要求。
- Runtimes License Agreement 的替代授权路径要求每个产品用户都取得自己的 Spine Editor license，并在任何形式的再分发中包含该许可证及版权声明。
- Trial 不授予 Spine Runtimes 的集成或分发权。Pocket 将该包保持为可选、非默认的私有工作区包；实际把 runtime 捆绑到 Pocket 或消费者产物前，需先确定采用哪条官方授权路径，并随产品带上对应条款与声明。

以上是官方条款的工程摘要，不能替代对具体 Pocket 分发形态的法律审查。

## Pocket renderer 的接口缺口

迁移时查看了以下保留实现：

- [`PocketTextureTriangleOp`](../packages/pocket_flutter/lib/src/pocket_model.dart) 只描述 texture、uniform color、position、uv 和 clip。
- [`PocketViewPainter`](../packages/pocket_flutter/lib/src/pocket_view_painter.dart) 以 `ui.Vertices(VertexMode.triangles)` 和 image shader 绘制纹理几何，坐标和 UV 一一对应，当前 modulation 使用单一 tint。此渲染思想适合重用，不需要第二个 renderer。
- [`pocket_runtime.dart`](../packages/pocket_flutter/lib/src/pocket_runtime.dart) 把 texture-triangle 作为 DrawOp 暴露；native `TEX_TRI` ABI 的 record 是固定三顶点。骨骼 attachment 通常是一组三角面网格，clipping 还会动态增加顶点，因而单个旧 `TEX_TRI` record 不能表达一个完整 attachment。Pocket 增加的 retained mesh 路径可以消费同一几何，但本包不负责 mesh ABI、纹理解码或 Flutter 绘制。

必要适配因此是：每个 Spine attachment 每帧输出一个脱离 runtime scratch buffer 的 geometry snapshot，由 SDK 的 Pocket / VN adapter 转成 retained image mesh。mesh 仍使用项目资产 registry 里的逻辑纹理 key；解码和上传继续走 Pocket 已有资源边界。

## 新 adapter 契约

源码位于 `sdk/packages/pocket_spine/`，只导入官方 `@esotericsoftware/spine-core`。包导出 `createSpineRig` 与下面的几种数据：

```ts
createSpineRig({
  skeleton: { format: "json", data } | { format: "binary", data },
  atlasText,
  textureKeys: { "page.png": "logical/image/key" },
  yAxis?: "up" | "down", // 默认 down
  coordinateScale?: number, // 默认 1
})
```

返回的 rig 只包装 Spine 官方对象和方法：

- `animationNames` / `skinNames` 从官方 `SkeletonData` 读取；`play(name,{loop,track})`、`setMix(from,to,seconds)`、`setSkin(name)` 直接调 `AnimationState` / `Skeleton`。`setSkin(undefined)` / `setSkin(null)` 恢复 `SkeletonData.defaultSkin`；没有 default skin 的模型则恢复无 skin 的 setup pose，不硬编码名为 `default` 的 skin。没有第二套时间轴或 skeleton state machine。
- `advance(deltaSeconds)` 更新 Spine 时间、AnimationState、应用 pose 并计算 world transform。上游 VN frame clock 可调用它；暂停时不应为了 mesh 而另行空转。
- `frame()` 按 Spine draw order 返回 `SpineFrameItem[]`。可绘制 mesh 含 `texture` 逻辑键、`positions`、`uvs`、`triangles`、uniform `rgba`、`blendMode:"normal"`、`clipped` 和 atlas 页 `premultipliedAlpha`。数组均为 adapter 持有的新 TypedArray，不会在下一次 frame 后被官方 runtime 重写。坐标默认从 Spine y-up 翻为 Pocket y-down，数值仍处在模型局部坐标，场景布局和角色变换由 Pocket 节点负责。
- 对不支持的 slot / attachment，不伪造 srcOver mesh，而返回 `kind:"unsupported"` 与原因。当前明确包括 additive/multiply/screen blend、two-color/dark tint、以及 region/mesh/clipping 之外的附件类型。
- `dispose()` 清空 Spine animation tracks、结束 clipping 状态并释放 `TextureAtlas`。TextureAtlas 页纹理没有由本 adapter 创建；PNG/图片资源属于 Pocket registry / texture store，因此不会被 adapter 重复 decode 或 dispose。调用已 dispose rig 的操作会报错，重复 dispose 安全。

Skeleton clipping 由官方 `SkeletonClipping.clipTrianglesUnpacked` 在 CPU 侧完成；`clipped:true` 的 position/UV/index 数据已经是裁切后的几何，Pocket renderer 不应再尝试用第二套 Spine polygon clip。当前测试验证了一个凸四边形 clip polygon。更复杂的 Spine clipping 组合要继续增加真实 fixture。

VN factory 在计算首帧角色 fit bounds 前先应用完整初始 intent，并以零 delta 调用官方 runtime 使 pose 生效；因此只有被初始 intent 指定的 skin、且没有 default skin 的模型也会按真实 mesh bounds 适配舞台。运行中清除 `skin` 和 engine rollback 都通过同一 official rig API 恢复 setup/default skin；skin 改变不重置正在播放的 animation phase。

Pocket retained mesh 目前的统一 tint 是单个 ARGB/ABGR 颜色。本 adapter 输出 `[r,g,b,a]` 的 unpremultiplied 归一化值，桥接层负责按 Pocket mesh buffer 打包；atlas page 的 PMA 标记同时保留。普通 RGBA 页才能直接验证普通 alpha 混合；PMA 页应由集成 adapter 明确拒绝，直到 Pocket texture decode / shader 的预乘语义有端到端验证。

## 可复现验证

自制 fixture `test/fixtures/weighted-mesh.json` + `.atlas` 用官方 Spine JSON / atlas loader 计算，包括 root/hinge 双骨加权四点网格、`idle` / `wave` 旋转动画和 clipping attachment。使用 Bun 在没有 `document` 的运行环境执行：

```sh
cd sdk/packages/pocket_spine
bun test
```

覆盖的行为：

1. 官方 JSON loader 读入自制 skeleton 和 atlas；weighted mesh 生成可绘制 mesh，texture key 映射正确。
2. 官方 SkeletonClipping 输出新的位置、UV 和三角索引；clip 后顶点限制在 fixture 裁切窗口内。
3. `advance()` 改变 weighted vertices；`AnimationStateData` / `AnimationState` 的 idle→wave mix 输出不同于直接播放 wave 的中间几何。
4. additive slot 返回 `unsupported:blend-mode`，没有输出可被误当 normal blend 的 mesh。
5. snapshot 不与 runtime 重用 scratch buffer alias；dispose 幂等，dispose 后不能继续 frame。
6. 每个 atlas 页都需要由 caller 显式绑定 Pocket 逻辑纹理 key。

在 `sdk/` 下还执行了 VN/Spine 集成回归：

```sh
bun test packages/pocket_vn/test packages/pocket_spine/test
```

结果：**30 passed，0 failed**。新增用例使用官方 parser 的不同 skin 与没有 default skin 的 fixture 验证首帧 fit；真实 NovelEngine rollback 把 model intent 从另一 skin 恢复到 setup skin，并与未换 skin 的官方 Spine control rig 在同一 animation phase 上比较位置几何。

另外，从官方 `spine-runtimes` 4.3 branch 临时读取 `spine-ue/Content/GettingStarted/Assets/celestial-circus/celestial-circus-pro.skel` 及其相邻 `.atlas`，以同一官方 `SkeletonBinary` 路径做了 binary smoke。Headless 初始 pose 产出 64 个 items：56 个 mesh、8 个明确报告为 unsupported blend mode；随后 advance 和 dispose 成功。官方样本没有保存到 Pocket 仓库。

在当前环境还执行了：

```sh
../../node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict src/index.ts
bun build src/index.ts --target browser --outdir /tmp/pocket-spine-build --external @esotericsoftware/spine-core
```

两项均通过。Browser bundle 只用于验证核心模块可被 Bun 打包，未创建 Canvas/WebGL renderer。JS package 接入真正 pinned guest/QuickJS 和 Pocket mesh buffer 的端到端路径属于后续集成验收。

## 明确未支持 / 需要继续验收

- Blend: additive、multiply、screen、two-color tint 暂不绘制，保留可观察错误项。官方样本中 8 个 additive slot 已走该错误路径。
- Attachment: region 和 mesh 可输出；clipping attachment 只作为 CPU 裁切操作；path、point、bounding box、sequence 中的高级变体和其他非图片附件当前不绘制。
- Texture: adapter 不读取图片文件、不做 atlas page packing、不解码、不生成 GPU handle，也不持有 Pocket image。atlas region 与 page file 的映射来自调用者。
- Physics: advance 使用官方 `Physics.update`，但还没有针对 Spine physics constraints 做确定性、暂停/恢复和不同帧步长的回归。
- Geometry: 已对普通 mesh、weighted mesh、普通 convex clip 验证；尚未覆盖 deform/linked mesh/sequence/inverse 或 concave clipping 的 Pocket end-to-end。
- Live2D 是不同授权和模型格式，本包不包含也不假装兼容 Live2D。
- 生命周期复用优化：本小包每个 rig 独立创建 `SkeletonData` / atlas；共享不可变数据缓存可之后根据模型规模测量再做，当前不添加第二层缓存 owner。

## 参考

- [Spine `spine-ts` 4.3 README（模块划分、4.3.xx 兼容与授权摘要）](https://github.com/EsotericSoftware/spine-runtimes/blob/4.3/spine-ts/README.md)
- [Spine `Skeleton.ts` 4.3](https://github.com/EsotericSoftware/spine-runtimes/blob/4.3/spine-ts/spine-core/src/Skeleton.ts)
- [Spine `SkeletonClipping.ts` 4.3](https://github.com/EsotericSoftware/spine-runtimes/blob/4.3/spine-ts/spine-core/src/SkeletonClipping.ts)
- [Spine `SkeletonRendererCore.ts` 4.3](https://github.com/EsotericSoftware/spine-runtimes/blob/4.3/spine-ts/spine-core/src/SkeletonRendererCore.ts)
- [Spine Runtimes License Agreement](https://esotericsoftware.com/licenses/Spine-Runtimes-License-Agreement.pdf)
- [Spine Editor License Agreement](https://esotericsoftware.com/spine-editor-license)
- [Official npm package `@esotericsoftware/spine-core`](https://www.npmjs.com/package/@esotericsoftware/spine-core)
