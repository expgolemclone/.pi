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

## Input-ready notification

`agent/extensions/notify.ts` is auto-discovered. `setup.ps1` removes the old official notifier and generates the adopted three-note wood-like chime. Run `/reload` after setup.

- Notifies once at `agent_settled`, after automatic retries and continuations, only in native Windows interactive mode. Mid-run confirmation dialogs are not covered.
- A Windows toast titled `Pi` says `Ready for input`. Its audio is explicitly silent; only `agent/sounds/ready.wav` plays. Windows' global notification sound settings are unchanged.
- Direct WAV playback is independent of Do not disturb; Windows notification settings can suppress the banner, not the chime. Use system/application volume controls to mute it.
- PowerShell receives a direct UTF-16LE `-EncodedCommand`, not a `.ps1` file. It works with `Restricted` without changing execution policy. XML is loaded directly, avoiding the official example's live DOM collection mutation. Process failures are reported; no fallback sound is used.

## Completion sound

`node tools/sounds.mjs` regenerates `agent/sounds/ready.wav` and `validation.json`. Generated files are not tracked. Parameters live only in `tools/sounds.mjs`; rejected candidates are removed by setup.

- ZzFX 1.4.0 is pinned to commit `aab7e2b6b9086746b6e55fab75c75ce03e716c49`. `tools/vendor/zzfx.mjs` extracts upstream `buildSamples` without browser initialization or synthesis changes. Its MIT license is included.
- The adopted sound ascends through C4, E4, G4 and is 0.448 seconds, mono, 44.1 kHz, 16-bit PCM. Both component amplitudes are doubled (+6.02 dB) for a peak near -6.42 dBFS, without changing timbre or system volume. The writer uses correct mono block alignment instead of upstream `wav.js`'s fixed value of 4 and rejects invalid or clipping samples.
- Run `node tools/preview-sound.mjs` to preview the same toast and chime as Pi, or `node --test tests/*.test.mjs` to verify notification loading, mode filtering, single playback under `Restricted`, WAV validity, reproducibility, and existing configuration.

## Boundaries

- Project trust is Pi-local in `agent/trust.json`. Unregistered projects do not load project resources; `pi --approve` trusts one invocation.
- Pi runs tools with the current user's operating-system permissions. No sandbox or approval policy is supplied by `.agents/settings.json`.
- `provider`, `model`, `thinkingLevel` and `serviceTier` are the only `.agents/settings.json` keys. `priority` requests the OpenAI priority service tier. The model requires Pi's OpenAI OAuth credential.
- OAuth credentials and session histories stay local. The tracked-file allowlist excludes `auth.json`, sessions, caches, generated settings and downloaded binaries. No GitHub Actions are used.
