import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import {
  MobileAlert,
  MobileBadge,
  MobileButton,
  MobileCard,
  MobileListTile,
  ScrollablePage,
  useMobileTheme,
} from "@pocket/ui";
import type { createPocketPlatformClient } from "@pocket/ui/platform";
import type { installShowcaseSystem } from "./system.ts";

type ShowcasePlatform = ReturnType<typeof createPocketPlatformClient>;
type ShowcaseSystem = ReturnType<typeof installShowcaseSystem>;
type AppUpdateStatus = Awaited<ReturnType<ShowcasePlatform["getAppUpdateStatus"]>>;

type AppEntry = {
  appId: string;
  title: string;
};

type AppStatusState =
  | { phase: "loading" }
  | { phase: "ready"; status: AppUpdateStatus; checkingLatest?: boolean; message?: string }
  | { phase: "error"; message: string };

function appTitle(entry: { appId: string; presentation?: Record<string, unknown> }): string {
  return typeof entry.presentation?.title === "string" ? entry.presentation.title : entry.appId;
}

function versionBuild(version: string | null, build: number | null): string {
  if (!version) return "Not reported";
  return `v${version}${build === null ? "" : ` · build ${build}`}`;
}

function statusLabel(status: AppUpdateStatus): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  if (!status.configured || status.stage === "not_configured") return { label: "NO UPDATE SOURCE", tone: "neutral" };
  if (status.stage === "error") return { label: "UPDATE ERROR", tone: "danger" };
  if (status.latestVersion === null) return { label: "NOT CHECKED", tone: "neutral" };
  if (status.stagedVersion !== null && status.stagedBuild !== null &&
      status.stagedVersion === status.latestVersion && status.stagedBuild === status.latestBuild) {
    return { label: "STAGED", tone: "success" };
  }
  if (status.updateAvailable) return { label: "UPDATE AVAILABLE", tone: "warning" };
  return { label: "UP TO DATE", tone: "success" };
}

