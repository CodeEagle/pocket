import { mount } from "@pocketjs/framework/solid";
import { createSignal } from "solid-js";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import {
  Chip,
  Divider,
  FloatingActionButton,
  IconButton,
  LinearProgressIndicator,
  NavigationDestination,
} from "@pocket/ui";

function App() {
  const [progress, setProgress] = createSignal(0.5);
  const [selected, setSelected] = createSignal("home");
  const [fabDisabled, setFabDisabled] = createSignal(false);
  return (
    <Screen>
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
      </View>
    </Screen>
  );
}

mount(() => <App />);
