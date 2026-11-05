import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildGuest } from "../build_guest.ts";

const output = process.argv[2];
if (!output) throw new Error("Pass the fixture output directory");
const project = mkdtempSync(join(tmpdir(), "pocket-on-demand-consumer-"));
try {
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ app: { entry: "app.tsx" } }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  mkdirSync(join(project, "assets"));
  writeFileSync(join(project, "assets/remote.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#3264c8"/></svg>');
  writeFileSync(join(project, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { createSignal } from "solid-js";
import { Image, Screen, Text, View } from "@pocketjs/framework/solid/components";
import { Button } from "@pocket/ui";
function App() {
  const [count, setCount] = createSignal(0);
  return <Screen class="w-full h-full flex-col bg-white">
    <View class="flex-col gap-4 p-4">
      <Text class="text-base text-black">Downloaded count {count()}</Text>
      <Image src="assets/remote.svg" style={{ width: 32, height: 32 }} />
      <Button label="Increment downloaded app" onPress={() => setCount(count() + 1)} />
    </View>
  </Screen>;
}
mount(() => <App />);
`);
  const root = resolve(output);
  mkdirSync(root, { recursive: true });
  await buildGuest({ projectRoot: project, outDir: join(project, "out"), copyAssetsTo: join(root, "assets") });
  console.log(`On-demand mini-app fixture written to ${root}`);
} finally { rmSync(project, { recursive: true, force: true }); }
