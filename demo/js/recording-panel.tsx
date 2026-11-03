import { createSignal, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import { ActionButton, Card } from "@pocket/ui";
import { captureUpstreamTape } from "@pocket/ui/recording";
import { hostError, type HostBridge, type JsonValue } from "@pocket/ui/host";

/** Debug controls use the same SDK capability bridge as every other page. */
export function RecordingPanel(props: { host: HostBridge }): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("Capture input, IME and external results; replay in a fresh guest.");
  const run = async (action: "status" | "replay" | "export"): Promise<void> => {
    if (busy()) return;
    setBusy(true);
    try {
      // Freeze before exporting so the tape never records its own payload.
      if (action !== "status") await props.host.request("diagnostics.recording.stop");
      const params = action === "export"
        ? { inputTape: captureUpstreamTape() as unknown as JsonValue }
        : {};
      const result = await props.host.request(`diagnostics.recording.${action}`, params);
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid recording response");
      if (action === "export") {
        setMessage(`Exported: ${String(result.path)}`);
      } else if (action === "replay") {
        const runtimes = result.runtimes && typeof result.runtimes === "object" ? Object.values(result.runtimes) : [];
        const failed = runtimes.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && entry.matched !== true);
        setMessage(result.ok === true
          ? `Replay matched · ${runtimes.length} native guests`
          : `Replay mismatch: ${JSON.stringify(failed ?? result).slice(0, 420)}`);
      } else {
        const runtimes = Array.isArray(result.runtimes) ? result.runtimes : [];
        const entries = runtimes.reduce((sum, runtime) => sum + (runtime && typeof runtime === "object" && !Array.isArray(runtime) && typeof runtime.entries === "number" ? runtime.entries : 0), 0);
        setMessage(`${result.stopped ? "Stopped" : "Recording"} · ${runtimes.length} guests · ${entries} transactions${result.incomplete ? " · incomplete" : ""}`);
      }
    } catch (error) {
      const failure = hostError(error);
      setMessage(failure.code === "unconfigured" || failure.code === "unsupported_capability"
        ? "Recording is off. Launch with --dart-define=POCKET_RECORD=true, then repeat the journey."
        : `${failure.code}: ${failure.message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <View class="flex-col gap-3">
        <Text class="text-base text-slate-950 font-bold">Deterministic replay</Text>
        <Text class="text-xs text-slate-600">{busy() ? "Working…" : message()}</Text>
        <ActionButton label="Recording status" kind="quiet" onPress={() => { void run("status"); }} />
        <ActionButton label="Stop & verify replay" kind="secondary" onPress={() => { void run("replay"); }} />
        <ActionButton label="Export recording" kind="quiet" onPress={() => { void run("export"); }} />
      </View>
    </Card>
  );
}
