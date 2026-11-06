/** Shared creation policy for CLI and Studio. Existing projects default to App. */
export type ProjectTemplate = "app" | "game";

export function resolveProjectTemplate(value: unknown): ProjectTemplate {
  if (value === undefined) return "app";
  if (value === "app" || value === "game") return value;
  throw new Error("template must be app or game");
}
