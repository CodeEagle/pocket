import type { HostBridge } from "./host.ts";

export type PocketPermissionStatus = "granted" | "denied" | "restricted" |
  "permanentlyDenied" | "limited" | "provisional" | "notRequired";

export type PocketPermissionResult = {
  ok: boolean;
  permission: string;
  status: PocketPermissionStatus;
  granted: boolean;
  limited?: boolean;
  runtimePermissionRequired?: boolean;
  platformPermissions?: string[];
  realHardware: boolean;
};

/** A thin client over the optional permission_handler provider. No status is
 * cached: the OS remains the source of truth. Request from a user action. */
export function createPocketPermissionsClient(host: HostBridge) {
  return {
    status(policyKey: string): Promise<PocketPermissionResult> {
      return host.request<PocketPermissionResult>("permissions.status", { policyKey });
    },
    request(policyKey: string): Promise<PocketPermissionResult> {
      return host.request<PocketPermissionResult>("permissions.request", { policyKey });
    },
    openSettings(): Promise<{ ok: boolean; opened: boolean; realHardware: boolean }> {
      return host.request("permissions.openSettings", {});
    },
  };
}
