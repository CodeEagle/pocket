// The only module that talks to the update capabilities: it wraps the SDK's guest-controlled refresh client
// (`@pocket/ui/updates`) with the Studio's portable UI state handoff (SYSTEM_UI_SELF_REFRESH.md). Automatic
// refresh is NOT enabled: replacing the guest while a user edits would be rude, so Settings has explicit
// "检查 Studio 更新" / "应用更新" actions.
import type { HostBridge } from "@pocket/ui/host";
import { createPocketPlatformClient } from "@pocket/ui/platform";
import { createPocketUpdateClient, type PocketUpdateStateOptions } from "@pocket/ui/updates";
import type { UpdateBackend, UpdateStatus } from "./self-update.ts";

export interface UpdateHandoff {
  capture: PocketUpdateStateOptions["capture"];
  restore: PocketUpdateStateOptions["restore"];
}

export function createUpdateLink(host: HostBridge, handoff: UpdateHandoff): UpdateBackend {
  const platform = createPocketPlatformClient(undefined, { bridge: host });
  const client = createPocketUpdateClient(host, {
    state: { key: "studio.update-state", schema: "studio-ui/1", storage: platform.storage, ...handoff },
    onError: (error) => console.warn("Studio update", (error as { code?: string })?.code ?? "error"),
  });
  const summary = (s: Awaited<ReturnType<typeof client.status>>): UpdateStatus => ({
    configured: s.configured, stage: s.stage, activeVersion: s.activeVersion, activeBuild: s.activeBuild,
    preparedUpdate: s.preparedUpdate ? { version: s.preparedUpdate.version, build: s.preparedUpdate.build } : null,
    lastError: s.lastError ?? null,
  });
  return {
    ready: client.ready,
    status: async () => summary(await client.status()),
    check: async () => summary(await client.check({ mode: "granular", scope: "all" })),
    apply: () => client.apply(),
  };
}
