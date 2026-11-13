import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import { Button as PaperButton } from "@pocket/looseleaf";
import { Button as ArcButton } from "@pocket/arc";

function App() {
  const [count, setCount] = createSignal(0);
  return <View class="w-full h-full flex-col gap-4 p-4">
    <Text class="text-base">{`Count ${count()}`}</Text>
    <PaperButton label="Paper increment" onPress={() => setCount(count() + 1)} />
    <ArcButton label="Arc increment" onPress={() => setCount(count() + 10)} />
  </View>;
}
mount(App);
