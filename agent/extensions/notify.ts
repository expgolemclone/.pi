import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const sound = fileURLToPath(new URL("../sounds/ready.wav", import.meta.url));
const widget = "ready-window";
const readyColor = "#06402b";

type ReadyState = {
  abort: AbortController;
  cancelled: boolean;
  originalColor?: string;
  resolveColor?: (color: string | undefined) => void;
};

function powerShellCommand(script: string, timeout: number) {
  // Restricted permits direct commands, not .ps1 files. Do not change policy.
  return {
    command: "mise.exe",
    args: ["exec", "--", "pwsh", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    options: { timeout },
  };
}

export function soundCommand(soundPath = sound) {
  return powerShellCommand(`
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$SoundPath = '${soundPath.replace(/'/g, "''")}'
$player = [System.Media.SoundPlayer]::new($SoundPath)
try {
    # Missing/invalid WAVs must fail, never play a system beep.
    $player.Load()
    $player.PlaySync()
} finally {
    $player.Dispose()
}
`, 10000);
}

export function windowCommand(marker: string) {
  if (!/^[0-9a-f]{16}$/.test(marker)) throw new Error("Invalid window marker");
  return powerShellCommand(`
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:TEMP = 'C:\\dev\\tmp'
$env:TMP = $env:TEMP
Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PiWindow { [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command); }'
$marker = '${marker}'
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'TermControl')
$deadline = [DateTime]::UtcNow.AddSeconds(4)
$lastError = ''
do {
    $handles = [Collections.Generic.HashSet[int]]::new()
    foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        try {
            if ($window.Current.ClassName -ne 'CASCADIA_HOSTING_WINDOW_CLASS') { continue }
            foreach ($control in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
                $pattern = $control.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                foreach ($range in $pattern.GetVisibleRanges()) {
                    if ($range.GetText(-1).Contains($marker)) {
                        [void]$handles.Add($window.Current.NativeWindowHandle)
                        break
                    }
                }
            }
        } catch {
            # Windows may disappear or become inaccessible while enumerating.
            $lastError = $_.Exception.Message
        }
    }
    if ($handles.Count -gt 1) { throw 'Pi window marker is ambiguous.' }
    if ($handles.Count -eq 1) {
        foreach ($value in $handles) { $handle = [IntPtr]::new($value) }
        if ([PiWindow]::IsIconic($handle)) {
            # Restore without activating or changing an already-visible window.
            [void][PiWindow]::ShowWindow($handle, 4)
            if ([PiWindow]::IsIconic($handle)) { throw 'Could not restore the minimized Pi window.' }
        }
        return
    }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
throw "Could not identify the Pi window. $lastError"
`, 8000);
}

function isUserInput(data: string) {
  // Terminal replies and focus reports are not acknowledgements.
  return data.length > 0 &&
    !/^\x1b[\]P_^X]/.test(data) &&
    !/^\x1b\[(?:[IO]|[?>][\d;]*[cnu]|(?:\d+;)+\d+[Rt])$/.test(data);
}

export default function (pi: ExtensionAPI) {
  let ready: ReadyState | undefined;
  let unsubscribe: (() => void) | undefined;

  function clearReady(ctx: ExtensionContext) {
    if (!ready) return;
    const state = ready;
    ready = undefined;
    state.cancelled = true;
    state.abort.abort();
    state.resolveColor?.(undefined);
    if (state.originalColor) process.stdout.write(`\x1b]11;${state.originalColor}\x07`);
    ctx.ui.setWidget(widget, undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || process.platform !== "win32" || !process.env.WT_SESSION) return;
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      const reply = data.match(/^\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)$/i);
      if (reply && ready?.resolveColor) {
        if (/^(?:rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}|#[0-9a-f]{6}|#[0-9a-f]{12})$/i.test(reply[1])) {
          ready.resolveColor(reply[1]);
        }
        return { consume: true };
      }
      if (ready && isUserInput(data)) clearReady(ctx);
      return undefined;
    });
  });

  pi.on("agent_start", (_event, ctx) => clearReady(ctx));

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui" || process.platform !== "win32") return;

    const audio = soundCommand();
    const soundTask = Promise.resolve().then(async () => {
      const result = await pi.exec(audio.command, audio.args, audio.options);
      if (result.code !== 0 || result.killed) {
        throw new Error(`Pi sound failed (${result.code}, killed=${result.killed}): ${result.stderr}`);
      }
    });
    const tasks: Promise<void>[] = [soundTask];

    if (process.env.WT_SESSION) {
      clearReady(ctx);
      const state: ReadyState = { abort: new AbortController(), cancelled: false };
      ready = state;
      const marker = randomBytes(8).toString("hex");
      ctx.ui.setWidget(widget, [`Pi ready ${marker}`]);

      const colorTask = new Promise<string | undefined>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.resolveColor = undefined;
          reject(new Error("Could not query the terminal background color"));
        }, 1000);
        state.resolveColor = (color) => {
          clearTimeout(timer);
          state.resolveColor = undefined;
          resolve(color);
        };
        process.stdout.write("\x1b]11;?\x07");
      }).then((color) => {
        if (!color || state.cancelled) return;
        state.originalColor = color;
        process.stdout.write(`\x1b]11;${readyColor}\x07`);
      });
      tasks.push(colorTask);

      const window = windowCommand(marker);
      const windowTask = Promise.resolve().then(async () => {
        try {
          const result = await pi.exec(window.command, window.args, { ...window.options, signal: state.abort.signal });
          if (!state.cancelled && (result.code !== 0 || result.killed)) {
            throw new Error(`Pi window restore failed (${result.code}, killed=${result.killed}): ${result.stderr}`);
          }
        } catch (error) {
          if (!state.cancelled) throw error;
        } finally {
          if (ready === state) ctx.ui.setWidget(widget, undefined);
        }
      });
      tasks.push(windowTask);
    }

    const results = await Promise.allSettled(tasks);
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map((result) => result.reason), errors.map((result) => String(result.reason)).join("; "));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearReady(ctx);
    unsubscribe?.();
    unsubscribe = undefined;
  });
}
