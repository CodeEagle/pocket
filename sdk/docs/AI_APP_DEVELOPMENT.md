# Pocket AI 应用开发指南

本文是给 AI/Codex 类开发代理使用的执行规范。目标是让代理在不了解仓库历史时，也能沿用 Pocket 的真实编译、运行、Editor、硬件和热更新链路，不生成第二套 runtime、Flutter 业务页面或静态占位实现。

## 1. 开始前必须遵守

1. 应用页面、路由、业务状态、组件组合、更新按钮与更新策略写在 JS/TS/TSX。
2. Dart 只承接 Flutter 绘制表面、IME、生命周期、FFI、资源 IO、可信准入和显式注册的原生 capability transport。
3. 能在 JS 中完成的逻辑不得移到 Dart，例如表单 reducer、导航栈、请求重试、更新提示、录制控制和页面编排。
4. 不新增 WebView、第二套布局引擎、mock runtime fallback 或“先显示成功”的占位实现。
5. 硬件默认关闭，只启用应用实际需要的模块。Guest 声明能力不等于宿主已经注册能力。
6. 原生能力缺失时，优先按现有 `PocketPlugin` + `HostBridge` 协议接入自己的插件；不要把业务 UI 一起放进插件。
7. 使用固定 PocketJS compiler/engine 与 `buildGuest`。不要直接执行源码作为生产 fallback。
8. 修改 JS、UI 库或资源后必须重建 QJBC/PAK；静态检查不能代替真实 JS 执行和输入后画面变化验证。

## 2. AI 的推荐工作顺序

```text
确认需求
  → 用 TCA 风格完成 App/Game 的完整功能闭环
  → 为 State/Action/Reducer/Effect 添加测试用例
  → 选择 JS UI 并绑定已验证的状态与动作
  → 只选择必需的硬件/平台插件
  → 声明 manifest capability/permission
  → 使用 Editor 构建和真实 runtime 预览
  → 在模拟器/真机验证原生边界
  → buildGuest 生成 qjbc/pak
  → package_update 签名并部署
  → 验证首次 bundle、后续 blob 增量与回退
```

### App/Game 的功能优先顺序：TCA → 测试 → UI

无论选择 `app` 还是 `game`，都先用 TCA（State、Action、Reducer、Effect）风格把完整功能做完，再补测试用例，最后做 UI。这里的 TCA 是业务组织方法，不要求引入或伪造一个当前仓库没有的第三方 TCA 包；实现仍放在项目自己的 JS/TS 中。

1. **先完成功能**：先定义完整的 State 和 Action，用 Reducer 实现状态转移，用 Effect 编排计时、请求、持久化或其他异步边界。App 要先跑通业务流程，Game 要先跑通开始、进行中、暂停、恢复、重启、结束等完整状态，不依赖页面是否已经画出来。
2. **再加测试用例**：覆盖初始状态、主路径、边界值、错误/失败、异步结果，以及 App 的提交/返回或 Game 的暂停/恢复/重开/倒计时结束。优先测试 State/Action/Reducer/Effect 的行为和状态转移；截图或静态文件检查不能替代逻辑测试。
3. **最后做 UI**：只把已经验证的 State 和 Action 绑定到现有的 `@pocket/ui`、`View`、`Focusable` 等组件。UI 负责呈现和派发动作，不再创建第二份业务状态、计时器或流程编排；需要新的视觉时也保留已验证的交互语义。

这个顺序是功能开发的门槛，不是发布后再补的文档工作。若功能、测试或 UI 需要调整，应先回到对应的 State/Action/Reducer/Effect 层修正，再重新验证后继续向后推进。

开始修改前，AI 应先回答：

- 这个需求能否全部在 JS 完成？
- 是否真的需要新增 Dart/Swift/Kotlin？对应的系统边界是什么？
- 需要哪些 capability、permission 和原生包？能否少启用一个？
- 页面使用已有哪个 `@pocket/ui` 控件？是否在重复造组件？
- 资源属于首次基础包、按需网络资源，还是后续版本中的单资源更新？
- 如何验证真实 JS 输入驱动画面变化，而不只是检查文件存在？

