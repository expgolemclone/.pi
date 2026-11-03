import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TerminalColors } from "@earendil-works/pi-tui";

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

  pi.on("input", (event, ctx) => {
    if (ctx.mode === "tui" && process.platform === "win32" && process.env.WT_SESSION && event.source === "interactive") {
      clearReady(ctx);
      process.stdout.write("\x1b[2t");
    }
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
      // Windows Terminal handles restore on the same stream as minimize.
      process.stdout.write("\x1b[1t");
      const state: ReadyState = { abort: new AbortController(), cancelled: false };
      ready = state;
      const colorTask = new Promise<void>((resolve, reject) => {
        state.abort.signal.addEventListener("abort", () => resolve(), { once: true });
        ctx.ui.setWidget(widget, (tui) => {
          let handled = false;
          // A timeout can be followed by a late reply; never change colors we cannot restore.
          const applyColors = ({ foreground, background }: TerminalColors) => {
            if (state.cancelled || handled || !foreground || !background) return;
            handled = true;
            if (ctx.ui.theme.appearance === "dark" && ctx.ui.theme.name !== "system") {
              ctx.ui.notify("White completion background requires Pi's system or a light theme", "warning");
              return;
            }
            state.original = {
              foreground: terminalColor(foreground),
              background: terminalColor(background),
              appearance: ctx.ui.theme.appearance,
            };
            process.stdout.write(`\x1b]10;#000000\x07\x1b]11;${readyColor}\x07`);
            refreshAppearance("light");
          };
          void tui.queryTerminalColors({ timeoutMs: 1000, onLateReply: applyColors }).then(applyColors).then(resolve, reject);
          return { render: () => [], invalidate: () => {} };
        });
      });
      tasks.push(colorTask.finally(() => {
        if (ready === state) ctx.ui.setWidget(widget, undefined);
      }));
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
