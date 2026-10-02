# Pi on Windows

Windows native Pi setup using ChatGPT OAuth. Verified with Pi 1.0.0 and PowerShell 7.

## Setup

1. Install Pi if absent: `npm install --global --ignore-scripts '@earendil-works/pi-coding-agent'`.
2. Clone this private repository into `~/.pi` using `jj`. Existing installations already use this directory.
3. Prepare the shared repositories `~/.codex` and `~/.agents`, then run `./setup.ps1` in PowerShell 7.
4. Start `pi`, use `/login` to select OpenAI and Sign in with ChatGPT, then complete browser login.

## Single source of settings

- `agent/extensions/codex-settings.ts` reads `~/.codex/config.toml` at session startup and before input. Model, reasoning effort, service tier and trusted project paths are not duplicated in Pi configuration.
- `~/.codex/AGENTS.md` is read into system context for each turn. No copy or symbolic link is needed.
- Shared Skills are automatically discovered from `~/.agents/skills/`. Five existing Skills loaded without diagnostics.
- `setup.ps1` generates Pi's local `agent/settings.json`, enabling PowerShell and file tools while preserving Pi runtime metadata. Edit this script to change the managed tool selection, then rerun it.
- GitHub stores the source repositories. Pi reads their local checkouts. Synchronize with `jj` before use when remote changes must be reflected. Direct GitHub reads are not configured.

## Boundaries

- Only root single-line string settings and Codex `[projects]` trust entries are supported. The nearest registered project path determines trust. Unregistered paths do not load Pi project resources.
- Codex permissions must be `never` and `danger-full-access`. Other settings stop input processing because Pi has no equivalent built-in sandbox.
- `fast` maps to the OpenAI request's `priority` service tier. OAuth inference, shared system instructions, project trust and PowerShell 7 execution were verified.
- Codex project configs, profiles, plugins, UI and plan mode are not synchronized. Skills requiring Codex-specific tools need separate compatibility work.
- OAuth credentials and session histories stay local. The tracked-file allowlist excludes `auth.json`, sessions, caches, generated settings and downloaded binaries. No GitHub Actions are used.
