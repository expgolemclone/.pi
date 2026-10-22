import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import WindowsToaster from "node-notifier/notifiers/toaster.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const sound = fileURLToPath(new URL("../sounds/ready.wav", import.meta.url));

export function notificationCommand(soundPath = sound) {
  // Restricted permits direct commands, not .ps1 files. Do not change policy.
  // UTF-16LE encoding preserves quotes and Unicode across Windows argument parsing.
  const script = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$SoundPath = '${soundPath.replace(/'/g, "''")}'
$player = [System.Media.SoundPlayer]::new($SoundPath)
try {
    # Load explicitly: missing/invalid WAVs must fail, never play a system beep.
    $player.Load()
    # Direct playback is independent of toast sounds and Do not disturb.
    $player.PlaySync()
} finally {
    $player.Dispose()
}
`;
  return {
    command: "mise.exe",
    args: ["exec", "--", "pwsh", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    options: { timeout: 10000 },
  };
}

export default function (pi: ExtensionAPI, toast = new WindowsToaster({ withFallback: false })) {
  // Notification-only final boundary: no alerts during retries or continuations.
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui" || process.platform !== "win32") return;
    await promisify(toast.notify.bind(toast))({ title: "Pi", message: "Ready for input", sound: false });
    const { command, args, options } = notificationCommand();
    const result = await pi.exec(command, args, options);
    if (result.code !== 0 || result.killed) {
      throw new Error(`Pi notification failed (${result.code}, killed=${result.killed}): ${result.stderr}`);
    }
  });
}
