# Live2D 子像素精度与高清验收

2026-11-08，用户反馈全身人物发糊，近景稍好，观感类似未开启 Retina。本轮把显示倍率、源纹理、模型坐标精度分开核对；不能用大尺寸导出图片替代设备验收。

## 已复现的边界

- 当前 macOS 会话 `NSScreen` 仅报告 1920×1080、`backingScaleFactor=1`。普通桌面窗口的自然 DPR1 不能证明 Retina 设备表现，也不能据此认定 App 关闭了 Retina。
- 现有 Flutter painter 接收实际 `View.devicePixelRatio`，网格直接绘制到 Canvas；当前路径没有一张固定 329×600 的模型位图再放大。两张原始模型页为 2048×2048，LOD 选择已计入 DPR。
- pinned Core `draw.rs::emit_tex_tri` 对裁剪后的模型顶点执行 `roundf`，再打包整数 XY。后续 native PFB 与 Dart 均支持 float32 坐标，但无法恢复前面丢失的小数。DPR2 下，一次 0.5 逻辑像素舍入可变成 1 个物理像素偏差；这证明精度损失存在，不证明它解释全部观感问题。
- 源 PNG 与 staged PNG SHA 相同，均为 2048×2048、8-bit/channel RGBA。staged PAK `3d775a1f…` 的两页为 PSM8888，每页 16,777,216B 像素；标准 PNG unfilter 后逐字节等于 PAK payload，没有降尺寸、5650/4444 量化或有损编码。Flutter 只在资源解码边界做一次 straight→premultiplied 转换，模型 shader 未重复显式 premultiply。
- 原 DrawList 8/14 和普通 UI 行为必须保留；新增浮点模型输出属于 pinned renderer 的必要适配，不引入第二个布局或渲染器。

## macOS 显示模式的核对边界

