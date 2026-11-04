import { createSignal, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { after } from "@pocketjs/framework/clock";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { ActionButton } from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";

function App() {
  const host = createHostBridge(undefined, {
    timeoutFrames: 1800,
    scheduleTimeout: (frames, callback) => after(frames / 60, callback),
  });
  onCleanup(() => host.dispose());
  const [status, setStatus] = createSignal("Bluetooth ready");
  const [rssi, setRssi] = createSignal("");
  let deviceId = "";
  const selector = () => ({ deviceId, serviceUuid: "0000180f-0000-1000-8000-00805f9b34fb", characteristicUuid: "00002a19-0000-1000-8000-00805f9b34fb" });
  const failed = (error: any) => setStatus(`error=${error.code || error.message}`);
  async function scan() {
    setStatus("Selecting device");
    try {
      const result: any = await host.request("hardware.bluetooth.scan", { services: ["battery_service"], optionalServices: ["battery_service"] });
      deviceId = result.devices[0]?.id || result.devices[0]?.deviceId || "";
      setStatus(`selected=${result.source}:${result.devices.length}`);
      setRssi(typeof result.devices[0]?.rssi === "number" ? `RSSI ${result.devices[0].rssi}` : "");
    } catch (error) { failed(error); }
  }
  async function permission() {
    try {
      const result: any = await host.request("hardware.permissions.request", { permission: "hardware.bluetooth", optionalServices: ["battery_service"] });
      setStatus(`permission=${result.status}`);
    } catch (error) { failed(error); }
  }
  async function read() {
    try {
      await host.request("hardware.bluetooth.connect", { deviceId });
      const result: any = await host.request("hardware.bluetooth.read", selector());
      setStatus(`battery=${result.value[0]}`);
    } catch (error) { failed(error); }
  }
  async function write() {
    try {
      const result: any = await host.request("hardware.bluetooth.write", { ...selector(), value: [43], withResponse: true });
      setStatus(`written=${result.bytesWritten}`);
    } catch (error) { failed(error); }
  }
  return <Screen><View class="flex-col w-full gap-4 p-4 bg-slate-100">
    <Text class="text-slate-900">{status()}</Text>
    <Text class="text-slate-900">{rssi()}</Text>
    <ActionButton label="Scan BLE" onPress={() => { void scan(); }} />
    <ActionButton label="Read battery" onPress={() => { void read(); }} />
    <ActionButton label="Write battery" onPress={() => { void write(); }} />
    <ActionButton label="Request BLE" onPress={() => { void permission(); }} />
  </View></Screen>;
}
mount(() => <App />);
