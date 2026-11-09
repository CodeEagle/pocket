import storyDocument from "./story.json";
import type { StoryDefinition } from "@pocket/vn";

/** Canonical editor document, re-exported with the SDK story contract. */
export const lanternStory = storyDocument as StoryDefinition;

export default lanternStory;
