import { createSignal } from "solid-js";
import {
  MOBILE_THEME_DARK,
  MOBILE_THEME_LIGHT,
  MobileAppBar,
  MobileButton,
  MobileScaffold,
  MobileThemeProvider,
  availableDisplayPanes,
  createDisplayGeometry,
} from "@pocket/ui";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";

function App() {
  const [dark, setDark] = createSignal(false);
  const displayGeometry = createDisplayGeometry();
  // The public helper already applies safe-area insets and splits around an
  // active vertical division. The scaffold paints only the first available
  // pane, so a new project is usable on phones and Duo-style displays without
  // inventing another layout engine.
  const contentStyle = () => {
    const pane = availableDisplayPanes(displayGeometry())[0];
    return {
      marginL: pane?.left ?? 0,
      marginT: pane?.top ?? 0,
      width: pane?.width ?? displayGeometry().width,
      height: pane?.height ?? displayGeometry().height,
      grow: 0,
    };
  };
  return (
    <MobileThemeProvider theme={() => dark() ? MOBILE_THEME_DARK : MOBILE_THEME_LIGHT}>
      <MobileScaffold appBar={
        <MobileAppBar title="Pocket 应用" subtitle="应用模板" trailing={
          <MobileButton label={dark() ? "浅色" : "深色"} kind="text" onPress={() => setDark(!dark())} />
        } />
      }>
        <View style={contentStyle()} class={dark() ? "flex-col gap-2 p-4 bg-[#0d1726]" : "flex-col gap-2 p-4 bg-slate-50"}>
          <Text class={dark() ? "text-xl text-white font-bold" : "text-xl text-slate-950 font-bold"}>你好，PocketJS</Text>
          <Text class={dark() ? "text-sm text-slate-300" : "text-sm text-slate-600"}>编辑 app.tsx，然后运行 pocket build。</Text>
        </View>
      </MobileScaffold>
    </MobileThemeProvider>
  );
}

mount(() => <App />);
