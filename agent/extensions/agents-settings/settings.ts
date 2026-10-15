import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const settingsPath = join(homedir(), ".agents", "settings.json");
const keys = ["provider", "model", "thinkingLevel", "serviceTier"];

export function parseSettings(raw: string) {
  const settings = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
      Object.keys(settings).length !== keys.length || keys.some((key) => typeof settings[key] !== "string" || !settings[key])) {
    throw new Error(".agents/settings.json must contain exactly provider, model, thinkingLevel and serviceTier strings.");
  }
  if (settings.provider !== "openai") throw new Error("This configuration requires the OpenAI provider.");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(settings.thinkingLevel)) {
    throw new Error(`Unsupported thinking level: ${settings.thinkingLevel}`);
  }
  if (!["priority", "auto", "default", "flex"].includes(settings.serviceTier)) {
    throw new Error(`Unsupported service tier: ${settings.serviceTier}`);
  }
  return settings;
}

export function readSettings() {
  return parseSettings(readFileSync(settingsPath, "utf8"));
}

export function applyServiceTier(payload: unknown, provider: string | undefined) {
  if (provider === "openai") {
    return { ...(payload as Record<string, unknown>), service_tier: readSettings().serviceTier };
  }
}
