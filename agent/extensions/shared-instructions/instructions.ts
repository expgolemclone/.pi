import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

const instructionsPath = join(homedir(), ".agents", "AGENTS.md");

export function readInstructions() {
  return { path: instructionsPath, content: readFileSync(instructionsPath, "utf8") };
}

export function injectInstructions(files: BeforeAgentStartEvent["systemPromptOptions"]["contextFiles"]) {
  const shared = readInstructions();
  const existing = files.find((file) => resolve(file.path).toLowerCase() === resolve(shared.path).toLowerCase());
  if (existing) existing.content = shared.content;
  else files.unshift(shared);
}
