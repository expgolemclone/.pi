import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const attemptType = "daily-handoff-attempt";
const schedules = new Map<string, readonly [number, number]>([
  ["company", [16, 30]],
  ["nucbox", [20, 45]],
]);

export function nextDeadline(now: Date, time: readonly [number, number]) {
  const deadline = new Date(now);
  deadline.setHours(...time, 0, 0);
  if (deadline.getTime() <= now.getTime()) deadline.setDate(deadline.getDate() + 1);
  return deadline;
}

function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  function stop() {
    generation++;
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  pi.on("session_shutdown", stop);
  pi.on("session_start", async (_event, ctx) => {
    stop();
    const active = generation;
    // Preserve a deadline crossed while profile resolution is in progress.
    const startedAt = new Date();
    const result = await pi.exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $HOME 'local-repository-map/repository-map.psm1')
(Get-LocalRepositoryProfile).Name | ConvertTo-Json -Compress
`], { timeout: 10000 });
    if (active !== generation) return;
    if (result.code !== 0 || result.killed) {
      throw new Error(`Daily handoff profile resolution failed (${result.code}, killed=${result.killed}): ${result.stderr}`);
    }
    const profile = JSON.parse(result.stdout.trim());
    if (typeof profile !== "string" || !profile) throw new Error("Daily handoff requires a resolved repository profile name.");
    const time = schedules.get(profile);
    if (!time) return;

    const arm = (target: Date) => {
      if (active !== generation) return;
      // Recheck wall time to notice clock changes without firing early.
      timer = setTimeout(() => {
        if (active !== generation) return;
        timer = undefined;
        try {
          const now = new Date();
          if (now.getTime() < target.getTime()) {
            arm(target);
            return;
          }
          const date = localDate(target);
          if (localDate(now) === date && !ctx.sessionManager.getEntries().some(entry =>
            entry.type === "custom" && entry.customType === attemptType &&
            (entry.data as { date?: string } | undefined)?.date === date)) {
            // Record an attempt, not completion, before the void sender API.
            pi.appendEntry(attemptType, { date });
            pi.sendUserMessage("handoff", { deliverAs: "steer" });
          }
          arm(nextDeadline(now, time));
        } catch (error) {
          stop();
          report(ctx, error);
        }
      }, Math.max(0, Math.min(target.getTime() - Date.now(), 60000)));
      timer.unref();
    };
    arm(nextDeadline(startedAt, time));
  });
}

function report(ctx: ExtensionContext, error: unknown) {
  const message = `Daily handoff scheduling stopped: ${String(error)}`;
  if (ctx.hasUI) ctx.ui.notify(message, "error");
  else console.error(message);
}
