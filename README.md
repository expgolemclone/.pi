# Pi on Windows

Windows native Pi setup using ChatGPT OAuth. Verified with Pi 1.0.0 and PowerShell 7.

## Setup

1. Install Pi if absent: `npm install --global --ignore-scripts '@earendil-works/pi-coding-agent'`.
2. Clone this private repository into `~/.pi` using `jj`. Existing installations already use this directory.
3. Prepare `~/.agents`, then run `./setup.ps1` in PowerShell 7. No `.codex` directory is required.
4. Start `pi`, use `/login` to select OpenAI and Sign in with ChatGPT, then complete browser login.

## Single source of settings

- `agent/extensions/agents-settings.ts` reads `~/.agents/settings.json` at startup and before input. Model and reasoning effort are applied without duplicating defaults in Pi settings.
- `~/.agents/AGENTS.md` is read into system context for every turn. Skills are discovered from `~/.agents/skills/`.
- `setup.ps1` generates Pi's local `agent/settings.json`, enabling PowerShell and file tools while preserving Pi runtime metadata. Edit this script to change the managed tool selection, then rerun it.
- GitHub stores the source repositories. Pi reads their local checkouts. Synchronize with `jj` before use when remote changes must be reflected. Direct GitHub reads are not configured.

## Boundaries

- Project trust is Pi-local in `agent/trust.json`. Unregistered projects do not load project resources; `pi --approve` trusts one invocation. Existing trusted paths were migrated once from Codex.
- Shared permissions must be `never` and `danger-full-access`. Other settings stop input processing because Pi has no equivalent built-in sandbox.
- `fast` maps to the OpenAI request's `priority` service tier. The model requires Pi's OpenAI OAuth credential.
- Codex project configs, profiles, plugins, UI and plan mode are not synchronized. Skills requiring Codex-specific tools need separate compatibility work.
- OAuth credentials and session histories stay local. The tracked-file allowlist excludes `auth.json`, sessions, caches, generated settings and downloaded binaries. No GitHub Actions are used.
