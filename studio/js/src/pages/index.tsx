// Page registry. Later milestones add a line here (and a rail label) instead
// of editing the shell: M4 swaps the editor widget, M5 fills artifacts /
// publish / versions.
import type { JSX } from "solid-js";
import type { Studio, StudioPage } from "../state/studio.ts";
import { ProjectsPage } from "./projects.tsx";
import { SourcePage } from "./source.tsx";
import { ConsolePage } from "./console.tsx";
import { PreviewPage } from "./preview.tsx";
import { ResourcesPage } from "./resources.tsx";
import { SettingsPage } from "./settings.tsx";
import { PlaceholderPage } from "./placeholder.tsx";

export interface PageDef { id: StudioPage; label: string; render: (studio: Studio) => JSX.Element }

export const pages: readonly PageDef[] = [
  { id: "projects", label: "项目", render: (s) => <ProjectsPage studio={s} /> },
  { id: "source", label: "源码", render: (s) => <SourcePage studio={s} /> },
  { id: "console", label: "控制台", render: (s) => <ConsolePage studio={s} /> },
  { id: "preview", label: "预览", render: (s) => <PreviewPage studio={s} /> },
  { id: "resources", label: "资源", render: (s) => <ResourcesPage studio={s} /> },
  { id: "settings", label: "设置", render: (s) => <SettingsPage studio={s} /> },
  { id: "artifacts", label: "产物", render: () => <PlaceholderPage title="产物" milestone="M5" /> },
  { id: "publish", label: "发布", render: () => <PlaceholderPage title="发布" milestone="M5" /> },
  { id: "versions", label: "版本", render: () => <PlaceholderPage title="版本" milestone="M5" /> },
];
