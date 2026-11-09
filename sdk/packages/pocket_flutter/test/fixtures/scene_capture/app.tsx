import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, View } from "@pocketjs/framework/solid/components";

function App() {
  const [changed, setChanged] = createSignal(false);
  return <View class="w-full h-full">
    <Focusable
      class={changed()
        ? "absolute left-4 top-3 w-12 h-9 bg-[#25bd62]"
        : "absolute left-4 top-3 w-12 h-9 bg-[#ed2839]"}
      onPress={() => setChanged(!changed())}
    />
  </View>;
}

mount(App);
