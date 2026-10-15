import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
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

export function applyServiceTier(payload: unknown, provider: string | undefined) {
  if (provider === "openai") {
    return { ...(payload as Record<string, unknown>), service_tier: config().serviceTier };
  }
}

// https://github.com/narumiruna/pi-extensions/blob/main/docs/api/oauth-credential-source-v1.md
export async function requireOAuth(pi: ExtensionAPI, ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>) {
  const error = () => new Error("The shared model requires Pi's OpenAI ChatGPT OAuth login.");
  const selectedModel = ctx.model;
  const pending: Promise<unknown>[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    pi.events.emit("oauth:credential-readiness:v1", {
      session: ctx.sessionManager, provider: model.provider,
      waitUntil: (task: Promise<unknown>) => { pending.push(Promise.resolve(task)); },
    });
    if (pending.length) {
      await Promise.race([
        Promise.all(pending),
        new Promise((_, reject) => { timer = setTimeout(() => reject(error()), 10_000); }),
      ]);
    }
    if (ctx.model !== selectedModel) throw error();
    if (ctx.modelRegistry.isUsingOAuth(model)) return;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (ctx.model !== selectedModel || !auth.ok || !auth.apiKey) throw error();
    if (new URL(auth.baseUrl ?? model.baseUrl).origin !== "https://api.openai.com") throw error();
    for (const [name, value] of Object.entries(auth.headers ?? {})) {
      if (name.toLowerCase() === "authorization" && value !== `Bearer ${auth.apiKey}`) throw error();
    }
    const matches: unknown[] = [];
    let collecting = true;
    try {
      pi.events.emit("oauth:credential-source:v1", {
        session: ctx.sessionManager, provider: model.provider,
        offer: (value: unknown) => {
          if (!collecting) return;
          try {
            const credential = structuredClone(value) as Record<string, unknown>;
            if (credential?.type !== "oauth" || credential.access !== auth.apiKey ||
                typeof credential.refresh !== "string" || typeof credential.expires !== "number" ||
                !Number.isFinite(credential.expires) || credential.expires <= Date.now()) return;
            if (!matches.some(match => isDeepStrictEqual(match, credential))) matches.push(credential);
          } catch { /* Invalid offers cannot authorize a request. */ }
        },
      });
    } finally { collecting = false; }
    if (matches.length !== 1) throw error();
  } catch {
    // Never surface errors supplied by a credential owner; they may contain secrets.
    throw error();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default function (pi: ExtensionAPI) {
  async function sync(ctx: ExtensionContext) {
    const shared = config();
    const model = ctx.modelRegistry.find(shared.provider, shared.model);
    if (!model) throw new Error("The shared model requires Pi's OpenAI ChatGPT OAuth login.");
    await requireOAuth(pi, ctx, model);
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
      try {
        if (ctx.mode === "print" || ctx.mode === "json") {
          process.exitCode = 1;
          console.error(String(error));
        } else {
          ctx.ui.notify(String(error), "error");
        }
      } finally {
        // Handler exceptions are caught by Pi and would let invalid input continue.
        return { action: "handled" };
      }
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
    return applyServiceTier(event.payload, ctx.model?.provider);
  });
}
