import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyServiceTier, readSettings } from "./settings.ts";
import { requireOAuth } from "./openai-oauth.ts";
import { injectInstructions, readInstructions } from "./instructions.ts";

export default function (pi: ExtensionAPI) {
  async function sync(ctx: ExtensionContext) {
    const shared = readSettings();
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
      readInstructions();
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
    injectInstructions(event.systemPromptOptions.contextFiles);
  });

  pi.on("before_provider_request", (event, ctx) => {
    return applyServiceTier(event.payload, ctx.model?.provider);
  });
}