## 3. 创建应用

默认创建不含硬件插件的薄宿主：

```sh
bun sdk/pocket.ts init /absolute/path/to/app \
  --app-id=com.example.notes \
  --name=notes \
  --version=1.0.0
```

生成后，业务工程应保持下面的职责：

```text
app/
├── lib/                 # 薄 Flutter host，不放业务页面/业务状态
├── ios/ android/        # 原生声明与真正的平台 provider
├── assets/              # buildGuest 生成的 qjbc/pak/metadata/manifest
└── js/                  # 唯一业务工程
    ├── app.tsx
    ├── manifest.json
    ├── pocket.json
    ├── package.json
    └── assets/
```

构建应用：

```sh
cd /absolute/path/to/app/js
bun install
bun run build
```

若是带 SystemUI 与多个 mini-app 的工程，使用项目已有的 `build:system`，不要为每个页面创造不同编译器入口。

## 4. JS 与 Dart 的分界

| 放在 JS | 只在必要边界放在 Dart/原生 |
| --- | --- |
| 页面、路由、导航栈 | `PocketView` 与 Flutter Canvas |
| signal/store/reducer | 系统 IME/TextInputClient transport |
| loading/error/empty 状态 | 生命周期与 viewport 事实 |
| 表单校验、重试策略 | FFI、文件读取、资源解码 |
| 更新检查/应用时机 | 签名、哈希、ABI、权限可信准入 |
| 硬件结果如何展示 | 相机、BLE、定位等系统 API provider |
| 列表、分页、筛选 | 原生 Texture 与授权生命周期 |
| 多应用打开/关闭/返回 | Worker/IO 官方执行边界的事实采集 |

错误示例：在 Dart 中维护一个 `currentPage`，同时 JS 又维护路由；在 Flutter 中为每个 JS 卡片创建业务 Widget；把网络重试策略写进插件。

正确示例：JS 决定页面与重试，Dart 插件只完成一次有界请求并返回结构化结果。

## 5. UI 控件与组合

公共入口：

```ts
import {
  MobileThemeProvider,
  MOBILE_THEME_LIGHT,
  MobileScaffold,
  MobileAppBar,
  MobileCard,
  MobileButton,
  MobileListTile,
  MobileSwitch,
  MobileDialog,
  ScrollablePage,
  InputField,
} from "@pocket/ui";
```

典型页面：

```tsx
import { createSignal } from "solid-js";
import {
  MobileThemeProvider,
  MOBILE_THEME_LIGHT,
  MobileScaffold,
  MobileAppBar,
  MobileCard,
  MobileButton,
  MobileParagraph,
  ScrollablePage,
  InputField,
} from "@pocket/ui";

export function NotesPage() {
  const [title, setTitle] = createSignal("");
  const [saved, setSaved] = createSignal(false);

  return (
    <MobileThemeProvider theme={MOBILE_THEME_LIGHT}>
      <MobileScaffold appBar={<MobileAppBar title="Notes" />}>
        <ScrollablePage class="px-4 py-4 gap-3">
          <MobileCard>
            <InputField
              value={title}
              placeholder="Title"
              onInput={setTitle}
            />
            <MobileParagraph text={saved() ? "Saved" : "Not saved"} />
            <MobileButton
              label="Save"
              disabled={!title().trim()}
              onPress={() => setSaved(true)}
            />
          </MobileCard>
        </ScrollablePage>
      </MobileScaffold>
    </MobileThemeProvider>
  );
}
```

控件选择建议：

| 场景 | 优先使用 |
| --- | --- |
| 页面骨架、安全区 | `MobileScaffold`、`SafeAreaScaffold` |
| 长内容和键盘避让 | `ScrollablePage` |
| 系统输入 | `InputField`，业务值仍由 JS 持有 |
| 主操作 | `MobileButton` / Filled、Tonal、Outlined、Text aliases |
| 设置项 | `MobileListTile`、`MobileSwitch`、`MobileSegmentedControl` |
| 选择 | `MobileCheckbox`、`MobileRadioGroup`、`ShadcnSelect` |
| 反馈 | `MobileAlert`、`MobileToast`、`MobileDialog`、`MobilePopup` |
| 导航 | `NavigationBar`、`Tabs`；路由状态由 JS 持有 |
| Apple glass | `AppleGlassButton`、`AppleGlassToolbar`、`AppleGlassNavigationBar` |
| 相机/视频等原生画面 | 已授权的 `PlatformTextureSurface` |

