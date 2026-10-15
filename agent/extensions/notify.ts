import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
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
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $xml = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]::new()
    # LoadXml avoids live DOM collection mutation from the official example.
    $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Pi</text><text>Ready for input</text></binding></visual><audio silent="true" /></toast>')
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pi').Show($toast)
    # Direct playback is independent of toast sounds and Do not disturb.
    $player.PlaySync()
} finally {
    $player.Dispose()
}
`;
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    options: { timeout: 10000 },
  };
}

export default function (pi: ExtensionAPI) {
  // Notification-only final boundary: no alerts during retries or continuations.
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui" || process.platform !== "win32") return;
    const { command, args, options } = notificationCommand();
    const result = await pi.exec(command, args, options);
    if (result.code !== 0 || result.killed) {
      throw new Error(`Pi notification failed (${result.code}, killed=${result.killed}): ${result.stderr}`);
    }
  });
}
