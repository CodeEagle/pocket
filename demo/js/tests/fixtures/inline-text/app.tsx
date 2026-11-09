import { For, batch, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { InlineText, inlineFontSlot, type InlineTextLayout, type InlineTextRef, type InlineTextRun } from "@pocket/ui";

const SOURCE = "Read this long linked phrase that wraps across several lines, then stop.";
const RUNS: readonly InlineTextRun[] = [
  { start: 0, end: 4, ruby: { text: "reed", fontSlot: inlineFontSlot("ruby") } },
  { start: 5, end: 59, fontSlot: inlineFontSlot("bodyBold"), color: 0xffa3e1ff, linkId: "long-note" },
];
const REPLACEMENT_SOURCE = "Read a new note after switching sources.";
const REPLACEMENT_RUNS: readonly InlineTextRun[] = [
  { start: 0, end: 3, fontSlot: inlineFontSlot("bodyBold"), color: 0xffa3e1ff, linkId: "replacement-note" },
];

function App() {
  const [reveal, setReveal] = createSignal(0);
  const [sourceVersion, setSourceVersion] = createSignal("original");
  const [source, setSource] = createSignal(SOURCE);
  const [runs, setRuns] = createSignal<readonly InlineTextRun[]>(RUNS);
  const [clicks, setClicks] = createSignal(0);
  const [backgroundClicks, setBackgroundClicks] = createSignal(0);
  const [width, setWidth] = createSignal(180);
  const [immediateWidth, setImmediateWidth] = createSignal(0);
  const ref: InlineTextRef = { current: null };
  const [layout, setLayout] = createSignal<InlineTextLayout>({ width: 0, height: 0, lineCount: 0, links: [] });
  return <View class="w-full h-full bg-[#101820]">
    <View class="absolute flex-col gap-2" style={{ insetL: 16, insetT: 12, width: 340 }}>
      <Focusable onPress={() => setReveal(3)}><Text class="text-sm">Reveal three</Text></Focusable>
      <Focusable onPress={() => setReveal(4)}><Text class="text-sm">Reveal four</Text></Focusable>
      <Focusable onPress={() => setReveal(source().length)}><Text class="text-sm">Reveal all</Text></Focusable>
      <Focusable onPress={() => batch(() => {
        setSourceVersion("replacement");
        setSource(REPLACEMENT_SOURCE);
        setRuns(REPLACEMENT_RUNS);
      })}><Text class="text-sm">Switch source at same reveal</Text></Focusable>
      <Text class="text-xs">{`Source ${sourceVersion()} · reveal ${reveal()}`}</Text>
      <Text class="text-xs">{`Layout ${layout().width} ${layout().height} ${layout().lineCount}`}</Text>
      <Text class="text-xs">{`Link ids ${layout().links.map(link => link.id).join(",") || "none"}`}</Text>
      <Text class="text-xs">{`Link clicks ${clicks()}`}</Text>
      <Text class="text-xs">{`Background clicks ${backgroundClicks()}`}</Text>
    </View>
    <Focusable class="absolute" style={{ insetL: 16, insetT: 180, width: 340 }} onPress={() => setBackgroundClicks(count => count + 1)}>
      <InlineText ref={ref} source={source()} runs={runs()} revealCodepoints={reveal()} style={{ width: width(), fontSlot: inlineFontSlot("body"), textColor: 0xffd9ecf5 }} onLayout={setLayout} />
      <For each={layout().links}>{link => <For each={link.rects}>{rect =>
        <Focusable class="absolute" style={{ insetL: rect.x, insetT: rect.y, width: rect.width, height: rect.height }} onPress={() => setClicks(count => count + 1)} />
      }</For>}</For>
    </Focusable>
    <View class="absolute flex-col" style={{ insetL: 16, insetT: 420, width: 340 }}>
      <Text class="text-xs">{`Link rectangles ${layout().links.flatMap(link => link.rects).length}`}</Text>
      <For each={layout().links.flatMap(link => link.rects)}>{(rect, index) =>
        <Text class="text-xs">{`Rect ${index()} ${rect.x} ${rect.y} ${rect.width} ${rect.height}`}</Text>
      }</For>
    </View>
    <Focusable class="absolute" style={{ insetL: 16, insetT: 550, width: 150, height: 24 }} onPress={() => batch(() => {
      setWidth(240);
      setImmediateWidth(ref.current!.getLayout().width);
    })}><Text class="text-sm">Batch width</Text></Focusable>
    <View class="absolute" style={{ insetL: 180, insetT: 550, width: 190 }}><Text class="text-xs">{`Immediate width ${immediateWidth()}`}</Text></View>
  </View>;
}

mount(() => <App />);
