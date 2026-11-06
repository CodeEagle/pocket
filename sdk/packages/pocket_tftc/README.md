# @pocket/tftc

独立的 TFTC JavaScript 包：设备识别、帧编解码、安全握手、控制、心跳、notify 属性解析均在 JS 中运行。默认入口不依赖 Flutter、Electron 或 Pocket UI；原生端只负责蓝牙 IO。

## 安装

当前仓库内由 SDK workspace 管理。独立消费者可在项目目录执行 `bun add file:/path/to/pocket/sdk/packages/pocket_tftc`；直接网页入口不需要 Flutter。使用 `/pocket` 适配器时，消费者还需已有的 `@pocket/ui` 公开 host/streams 包。

## 在 Preview 中开发和检查产品

在 SDK 根目录启动现有编辑器：`bun run editor`，打开产品项目的 Preview，启用 Bluetooth。

- macOS 与 Windows 的 **Local Bluetooth** 使用编辑器所在电脑的蓝牙扫描，选择设备后即可连接。两端复用 dokidoki 使用的 `@abandonware/noble@1.9.2-26`，Windows 由库自带 WinRT 后端处理；需要 Node.js、可用的 BLE 适配器和开启的系统蓝牙，不再维护 PowerShell/WinRT 实现。
- Noble 没有显式的 `requestBlePermission` API；Local Bluetooth 的权限请求会明确返回 `hardware_unsupported`，真实扫描或 GATT 操作由操作系统处理授权。不要把这个结果改成伪造的 `granted`。
- Web SDK/Editor 不提供浏览器蓝牙；网页只作为 Canvas 渲染和输入投影，所有 `hardware.bluetooth.*` 请求由编辑器进程的 `@abandonware/noble` 处理。需要蓝牙时由使用者自行安装 `npm install @abandonware/noble@1.9.2-26`。
- 开发 DK-META2 时使用 **Noble Bluetooth**：实际设备的广播 manufacturer data 会保留在扫描结果中，不能用收到明文状态来代替识别或跳过安全校验。
- 连接后保持 notify 订阅即可实时检查变化，不需要轮询电量或工作状态。离开页面时释放连接和订阅。编辑器服务必须运行在拥有蓝牙设备的电脑上；远程打开另一个电脑的 Local Bluetooth Preview，连接的是服务端电脑的蓝牙。

Windows 编辑器还需要当前 pinned runtime 对应的本机 `pocket_probe.exe`；Preview 已支持查找 Cargo 的 Windows 输出路径，也可以用 `POCKET_NATIVE_PROBE` 指定既有构建。本包不附带生成的 Windows 二进制。 Windows 构建环境需有 Bun、Rust/MSVC 工具链、可执行的 `python3` 与 GNU `patch`。准备 pinned 上游后，在 SDK 根目录用 `cargo build --locked --manifest-path native/Cargo.toml --bin pocket_probe` 构建本机探针，再用 `bun run editor` 启动；现有 `build_native.sh` 和 launchctl service wrapper 不支持 Windows。这些 Windows 构建步骤尚未在本机执行验证。

通过 `bun install` 安装可选 Noble 依赖；源码编译时需要其平台工具链，SDK 提供 `node-gyp` 构建工具。可用 `POCKET_EDITOR_BLUETOOTH_NODE` 指定 Node 可执行文件。原生模块保持 external，不打包进浏览器或 guest。

Windows Local Bluetooth 已有 npm 传输适配和协议回归，**尚未在 Windows 电脑上做实机验收**。此次真实设备验收在 macOS 上完成；浏览器自动化测试使用显式测试 IO，不能代替 Windows 实机结论。

## 接入产品页面

```ts
import { TftcClient } from '@pocket/tftc';
import { createPocketBluetooth } from '@pocket/tftc/pocket';

// 复用当前页面已有的 HostBridge。selectDevice 由产品 UI 实现。
const bluetooth = createPocketBluetooth(host, {
  selectDevice: devices => devices.find(d => d.name === 'DK-META2'),
});
const client = new TftcClient({ bluetooth, security });
const unsubscribe = client.on('change', ({ detail }) => {
  for (const change of detail.changes) {
    console.log(change.field, change.previous, '->', change.current);
  }
  // detail.state 是这次设备上报后的完整已观察状态。
});
await client.connect();
await client.setVibration(10);
// 页面退出：先停止，结束 client，然后释放自己拥有的流。
await client.stop();
await client.disconnect();
unsubscribe();
bluetooth.dispose();
```

宿主注册现有的 `hardware.bluetooth.scan/connect/read/write` 和 `hardware.bluetooth.notifications` 即可。`/pocket` 入口只依赖 `@pocket/ui/host`、`@pocket/ui/streams` 的公开接口；不增加 `tftc.*` 原生业务接口。

没有系统计时器的 Pocket guest 需注入 `timers: {setTimeout, clearTimeout, setInterval, clearInterval}`（毫秒）和 `now`。原生 guest 的安全服务也可注入，不要求把生产密钥放进页面。完整的 pinned buildGuest 示例见 `demo/js/acceptance/tftc.tsx`。

Web SDK 不使用浏览器蓝牙 API。Editor/本地服务只通过 Node 加载 `@abandonware/noble`，再把 Noble 的真实扫描、连接、GATT 和通知结果映射到 `createPocketBluetooth(host)` 所消费的宿主能力。Noble 不随 SDK 打包；需要蓝牙时由使用者在应用或 Editor 工作目录自行安装：`npm install @abandonware/noble@1.9.2-26`。安全 provider 可使用 `createBleSecurityProvider({ productSecretsByProductId })`；内置 provider 使用 Web Crypto，包内不含生产密钥。

## Flutter Blue Plus 兼容

