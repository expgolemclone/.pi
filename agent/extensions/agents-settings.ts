import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const agentsDir = join(homedir(), ".agents");
const instructionsPath = join(agentsDir, "AGENTS.md");
const keys = ["approval_policy", "sandbox_mode", "model", "model_reasoning_effort", "service_tier"];

function config() {
  const settings = JSON.parse(readFileSync(join(agentsDir, "settings.json"), "utf8").replace(/^\uFEFF/, ""));
  if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
      Object.keys(settings).length !== keys.length || keys.some((key) => typeof settings[key] !== "string" || !settings[key])) {
    throw new Error(".agents/settings.json must contain exactly the five shared string settings.");
  }
  if (settings.approval_policy !== "never" || settings.sandbox_mode !== "danger-full-access") {
    throw new Error("Shared permissions changed. Pi needs a matching isolation/approval design before use.");
  }
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(settings.model_reasoning_effort)) {
    throw new Error(`Unsupported reasoning effort: ${settings.model_reasoning_effort}`);
  }
  if (!["fast", "priority", "auto", "default", "flex"].includes(settings.service_tier)) {
    throw new Error(`Unsupported service tier: ${settings.service_tier}`);
  }
  return settings;
}

export default function (pi: ExtensionAPI) {
  async function sync(ctx: ExtensionContext) {
    const shared = config();
    const model = ctx.modelRegistry.find("openai", shared.model);
    if (!model || !ctx.modelRegistry.isUsingOAuth(model)) throw new Error("The shared model requires Pi's OpenAI ChatGPT OAuth login.");
    if (!await pi.setModel(model)) throw new Error("Could not select the shared model in Pi.");
    pi.setThinkingLevel(shared.model_reasoning_effort);
    if (pi.getThinkingLevel() !== shared.model_reasoning_effort) throw new Error("Pi cannot use the shared reasoning effort.");
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
      const tier = config().service_tier;
      return { ...(event.payload as Record<string, unknown>), service_tier: tier === "fast" ? "priority" : tier };
    }
  });
}
