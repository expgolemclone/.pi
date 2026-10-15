import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
