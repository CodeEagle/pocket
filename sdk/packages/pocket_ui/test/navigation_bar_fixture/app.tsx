import { mount } from "@pocketjs/framework/solid";
import { createDisplayGeometry } from "@pocket/ui";
import { createSignal } from "solid-js";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { NavigationBar } from "@pocket/ui";

function App() {
  const [route, setRoute] = createSignal("home");
  const geometry = createDisplayGeometry({
    fallback: {
      width: 390,
      height: 844,
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      keyboardInset: 0,
      reservedRegions: [],
    },
  });

  return (
    <Screen class="w-full h-full flex-col bg-white">
      <View class="flex-1 items-center justify-center">
        <Text class="text-base text-[#17233B]">Navigation fixture</Text>
      </View>
      <NavigationBar
        route={route()}
        onNavigate={setRoute}
        geometry={geometry}
      />
    </Screen>
  );
}

mount(() => <App />);
