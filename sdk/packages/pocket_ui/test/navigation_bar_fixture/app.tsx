import { mount } from "@pocketjs/framework/solid";
import { createDisplayGeometry } from "@pocket/ui";
import { createSignal } from "solid-js";
import { Focusable, Screen, Text, View } from "@pocketjs/framework/solid/components";
import { NavigationBar, type NavigationItem } from "@pocket/ui";

const settingsItems: readonly NavigationItem[] = [
  { id: "home", label: "Home", kind: "home" },
  { id: "gallery", label: "Gallery", kind: "gallery" },
  { id: "about", label: "Host", kind: "host" },
  { id: "settings", label: "Settings", kind: "settings" },
];

function App() {
  const [route, setRoute] = createSignal("home");
  const [visible, setVisible] = createSignal(true);
  const [settings, setSettings] = createSignal(false);
  const [dark, setDark] = createSignal(false);
  const geometry = createDisplayGeometry({
    fallback: {
      width: 390,
      height: 844,
      safeArea: { top: 0, right: 0, bottom: 34, left: 0 },
      keyboardInset: 0,
      reservedRegions: [],
    },
  });

  return (
    <Screen class="w-full h-full flex-col bg-white">
      <View class="flex-1 items-center justify-center">
        <Text class="text-base text-[#17233B]">Navigation fixture</Text>
        <Focusable onPress={() => setVisible(!visible())}>
          <Text class="text-sm text-[#315DEB]">Toggle navigation</Text>
        </Focusable>
        <Focusable onPress={() => setSettings(!settings())}>
          <Text class="text-sm text-[#315DEB]">Toggle settings</Text>
        </Focusable>
        <Focusable onPress={() => setDark(!dark())}>
          <Text class="text-sm text-[#315DEB]">Toggle dark</Text>
        </Focusable>
      </View>
      <NavigationBar
        route={route()}
        onNavigate={setRoute}
        geometry={geometry}
        visible={visible()}
        items={settings() ? settingsItems : undefined}
        dark={dark()}
        accentColor={0xff7c5cff}
      />
    </Screen>
  );
}

mount(() => <App />);