同一个 `/pocket` 适配器支持 `flutter_blue_plus` 的 manufacturer data Map（company ID 为 key，payload 为 value），由 JS 补回 CID；读取、响应模式、notify 和断连沿用同一 HostBridge 契约。Flutter 只映射插件 IO，不迁移 JS 业务状态机回 Dart。当前已做数据契约回归，尚未实际替换 Flutter 插件并做手机验收。完整映射、字节语义与限制见 [传输契约](../../docs/TFTC_TRANSPORT_CONTRACT.md)。

## 实时反馈契约

所有状态来自设备，发送控制命令不会乐观更新设备状态。

| 事件 | 内容 |
| --- | --- |
| `change` | 校验、解密、分片组装和属性解码成功后，实际发生变化的字段；重复值不再产生此事件 |
| `message` | 每条有效业务通知；包含 `command`、`msgId`、`payload`、`changes`、`state`；重复上报时 `changes` 可为空 |
| `state` | 属性上报后的完整已观察快照，与 `status()` 一致 |
| `notify` | 兼容保留的有效业务通知原始帧 |
| `connection-state` / `disconnected` | 连接生命周期 |
| `command` | 已发送命令记录，不能作为设备执行成功的证明 |
| `diagnostic` | 帧校验、连接、安全或传输诊断 |

`client.on(name, callback)` 返回取消订阅函数。`change.detail` 含 `source: 'notify'`、`command`、`msgId`、`timestampMs`、`raw`、`state` 和 `changes`。每个 change 含：

```js
{ key: 8, dataKey: 'VIBRATION_LEVEL', field: 'vibrationLevel',
  kind: 'raw', previous: 0, current: 10 }
```

compact 字节还会拆出 `kind: 'derived'` 的语义变更，例如 `battery`、`batteryStatus`、`isWorking`、`workModeState`、`commandFlag`、`linerStatus`、`linerId`。渲染列表时可隐藏 compact 原始项（key 32/33/34），避免同一变化显示两遍。首次观察的旧值为 `null`，不是已知的零。电量保留 App 的 **0–50 原值**，不能直接标成百分比。

## 控制与范围

- 生命周期：`connect`、`disconnect`、`pause`、`resume`、`stop`。
- 控制：`setLinear`、`setRotary`、`setVibration`、`setSuction`、`setHeat`，按设备 profile 验证能力。
- YXL ONE 的直接伸缩/旋转使用 0–9 档；标准 TFTC 使用 0–100 强度，旋转支持负方向。
- 原始标准属性：`writeSingle` 支持 App channel 别名；`writePairs` 显式批量写入。`queryKeys` 是低层匹配应答接口，不作为 Preview 的状态刷新流程；本次 DK-META2 实机上其电量/工作状态请求超时，未声明该固件支持。已删去多余的 `queryBattery`、`queryWorkState` 专用方法和按钮。
- `status()` 返回已观察属性，未上报值为 `null`。未知产品、未迁移业务或产品不支持的通道明确报错。

内置连接型号见 `DEVICE_PROFILES`（TF 别名归一到 DK）。PT3MAX/NAV 的 App 产品规则由 `resolveProductCommands` / `resolveProductOperation` 复用，`executeCommands` 只支持明确迁移的产品。源代码没有可核对的广播名/PID，因此未猜测注册；接入时用 `profileForDevice` 注入已验证配置及 `productKey: PRODUCT_IDS.DKPT3MAX` 或 `PRODUCT_IDS.DKASTP`。

Pocket 当前没有单设备物理 disconnect capability：适配器取消自己的通知流并结束本地会话，物理 GATT 由宿主 scope 生命周期释放。直接浏览器传输会调用实际 GATT disconnect。

App 产品选择、账号/游戏授权、内胆激活、OTA 编排、Buttplug、手机模拟设备不包含在本包中。纯协议入口为 `@pocket/tftc/protocol`。来源、消融和验收记录见 [迁移记录](../../docs/tftc-migration.md)。

## 真机验收与回归

此次 DK-META2 已通过真实 pinned guest → Preview → FFB8 验收。原有 CoreBluetooth 路径和切换后的 npm Noble 路径都实际捕获：

- 振动、伸缩、旋转分别从 `0 → 10 → 0`；脉冲后自动发送停止。
- `isWorking: false → true → false`，以及电量 `33 → 32`（旧路径）和 `32 → 31`（Noble 路径）的主动上报。
- 页面实时显示字段名、旧值、新值；没有依赖电量/工作状态轮询。

切换到 Noble 后，macOS 上的 `@abandonware/noble@1.9.2-26` 已重新发现 DK-META2，并完成三路控制和 notify 验收。Noble 实机截图保存在 `/tmp/tftc-noble-notify-acceptance.png`（临时验收产物，不提交到 SDK）。Windows 仍未做实机验收。

这台设备广播为明文模式；安全握手经过协议/Web Crypto 回归，没有在安全模式真机上验收。

在 `sdk/` 运行：

```sh
bun test packages/pocket_tftc/test editor/test/local_bluetooth.test.ts editor/test/noble_bluetooth.test.ts scripts/tests/native_probe_path.test.ts scripts/tests/export_web_sdk.test.ts
python3 scripts/check_architecture.py
bun scripts/build_guest.ts --project-root=../demo/js --entry=acceptance/tftc.tsx --outdir=/tmp/pocket-tftc-live-build
bun scripts/tftc_preview.ts
```

最后一条启动开发用实机验收页 `http://127.0.0.1:8797/`，普通产品开发仍使用现有 editor Preview。安全设备可在服务端配置 `TFTC_SECRETS_FILE`（不提交生产密钥）；验收脚本的安全桥仅用于开发页。
