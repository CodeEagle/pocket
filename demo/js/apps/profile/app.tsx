import { For, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import {
  MOBILE_THEME_LIGHT,
  MobileAppBar,
  MobileBadge,
  MobileButton,
  MobileCard,
  MobileThemeProvider,
  SafeAreaScaffold,
  ScrollablePage,
  StatusBar,
} from "@pocket/ui";
import type { JsonValue } from "@pocket/ui/host";
import { createPocketPlatformClient } from "@pocket/ui/platform";

const LOBBY_APP_ID = "pocket.demo.lobby";
const SHARED_NAMESPACE = "identity";

type ProfileKey = "alex" | "lin";
type Profile = {
  name: string;
  role: string;
  uid: string;
  vipLevel: number;
};

const PROFILES: Record<ProfileKey, Profile> = {
  alex: {
    name: "Alex Chen",
    role: "Chief Sandbox Architect",
    uid: "USR-ALEX-1001",
    vipLevel: 9,
  },
  lin: {
    name: "Lin Mei",
    role: "Lead 3D Flutter Scene Engineer",
    uid: "USR-LIN-1007",
    vipLevel: 7,
  },
};

type StoredProfile = Partial<Profile> & { name?: unknown; role?: unknown; uid?: unknown };

function profileFromValue(value: unknown): Profile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as StoredProfile;
  if (typeof candidate.name !== "string" || typeof candidate.role !== "string" || typeof candidate.uid !== "string") {
    return undefined;
  }
  return {
    name: candidate.name,
    role: candidate.role,
    uid: candidate.uid,
    vipLevel: typeof candidate.vipLevel === "number" ? candidate.vipLevel : 0,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ProfileApp(): JSX.Element {
  const platform = createPocketPlatformClient();
  const [selected, setSelected] = createSignal<ProfileKey>("alex");
  const [stored, setStored] = createSignal<Profile | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal("Choose Alex or Lin, then open the lobby.");
  const [statusOk, setStatusOk] = createSignal(true);

  onMount(async () => {
    try {
      const value = await platform.storage.get("userInfo", SHARED_NAMESPACE);
      const profile = profileFromValue(value);
      if (profile) {
        const match = (Object.keys(PROFILES) as ProfileKey[]).find((key) => PROFILES[key].uid === profile.uid);
        if (match) setSelected(match);
        setStored(match ? PROFILES[match] : profile);
        setStatus(`Shared identity restored for ${profile.name}.`);
      }
    } catch (error) {
      setStatus(`Shared identity unavailable: ${errorText(error)}`);
      setStatusOk(false);
    }
  });

  onCleanup(() => platform.dispose());

  const selectedProfile = (): Profile => PROFILES[selected()];

  const chooseProfile = (key: ProfileKey): void => {
    setSelected(key);
    setStatus(`Selected ${PROFILES[key].name}. Save it to the identity namespace.`);
    setStatusOk(true);
  };

  const returnToShowcase = async (value: JsonValue): Promise<void> => {
    try {
      await platform.returnResult(value);
    } catch (error) {
      setStatus(`Return failed: ${errorText(error)}`);
      setStatusOk(false);
    }
  };

  const saveAndOpenLobby = async (): Promise<void> => {
    setBusy(true);
    setStatusOk(true);
    const profile = selectedProfile();
    const userInfo = {
      name: profile.name,
      role: profile.role,
      uid: profile.uid,
    };
    try {
      await platform.storage.set("userInfo", userInfo, SHARED_NAMESPACE);
      setStored(profile);
      setStatus(`Saved ${profile.name}; opening the independent lobby guest...`);
      const result = await platform.openApp(LOBBY_APP_ID, {
        from: "profile",
        userInfo,
      });
      const returned = result.value && typeof result.value === "object"
        ? JSON.stringify(result.value)
        : String(result.value ?? "no result");
      const outcome = result.cancelled
        ? `Lobby cancelled${result.reason ? ` (${result.reason})` : ""}`
        : `Lobby returned: ${returned}`;
      // Returning/cancelling the nested lobby only resumes this Profile guest.
      // Keep selected/stored local state alive until the user explicitly
      // chooses the separate Return to Showcase action below.
      setStatus(`${outcome}; Profile remains available.`);
    } catch (error) {
      setStatus(`Profile flow failed: ${errorText(error)}`);
      setStatusOk(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <MobileThemeProvider theme={MOBILE_THEME_LIGHT}>
      <SafeAreaScaffold
        reservedActions="mini-app"
        appBar={() => (
          <MobileAppBar
            title="Pocket Profile"
            subtitle="pocket.demo.profile · shared identity"
            trailing={<MobileBadge label="Guest A" tone="accent" />}
          />
        )}
      >
        <ScrollablePage>
          <View class="flex-col gap-3 p-4">
            <StatusBar label="Identity namespace" detail={status()} ok={statusOk()} />
            <MobileCard
              title="PocketNexus identity"
              detail="A real JS-owned profile guest. The saved value is shared only through the host allowlist."
            >
              <View class="flex-col gap-1">
                <Text class="text-xs text-slate-600">Current selection</Text>
                <Text class="text-lg text-slate-950 font-bold">{selectedProfile().name}</Text>
                <Text class="text-xs text-slate-600">{selectedProfile().role}</Text>
                <Text class="text-xs text-slate-600">UID {selectedProfile().uid} · VIP {selectedProfile().vipLevel}</Text>
              </View>
            </MobileCard>
            <MobileCard title="Choose an account" detail="Select the identity to share with Lobby.">
              <View class="flex-col gap-2">
                <For each={Object.entries(PROFILES) as [ProfileKey, Profile][]}>
                  {([key, profile]) => (
                    <MobileButton
                      label={`${profile.name} (VIP ${profile.vipLevel})`}
                      kind={selected() === key ? "filled" : "outlined"}
                      disabled={busy()}
                      onPress={() => chooseProfile(key)}
                    />
                  )}
                </For>
              </View>
            </MobileCard>
            <MobileCard
              title="Host-backed flow"
              detail={stored() ? `Last shared value: ${stored()!.name} · ${stored()!.uid}` : "No identity has been saved in this session."}
            >
              <View class="flex-col gap-2">
                <MobileButton
                  label="Save identity & open Lobby"
                  disabled={busy()}
                  onPress={() => { void saveAndOpenLobby(); }}
                />
                <MobileButton
                  label="Return to Showcase"
                  kind="outlined"
                  disabled={busy()}
                  onPress={() => { void returnToShowcase({ profile: (stored() ?? selectedProfile()) as unknown as JsonValue, source: "profile" }); }}
                />
              </View>
            </MobileCard>
          </View>
        </ScrollablePage>
      </SafeAreaScaffold>
    </MobileThemeProvider>
  );
}

mount(() => <ProfileApp />);