不要假设 DOM/CSS 浏览器库可以直接使用。Pocket UI 是 TSX + PocketJS 原生节点，不是 WebView。完整导出以 `sdk/packages/pocket_ui/src/index.ts` 为准。

### 自定义游戏/App 界面时保留控件行为

自定义视觉不等于重新实现控件。新游戏或 App 默认应继承现有控件的行为，只替换与产品
匹配的皮肤、颜色、形状、字体、动效和布局。优先顺序是：

1. 使用现有组件和 theme/appearance/class/style 参数换肤。
2. 用现有基础组件组合新的视觉组件，同时保留其 Focusable、按压、禁用和语义行为。
3. 只有产品确实需要不同交互模型时才覆盖行为，并记录为什么现有行为不适用。

必须保留的默认体验包括：按下/取消/抬起事务、focus/键盘与手柄导航、disabled 状态、
滚动竞争和惯性、IME 与键盘避让、safe area、触控热区、无障碍语义、路由失活、生命周期
取消以及 reduced-motion 等既有约束。不要只复制外观后用裸 pointer handler 重写按钮、输入、
列表或弹窗；这通常会失去取消手势、焦点、语义和设备一致性，造成明显的体验下降。

如果必须新增行为，至少验证点击与拖出取消、连续快速操作、键盘/手柄、滚动嵌套、页面离开、
横竖屏/尺寸变化、无障碍和真机触控。AI 应明确说明“复用了哪个现有行为、只改了哪层皮肤”；
不能把静态截图相似当作交互验收。

### 游戏视口与安全区

游戏场景的视觉层与交互层使用不同边界：背景、视频、氛围层、转场和遮罩绘制到完整 viewport，不能继承控件的 safe-area clip；按钮、对白、菜单及场景命中目标使用 `pageInsets` 形成的一份安全框。自定义游戏复用已有 `display.viewport` / `pageInsets` 几何原语，不另加 Dart `SafeArea`、逐控件重复 inset 或第二份布局/相机状态。如有分层和 camera，应复用同一 pose，并明确视觉与命中坐标的映射；具体相机原点由游戏设计决定。

直接使用 `NovelView` 时由其内置视口布局保证场景视觉全屏、交互内容安全；自定义游戏必须自己遵守上述边界。详细证据与当前实现记录见 [`VISUAL_NOVEL_MOBILE_SAFE_AREA.md`](VISUAL_NOVEL_MOBILE_SAFE_AREA.md)。

分层后，位于可点击场景上方的纯布局容器应使用现有 `hitPass: 1` 让自身空白区域透传命中，子控件仍正常响应。视觉透明不等于命中透明；菜单遮罩等有意阻断输入的区域须保留阻断行为。

## 6. HostBridge 与能力声明

JS 通过同一个 `HostBridge` 请求原生能力：

```ts
const result = await host.request<{ model: string }>("plugins.packageInfo", {});
```

`manifest.json` 只声明应用需要的能力：

```json
{
  "protocolVersion": 1,
  "capabilities": {
    "requires": [],
    "optional": ["plugins.packageInfo"]
  },
  "permissions": {
    "optional": []
  }
}
```

准入顺序是：宿主已编译和注册 provider → 宿主允许该 policy → Guest manifest 声明 → 操作系统授权。任一层缺失都必须返回明确错误，不能伪造结果。

## 7. 硬件必须按需开启

默认不要使用 `--hardware`，它会带入全量兼容聚合包。新应用只选实际需要的模块：

```sh
# 只使用相机和蓝牙
bun sdk/pocket.ts init /path/to/app --camera --bluetooth

# 只使用运动传感器；需要 iOS motion 权限时再加 permissions
bun sdk/pocket.ts init /path/to/motion \
  --sensors --permissions=hardware.sensors

# 定位与天气是两个独立模块
bun sdk/pocket.ts init /path/to/weather --location --weather

# 网络、系统触觉/系统栏、Deep Link 也都是显式 opt-in
bun sdk/pocket.ts init /path/to/app \
  --dio --platform-experience --deep-link-scheme=myapp
```

