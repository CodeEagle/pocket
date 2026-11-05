import { Show, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Grid, Text, View, type NodeMirror } from "@pocketjs/framework/solid/components";
import { Card, MobileAppBar, MobileBadge, Row, SafeAreaScaffold, ScrollContourItem, ScrollablePage, StatusBar, createDisplayGeometry, useScrollContourReserve } from "@pocket/ui";

function FixtureGridTile(props: { index: number; label: string; viewportWidth: () => number }) {
  const { leftReserve, nodeRef, reserve } = useScrollContourReserve({
    itemLeft: 16,
    itemRight: () => Math.max(0, props.viewportWidth() - 16),
  });
  let appliedLeftNonZero = false;
  const tileStyle = () => {
    const l = leftReserve();
    const r = reserve();
    const isLeftColumn = props.index % 2 === 0;
    if (isLeftColumn && l > 0) appliedLeftNonZero = true;
    return {
      width: Math.max(0, (props.viewportWidth() - l - r - 32 - 12) / 2),
      ...(isLeftColumn && (l > 0 || appliedLeftNonZero) ? { marginL: l } : {}),
    };
  };
  return (
    <Focusable
      nodeRef={nodeRef}
      class="flex-row items-center justify-between h-[26] px-3 rounded-lg bg-white overflow-hidden"
      style={tileStyle()}
    >
      <Text class="text-xs text-[#17233B] font-bold">{props.label}</Text>
      <Text class="text-xs text-[#315DEB] font-bold">{`${props.label}R`}</Text>
    </Focusable>
  );
}

function App() {
  const geometry = createDisplayGeometry();
  const viewportWidth = () => geometry().width || 390;
  const objectRef: { current: NodeMirror | null } = { current: null };
  let callbackRef: NodeMirror | undefined;
  const [pressedCount, setPressedCount] = createSignal(0);
  return (
    <SafeAreaScaffold
      reservedActions="mini-app"
      appBar={() => (
        <MobileAppBar
          title="Safe Header"
          subtitle="profile guest · shared identity"
          trailing={<MobileBadge label="Guest A" tone="accent" />}
        />
      )}
      bottomBar={
        <View class="h-[52] px-4 bg-white">
          <Text class="text-sm text-[#17233B]">Safe Bottom</Text>
        </View>
      }
    >
      <ScrollablePage>
        <View class="flex-col gap-3 p-4 bg-[#F5F6FA]">
          <Show when={pressedCount() === 0}>
            <Grid columns={2} gap={12} class="flex-row flex-wrap">
              <FixtureGridTile index={0} label="Tile1" viewportWidth={viewportWidth} />
              <FixtureGridTile index={1} label="Tile2" viewportWidth={viewportWidth} />
            </Grid>
            <StatusBar label="Identity namespace" detail="Choose Alex or Lin." />
          </Show>
          <Text class="text-sm text-[#17233B]">Safe Body</Text>
          <Show when={pressedCount() === 0}>
            <Card class="flex-col gap-2 w-full p-4 h-[100] rounded-xl bg-white border-[#E5E9F2]">
              <Row class="flex-row items-center justify-between">
                <Text class="text-sm text-[#17233B] font-bold">Contour Card 1</Text>
                <Text class="text-xs text-[#315DEB] font-bold">Edge 1</Text>
              </Row>
            </Card>
          </Show>
          <ScrollContourItem
            ref={(node) => {
              callbackRef = node;
            }}
            nodeRef={objectRef}
            focusable
            onPress={() => {
              if (callbackRef && objectRef.current === callbackRef) {
                setPressedCount((value) => value + 1);
              }
            }}
            class="flex-col gap-2 w-full p-4 h-[120] rounded-xl bg-white border-[#E5E9F2] overflow-hidden"
          >
            <Row class="flex-row items-center justify-between">
              <Text class="text-sm text-[#17233B] font-bold">Contour Card 2</Text>
              <Text class="text-xs text-[#315DEB] font-bold">Edge 2</Text>
            </Row>
            <Text class="text-xs text-[#7C8799]">{pressedCount() > 0 ? "RefPressed" : "RefIdle"}</Text>
          </ScrollContourItem>
          <Card class="flex-col gap-2 p-4 h-[360] rounded-xl bg-white border-[#E5E9F2]">
            <Text class="text-sm text-[#17233B] font-bold">Contour Card 3</Text>
          </Card>
        </View>
      </ScrollablePage>
    </SafeAreaScaffold>
  );
}

mount(() => <App />);
