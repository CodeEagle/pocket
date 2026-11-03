import { resolve } from "node:path";
import { buildGuest, type BuildGuestResult } from "../../../sdk/scripts/build_guest.ts";
import { validateSystemFile } from "../../../sdk/scripts/build_system.ts";

const scriptRoot = resolve(import.meta.dir);
const miniApps = [
  { name: "profile", projectRoot: resolve(scriptRoot, "../apps/profile") },
  { name: "lobby", projectRoot: resolve(scriptRoot, "../apps/lobby") },
] as const;

export async function buildMiniApps(): Promise<BuildGuestResult[]> {
  const validated = await validateSystemFile(resolve(scriptRoot, "../pocket.system.json"));
  if (!validated.ok) throw new Error(JSON.stringify(validated.diagnostics));
  const results: BuildGuestResult[] = [];
  for (const app of miniApps) {
    const assets = resolve(scriptRoot, `../../assets/apps/${app.name}`);
    console.log(`build_mini_apps: building ${app.name} from ${app.projectRoot}`);
    results.push(await buildGuest({
      projectRoot: app.projectRoot,
      copyAssetsTo: assets,
      keepSource: resolve(app.projectRoot, ".pocket-build/app.js"),
    }));
    console.log(`build_mini_apps: wrote ${assets}`);
  }
  return results;
}

if (import.meta.main) {
  try {
    await buildMiniApps();
  } catch (error) {
    console.error(`build_mini_apps: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