可选模块包括 `pocket_permissions`、`pocket_camera`、`pocket_bluetooth`、`pocket_sensors`、`pocket_location`、`pocket_biometrics`、`pocket_weather`、`pocket_platform` 和 `pocket_dio`。

Dio 插件的 `dio.request` 自动使用独立 Dart IO Worker isolate 执行请求、读流和解码，保留 `createPocketDioClient(host)` 接口；纯 Dio 接入不需要另建 `domains.worker`，继续使用 `network` 权限与插件 `allowedOrigins`。官方 JS `net.http` 则使用 `domains.worker` 和 `workerHttpOrigins`，两套授权不可混用。游戏重计算按需走官方业务 Worker；Web `renderWorker` 是独立渲染开关，默认关闭。

权限请求必须由用户操作触发，JS 决定说明、拒绝后的 UI 和是否打开设置。插件只返回系统真实状态。

### 接入自己的原生能力

现有模块不能满足需求时：

1. 在独立 Flutter package 中实现 `PocketPlugin`。
2. 每个 guest generation 创建独立 provider；实现关闭和取消。
3. capability 使用稳定命名，例如 `vendor.maps.route`。
4. 为参数、响应、大小、超时、origin 和并发建立有界校验。
5. 在 `PocketAppConfig.pluginFactories` 中显式注册。
6. 在 Guest manifest 声明 capability，并在 JS 封装小型 typed client。
7. Swift/Kotlin 只处理系统 API；业务策略、状态机和 UI 留在 JS。

```dart
final config = PocketAppConfig(
  appId: 'com.example.notes',
  pluginFactories: [
    (controller) => VendorMapsPlugin(controller: controller),
  ],
  additionalCapabilities: {'vendor.maps.route'},
);
```

更新包不能安装新的 Dart/Swift/Kotlin。新增原生能力必须先随宿主版本发布，再由 JS 包声明使用。

## 8. Editor / Pocket Studio

Showcase：

```sh
cd demo/js
bun run editor
# http://127.0.0.1:8791
```

外部项目：

```sh
cd sdk
bun pocket.ts editor /absolute/path/to/js-project \
  --flutter-root=/absolute/path/to/flutter-project \
  --port=8791
```

局域网热更新测试可启用 Editor 内置只读版本后台：

```sh
bun pocket.ts editor /absolute/path/to/js-project \
  --flutter-root=/absolute/path/to/flutter-project \
  --port=8791 \
  --update-host=192.168.1.20 \
  --update-port=8792 \
  --update-host-version=3.2.0
```

Publish test package 会产生
`http://192.168.1.20:8792/pocket/3.2.0/<packageId>/test/latest.json`，
并在页面显示可用的 `host.json`。LAN listener 只提供签名包、bundle、blob 和公开
bootstrap，Editor API、源码及签名私钥仍只在 loopback。

点击 Editor 顶部 **Versions** 打开 **Version management**，可同时查看 `test` 和
`stable` 槽、各根包/mini-app 的实际 version/build，以及局域网 manifest/host 配置。
该视图从已签名发布目录读取，不是另一份版本真相来源。

AI 使用 Editor 的标准步骤：

1. 修改并保存 JS/TS/TSX。
2. 点击 Build，确认使用真实 `buildGuest` 生成 QJBC/PAK。
3. 在 Canvas 预览中执行点击、滚动、输入和尺寸切换。
4. 使用 **Copy preview link** 将预览链接交给可控制浏览器的 AI。
5. 原生硬件、IME、Texture、权限和性能必须继续部署到模拟器/真机验证。
6. 源码修改后重新 Build；Editor 不声称把未构建 TSX 自动热替换进运行中的字节码。
7. Publish/Test package 复用正式签名、内容寻址和更新协调器，不建立第二套热更协议。

浏览器预览是真实 QuickJS/PocketJS 帧，但 Canvas 字体/解码与 Flutter 设备可能不同。网页预览通过不等于 iOS/Android 已通过。

