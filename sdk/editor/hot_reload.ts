import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type HotIdentity = { compatibility: string; source: string };
type HotArtifact = { sourcePath?: string; pakPath?: string; metadataPath?: string; projectDirectory?: string; tickHz?: number };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Only completed, compiler-produced source with an unchanged resource/policy ABI is eligible. */
export async function hotIdentity(artifact: HotArtifact): Promise<HotIdentity | undefined> {
  if (!artifact.sourcePath || !artifact.pakPath || !artifact.metadataPath) return;
  const [sourceBytes, pak, metadataBytes] = await Promise.all([
    readFile(artifact.sourcePath), readFile(artifact.pakPath), readFile(artifact.metadataPath),
  ]);
  if (sourceBytes.length > 16 * 1024 * 1024) return;
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  if (metadata.entryFormat !== "quickjs-bytecode" || typeof metadata.runtimeAbi !== "string" ||
      metadata.worker || metadata.kind !== "script" || metadata.sourceSha256 !== hash(sourceBytes)) return;
  const manifest = await readFile(join(dirname(artifact.metadataPath), "guest-manifest.json"), "utf8");
  const projectConfig = artifact.projectDirectory
    ? await readFile(join(artifact.projectDirectory, "pocket.json"), "utf8") : "";
  const compatibility = hash(JSON.stringify({
    runtimeAbi: metadata.runtimeAbi, binding: metadata.bindingGeneration, tickHz: metadata.tickHz,
    configuredTickHz: artifact.tickHz, pak: hash(pak), manifest: JSON.parse(manifest),
    config: projectConfig ? JSON.parse(projectConfig) : null,
  }));
  return { compatibility, source: sourceBytes.toString("utf8").replace(/\0$/, "") };
}

/** A nonce separates acknowledgements from application events and stale command replies. */
export function hotCommandSource(method: "bind" | "prepare" | "commit", argument: unknown, nonce: string): string {
  return `(()=>{const h=globalThis.__pocketDevHot;let result={supported:false};if(h&&h.protocol===1){result={supported:true,value:h[${JSON.stringify(method)}](${JSON.stringify(argument)})};}if(!pocket._emit(JSON.stringify({type:"event",name:"pocket.dev.hot.ack",payload:{nonce:${JSON.stringify(nonce)},result}})))throw new Error("Hot acknowledgement queue is full");})()`;
}
