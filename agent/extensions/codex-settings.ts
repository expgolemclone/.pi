import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const codexDir = join(homedir(), ".codex");
const instructionsPath = join(codexDir, "AGENTS.md");

// Read only single-line TOML strings from the root table, never project settings.
function stringSetting(root: string, key: string): string {
  const values = [...root.matchAll(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`, "gm"))];
  if (values.length !== 1) throw new Error(`Expected one root ${key} string in .codex/config.toml`);
  const value = values[0][1];
  return value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1);
}

function config() {
  const text = readFileSync(join(codexDir, "config.toml"), "utf8").replace(/\r/g, "");
  const root = text.split(/^\s*\[/m, 1)[0];
  if (stringSetting(root, "approval_policy") !== "never" || stringSetting(root, "sandbox_mode") !== "danger-full-access") {
    throw new Error("Codex permissions changed. Pi requires a matching isolation/approval design before use.");
  }
  const model = stringSetting(root, "model");
  const thinking = stringSetting(root, "model_reasoning_effort");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) {
    throw new Error(`Unsupported Codex reasoning effort: ${thinking}`);
  }
  const tier = stringSetting(root, "service_tier");
  if (!["fast", "priority", "auto", "default", "flex"].includes(tier)) throw new Error(`Unsupported service tier: ${tier}`);
  return { text, model, thinking, tier: tier === "fast" ? "priority" : tier };
}

export default function (pi: ExtensionAPI) {
  async function sync(ctx: ExtensionContext) {
    const shared = config();
    const model = ctx.modelRegistry.find("openai", shared.model);
    if (!model || !ctx.modelRegistry.isUsingOAuth(model)) throw new Error("The Codex model requires Pi's OpenAI ChatGPT OAuth login.");
    if (!await pi.setModel(model)) throw new Error("Could not select the Codex model in Pi.");
    pi.setThinkingLevel(shared.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
    if (pi.getThinkingLevel() !== shared.thinking) throw new Error("Pi cannot use the configured Codex reasoning effort.");
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
    if (!files.some((file) => resolve(file.path).toLowerCase() === resolve(instructionsPath).toLowerCase())) {
      files.unshift({ path: instructionsPath, content: readFileSync(instructionsPath, "utf8") });
    }
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider === "openai") {
      return { ...(event.payload as Record<string, unknown>), service_tier: config().tier };
    }
  });

  pi.on("project_trust", (event) => {
    const cwd = resolve(event.cwd).toLowerCase();
    const projects = [...config().text.matchAll(/^\[projects\.("(?:[^"\\]|\\.)*"|'[^']*')\][ \t]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm)];
    const matches = projects.map((match) => {
      const quoted = match[1];
      const path = resolve(quoted.startsWith('"') ? JSON.parse(quoted) : quoted.slice(1, -1)).toLowerCase();
      return { path, trust: stringSetting(match[2], "trust_level") };
    }).filter(({ path }) => cwd === path || cwd.startsWith(path + sep)).sort((a, b) => b.path.length - a.path.length);
    return { trusted: matches[0]?.trust === "trusted" ? "yes" : "no", remember: false };
  });
}