/** Lists configured MiniApps and stages a selected signed update for the next healthy open. */
export function MiniAppUpdatesPage(props: {
  platform: ShowcasePlatform;
  system: ShowcaseSystem;
}): JSX.Element {
  const theme = useMobileTheme();
  const apps = createMemo<AppEntry[]>(() => {
    const snapshot = props.system.snapshot();
    return snapshot.catalog
      .filter((entry) => entry.installed && entry.appId !== snapshot.systemUI)
      .map((entry) => ({ appId: entry.appId, title: appTitle(entry) }));
  });
  const [statuses, setStatuses] = createSignal<Record<string, AppStatusState>>({});
  const [loadingLocal, setLoadingLocal] = createSignal(false);
  const [checkingAll, setCheckingAll] = createSignal(false);
  const [busyAppId, setBusyAppId] = createSignal<string | null>(null);
  let disposed = false;
  onCleanup(() => { disposed = true; });

  const setAppState = (appId: string, state: AppStatusState): void => {
    setStatuses((current) => ({ ...current, [appId]: state }));
  };
  const loadLocalStatus = async (): Promise<void> => {
    if (loadingLocal() || checkingAll() || busyAppId() !== null) return;
    setLoadingLocal(true);
    const rows = apps();
    for (const app of rows) setAppState(app.appId, { phase: "loading" });
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (!disposed) {
        const index = nextIndex++;
        if (index >= rows.length) return;
        const app = rows[index]!;
        try {
          const status = await props.platform.getAppUpdateStatus(app.appId);
          if (!disposed) setAppState(app.appId, { phase: "ready", status });
        } catch (error) {
          if (!disposed) {
            setAppState(app.appId, {
              phase: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, rows.length) }, () => worker()));
    if (!disposed) setLoadingLocal(false);
  };

  onMount(() => { void loadLocalStatus(); });

  const checkAllUpdates = async (): Promise<void> => {
    if (loadingLocal() || checkingAll() || busyAppId() !== null) return;
    const rows = apps().filter((app) => {
      const state = statuses()[app.appId];
      return state?.phase === "ready" && state.status.configured;
    });
    if (rows.length === 0) return;
    setCheckingAll(true);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (!disposed) {
        const index = nextIndex++;
        if (index >= rows.length) return;
        const app = rows[index]!;
        const existing = statuses()[app.appId];
        if (existing?.phase === "ready") {
          setAppState(app.appId, { ...existing, checkingLatest: true, message: undefined });
        }
        try {
          const status = await props.platform.getAppUpdateStatus(app.appId, { checkLatest: true });
          if (!disposed) setAppState(app.appId, { phase: "ready", status });
        } catch (error) {
          if (!disposed) {
            const current = statuses()[app.appId];
            const message = error instanceof Error ? error.message : String(error);
            if (current?.phase === "ready") {
              setAppState(app.appId, { ...current, checkingLatest: false, message });
            } else {
              setAppState(app.appId, { phase: "error", message });
            }
          }
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(3, rows.length) }, () => worker()));
    } finally {
      if (!disposed) setCheckingAll(false);
    }
  };

  const runAppAction = async (
    appId: string,
    action: "check" | "prepare",
  ): Promise<void> => {
    if (loadingLocal() || checkingAll() || busyAppId() !== null) return;
    setBusyAppId(appId);
    const current = statuses()[appId];
    if (action === "check" && current?.phase === "ready") {
      setAppState(appId, { ...current, checkingLatest: true, message: undefined });
    }
    try {
      const status = action === "check"
        ? await props.platform.getAppUpdateStatus(appId, { checkLatest: true })
        : await props.platform.prepareAppUpdate(appId);
      if (!disposed) setAppState(appId, { phase: "ready", status });
    } catch (error) {
      if (!disposed) {
        const message = error instanceof Error ? error.message : String(error);
        const latest = statuses()[appId];
        if (latest?.phase === "ready") {
          setAppState(appId, { ...latest, checkingLatest: false, message });
        } else {
          setAppState(appId, { phase: "error", message });
        }
      }
    } finally {
      if (!disposed) setBusyAppId(null);
    }
  };

  const allUpdatesUnconfigured = (): boolean => apps().length > 0 && apps().every((app) => {
    const row = statuses()[app.appId];
    return row?.phase === "ready" && !row.status.configured;
  });

  return (
    <ScrollablePage>
      <View class="flex-col gap-3 p-4 pb-6">
        <MobileCard
          title="MiniApp packages"
          detail="Installed versions and signed updates for this Demo. Staged packages activate after the app next opens and passes its health check."
        >
          <View class="flex-col gap-2">
            <MobileListTile title={`${apps().length} installed MiniApps`} detail="Each app reports its own installed, active, latest and staged build." />
            <MobileButton
              label={loadingLocal() ? "Loading…" : checkingAll() ? "Checking…" : "Check all updates"}
              kind="outlined"
              compact
              disabled={loadingLocal() || checkingAll() || busyAppId() !== null || apps().length === 0}
              onPress={() => void checkAllUpdates()}
            />
          </View>
        </MobileCard>

        <Show when={allUpdatesUnconfigured()}>
          <MobileAlert
            tone="info"
            title="No signed MiniApp update source"
            body="Installed package versions are shown locally. Latest versions appear after this host is launched with its signed update configuration."
          />
        </Show>

        <Show when={apps().length > 0} fallback={
          <MobileAlert tone="info" title="No installed MiniApps" body="This Demo system has no installed child packages." />
        }>
          <For each={apps()}>{(app) => {
            const row = () => statuses()[app.appId];
            const status = () => row()?.phase === "ready" ? row()!.status : undefined;
            const stateBadge = () => {
              const current = status();
              if (row()?.phase === "ready" && row()!.checkingLatest) return { label: "CHECKING", tone: "neutral" as const };
              return current ? statusLabel(current) : undefined;
            };
            const stagedIsLatest = () => {
              const current = status();
              return !!current && current.stagedVersion !== null && current.stagedBuild !== null &&
                current.stagedVersion === current.latestVersion && current.stagedBuild === current.latestBuild;
            };
            const canPrepare = () => status()?.configured === true && status()?.updateAvailable === true && !stagedIsLatest();
            const isBusy = () => busyAppId() === app.appId;
            return (
              <MobileCard title={app.title} detail={app.appId}>
                <Show when={row()?.phase === "ready"} fallback={
                  <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
                    {row()?.phase === "error" ? row()!.message : "Loading installed package status…"}
                  </Text>
                }>
                  <MobileBadge label={stateBadge()?.label ?? "CHECKING"} tone={stateBadge()?.tone ?? "neutral"} />
                  <Show when={app.appId === "pocket.demo.lantern" && status()!.configured}>
                    <MobileListTile
                      title="Automatic updates"
                      detail="Checked on app open"
                      trailing={<MobileBadge label="ON" tone="success" />}
                    />
                  </Show>
                  <MobileListTile title="Installed" detail={versionBuild(status()!.installedVersion, status()!.installedBuild)} />
                  <Show when={status()!.activeVersion !== null}>
                    <MobileListTile
                      title="Active"
                      detail={versionBuild(status()!.activeVersion, status()!.activeBuild)}
                    />
                  </Show>
                  <MobileListTile title="Latest" detail={versionBuild(status()!.latestVersion, status()!.latestBuild)} />
                  <Show when={status()!.stagedVersion !== null}>
                    <MobileListTile
                      title="Staged · activates on next healthy open"
                      detail={versionBuild(status()!.stagedVersion, status()!.stagedBuild)}
                    />
                  </Show>
                  <Show when={status()!.lastError}>
                    <MobileAlert tone="warning" title="Update status" body={status()!.lastError!} />
                  </Show>
                  <View class="flex-row flex-wrap gap-2">
                    <Show when={status()!.configured}>
                      <MobileButton
                        label={isBusy() ? "Checking…" : "Check latest"}
                        kind="outlined"
                        disabled={loadingLocal() || checkingAll() || busyAppId() !== null}
                        onPress={() => void runAppAction(app.appId, "check")}
                      />
                      <Show when={canPrepare()}>
                        <MobileButton
                          label={isBusy() ? "Downloading…" : "Download update"}
                          kind="tonal"
                          disabled={loadingLocal() || checkingAll() || busyAppId() !== null}
                          onPress={() => void runAppAction(app.appId, "prepare")}
                        />
                      </Show>
                    </Show>
                  </View>
                  <Show when={row()?.phase === "ready" && row()!.message}>
                    <MobileAlert tone="warning" title="Update check failed" body={row()!.message!} />
                  </Show>
                  <Show when={!status()!.configured}>
                    <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
                      No signed update source is configured for this host.
                    </Text>
                  </Show>
                </Show>
              </MobileCard>
            );
          }}</For>
        </Show>
      </View>
    </ScrollablePage>
  );
}
