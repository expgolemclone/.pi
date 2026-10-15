import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "kintone_connect",
    label: "Connect kintone",
    description: "Start the installed kintone workspace MCP when kintone operations are needed. Does not perform business operations. Safe to call again.",
    promptSnippet: "Start kintone MCP on demand",
    promptGuidelines: [
      "Before using kintone MCP, call kintone_connect, including in resumed sessions. Then use a separate codemode call to discover and use mcp__kintone tools. Do not connect for unrelated work.",
    ],
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_toolCallId, _params, signal) {
      signal?.throwIfAborted();
      const existing = pi.getMcpServers().find(server => server.name === "kintone");
      if (existing && resolve(existing.extensionPath) !== resolve(fileURLToPath(import.meta.url))) {
        throw new Error(`kintone MCP is already registered by another extension: ${existing.extensionPath}`);
      }
      if (!existing) {
        const localAppData = process.env.LOCALAPPDATA;
        if (!localAppData) throw new Error("LOCALAPPDATA is required to locate the installed kintone integration.");
        const integration = await import(pathToFileURL(join(localAppData, "kintone-workspace/integrations/pi.js")).href);
        signal?.throwIfAborted();
        await integration.default(pi);
        if (!pi.getMcpServers().some(server => server.name === "kintone")) {
          throw new Error("The installed kintone integration did not register its MCP server.");
        }
      }
      return {
        content: [{ type: "text", text: "kintone MCP is registered; connection is managed by Pi. In a separate codemode call, use searchTools with namespace mcp__kintone to wait for discovery and find its tools. Connection failures are reported by Pi's MCP support." }],
        details: undefined,
      };
    },
  });
}
