import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const agentsDir = join(homedir(), ".agents");
const instructionsPath = join(agentsDir, "AGENTS.md");
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

function config() {
  return parseSettings(readFileSync(join(agentsDir, "settings.json"), "utf8"));
}

export default function (pi: ExtensionAPI) {
  async function sync(ctx: ExtensionContext) {
    const shared = config();
    const model = ctx.modelRegistry.find(shared.provider, shared.model);
    if (!model || !ctx.modelRegistry.isUsingOAuth(model)) throw new Error("The shared model requires Pi's OpenAI ChatGPT OAuth login.");
    if (!await pi.setModel(model)) throw new Error("Could not select the shared model in Pi.");
    pi.setThinkingLevel(shared.thinkingLevel);
    if (pi.getThinkingLevel() !== shared.thinkingLevel) throw new Error("Pi cannot use the configured thinking level.");
  }

  pi.on("session_start", async (_event, ctx) => { await sync(ctx); });
  pi.on("input", async (_event, ctx) => {
    try {
      readFileSync(instructionsPath, "utf8");
      await sync(ctx);
      return { action: "continue" };
    } catch (error) {
      ctx.ui.notify(String(error), "error");
      return { action: "handled" };
    }
  });

  pi.on("before_agent_start", (event) => {
    const files = event.systemPromptOptions.contextFiles;
    const shared = { path: instructionsPath, content: readFileSync(instructionsPath, "utf8") };
    const existing = files.find((file) => resolve(file.path).toLowerCase() === resolve(instructionsPath).toLowerCase());
    if (existing) existing.content = shared.content;
    else files.unshift(shared);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider === "openai") {
      return { ...(event.payload as Record<string, unknown>), service_tier: config().serviceTier };
    }
  });
}
