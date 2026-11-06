# TFTC 蓝牙传输契约

`@pocket/tftc` 只实现 JS 协议。Preview 和 Web SDK 的蓝牙都只走 Noble；后续 Flutter 的 `flutter_blue_plus` 仍可共用 `TftcClient`，但不在浏览器再实现另一套蓝牙产品逻辑。

## 传输分工

| 场景 | 实际 BLE 后端 | JS 入口 |
| --- | --- | --- |
| macOS / Windows 编辑器 Preview | `@abandonware/noble@1.9.2-26`，与 dokidoki 锁定版本一致 | `createPocketBluetooth(host)` |
| Web SDK / Editor Canvas 网页 | 页面不直接访问蓝牙；由编辑器进程的 `@abandonware/noble` 通过 Preview SSE 提供 | 同一 Pocket 适配器 |
| Flutter | `flutter_blue_plus`，由薄宿主映射下列 IO 事实 | 同一 Pocket 适配器 |

Noble 负责系统蓝牙，编辑器只映射 scan/GATT/stream。后续 Flutter 宿主负责调用插件、权限、生命周期与真实断链，TFTC 帧、PID/FMSK、安全流程、产品控制、心跳和属性变更解析仍归 JS。当前 SDK 原生传输尚未替换成 `flutter_blue_plus`；下述契约测试验证数据兼容，不代表已完成 Flutter 插件实机迁移。

Noble 没有显式的权限申请 API。Noble Bluetooth 对
`hardware.permissions.request` / `requestBlePermission` 返回结构化的
`hardware_unsupported`，由操作系统在实际扫描或 GATT 操作时处理蓝牙授权；
宿主不能伪造 `granted`。浏览器 Canvas 只是渲染和输入投影，不持有蓝牙对象；
Flutter 宿主仍遵循自己的平台权限流程。

## HostBridge 请求

沿用 `hardware.bluetooth.*`，不新增 `tftc.*` 原生业务 capability。

| 请求 | params | 成功 result 的必要字段 |
| --- | --- | --- |
| `hardware.bluetooth.scan` | `timeoutMs`、可选 `services` | `devices: [{id,name,rssi,manufacturerData}]` |
| `hardware.bluetooth.connect` | `deviceId` | `services: [{uuid,characteristics:[{uuid,canRead,canWrite,canWriteWithoutResponse,canNotify,canIndicate}]}]` |
| `hardware.bluetooth.read` | `deviceId,serviceUuid,characteristicUuid` | `value: number[]` |
| `hardware.bluetooth.write` | 同上，加 `value: number[], withResponse: boolean` | `bytesWritten`，仅原生操作完成后回复 |

每个响应保留原请求 `requestId` / `capability`。失败返回结构化 `ok:false,error:{code,message}`；不能把写入回调、空列表或收到普通状态当作 TFTC 认证完成。设备 ID 是后端给出的不透明字符串，不当成 MAC 解析；UUID 接受短形式和完整形式。

`services` 是 Noble 报告的可访问服务列表，不要求广播同时携带全部服务。产品筛选和选择在 JS 页面中完成。

## manufacturer data

Noble/CoreBluetooth 的数组包含两字节 little-endian company ID：

```js
manufacturerData: [0xc5, 0x5f, /* 原始厂商 payload */]
```

`flutter_blue_plus` 返回的 `AdvertisementData.manufacturerData` 是 `Map<int,List<int>>`，company ID 位于 key，value 不再包含它。宿主可以直接传 JSON 字典，不必在 Dart 解析 TFTC：

```js
manufacturerData: { '24517': [/* 插件原始 payload */] }
```

Pocket JS 适配器补回 company ID，再交给同一个协议解析器。不得重复添加 CID、倒转 PID/MAC、按设备名猜 FMSK 或丢弃安全标记。空 Map 表示没有广播信息；多个记录原样保留，TFTC 解析器拒绝无法确认或相互冲突的内容。浏览器页面不提供第二条扫描路径；需要真实广播/厂商数据时，必须让编辑器宿主加载 Noble。

## notify 与断连

Flutter 宿主对对应特征启用通知，监听 `onValueReceived`，把每次真实字节更新发送到已有 `hardware.bluetooth.notifications` stream：

```js
{ type:'event', name:'stream.data', payload:{
  streamId,
  data:{deviceId,serviceUuid,characteristicUuid,value:[/* 本次原始字节 */]}
} }
```

宿主不合并不同通知、不解析属性、不依据已发送的命令补状态。Noble 的 `data` 同时用于读取和 notify，适配器只将 `isNotification === true` 转成通知，避免重复反馈。JS 会完成校验、解密与协议分片组装，再触发 `message`、`state` 和 `change`。

单个流取消要移除自己的 listener；仍有其他订阅时不能关闭它们的 CCCD。实际连接断开要发送 `stream.error`（例如 `hardware_bluetooth_disconnected`），使 JS 结束旧会话。scope 释放须取消进行中的扫描、释放该 scope 的连接和流；迟到结果不能重新建立已销毁的会话。

目前 Pocket 没有单设备物理 disconnect capability，`client.disconnect()` 结束 JS 会话并取消订阅，宿主 scope 释放负责物理断开。这一点接回 `flutter_blue_plus` 时也必须保持真实，不能把本地标志当成已调用插件 disconnect。

`withResponse:true` 对应 `characteristic.write(value, withoutResponse:false)`；反之使用 `withoutResponse:true`，仅在特征支持时执行。MTU 和写入大小限制属于真实传输事实：不得把一帧随意切成多次 GATT 写入。当前普通控制使用小帧；OTA 编排和任意大帧发送未声明支持。

## 验证边界

- `packages/pocket_tftc/test/pocket-bluetooth.test.ts`：真实执行 `TftcClient → HostBridge`，输入明确为测试 IO 的 Flutter manufacturer Map、GATT 库存和 notify 字节，检查状态、字段变更、写入模式与无乐观状态。
- `editor/test/noble_bluetooth.test.ts`：显式测试 Noble IO，执行生产适配器，检查广告、GATT、首次通知、读取/通知区分、所有权、取消和断连。
- macOS DK-META2 已在最终 `@abandonware/noble@1.9.2-26` Preview 链路上完成三路脉冲和字段上报验收，完整记录见 [迁移与验收记录](tftc-migration.md)。Windows 以及 Flutter Blue Plus 真机验收仍需相应设备环境，不能由上述测试替代。