## 9. 资源打包选项

构建产物：

| 文件 | 用途 |
| --- | --- |
| `app.qjbc` | QuickJS 可执行字节码 |
| `app.pak` | 字体、图片等完整规范资源包 |
| `app.bytecode.json` | ABI、哈希、大小、版本/build |
| `guest-manifest.json` | capability/permission 声明 |
| `app.js` | 诊断复现，不是生产 fallback |

Editor 的 `pocket.resources.json` 决定资源进入基础归档还是网络下载：

```json
{
  "version": 1,
  "packages": {
    "com.example.notes": {
      "network": [
        "pak:ui:img.assets/large-cover.png",
        "asset:assets/intro.mp4"
      ]
    }
  }
}
```

- 默认资源进入首次 bundle。
- `networkPakKeys` 仅允许可安全拆分的 `ui:img.*` PAK 项。
- `networkAssets` 适用于普通 loose assets。
- 字体、metadata、entry、Worker 和其他必需记录不能被错误移出基础包。
- 即使资源按网络放置，最终仍组装并验证完整规范 PAK，不增加第二套资源读取器。
- 相同 SHA-256 内容只保存一次。

CLI 对应参数：

```sh
--network-pak-key ui:img.assets/large-cover.png
--network-asset assets/intro.mp4
--bundle-format 7z   # 默认；也支持 zip
--no-bundle          # 只适用于明确不需要首次整包的高级场景
```

## 10. 统一热更新地址

生产部署约定：

```text
https://<domain>/<optional-prefix>/pocket/<hostVersion>/<packageId>/<packageVersion>/
├── latest.json
├── signed-manifest.json
├── payload.json
├── bundles/bundle-<sha256>.7z
└── blobs/<sha256>
```

`<root>` 不要求是域名根目录。`baseUrl` 可以包含任意固定路径前缀，例如
`https://xxx.com/some-other-path`，对应地址就是
`https://xxx.com/some-other-path/pocket/<hostVersion>/<packageId>/<packageVersion>/latest.json`。
发布端同样可以把 `--deploy-root` 指向 `./public/some-other-path`。

例如：

```text
https://xxx.com/pocket/3.2.0/com.example.notes/stable/latest.json
```

这里 URL 中的 `packageVersion` 是发布槽位：

- 用 `stable`、`beta` 等稳定槽位，客户端会持续读取同一 `latest.json` 并自动发现签名 payload 内的新版本。
- 用 `1.4.7` 等不可变槽位，客户端固定在该发布线；切换版本需要修改宿主配置。
- 真正的包版本和防重放 build 位于签名 payload 中。每次发布必须提高 build。
- `latest.json` 可以替换；`bundles/bundle-<sha256>.*` 和 `blobs/<sha256>` 必须不可变并长期保留，避免并发客户端读取到不一致内容。

宿主配置：

```dart
updates: const PocketUpdateConfig(
  baseUrl: 'https://xxx.com/some-other-path',
  hostVersion: '3.2.0',
  packageVersion: 'stable',
  keyId: 'release-2026',
  publicKey: '<base64-ed25519-public-key>',
  namespace: 'notes-stable',
),
```

等价环境变量：

```text
POCKET_UPDATE_BASE_URL=https://xxx.com/some-other-path
POCKET_HOST_VERSION=3.2.0
POCKET_PACKAGE_VERSION=stable
POCKET_UPDATE_KEY_ID=release-2026
POCKET_UPDATE_PUBLIC_KEY=<base64-public-key>
POCKET_STORE_NAMESPACE=notes-stable
```

`POCKET_UPDATE_URL` 仍供 Editor、本地 loopback 和已有消费者直接指定完整 manifest URL；不能与结构化地址字段混用。生产使用 HTTPS，私钥只存在于发布端。

宿主地址和应用根部的 `createPocketUpdateClient(..., { autoRefresh: true })` 首次随 App
发布后，后续发布只需把新产物原子部署到同一槽位：JS 更新客户端会读取该地址、下载并验证
候选版本。是否立即应用、提示用户或延后重启仍由 JS 策略决定；Dart 不新增第二套自动更新状态机。

