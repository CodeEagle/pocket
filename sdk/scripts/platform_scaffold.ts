import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PlatformExperienceOptions {
  platformExperience?: boolean;
  deepLinkScheme?: string;
}

export function resolvePlatformExperience(options: PlatformExperienceOptions): {
  platformExperience: boolean;
  deepLinkScheme?: string;
} {
  const scheme = options.deepLinkScheme;
  if (scheme !== undefined && (
    !/^[a-z][a-z0-9+.-]{0,31}$/.test(scheme) ||
    new Set(["http", "https", "file", "content", "data", "javascript", "intent"]).has(scheme)
  )) {
    throw new Error("deep-link-scheme must be a lowercase custom URL scheme (1–32 characters)");
  }
  return { platformExperience: options.platformExperience === true || scheme !== undefined, deepLinkScheme: scheme };
}

/** No scheme means no filesystem access or platform configuration changes. */
export function patchDeepLinkPlatforms(flutterDirectory: string, scheme?: string): void {
  if (scheme === undefined) return;
  resolvePlatformExperience({ deepLinkScheme: scheme });
  if (!existsSync(join(flutterDirectory, "ios/Runner/Info.plist")) &&
      !existsSync(join(flutterDirectory, "android/app/src/main/AndroidManifest.xml"))) return;
  // Python is already required by the pinned upstream bootstrap. Standard XML
  // parsers preserve consumer entries without another npm parser dependency.
  const script = join(dirname(fileURLToPath(import.meta.url)), "patch_deep_links.py");
  const result = spawnSync("python3", [script, flutterDirectory, scheme], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`cannot configure optional Deep Links: ${result.error?.message ?? result.stderr.trim()}`);
  }
}
