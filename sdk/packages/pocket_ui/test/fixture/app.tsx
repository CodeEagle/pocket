import { mount } from "@pocketjs/framework/solid";
import { createSignal, onCleanup, onMount } from "solid-js";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import {
  Chip,
  Divider,
  FloatingActionButton,
  InputField,
  IconButton,
  LinearProgressIndicator,
  NavigationDestination,
  ScrollablePage,
  deliverTextInputEvent,
} from "@pocket/ui";

const bridge = globalThis as typeof globalThis & {
  __pocketEvent?: (line: string) => void;
};

function App() {
  const [progress, setProgress] = createSignal(0.5);
  const [selected, setSelected] = createSignal("home");
  const [fabDisabled, setFabDisabled] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  onMount(() => {
    const previous = bridge.__pocketEvent;
    const receive = (line: string): void => {
      try {
        const message = JSON.parse(line) as {
          method?: unknown;
          name?: unknown;
          params?: unknown;
          payload?: unknown;
        };
        const method = typeof message.method === "string"
          ? message.method
          : typeof message.name === "string" ? message.name : "";
        const params = message.params ?? message.payload;
        if (params && typeof params === "object") {
          deliverTextInputEvent(method, params as any);
        }
      } catch {
        // Keep unrelated host messages on the original bridge path.
      }
      previous?.(line);
    };
    bridge.__pocketEvent = receive;
    onCleanup(() => {
      if (bridge.__pocketEvent === receive) bridge.__pocketEvent = previous;
    });
  });
  return (
    <Screen>
      <ScrollablePage>
        <View class="flex-col gap-2 p-4">
          <Text class="text-sm text-slate-950 font-bold">SDK Flutter vocabulary fixture</Text>
          <Text class="text-xs text-slate-600">Progress {Math.round(progress() * 100)}%</Text>
          <Text class="text-xs text-slate-600">FAB {fabDisabled() ? "disabled" : "enabled"}</Text>
          <Chip label="Toggle Chip" selected={selected() === "chip"} onPress={() => setSelected(selected() === "chip" ? "home" : "chip")} />
          <Divider />
          <LinearProgressIndicator value={progress()} />
          <View class="flex-row gap-2">
            <IconButton icon="!" tooltip="Toggle disabled" onPress={() => setFabDisabled(!fabDisabled())} />
            <FloatingActionButton icon="+" label="Advance" tooltip="Advance progress" disabled={fabDisabled()} onPress={() => setProgress(Math.min(1, progress() + 0.1))} />
            <NavigationDestination icon="⌂" label="Home" selected={selected() === "home"} onPress={() => setSelected("home")} />
            <NavigationDestination icon="◉" label="Library" selected={selected() === "library"} onPress={() => setSelected("library")} />
          </View>
          <InputField value={draft} onInput={setDraft} placeholder="Tap to type" />
          <View style={{ height: 320 }} />
        </View>
      </ScrollablePage>
    </Screen>
  );
}

mount(() => <App />);