## 11. 首次整包与后续单资源更新

运行时已经使用同一套签名协议支持两种模式：

1. **首次下载**：没有健康 baseline 时，`auto` 下载 manifest 中的一个 7z/ZIP bundle，验证 archive SHA-256、大小和每个 blob，再组装完整 PAK。
2. **后续更新**：已有 baseline 后，`auto` 转为 granular，复用本地内容寻址 blob，只下载哈希变化的代码或资源。
3. **单资源更新**：发布端基于上一版使用 `patchPackageArtifacts` 替换一个 PAK key 或 loose asset；客户端可用 `checkResource(resource)` 限定目标并验证其他组件没有变化。
4. **代码更新**：使用 `checkCodeOnly()`，若资源或 policy 同时变化则拒绝该 scope。

JS 自动检查与应用：

```ts
import { createPocketUpdateClient } from "@pocket/ui";

const updates = createPocketUpdateClient(host, {
  autoRefresh: true,
  onError: (error) => console.warn("update failed", error),
});

// 手动整套刷新
await updates.refresh();

// 只允许代码变化
await updates.refresh({ mode: "granular", scope: "code" });

// 只允许指定 PAK/loose asset 变化
await updates.refresh({
  mode: "granular",
  scope: "resource",
  resource: "ui:img.assets/large-cover.png",
});
```

更新候选只有在首帧和健康窗口通过后才晋升；失败会回到已验证的 lastGood/previous 或不可变内置包。

## 12. 发布命令

首次发布到统一目录：

```sh
bun sdk/scripts/package_update.ts package \
  --app-id com.example.notes \
  --version 1.0.0 \
  --build 100 \
  --entry-format quickjs-bytecode \
  --bytecode app.qjbc \
  --runtime-abi "$(jq -r .runtimeAbi app.bytecode.json)" \
  --pak app.pak \
  --guest-manifest guest-manifest.json \
  --deploy-root ./public/some-other-path \
  --host-version 3.2.0 \
  --route-version stable \
  --key-file ./release-key.json
```

输出目录是：

```text
public/some-other-path/pocket/3.2.0/com.example.notes/stable/
```

只更新一个 PAK 图片资源：

```sh
bun sdk/scripts/package_update.ts patch \
  --base-dir ./public/some-other-path/pocket/3.2.0/com.example.notes/stable \
  --app-id com.example.notes \
  --version 1.0.1 \
  --build 101 \
  --pak-entry ui:img.assets/large-cover.png=./new-cover.png \
  --deploy-root ./public/some-other-path \
  --host-version 3.2.0 \
  --route-version stable \
  --key-file ./release-key.json
```

只更新 loose asset：

```sh
--asset assets/intro.mp4=./intro-v2.mp4
```

只更新代码：

```sh
--bytecode ./app-v2.qjbc --runtime-abi '<same-compatible-abi>'
```

将 `public/` 原样同步到对象存储/CDN 即可。服务器只需支持静态 GET；不要在 CDN 层改写签名 JSON 或压缩 blob 内容。

## 13. 自己接入热更新服务

不要求使用 Pocket 自带服务器。自建服务只需：

1. 按统一目录提供 `latest.json`。
2. 保持 manifest 内相对 URL 与同源策略。
3. 提供签名声明的 bundle 和 `blobs/<sha256>`。
4. 对 hashed bundle/blob 使用 immutable cache；对 `latest.json` 使用短缓存或 no-cache。
5. 原子发布：先上传全部 hashed 文件，最后替换 `latest.json`。
6. 保留旧 hashed 文件，至少覆盖客户端更新与回退窗口。
7. 不将 Ed25519 私钥放进 App、Editor 公开目录或 CI artifact。

宿主只信任配置中的公钥或 root trust policy。HTTP 只允许 debug loopback/显式 debug host；生产必须 HTTPS。

## 14. 验收清单

AI 在交付前至少确认：

