# Pi on Windows

Windows native Pi setup using ChatGPT OAuth. Verified with Pi 1.0.0 and PowerShell 7.

## Setup

1. Install Pi if absent: `npm install --global --ignore-scripts '@earendil-works/pi-coding-agent'`.
2. Clone this private repository into `~/.pi` using `jj`. Existing installations already use this directory.
3. Prepare `~/.agents`, then run `./setup.ps1` in PowerShell 7.
4. Start `pi`, use `/login` to select OpenAI and Sign in with ChatGPT, then complete browser login.

## Single source of settings

- `agent/extensions/agents-settings.ts` reads `~/.agents/settings.json` at startup and before input. Model and reasoning effort are applied without duplicating defaults in Pi settings.
- `~/.agents/AGENTS.md` is read into system context for every turn. Skills are discovered from `~/.agents/skills/`.
- `setup.ps1` generates Pi's local `agent/settings.json`, enabling PowerShell and file tools while preserving Pi runtime metadata. Edit this script to change the managed tool selection, then rerun it.
- GitHub stores the source repositories. Pi reads their local checkouts. Synchronize with `jj` before use when remote changes must be reflected. Direct GitHub reads are not configured.

## Plan mode

`setup.ps1` loads the official plan-mode example directly from the installed Pi package, without copying its source. Run `/reload` after setup.

- `/plan` or `Ctrl+Alt+P` toggles planning. `pi --plan` starts in plan mode.
- Ask for a numbered `Plan:`. The extension offers execution approval and tracks progress with `/todos`.
- This is not a sandbox: the sample disables `edit`/`write` and filters Bash, but does not restrict PowerShell or other custom tools. For file-only exploration, start `pi --plan --tools read,grep,find,ls --exclude-tools bash,powershell`.

## Input-ready notification

`setup.ps1` loads the official `notify.ts` example directly from the installed Pi package, without copying or modifying it. Run `/reload` after setup.

- Notifies once the full agent run settles, not during automatic retries or continuations.
- Windows Terminal uses a Windows toast titled `Pi` with `Ready for input`. Enable Windows Settings > System > Notifications and notification sounds; Do not disturb can suppress alerts.
- The unmodified example can emit a Windows PowerShell `Collection was modified` error while composing XML, but still reaches toast submission.
- Mid-run confirmation dialogs are not covered. The official example has no mute command or interactive-mode filter.

## Completion sound candidates

`node tools/sounds.mjs` generates three local WAVs and `validation.json` in `agent/sounds/candidates/`. These generated files are not tracked. Definitions live only in `tools/sounds.mjs`; ZzFX 1.4.0 is pinned to commit `aab7e2b6b9086746b6e55fab75c75ce03e716c49`.

- `tools/vendor/zzfx.mjs` extracts upstream `buildSamples` without browser initialization or synthesis changes. Its MIT license is included.
- The PCM writer uses correct mono block alignment instead of upstream `wav.js`'s fixed value of 4, and rejects invalid or clipping samples.
- Run `./tools/preview-sound.ps1 1`, `2`, or `3` to hear the soft chime, wood-like tone, or retro jingle. Playback is explicit; the existing Pi notification is unchanged until a sound is selected.
- Run `node --test tests/*.test.mjs` to check format, signal bounds, reproducibility, and existing configuration.

## Boundaries

- Project trust is Pi-local in `agent/trust.json`. Unregistered projects do not load project resources; `pi --approve` trusts one invocation.
- Pi runs tools with the current user's operating-system permissions. No sandbox or approval policy is supplied by `.agents/settings.json`.
- `provider`, `model`, `thinkingLevel` and `serviceTier` are the only `.agents/settings.json` keys. `priority` requests the OpenAI priority service tier. The model requires Pi's OpenAI OAuth credential.
- OAuth credentials and session histories stay local. The tracked-file allowlist excludes `auth.json`, sessions, caches, generated settings and downloaded binaries. No GitHub Actions are used.
