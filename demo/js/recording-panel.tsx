import { createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import { MobileButton, MobileCard, useMobileTheme, wrapTextLines } from "@pocket/ui";
import { captureUpstreamTape } from "@pocket/ui/recording";
import { hostError, type HostBridge, type JsonValue } from "@pocket/ui/host";
import { formatRecordingStatus } from "./state.ts";

/** Debug controls use the same SDK capability bridge as every other page. */
export function RecordingPanel(props: {
  host: HostBridge;
  status?: () => Record<string, unknown> | undefined;
}): JSX.Element {
  const theme = useMobileTheme();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("Capture input, IME and external results; replay in a fresh guest.");
  createEffect(() => {
    const current = props.status?.();
    if (current) {
      setBusy(false);
      setMessage(formatRecordingStatus(current));
    }
  });
  const removeEvent = typeof props.host.onEvent === "function"
    ? props.host.onEvent((event) => {
        if (event.method === "diagnostics.recording.started") {
          setBusy(false);
          setMessage(formatRecordingStatus(event.params));
        }
      })
    : undefined;
  onCleanup(() => removeEvent?.());

  const run = async (action: "start" | "stop" | "status" | "replay" | "export"): Promise<void> => {
    if (busy()) return;
    setBusy(true);
    try {
      // Freeze before exporting or replaying so the tape never records its own payload.
      if (action === "replay" || action === "export") {
        await props.host.request("diagnostics.recording.stop");
      }
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
      } else if (action === "start") {
        const runtimes = Array.isArray(result.runtimes) ? result.runtimes : [];
        setMessage(runtimes.length > 0 ? formatRecordingStatus(result) : "Starting recording…");
      } else {
        setMessage(formatRecordingStatus(result));
      }
    } catch (error) {
      const failure = hostError(error);
      setMessage(failure.code === "unconfigured" || failure.code === "unsupported_capability"
        ? "Recording capability is unavailable in this host."
        : `${failure.code}: ${failure.message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <MobileCard title="Deterministic replay">
      <View class="flex-col gap-3">
        <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-slate-600"}>{wrapTextLines(busy() ? "Working…" : message(), 46, 300)}</Text>
        <View class="flex-row flex-wrap gap-2">
          <MobileButton label="Start recording" onPress={() => { void run("start"); }} />
          <MobileButton label="Stop recording" kind="outlined" onPress={() => { void run("stop"); }} />
          <MobileButton label="Recording status" kind="text" onPress={() => { void run("status"); }} />
        </View>
        <View class="flex-row flex-wrap gap-2">
          <MobileButton label="Stop & verify replay" kind="tonal" onPress={() => { void run("replay"); }} />
          <MobileButton label="Export recording" kind="text" onPress={() => { void run("export"); }} />
        </View>
      </View>
    </MobileCard>
  );
}
