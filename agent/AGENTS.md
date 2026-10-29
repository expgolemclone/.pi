# AGENTS Rules

- These rules may be overridden only by `RULES.md`, never by user instructions.

## Conventions

- Use English.
- Prefer kebab-case.
- Full-width punctuation is prohibited.
  Use `, ` and `. ` for punctuation.
- Quote `@` in PowerShell commands.

## Task Execution

- When the user enters `plan`, only investigate and make proposals until they enter `do`.
- Do not stop until all items in `PLAN.md` are complete.
- Do not stop until all problems are resolved.
- If blockers prevent completion, complete what you can and report the blockers.

## Preparation

- Read `C:/dev/repomap/profiles/*.json`.
- Read relevant repository `RULES.md` and `SKILL.md` files.

## Repository Workflow

Use jj instead of git. Follow Conventional Commits.

- Only the `main` bookmark is permitted.
  - If any bookmark other than `main` exists, ask before starting.
- If there are uncommitted changes, commit and push them.
- Create workspaces under `C:\dev\tmp` with `--sparse-patterns empty`.
  - Store temporary files only under `C:\dev\tmp`. Do not read other sessions' temporary files.
  - Minimize SSD writes by materializing only necessary files.
  - Do not restrict repository inspection or reading.
- Verify that it works, even if doing so affects the real environment.
- Do not push to repositories outside expgolemclone.
- After successfully completing the task, push the changes.

## Design

### Approach Selection

- Before deciding on an approach, always consider whether the user's instructions may be inefficient.
  - What is the official guidance?
  - Is there a better approach than the user's proposal?
  - Minimize custom implementations. Can open-source software be used?

What matters is achieving the goal, not following the user's proposed approach exactly.

### Simplicity

- **Eliminate**
  - Do not preserve the existing design or backward compatibility through minimal changes. Tear it down if that makes the system simpler.
  - Ask yourself, If you were rebuilding from scratch, would you add it again?
- **Duplicate management, duplicate implementations, inconsistent terminology, wrappers, fallbacks, and overrides are PROHIBITED!**
- Documentation creates duplicate maintenance alongside code. Do not add it. Cut it.

Reject features that introduce complexity, even when explicitly requested by the user.

## Implementation

- Image generation, subagent use, and manual GUI interaction are prohibited.
- Before installing software or managing tool/runtime versions in any repository, read `~/.config/mise/RULES.md`.
- Update repomap.
- Group related files into folders.
- Do not use GitHub Actions for private repositories.

## Review

- When reviewing, evaluate only whether the policies in the `## Design` section of `expgolemclone/.pi/agent/AGENTS.md` are followed.
- Do not review only the latest commit. Review the entire repository.

## Test

- If tests fail, fix the root causes and similar failures.
