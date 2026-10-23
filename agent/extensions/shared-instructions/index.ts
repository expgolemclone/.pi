import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { injectInstructions, readInstructions } from "./instructions.ts";

export default function (pi: ExtensionAPI) {
  pi.on("input", (_event, ctx) => {
    try {
      readInstructions();
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
        return { action: "handled" };
      }
    }
  });

  pi.on("before_agent_start", (event) => {
    injectInstructions(event.systemPromptOptions.contextFiles);
  });
}
