import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const sound = fileURLToPath(new URL("../sounds/ready.wav", import.meta.url));
const widget = "ready-window";
const readyColor = "#ffffff";

type ReadyState = {
  abort: AbortController;
  cancelled: boolean;
  original?: { foreground: string; background: string; appearance: "light" | "dark" };
};

function terminalColor(color: { r: number; g: number; b: number }) {
  return `#${[color.r, color.g, color.b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function refreshAppearance(appearance: "light" | "dark") {
  // Windows Terminal does not report OSC color changes. Let Pi re-query the real colors.
  queueMicrotask(() => process.stdin.emit("data", `\x1b[?997;${appearance === "light" ? 2 : 1}n`));
}

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
    if (state.original) {
      process.stdout.write(`\x1b]10;${state.original.foreground}\x07\x1b]11;${state.original.background}\x07`);
      refreshAppearance(state.original.appearance);
    }
    ctx.ui.setWidget(widget, undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || process.platform !== "win32" || !process.env.WT_SESSION) return;
    unsubscribe = ctx.ui.onTerminalInput((data) => {
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
      const colorTask = new Promise<void>((resolve, reject) => {
        state.abort.signal.addEventListener("abort", () => resolve(), { once: true });
        ctx.ui.setWidget(widget, (tui) => {
          void tui.queryTerminalColors({ timeoutMs: 1000 }).then(({ foreground, background }) => {
            if (state.cancelled) return;
            if (!foreground || !background) throw new Error("Could not query the terminal foreground and background colors");
            if (ctx.ui.theme.appearance === "dark" && ctx.ui.theme.name !== "system") {
              throw new Error("White completion background requires Pi's system or a light theme");
            }
            state.original = {
              foreground: terminalColor(foreground),
              background: terminalColor(background),
              appearance: ctx.ui.theme.appearance,
            };
            process.stdout.write(`\x1b]10;#000000\x07\x1b]11;${readyColor}\x07`);
            refreshAppearance("light");
          }).then(resolve, reject);
          return { render: (width) => [`Pi ready ${marker}`.slice(0, width)], invalidate: () => {} };
        });
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
