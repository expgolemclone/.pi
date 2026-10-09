import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      event.signal.throwIfAborted();
      const model = ctx.model;
      if (!model) throw new Error("No model selected for compaction.");
      const systemPrompt = readFileSync(new URL("../COMPACTION.md", import.meta.url), "utf8").trim();
      if (!systemPrompt) throw new Error("COMPACTION.md must not be empty.");

      const { preparation, customInstructions, signal } = event;
      const { messagesToSummarize, turnPrefixMessages, previousSummary, settings } = preparation;
      const maxTokens = Math.min(
        Math.floor(0.8 * settings.reserveTokens),
        model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
      );
      if (maxTokens < 1) throw new Error("Compaction output budget must be positive.");

      const response = await ctx.modelRegistry.streamSimple(model, {
        systemPrompt,
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: JSON.stringify({
              previousSummary: previousSummary ?? null,
              conversation: serializeConversation(convertToLlm([...messagesToSummarize, ...turnPrefixMessages])),
              customInstructions: customInstructions ?? null,
            }),
          }],
          timestamp: Date.now(),
        }],
      }, {
        maxTokens,
        reasoning: pi.getThinkingLevel(),
        signal,
        cacheRetention: "none",
        sessionId: randomUUID(),
      }).result();

      signal.throwIfAborted();
      if (response.stopReason !== "stop") {
        throw new Error(`Summary did not complete (${response.stopReason}): ${response.errorMessage ?? ""}`);
      }
      if (response.content.some((block) => block.type === "toolCall")) {
        throw new Error("Compaction must not call tools.");
      }
      const summary = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n").trim();
      if (!summary) throw new Error("Compaction summary was empty.");

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: response.usage,
        },
      };
    } catch (error) {
      try {
        ctx.ui.notify(`Custom compaction cancelled: ${String(error)}`, "error");
      } finally {
        // Throwing here lets Pi continue with the native prompt. Always cancel.
        return { cancel: true };
      }
    }
  });
}