Demo 的 Info.plist 已指定 `NSPrincipalClass=NSApplication`。Apple 的 [High Resolution Guidelines](https://developer.apple.com/library/archive/documentation/GraphicsAnimation/Conceptual/HighResolutionOSX/Explained/Explained.html) 区分 Cocoa 自动适配与系统放大的低分辨率模式；缺少一个显式 `NSHighResolutionCapable` 键本身，不能证明当前 App 在低分辨率模式。因此本轮没有添加一个未经证实能修复问题的 plist 开关，也没有伪造系统 DPR。自然 1× 屏幕与注入 2× 指标分别记录。

## 原实现基线

`lantern-letter-showcase-20261108/model-profile/` 与 `model-profile-dpr2/` 保留 d139f62d… QJBC / 3d775a1f… PAK 的真实 Core Profile 记录、截图与 required/completed `model-showcase` checkpoint。自然 DPR1 和 test-view 329×600/DPR2 均通过动作、遮罩、全身/近景、暂停恢复、释放及主线存档隔离。DPR2 截图为 658×1200，已人工查看，人物轮廓仍有明显台阶。

这些是逻辑尺寸与 DPR 注入测试；不是物理 Retina 显示器、iOS/Android 真机或 OS 换屏验收。原截图并未宣告用户反馈已解决。

## 修复与验证方式

- DrawList 追加 15/16，分别为 clamp/repeat 浮点纹理三角形，每个记录 15 words：op、texture、三组 float32 x/y/u/v、color。旧 8/14 的 12-word 记录不变，只有 retained PMS1 网格及其 mask 使用新记录。
- Native 把新 XY/UV 原样投影到现有 PFB float32 points；PFB 版本和 Dart 模型不需要另加状态或标签。检查截断、非有限坐标/UV、采样模式与 JSON/PFB 精度。
- `novel_model_showcase_test.dart` 的可选 `POCKET_MODEL_SUBPIXEL_ABLATION` 固定同一实际生产模型帧，使用现有 painter、原始纹理与 LOD 分别画出浮点、取整、4×DPR 后缩小的诊断参考图。它必须观察到真实 Core→DrawList→PFB 的非整数坐标；动作不同的两张图不能当作单变量对照。
- 4×图仅为诊断参考。`drawVertices` 的几何抗锯齿、贴图采样与真实显示器物理像素仍是不同因素；不能把一处精度修复描述为全面消除模糊。

## 实测结果与范围

- 最终模型 Guest：QJBC `b4e05229c4b70f17841fe28685a86c1b1d71e92c766416072ab0d7924db1469b`（1,081,051B），PAK `3d775a1fc3e773d17d73d3d45e73618adbd2a2fa52d5d4785e839fc7bcf48876`（69,216,400B）。Native 静态库 SHA `86a75823a5a0d638294f1cefcbec74f00915166661acc14b7a7efaf1e94d20e0`；新 native-only 工具包没有夹带此前构建的 WASM。
- 329×600 / DPR2 真实 macOS Profile、官方 Core 模型交互 **59秒通过**，driver 的 `model-showcase` required/completed 完整；全身三姿态、近景、遮罩、暂停恢复、再次进入、handle 释放和主线存档隔离均验证。已人工查看最终全身截图，鞋脚完整。实际模型帧有 3,199 个 Hiyori triangles、19,194 个非整数坐标，经 Core→DrawList→PFB 到达 Flutter，未提前取整。
- 同帧消融收集全部 **98 个模型 painter blocks**，保留其完整 mesh-layer 边界和次序；这些 block 可能还含相邻的 UI/气氛 op，不能当作干净全场景合成。两种对照只改变 Hiyori 坐标取整。头部与面部局部对 4×DPR 缩小参考的平均 premultiplied RGBA 像素误差分别由 4.372→1.690、4.579→2.092。该误差降低不等于通用“清晰度提升百分比”，也不能代表整屏、所有姿态或物理设备质量。
- 对照顺序为左取整、中浮点、右4×诊断参考：[头部局部图](../.pocket-build/live2d-subpixel-20261108/model-profile-dpr2-final/head-comparison.png)。坐标区域、脚本、原 PNG、完整驱动日志、checkpoint 与逐文件哈希保留于 `sdk/.pocket-build/live2d-subpixel-20261108/model-profile-dpr2-final/`。较早的 a40a4759…候选也通过相同实际 Core 测试并单独归档，不与最终 Guest 混用。
- 相同最终 Guest / native 在自然 macOS 指标下的模型 Profile **57秒通过**，未传尺寸或 DPR override，实际内容为 329×600、DPR1，`testViewMetrics=false`；动作、遮罩、暂停/恢复、释放及存档隔离通过，required/completed checkpoint 完整。7 张原 PNG、坐标消融和完整制品清单归档于 `sdk/.pocket-build/live2d-subpixel-20261108/model-profile-natural-final/`。它验证当前系统自然倍率运行，不代表物理 Retina。
- Native 旧 repeat 与新 float clamp/repeat 投影测试 **2/2** 通过，包括小数 XY/UV、采样器、JSON/PFB、截断及 NaN/Infinity 拒绝。另有 PMS1→Core 集成 **5/5**、DrawOps decoder **6/6**、raster/present 定向回归与补丁正反重放。独立只读审查没有发现 native/PFB 或同帧消融的阻塞问题。
- 最终 Guest 在新 native probe 上的主线三结局、存档/rollback/鉴赏、v1/v2/v3 迁移、能力巡演、视差回归 **32/32**（1,414 assertions）通过，日志 `/tmp/pocket-subpixel-final-native-regression-20261108.log`。

本轮修复证明模型坐标精度损失已消除，局部实际对照改善。Flutter `drawVertices` 的几何边缘抗锯齿仍有独立限制，4×诊断参考的细边质量不能宣称已在生产路径完整达到。当前系统仅有1×会话；物理 Retina、Android/iOS 真机、OS换屏及新版本完整性能/稳定RSS仍待验，整体 Goal 保持未完成。

## 普通 Demo 启动边界修复

首次独立启动捕获到 `AppDelegate.applicationDidFinishLaunching` 的 ObjC
forwarding 异常。保留父项目的 `macos/Runner/AppDelegate.swift` 没有此 override；
本地 Flutter 3.47.9 的 `FlutterAppDelegate` 实现与二进制方法表均没有
`applicationDidFinishLaunching:`，该 selector 仅为 `NSApplicationDelegate`
的可选协议方法。Demo 直接调用 `super` 因而触发未实现 selector。
最小适配删除该 super 调用，保留原窗口展示，没有新增生命周期状态。
独立包的异常日志保留为失败证据，不把仅有窗口/动态库映射算作 Guest 就绪。

## 普通 Demo 包交付

已重建普通 `lib/main.dart` macOS Profile 并复制到独立缓存
`sdk/.pocket-build/lantern-playable-retina-20261108/pocket_host.app`。
Root UI / Lantern 的 QJBC、PAK、metadata 共六文件与 staged assets
逐字节一致，`codesign --verify --deep --strict` 通过。使用 `open -n`
启动 PID 84903，实际 onscreen 窗口为 800×632，加载 Metal；该次启动
未再出现上述 AppDelegate 异常，并存在属于该 PID 的受认证 VM Service
listener。未启动 Editor、未清用户存档，旧 PID 41682 在新启动前已不存在。

直接 executable 的首次启动尝试已退出；日志中的签名信息不足以单独证明
因果，正常包验证通过后使用 `open -n` 成功，不需要重签或修改系统安全策略。
启动 manifest、首次失败日志、最终窗口事实和资源 hash 均留在该缓存目录。
前台游戏像素与 main isolate 业务初始化未取得独立证据，不能用窗口和
动态库映射代替这些验证。当时尚未定位的英文长文 store 差异，后续已确认为
locale重建触发的冗余自动存档并修复；T02后续完整验收通过，见
[最终长文 Flutter 验收](LANTERN_LETTER_SHOWCASE_FLUTTER.md)。

## Remaining mesh-edge boundary (independent read-only check)

The pinned Flutter engine's `engine/src/flutter/display_list/dl_op_flags.h`
`kDrawVerticesFlags` excludes `kUsesAntiAlias`; `lib/ui/painting/canvas.cc`
applies that flag mask. Consequently a Dart `Paint.isAntiAlias` toggle is not
an evidenced coverage-AA fix. The current SDK's filtered mip generation and
bilinear ImageShader sampling address texture minification, not silhouette
coverage. No duplicate DPR coordinate scale was found: the production painter
uses layout/frame scale and Flutter applies the view DPR; DPR² is intentional
in the two-dimensional mip-area calculation.

The existing 4× diagnostic also gives its higher DPR to the mip selector, so
it may choose a different image level. It remains a diagnostic reference for
the float/rounded comparison, not an isolated AA comparator. Any subsequent
AA experiment must pin the same selected image level as well as pose, masks,
blocks and viewport. An engine-side coverage experiment and its pixel/frame
cost have not been implemented or accepted. Do not substitute a no-op Dart
flag or a softer filter for evidence of smoother silhouette geometry.

## 后续普通试玩制品

当前普通 Demo 是 `sdk/.pocket-build/lantern-playable-locale-20261108/pocket_host.app`，
PID 15377，QJBC `9c01ae0d…` / PAK `3d775a1f…`。仅修改 JS autosave listener
的检查点初始化，没有改模型几何、纹理或 native 库。签名、六个内置资源的
逐字节一致性、onscreen窗口和VM listener已核验；前台游戏像素仍未独立确认。
此前 b4e 的模型和4×诊断图仍是该冻结制品的证据，本轮没有将其冒认为
9c01的模型帧率、RSS或画质重测。新包就绪后只终止旧普通Demo PID84903，
未启动Editor或清用户存档。制品记录在新缓存目录的 `manifest.json`。


## 固定 LOD 的边缘采样复验

2026-11-08 后续对当前 `9c01ae0d…` Guest 在 DPR1、注入 DPR2 下分别完成四姿态 Profile，两个 driver 均通过，48张诊断图及8张普通画面已归档。与早期4×DPR坐标实验不同，本次固定 painter DPR、纹理和 LOD 输入，只改变 raster sample factor。2×输出在全部8组外轮廓区域更接近4×诊断参考，但该结果不等于生产清晰度验收，也未启用逐帧离屏超采样。完整方法、数字和限制见[固定LOD边缘采样消融](VISUAL_NOVEL_MESH_EDGE_ABLATION.md)。


## 实际窗口 AA 路径的修正

后续 pinned 源码核对确认：`FlutterDartProject.mm` 在 `FLTEnableImpeller` 缺省时返回 YES；Demo plist 未关闭它。Metal `SwapchainTransientsMTL::GetMSAATexture()` 使用 kCount4，`SurfaceMTL` 绑定该 attachment，`VerticesContents` 沿 pass sample count 取 pipeline。因此当前 macOS 配置的窗口网格具有4×覆盖采样；缺少 `kUsesAntiAlias` 只说明 Dart Paint 开关不能切换它。此前将该 flag 或 flutter_tester/Skia 的像素结果直接解释为真实窗口没有网格 AA，是过度推断，现予以修正。Impeller snapshot 同样支持 MSAA，离屏图也不能笼统视为单采样。官方说明见[Impeller可用性](https://docs.flutter.dev/perf/impeller)与[抗锯齿](https://docs.flutter.dev/perf/antialiasing)。窗口/物理Retina质量仍需实际验收；当前重点为已复现的批内纹理LOD选择问题。

## 当前 SSAA2 验收进度（2026-11-08）

- 固定同一冻结 Guest（QJBC `9c01ae0d…` / PAK `3d775a1f…`）分别完成 macOS 800×600/DPR1 与 test-view 329×600/DPR2 的四姿态同帧 A/B：全身、近景、全身 idle0、全身 tapbody。两矩阵的 driver 均通过，保存的 A/B JSON 和截图位于 `sdk/.pocket-build/mesh-span-ssaa-ab-20261108/actual-desktop-dpr1/` 与 `actual-mobile-dpr2/`。这些图是实际 painter 的离屏重放比较，不是用户感知清晰度百分比。
- 每个 A/B 都保留真实 Widget tree 捕获的有序 mesh span partitions 和原 32-op painter 切分；sampleScale 1 的 group replay 在八组视口/姿态比较中均与逐原 painter 绘制逐像素相同。sampleScale 2 有可见像素差异，但这仅证明采样路径不同，不能证明整体模糊已解决。
- 合并后的当前六文件 SSAA2 focused 测试 **34/34 通过**，SDK analyze clean。绘制后的 `ui.Vertices` 已释放；Profile 里的 snapshot 计数也记录了 Dart `ui.Image` handle dispose，但这些都不证明 GPU in-flight work 已完成。
- near-deadline Ticker 实验的五个 10 秒窗口未显示有意义收益，已撤回该 flag、调度分支和专用测试；不把它纳入当前 SSAA2 候选。实验记录和限制见[Wake deadline audit](VISUAL_NOVEL_WAKE_DEADLINE_AUDIT.md)。
- 普通 main Demo 的 `POCKET_MESH_SUPERSAMPLE=2` Profile app 已构建、签名并复制到 `sdk/.pocket-build/lantern-playable-ssaa-20261108/pocket_host.app`，尚未 launch。全 20 窗口 soak 正在运行（session 55369）；最终 RSS/稳定性门禁与普通包启动/前台业务验证仍待结果。

800×600/DPR1 是当前 1× macOS 会话；329×600/DPR2 是测试视口 override，不是物理 Retina 面板。当前证据不宣称完全消糊、物理 Retina 验收通过或达到帧率目标。全 20 窗口结果和普通包实际启动后再更新最终判断。

## 最新普通包与 full20 结果（覆盖上面的待运行状态）

普通 main `POCKET_MESH_SUPERSAMPLE=2` Profile app 已从
`sdk/.pocket-build/lantern-playable-ssaa-20261108/pocket_host.app` 启动，PID
46513。签名、六项内置 Guest 资源与 staged assets 逐字节一致、800×632
onscreen 窗口、layer 0 和 VM listener 53331 均已观察到。后续 authenticated
VM-main 探测没有得到 authenticated URL；另一次 CUA/native pipe 启动失败且
browser host 不可用，因此 Guest main isolate 和前台游戏像素仍未确认。确认
PID 46513 就绪后，旧普通 Demo PID 15377 收到 SIGTERM；后台 daemon PID
39062 保留，用户存档未清理，Editor 未启动。

full20 soak（session 55369）以 exit 1 结束。20 次模型进出中，模型 handle
和三角形在每次退出时均为 0；snapshot 创建/释放计数 8,075/8,075 相符。
第 7–10 轮的 RSS 样本不稳定，因此稳定性门槛未通过。首 5 轮与末 5 轮
RSS 中位数相差 180,224 B（约 0.029%），两个增长上限均未超，但样本稳定性
条件仍须通过，不能据此判定 soak 通过。另有整游戏 7 个窗口和模型 5 个
窗口完成；模型 build P95 五窗为 15.013、14.852、14.313、14.144、15.310 ms，
均高于 12 ms 目标。

该包确认窗口可以启动且资源/VM listener 存在，不等于已确认游戏前台内容。full20
稳定 RSS 与 build P95 门槛尚未满足；1×桌面及 test-view DPR2 证据仍不等于
物理 Retina 或移动真机。完整 Goal 保持未完成。

## 后续清晰度核对与 PMS1 A/B（2026-11-08）

独立源码核对没有发现固定低清模型位图或宿主漏乘 DPR。Demo 的 800×600
初始内容区和可调整窗口沿用 retained parent；800×632 是含窗口装饰的尺寸。
当前系统自然 backing scale 为 1，不能用注入 DPR2 的截图代表物理 Retina。
全身和近景沿用同一 2048² 贴图；故事 scale 分别为 1.5 和 3.5，近景头部因此
得到更多最终像素。SSAA2 在 1×屏幕上最终仍回到相同物理像素预算；这既不
证明模糊已解决，也不证明 mip 有错。下一步固定同一 2× snapshot、LOD、
partition 和姿态，只比较最终 low/medium/high 下采样，检查纹理细节与边缘。

保留的小型 JS PMS1 批量写入候选经过实际 Flutter Profile 单次顺序 A/B：
每条件五个 10 秒模型窗口、两轮 handle 释放，两个 driver 均 exit 0。
五窗 P95 的中位值 native 9.964→9.547 ms、build 14.462→14.039 ms、
raster 0.485→0.524 ms、totalSpan 25.126→24.973 ms；overBudget 中位值
5→5。该候选不改变画质，build 仍未达 12 ms。完整范围和原始制品见
[CPU 采样记录](VISUAL_NOVEL_CPU_SAMPLING.md) 与
`sdk/.pocket-build/pms1-real-profile-20261108/comparison.json`。

候选 QJBC `396b07fc…` / PAK `3d775a1f…` 已 staged，旧 Guest 原样备份。
普通 PID 46513 仍是此前 9c01 的独立 SSAA2 包，未冒充已更新。
后续 full20 首次因生成框架 lipo EEXIST 在构建阶段失败，归档该单个生成文件后，
Flutter wrapper 的 git 报 `.git/config: Operation not permitted`；直接调用同版本
cached Flutter tool 可读取版本，但 xcodebuild 报 Demo macos 目录不可读。
这些尝试均没有进入 runtime，不能算 full20 或新画质通过。源码权限未修改，
未清用户存档，现有普通窗口和 daemon 保留。日志与状态在
`sdk/.pocket-build/pms1-real-profile-20261108/full20/manifest.json`。

### 后续恢复检查与滤镜测试入口

随后显式 `xcodebuild -list -project Runner.xcodeproj` 成功解析现有本地
Swift packages；直接调用同版本 cached Flutter tool 时，工程自动发现仍报
目录不可读。显式 workspace 编译也成功解析依赖，但官方 Prepare Flutter
Framework Script 再调用 Flutter wrapper 时仍因 Git `.git/config` 的 EPERM
失败，未产出新 app。源码核对没有找到保留当前依赖体系且跳过该准备步骤的
受支持开关；未更改 pubspec 的 SPM 配置、Flutter wrapper 或系统权限。
`--use-application-binary` 虽支持 macOS，但尚无本次新 binary 可用，不能
将它记为已运行。详见同一 full20 目录的 `recovery-environment-probe.json`。

现有 `novel_mesh_span_diagnostics.dart` 已增加 opt-in
`captureNovelMeshSpanFilterAblation`，showcase 测试仅在
`POCKET_MODEL_MESH_FILTER_ABLATION=true` 的 full/closeup 捕获点调用。
它从真实捕获的有序 partitions 只录制一次全 surface 2×透明 snapshot，
固定该图像分别输出 low/medium/high；另记原 DPR/LOD 不同的直接 1×参考。
实际 model bounds 用于之后手工选择眼睛、头发和衣纹区域，不新增自动裁切层。
该全 surface async picture replay 不宣称与生产 cropped `toImageSync` 逐像素
一致；其内部只改变最终滤镜。Dart format 与两文件 analyze 通过；root 后续只
补了一条该方法限制字符串。没有运行、没有采图、没有画质结论，生产滤镜未改。
测试状态与源 hash 见 `sdk/.pocket-build/pms1-real-profile-20261108/filter-test-status.json`。

本次系统屏幕抓取授权预检也返回 false；没有弹出授权请求或绕过它。现有普通
app 的前台像素和物理 Retina 仍未取得独立证据。上述入口及静态检查不替代
真实模型输入、窗口质量与性能/RSS 验收。


### 当前复查：仍未通过消糊验收

再次核对现有自然 DPR1 的 `ordinary-full.png` 与 `ordinary-closeup.png`：
两者均为 800×600，近景确实给脸部更多最终像素。这个观察不能证明最终
缩小滤镜正确，也不能把全身显示的细节不足归因于用户设备。本轮未修改
生产滤镜、模型或系统 DPR；普通独立包也未更新。

为区分 macOS app 构建阻塞与 Dart Canvas 测试阻塞，直接调用同一 pinned
3.47.9 的 cached `flutter_tools.snapshot test --no-pub`，加载
`pocket_mesh_span_sampling_test.dart` 时即报告 shell subprocess segmentation
fault，未执行测试主体。日志为
`/tmp/pocket-mesh-span-sampling-cached-snapshot-20261108.log`。
该次 shell 的 `tee` 返回值不能代表 Flutter 成功；runner 明确标记失败。
即使后续软件测试可运行，也不能代替普通 Metal 窗口和物理 Retina 验收。


补充隔离目录诊断：将同源 package 测试副本放在 `/private/tmp`，保留同一
3.47.9 Dart、Flutter packages、engine 与绝对依赖路径，补齐现有 shaders 和
package graph 后重试。Flutter 真实退出码为 1：准备测试资产时，官方
`stretch_effect.frag` 的 `impellerc` 以 -11 退出，抛出
`ShaderCompilerException`，测试主体仍未启动。日志为
`/tmp/pocket-mesh-span-sampling-isolated-20261108.log`；crash report 位于
`/private/tmp/pocket-mesh-span-copy-cb5hqnw2/flutter_01.log`。该诊断未修改
生产代码、Flutter wrapper 或系统权限；没有取得新的模型对照图。


### 同源内部路径恢复（2026-11-08）

后续最小实验将原签名 `impellerc` 普通复制到 `/private/tmp`，SHA-256 仍为
`87ba94547f2bd1ae172b812c3053cd13b2aab4a18ba02affb23800ed680af4d6`，
`--help` 从原路径 exit139 变为内部路径 exit0。没有改签名、权限或二进制。
因此建立临时同源 Flutter 3.47.9 副本，复制 `.git`、`bin`、`packages` 与根配置；
Dart、impellerc、flutter_tester 和 tools snapshot 哈希均与原件相同。
副本官方 `bin/flutter --version` 成功，sampling 测试 3/3 通过（exit0）。
记录在 `/private/tmp/pocket-flutter-sdk-3.47.9-20261108/isolation-check.json`
和 `isolated-sampling-test.json`，日志为
`/tmp/pocket-mesh-span-sampling-isolated-sdk-copy-20261108.log`。
软件 Skia 测试不替代 Metal；原 SDK 和源码权限均未修改。

再用不改源内容的临时 Demo 构建副本（SDK 源链接回原工程、现有 assets 原样
复制），官方 `pub get --offline` 与 macOS Profile 编译均成功。初次测试在新
标题菜单的被裁切入口断言处失败；已调整模型测试，让入口通过现有真实滚动
找到，并用可见的开始按钮确认返回标题，保留实际 replay/resume/磁盘检查。
这不是将隐藏文本注入画面或更改生产导航。后续运行结果另记，不能以成功编译
代替整条交互通过。


### 固定同一 snapshot 的最终滤镜结果

内部路径官方 Flutter 3.47.9 的真实 macOS Profile 模型 driver 最终 exit0，
`01:12 +2: All tests passed`，required/completed `model-showcase` 闭合。
同一 v6 Guest `88ef9081…` / PAK `b08e3f07…` 实际完成 Spine、Hiyori 动作、
遮罩、暂停恢复、两次释放重入、磁盘主 auto 不变及继续主线；仅模型功能通过，
不代表整游戏性能、稳定 RSS 或清晰度门槛通过。

800×600 / DPR1 的 full、closeup 各录一次 1600×1200 snapshot，再从同一
image 输出 low/medium/high。两组的 medium 与 high PNG 均逐字节相同；
low 与 medium 的 RGBA 差异为全身205像素、近景521像素（每图480,000像素）。
这是输出差异计数，不是清晰度分数。实际查看近景 low/medium 未看到足以
解释用户模糊反馈的细节改善，因此保留生产 medium，不新增滤镜开关。
本轮关闭“只把 medium 改 high 就能消糊”的候选，整体清晰度仍未通过。

报告、10张滤镜/参考PNG、4张普通截图、driver log、原测试源快照、Guest与
同源工具哈希位于 `sdk/.pocket-build/live2d-filter-internal-20261108/attempt5/`。
`attempt4/` 是最后标题断言失败的独立历史记录，不混作通过。
最终test源 SHA `c9275af5…d7834` 已与镜像一致核对。报告生成时的
`testSourceSha256:null` 由同目录 manifest 中的源快照补充；不能回填到失败的
attempt4 源。自然物理 Retina、移动设备与生产 cropped snapshot逐像素身份
仍未证明；本次指标为显式 test-view 800×600/DPR1。


## 同帧 LOD 可用性消融（2026-11-08）

沿用本文件记录的 retained parent 来源核对与已迁移的当前 `PocketMeshSpanPainter`，仅在诊断重放中清空 Hiyori span 的 `meshImageLevels`；同一捕获帧的 DrawOp 列表、原始 `ui.Image` 对象、partition 顺序、遮罩、其它 painter、SSAA2、mesh low 和最终 medium 均保留。生产渲染未修改，也未增加第二套运行时。旧 pre-SSAA mip ON/OFF 实验不能代替这一组合的验证。

内部路径的同源 Flutter 3.47.9 macOS Profile driver 两次均 exit 0 / `+2 All tests passed`：800×600/DPR1 为 01:25，800×600/DPR2 为 01:33。每次都覆盖全身、近景、idle、实际 pointer tap 与模型退出释放/重新进入。实际 Guest 为 `88ef9081…` QJBC、`b08e3f07…` PAK、`157a56f7…` metadata。两个测试源码与 helper 及日志/报告/PNG/哈希冻结在 `sdk/.pocket-build/live2d-lod-availability-20261108/{dpr1,dpr2}/`。

人工核对同帧 PNG：DPR1 的 source-only 全身出现明显噪点与接缝，近景没有足以采用的细节收益，故拒绝该候选。DPR2 输出确实为 1600×1200；近景两臂 raw RGBA 完全相同，全身/idle/tap 分别有 39,029 / 38,763 / 38,931 个不同像素。差异计数不是清晰度评分；关闭生成层级没有证明能修复用户反馈。保留现有生产 LOD，不把测试通过写成画质通过。

本轮系统查询仍是 1920×1080、backingScaleFactor=1；测试结束时前台为 loginwindow，无法验证用户实际 Retina 窗口像素。这一 test-view DPR2 只证明高密度输出路径，不代表物理 Retina 验收。Live2D 模糊问题保持未解决，性能和 RSS 门槛也保持未通过。


## 只提升最粗选层的后续消融（2026-11-08）

历史 per-triangle Local LOD 与 medium 原图实验没有排除“whole batch 最粗选层只提升一级”。因此继续复用现成 batch 诊断，在 captured DPR × SSAA2 的有效DPR下读取同一帧的真实选层；每个 partition/asset 仅移除当前最粗已选层及更粗层，然后由同一个真实 span painter重放。每batch断言未变或恰好2×尺寸（一级），不拆batch；ops/images对象、顺序、遮罩、两个滤镜、snapshot预算与SSAA2均保持。没有新增生产算法或运行时状态。

当前输入修复 Guest `a5fed263…` / `b08e3f07…` / `0fefee84…` 的 macOS Profile 800×600/DPR1 driver exit0，01:26 / +2；四姿态 promoted/unchanged batch分别107/0、90/2、106/1、108/0，raw RGBA不同像素14,940、34,020、14,489、14,685。全身和近景PNG人工核对后，候选内部出现细碎接缝/噪点，没有稳定、有用的清晰度收益，故拒绝。既然目标1×窗口的候选已退化，不继续重复DPR2或性能测试，生产LOD保持原样。完整报告、8PNG、日志、源码与哈希在 `sdk/.pocket-build/live2d-coarsest-promotion-20261108/dpr1/`。这些计数不是清晰度分数。

输入交接修复已独立完成完整main/tour回归并打入普通main Profile包：`sdk/.pocket-build/lantern-playable-v6-handoff-20261108/pocket_host.app`，PID3303。六项资源/签名、main isolate、800×632窗口已核验，模型测试结束后恢复其前台并再次观察到PID3303。该包没有采用上述两个LOD候选；不能将输入修复或模型driver通过表述为Live2D模糊已解决。


Current PAK source-fidelity follow-up: `b08e3f07…` was independently decoded and compared again; both 2048² Hiyori atlas buffers match official/staged PNG pixels exactly. Old `3d775a…` byte-audit evidence is not relabelled as current. See [current texture audit](LIVE2D_TEXTURE_QUALITY_AUDIT.md#current-ordinary-bundle-pak-follow-up-2026-11-08). Ordinary app computer-use inspection again failed at native-pipe startup, so no new ordinary-window pixels or physical Retina evidence were obtained. This is not a renderer fix and does not change the unresolved quality gate.

### 用户再次反馈模糊后的倍率复查（2026-11-08）

独立只读复查没有发现可证实的 DPR 错乘或意外二次 frame-fit。来源先核对 retained parent `../pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:3913–4008` 与 `lib/core/ffi_bridge.dart` 的 DPR 传递；parent 没有可直接复用的 Live2D mesh/snapshot 实现。当前 `PocketView` 使用当前 FlutterView DPR，frame/surface 保持逻辑尺寸；Live2D 局部坐标经 PMS1 float32 XYUV 传递。SSAA 的 crop 是物理像素，snapshot 尺寸为 crop×sampleScale，绘制倍率为 DPR×sampleScale，合成 destination 为 crop÷DPR，代码上没有额外一次 frame-fit。未因此新增 plist 键、滤镜或倍率修正。

本轮普通 PID3303 仍存活。系统原生查询实际返回前台 `com.apple.loginwindow`、屏幕1920×1080、backingScaleFactor=1；CUA native pipe 启动失败，`screencapture -l18877` 返回1（could not create image from window）。这些记录归档在 `sdk/.pocket-build/live2d-window-density-20261108/`。系统屏幕倍率不能代替同帧 FlutterView 指标或普通窗口像素；已请求解锁，质量问题仍未解决。下一步取得普通窗口同帧 physicalSize/DPR、frame/paint/snapshot 尺寸和最终像素，再与相同模型、姿态和尺度的官方渲染对照。


### 解锁后的真实应用内捕获与官方基准（2026-11-08）

桌面恢复解锁后，普通窗口 OS 截图仍不可用：系统查询 `CGPreflightScreenCaptureAccess=false`、`AXIsProcessTrusted=false`，CUA native pipe 启动失败。普通 PID3303 的 `_flutter.screenshot` 也失败，进程日志明确报告 Impeller 不支持 compressed screenshot。因此解锁不是唯一前提；本轮没有取得普通窗口的 OS 像素，也没有证明物理 Retina。

复用 retained parent `test/pocket_38_components_screenshot_test.dart:39–53` 的现有 Flutter layer 截图方式，在 ignored QA 目录建立临时入口，直接调用真正 `main.dart`，注册指标、root layer 捕获与真实 GestureBinding pointer 注入；不添加业务 UI、生产 renderer 或生产 SDK API。临时包使用独立 `com.example.pocketHost.live2dDiagnostic` 容器，原 PID3303 与用户存档保留。复制包生成的 App.framework 重新 ad-hoc 签名，保留原 DebugProfile entitlements，最终 deep strict 验证 exit0。

macOS Profile 两次 QA 编译 exit0；实际 input 将计数器 00 改为 01，再经页面拖动、游戏入口、立绘试映、Hiyori、Idle0、全身和近景选项进入模型场景。应用内 root layer 捕获为 800×600；同一运行场景的指标为 FlutterView DPR1、physicalSize 800×600、逻辑尺寸800×600，mesh span sampleScale2、95 partitions、两张实际 ui.Image 均为2048×2048。全身与近景截图已人工查看，仍不将其记为清晰度通过。截图与指标是相邻调用，动画继续运行，不是冻结几何的滤镜 A/B。

证据位于 `sdk/.pocket-build/live2d-window-unlocked-20261108/`，重点为 `live-idle0-full-{scene.png,metrics.json}`、`live-idle0-close-{scene.png,metrics.json}`，全身 PNG SHA256 `baeb731fe0eec6c91b5d435005d1632595d246d64da0de5540660c5bf955add9`，近景 `1270a6fd00803ba24009a165c97b57670f6cd05fb9c649c698d058853bbcb119`。它们是独立诊断进程中真正 Demo 的 Flutter root scene，不是普通 PID3303 的 OS 截图。

同时，官方 Native 5-r.5 macOS OpenGL Sample 的隔离副本已用其 pinned GLEW2.2.0/GLFW3.4 构建并实际 readback：800×600、contentScale1、Apple M4/OpenGL2.1 Metal，原始 MOC/两张 atlas 与官方资源 byte-exact。禁用动作、物理、眨眼调度，仅 Core 默认参数更新，故默认多手同时可见；该静态姿态不能直接与游戏 Idle0 比较。已导出134 drawables、2822 vertices、10278 indices、70参数、完整 MVP/XY/UV/index/masks/blend 与 framebuffer 状态，供相同几何/尺度的受控对照。官方 default FBO 无 MSAA samples。复现脚本、补丁、PNG、事实 JSON 与 manifest 位于 `sdk/.pocket-build/live2d-official-reference-20261108/`。尚未据此修改生产采样或宣称根因；整体模糊、性能与 RSS 门槛仍未通过。

诊断捕获完成后，已按完整进程路径核验并结束自建 PID16641，恢复普通 PID3303 前台；临时镜像 AppInfo.xcconfig 与原备份逐字节一致恢复。清理事实与 SHA 位于同目录 `cleanup.json`、`mirror-restoration.json`。普通存档未清理，未开启 Editor。

官方采样补充按证据来源区分：Sample/Framework 源码配置为 texture MIN `GL_LINEAR_MIPMAP_LINEAR`、MAG `GL_LINEAR`、2048²生成12层mip；anisotropy默认0，无sample覆盖；输入atlas不做CPU premultiply，标准shader输出premultiplied并以ONE/ONE_MINUS_SRC_ALPHA混合。mask默认1张256² RGBA8、nearest、无mip、非高精度。上述采样配置是源码推导，未执行glGetTexParameter/glGetTexLevelParameter；FBO、viewport、samples、driver和readback为实际运行记录。官方原生Sample已退出，无自建Demo残留进程。

后续复核：虽然open -a普通包成功退出0，17:40左右AppKit再次报告frontmost为com.apple.loginwindow；因此只能确认恢复普通包的置前请求与进程存活，不能把请求成功写成最终前台观察。离线同帧对照不依赖解锁；未重复要求用户解锁。

### 独立构图消融审计

只读核对 `demo/macos/Runner/Base.lproj/MainMenu.xib:333–339` 与 `MainFlutterWindow.swift:4–13`：初始内容区800×600、可调整大小；未运行新的窗口拉伸验收。`pocket_ui/src/display.ts:194–221` 与 `pocket_vn/src/view.tsx:328–337`已有viewport订阅。Hiyori在`demo/js/apps/lantern/story.json:3299–3337`使用scale1.5/y80；`live2d.ts:64–66`先映射Core到canonical240×350，`viewport.ts:76–92`的artScale=min(1.35,w/360,h/640)，`view.tsx:287–310`内层只乘一次artScale，未发现artScale²冗余。当前800×600全身约386px高；按同姿态线性估算，1920×1080内容区在cap下约556px，无cap约695px，而无面板可用带约980px。这些是构图估算，不是新截图、Retina证据或采样修复。完整公式/遮挡带/来源在ignored `sdk/.pocket-build/live2d-composition-ablation-20261108/{audit.md,calculations.json}`；未采用未经图像验证的放大或窗口修改。

### 官方默认帧通过生产 painter 的软件重放

`official_frame_replay_test.dart`用同帧MVP将Core XY投影到固定800×600逻辑画布，沿现有Live2D adapter翻转UV Y，保留原图、索引、renderOrder及8个mask。134 drawable中129 visible，4个零indices为无片元no-op，遵循现有`live2d.ts`过滤后有125个可渲染项。fixture显式校验全normal/default tint/non-inverted等限定条件；mask语义/拓扑保留，但官方256² nearest FBO与Flutter mask raster尺寸不同，不能称逐像素等价。

内部同源Flutter3.47.9软件test runner关键DPR1/sample2及完整四组均exit0。DPR1输出800×600，DPR2输出1600×1200；sample2实际snapshot/dispose均1，无budget/ineligible/failure bypass，DPR1生成390176像素、DPR2生成1530360像素。三处112×112逻辑ROI（脸眼、发缘、衣服）使用标注倍率的nearest展示：DPR1与官方800×600参考近似，DPR2有更多原生采样细节，sample1/2未见足以采用的新清晰度收益。像素数不是画质评分；DPR2图没有冒称物理Retina窗口。

root已实际查看完整DPR1/sample2及ROI contact sheet。结果不支持“只提高SSAA就可替代实际DPR2”，也不能证明当前OS backing1有软件错误或生产Metal与Skia相同。继续做实际Profile/Impeller冻结帧对照后，才决定渲染改动。PNG、报告和fixture在`live2d-official-reference-20261108/flutter-replay-production-painter-20261108/`及其上级ignored QA目录；未改生产代码，整体清晰度未通过。

### 实际 Profile / Impeller Metal 冻结帧复验

在独立QA入口调用真正main，注册仅诊断的officialReplay，并在私有容器读取与官方SHA一致的facts/两张atlas，复用上述转换与生产两个painter。内部同源Flutter3.47.9 Profile编译exit0；复制QA包ad-hoc签名并deep strict验证exit0。实际进程PID67263日志明确 `Using the Impeller rendering backend (MetalSDF)`，不是仅凭构建模式推断Metal。宿主FlutterView实际800×600/DPR1；同一冻结几何输出DPR1/sample1和sample2各800×600，157 ops/133 triangle ops/8 mask passes；sample2 snapshot/dispose各1、390176像素，三种bypass均0。

root查看两张完整PNG与NativeGL/Skia1/Skia2/Metal1/Metal2同像素112² ROI nearest×2对照，没有发现这个冻结帧上Metal特有的明显额外模糊。sample2也没有显示足以宣称解决用户反馈的细节收益。该结论仅针对这份Core defaults、DPR1、物理800×600图：不覆盖实际Idle0姿态、所有批次/遮罩、普通窗口OS合成、物理Retina或移动设备。实际DPR2软件图更多细节与DPR1密度相符，但不能据此断言OS backing1是SDK配置错误，也不能把测试DPR2强行当作物理设备。

证据位于 `sdk/.pocket-build/live2d-window-unlocked-20261108/official-metal-{process.log,response.json,manifest.json,host-metrics.json,cleanup.json}` 与 `official-metal-output/`。两Metal PNG SHA为sample1 `941dac665046f855c1661195d6b8a66319c05f31a386794d0473c454eae48567`、sample2 `24b9613d1706e0fec7ca592b3b90d3b06017017628ba01798859c8b4064efae0`。同目录five-column ROI SHA `131da58bf70369fba876e5e1dad6e13209495dcc80670b6fc5c03337357f3d4e`。已按完整binary路径核验并结束自建67263，镜像AppInfo逐字节恢复，普通3303存活并请求置前；最后系统前台观测仍是loginwindow，不把open成功当作前台证据。未采用新的生产滤镜、DPR覆盖、角色放大或窗口配置；模糊反馈仍未解决，Goal保持active。


### Desktop-scroll resource refresh (2026-11-08)

Final scroll/IME rebuild uses QJBC `ceb1faf8…`, PAK `212b5f26…`, metadata
`d243cb49…`. The original texture audit was rerun against this exact PAK:
both Hiyori atlases remain 2048² RGBA8 and pixel-exact to official originals
(`desktop-scroll-20261108/audit-result.json`, exit0). No production Live2D
sampling or density change was adopted. New input/scroll regressions do not
upgrade the unresolved model-quality or physical Retina gate.


The ordinary main bundle was subsequently refreshed to
`lantern-playable-desktop-scroll-20261108/pocket_host.app`, PID32713;
main isolate runnable and 12 resource hashes checked before retiring PID3303.
Current AppKit observation again reports 1920×1080, backingScale1 and
frontmost loginwindow, with screen-recording access false. No new claim of
physical Retina or model-quality acceptance follows from this deployment.


Independent source review retained a bounded packaging hypothesis rather than
adopting a speculative fix: Runner and the ordinary built Info.plist omit
`NSHighResolutionCapable`; this omission alone does not prove low-resolution
execution. Pinned FlutterView inherits layer contentsScale from its window and
publishes backing-converted physical size; PocketView consumes current Flutter
DPR for painting and mesh LOD. No second forced 1x path was evidenced. The next
useful density experiment needs a real 2x screen: record NSScreen scale, NSWindow
backingScaleFactor, FlutterView layer contentsScale and Flutter physicalSize/DPR
in the same ordinary frozen scene; only if inconsistent compare a single-key
YES plist variant. Current backing1 environment cannot distinguish that
hypothesis, and forcing logical DPR2 is not a substitute.


### Exact native view and current functional capture

The [native density diagnostic](VISUAL_NOVEL_NATIVE_DENSITY.md) now distinguishes
FlutterViewWrapper from actual FlutterView and verifies window/Flutter/Guest
size propagation during actual NSWindow resizing. The engine metrics layer
is NSViewBackingLayer, so its scale is not relabelled as a direct Metal-texture
measurement. Current real-view density remains1 even in a subsequently key,
foreground QA window. Current candidate189ec94e passes the original model
showcase Profile test with QJBC ceb1faf8 / PAK212b5f26 and natural800×600/DPR1
captures (no test-view metric override). Root reviewed Idle0 full-body PNG;
functional pass does not upgrade quality. The 20-cycle follow-up is incomplete,
and no new sampling/DPR/asset-quality change was adopted.


Latest ordinary Demo is now `lantern-playable-delta-base-20261108/pocket_host.app`,
PID85465, after main readiness, signature and twelve-resource checks. Final
AppKit observation confirms ordinary bundle foreground and its800×632 onscreen
window, still1920×1080/backing1. This supersedes the earlier lock observation
for final foreground state, not the missing physical2x evidence. The deployed
change is resource ownership only; model-quality acceptance remains open.


## Actual Idle0 official-renderer comparison

See [same-pose evidence](VISUAL_NOVEL_IDLE0_RENDER_COMPARISON.md). The actual
Profile Guest capture passed; both 2048² atlases and bounded 2× SSAA were active.
Official GL showed no obvious sharper facial detail in the controlled 1×
comparison. Raw dynamic-history flags and full triangle-key coverage retain
explicit limitations. No production quality fix or physical Retina acceptance
is claimed; the user-reported clarity issue remains open. Group totals and
the full Goal scope are unchanged.
