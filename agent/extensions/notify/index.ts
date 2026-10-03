import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const script = fileURLToPath(new URL("./windows.ps1", import.meta.url));
const sound = fileURLToPath(new URL("../../sounds/ready.wav", import.meta.url));

export default function (pi: ExtensionAPI) {
  // Notification-only final boundary: no alerts during retries or continuations.
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui" || process.platform !== "win32") return;
    const result = await pi.exec("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-File", script, "-SoundPath", sound,
    ], { timeout: 10000 });
    if (result.code !== 0 || result.killed) {
      throw new Error(`Pi notification failed (${result.code}, killed=${result.killed}): ${result.stderr}`);
    }
  });
}