- [ ] 没有把可在 JS 完成的业务逻辑新增到 Dart。
- [ ] 只启用了实际需要的硬件/平台包。
- [ ] manifest、宿主 allowlist 和系统权限三层一致。
- [ ] UI 使用已有控件并处理 loading/error/empty/disabled。
- [ ] Editor 中真实构建并通过点击/输入后的画面变化验证。
- [ ] 游戏使用真实 QJBC/DrawOps 检查背景绘制（图片、视频或图形）与所有生效 clip 的交集覆盖完整 viewport，且顶部状态栏区、底部 home-indicator 区有可见像素；控件与命中目标留在单次 safe frame，并验证 Start、菜单/等价游戏入口的真实输入。
- [ ] 游戏安全区验收覆盖 iPhone、Android、竖屏、横屏与旋转往返；报告分别标明 Core、Editor、物理设备证据，不能用其中一类替代另一类。
- [ ] 模拟器/真机验证了 IME、权限、Texture 或硬件边界。
- [ ] QJBC/PAK/metadata/manifest 来自同一次固定流水线。
- [ ] 发布地址符合 `/pocket/<hostVersion>/<packageId>/<packageVersion>/`。
- [ ] 首次无 baseline 时只需 manifest + bundle 即可完成安装。
- [ ] 后续代码更新只请求变化代码 blob。
- [ ] 后续单资源更新只请求该资源 blob，并复用其他内容。
- [ ] 错误签名、错误哈希、降级 build、ABI 不匹配和启动失败均 fail closed。
- [ ] 未把私钥、缓存、`.dart_tool`、`.swiftpm` 或 native binary 当源码提交。

## 15. 相关深入文档

- `SDK_INTEGRATION.md`：Flutter 消费工程接入。
- `COMPONENTS.md`：组件和宿主节点契约。
- `HARDWARE_MODULES.md`：按需硬件与权限。
- `OPTIONAL_PLUGINS.md`：Dio、平台能力和可选插件。
- `EDITOR_STUDIO.md`：Editor、预览与设备部署。
- `VISUAL_NOVEL_MOBILE_SAFE_AREA.md`：游戏/VN 全视口场景视觉、安全控件边界及分层验收证据。
- `EDITOR_RESOURCE_DELIVERY.md`：资源基础包/网络放置。
- `PACKAGE_UPDATE_MODES.md`：首次 bundle 与 granular 更新实现。
- `SYSTEM_UI_SELF_REFRESH.md`：JS 自动刷新和状态交接。
- `ON_DEMAND_MINI_APPS.md`：首次下载型 mini-app。

## 16. 来源、必要适配与验证

实现前核对了保留父工程（排除 `pocket_host/`）：

- `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_ota.js`：保留宿主版本门、包版本、完整性检查与失败回退的职责划分；其 `.pjc` 示例和短字符串 SHA 检查不作为当前实现。
- `pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart`：保留完整 bundle 解包、资源路径解析和最终完整资源准入的行为；不迁回 Dart 业务渲染器。
- `pocketjs_flutter_demo/tools/compile_pocket_syslib_aot.py`：只作为历史构建/版本元数据来源；当前继续使用固定 `buildGuest` + QuickJS QJBC，不建立第二条编译链。

当前仓库已有 `PocketUpdateCoordinator`、`PocketPackageStore`、
`packageArtifacts` / `patchPackageArtifacts`、Editor 发布和 JS update client，已经覆盖
首次 bundle、内容寻址 blob、单代码/单资源更新、健康晋升与回退。本轮有证据的缺口是
“生产 URL/目录没有统一生成入口”和“缺少一份 AI 可直接执行的总指南”，因此只新增：

- `PocketUpdateConfig` 的结构化 base/host/package slot 解析；
- 发布 CLI 的 `--deploy-root`、`--host-version`、`--route-version`；
- 本文和现有接入文档的统一说明。

没有新增下载器、缓存、更新状态机、Dart 业务 UI 或资源 loader。验证包括 Dart 3.9 /
Flutter 3.35 配置测试与全 SDK analyze、发布工具 21 项测试、JS 更新规划/刷新 14 项测试、
真实协调器首次 bundle → 代码 blob → 单 PAK 资源 → loose asset 测试，以及 CLI 统一目录
首次发布和同槽位增量 patch 探针。
