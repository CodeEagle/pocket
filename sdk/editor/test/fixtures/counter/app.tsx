import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { ActionButton } from "@pocket/ui";

function App() {
  const [count, setCount] = createSignal(0);

  return (
    <Screen>
      <View class="flex-col w-full gap-4 p-4 bg-slate-100">
        <Text class="text-slate-900">Independent counter fixture</Text>
        <Text class="text-slate-900">{`count=${count()}`}</Text>
        <ActionButton label="Increment counter" onPress={() => setCount((value) => value + 1)} />
      </View>
    </Screen>
  );
}

mount(() => <App />);
