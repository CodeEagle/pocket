import { createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import {
  MOBILE_THEME_LIGHT,
  MobileAppBar,
  MobileBadge,
  MobileButton,
  MobileCard,
  MobileScaffold,
  MobileThemeProvider,
  ScrollablePage,
  StatusBar,
} from "@pocket/ui";
import { createPocketPlatformClient } from "@pocket/ui/platform";

const SHOWCASE_APP_ID = "pocket.host.demo";
const SHARED_NAMESPACE = "identity";

type Profile = {
  name: string;
  role: string;
  uid: string;
  vipLevel?: number;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function profileFromValue(value: unknown): Profile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<Profile>;
  if (typeof candidate.name !== "string" || typeof candidate.role !== "string" || typeof candidate.uid !== "string") return undefined;
  return {
    name: candidate.name,
    role: candidate.role,
    uid: candidate.uid,
    vipLevel: typeof candidate.vipLevel === "number" ? candidate.vipLevel : undefined,
  };
}

function LobbyApp(): JSX.Element {
  const platform = createPocketPlatformClient();
  const [identity, setIdentity] = createSignal<Profile | undefined>(undefined);
  const [count, setCount] = createSignal(0);
  const [visits, setVisits] = createSignal(0);
  const [lastMessage, setLastMessage] = createSignal("No message sent yet.");
  const [status, setStatus] = createSignal("Loading shared identity...");
  const [statusOk, setStatusOk] = createSignal(true);
  let removeMessageListener: (() => void) | undefined;

  onMount(async () => {
    removeMessageListener = platform.onMessage((message) => {
      setLastMessage(`Inbound ${message.topic} from ${message.sourceAppId}`);
    });
    try {
      const value = await platform.storage.get("userInfo", SHARED_NAMESPACE);
      const profile = profileFromValue(value);
      setIdentity(profile);
      setStatus(profile ? `Shared identity loaded for ${profile.name}.` : "No shared identity yet.");
    } catch (error) {
      setStatus(`Shared identity unavailable: ${errorText(error)}`);
      setStatusOk(false);
    }
  });

  onCleanup(() => {
    removeMessageListener?.();
    platform.dispose();
  });

  const sendLobbyUpdate = async (): Promise<void> => {
    const nextCount = count() + 1;
    const nextVisits = visits() + 1;
    setCount(nextCount);
    setVisits(nextVisits);
    setStatusOk(true);
    try {
      await platform.sendMessage(
        SHOWCASE_APP_ID,
        {
          type: "lobby.update",
          userInfo: identity() ?? null,
          visits: nextVisits,
          count: nextCount,
        },
        "lobby.update",
      );
      setLastMessage(`Sent lobby.update · visits=${nextVisits} · count=${nextCount}`);
      setStatus("Message queued for Showcase.");
    } catch (error) {
      setStatus(`Message failed: ${errorText(error)}`);
      setStatusOk(false);
    }
  };

  const returnResult = async (): Promise<void> => {
    try {
      await platform.returnResult({
        visits: visits(),
        count: count(),
      });
    } catch (error) {
      setStatus(`Return failed: ${errorText(error)}`);
      setStatusOk(false);
    }
  };

  return (
    <MobileThemeProvider theme={MOBILE_THEME_LIGHT}>
      <MobileScaffold
        appBar={
          <MobileAppBar
            title="Pocket Lobby"
            subtitle="pocket.demo.lobby · independent state"
            trailing={<MobileBadge label="Guest B" tone="success" />}
          />
        }
      >
        <ScrollablePage>
          <View class="flex-col gap-3 p-4">
            <StatusBar label="Lobby platform state" detail={status()} ok={statusOk()} />
            <MobileCard
              title="Shared identity"
              detail={identity() ? `${identity()!.role} · UID ${identity()!.uid}` : "Waiting for profile guest data"}
            >
              <Text class="text-xl text-slate-950 font-bold">{identity()?.name ?? "Guest"}</Text>
              <Text class="text-xs text-slate-600">Namespace: identity · storage.get()</Text>
            </MobileCard>
            <MobileCard title="Independent lobby counter" detail="This state belongs to Guest B and is not the profile state.">
              <View class="flex-row items-center justify-between">
                <View class="flex-col gap-1">
                  <Text class="text-xs text-slate-600">visits</Text>
                  <Text class="text-xl text-slate-950 font-bold">{visits()}</Text>
                </View>
                <View class="flex-col gap-1">
                  <Text class="text-xs text-slate-600">count</Text>
                  <Text class="text-xl text-slate-950 font-bold">{count()}</Text>
                </View>
              </View>
              <MobileButton label="Increment lobby counter" onPress={() => { void sendLobbyUpdate(); }} />
              <Text class="text-xs text-slate-600">{lastMessage()}</Text>
            </MobileCard>
            <MobileCard title="Cross-app handoff" detail="The host receives both the message and the awaited return value.">
              <View class="flex-col gap-2">
                <MobileButton label="Send lobby update to Showcase" kind="outlined" onPress={() => { void sendLobbyUpdate(); }} />
                <MobileButton label="Return visits to Showcase" onPress={() => { void returnResult(); }} />
              </View>
            </MobileCard>
          </View>
        </ScrollablePage>
      </MobileScaffold>
    </MobileThemeProvider>
  );
}

mount(() => <LobbyApp />);
