import { createSignal, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { after, virtualNow } from "@pocketjs/framework/clock";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { ActionButton } from "@pocket/ui";
import { createHostBridge } from "@pocket/ui/host";
import { TftcClient } from "../../../sdk/packages/pocket_tftc/src/index.js";
import { createPocketBluetooth } from "../../../sdk/packages/pocket_tftc/src/pocket-bluetooth.ts";

function App() {
  const [status, setStatus] = createSignal("DK-META2 physical acceptance");
  const [detail, setDetail] = createSignal("Ready to scan real Bluetooth");
  const [changes, setChanges] = createSignal<string[]>([]);
  const [lastCommand, setLastCommand] = createSignal("No control sent");
  const host = createHostBridge(undefined, { timeoutFrames: 3600, scheduleTimeout: (frames, cb) => after(frames / 60, cb) });
  const bluetooth = createPocketBluetooth(host, { timeoutMs: 4000, selectDevice(devices) {
    const found = devices.find(device => device.name.toUpperCase() === "DK-META2");
    if (!found) throw new Error("DK-META2 not found: " + devices.map(device => device.name).join(", "));
    return found;
  } });
  const security = {
    beginBleSecurity: params => host.request("hardware.bluetooth.tftcSecurityBegin", params),
    completeBleSecurity: params => host.request("hardware.bluetooth.tftcSecurityComplete", params),
    clearBleSecurity: sessionId => host.request("hardware.bluetooth.tftcSecurityClear", { sessionId }),
  };
  const client = new TftcClient({ bluetooth, security, now: () => virtualNow() * 1000, timers: {
    setTimeout: (callback, milliseconds) => after(milliseconds / 1000, callback),
    clearTimeout: cancel => cancel?.(),
    setInterval(callback, milliseconds) {
      let active = true;
      let cancel = () => {};
      const step = () => { if (!active) return; callback(); if (active) cancel = after(milliseconds / 1000, step); };
      cancel = after(milliseconds / 1000, step);
      return () => { active = false; cancel(); };
    },
    clearInterval: cancel => cancel?.(),
  } });
  client.on("connection-state", ({ detail }) => setStatus("Connection: " + detail.state));
  client.on("state", () => {
    const s = client.status();
    setDetail("Battery " + s.battery + "/50 | working " + s.isWorking + " | V/L/R " + s.vibrationLevel + "/" + s.telescopicLevel + "/" + s.rotationLevel);
  });
  client.on("change", ({ detail }) => {
    const rows = detail.changes.filter(change => change.kind === "derived" || ![32, 33, 34].includes(change.key)).map(change => change.field + ": " + change.previous + " -> " + change.current);
    if (rows.length) setChanges(previous => [...rows, ...previous].slice(0, 8));
  });
  client.on("command", ({ detail }) => setLastCommand("Command: " + JSON.stringify({ action: detail.action, value: detail.value, pairs: detail.pairs })));
  client.on("diagnostic", ({ detail }) => { console.log("TFTC", JSON.stringify(detail)); });
  onCleanup(() => { void client.disconnect().finally(() => { bluetooth.dispose(); host.dispose(); }); });
  async function run(name, action) {
    setStatus(name + "...");
    try { const value = await action(); setStatus(name + " OK");  }
    catch (error) { setStatus(name + " FAILED"); setDetail(String(error?.message ?? error)); }
  }
  async function pulse(action) {
    try { await action(); await new Promise(resolve => after(1, resolve)); }
    finally { await client.stop(); }
  }
  return <Screen><View class="flex-col w-full gap-2 p-4 bg-slate-100">
    <Text class="text-slate-900">{status()}</Text>
    <Text class="text-slate-900">{detail()}</Text>
    <Text class="text-slate-900">{lastCommand()}</Text>
    <Text class="text-slate-900">{"Live notify changes\n" + changes().join("\n")}</Text>
    <ActionButton label="Connect DK-META2" onPress={() => { void run("Connect", () => client.connect()); }} />
    <ActionButton label="Vibrate 10 for 1s" onPress={() => { void run("Vibration pulse", () => pulse(() => client.setVibration(10))); }} />
    <ActionButton label="Linear 10 for 1s" onPress={() => { void run("Linear pulse", () => pulse(() => client.setLinear(10))); }} />
    <ActionButton label="Rotate 10 for 1s" onPress={() => { void run("Rotation pulse", () => pulse(() => client.setRotary(10))); }} />
    <ActionButton label="Stop all" onPress={() => { void run("Stop", () => client.stop()); }} />
    <ActionButton label="Disconnect" onPress={() => { void run("Disconnect", () => client.disconnect()); }} />
  </View></Screen>;
}
mount(() => <App />);
