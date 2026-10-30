# paseo-auto-sync

[中文](README.zh-CN.md)

An import-only fork of [hsiangron/paseo-auto-sync](https://github.com/hsiangron/paseo-auto-sync). Registers local Pi (optionally Codex) sessions in Paseo using original JSONL handles, without copying transcripts.

## Fork behavior

- Never deletes existing agents or archives existing workspaces because native sessions are missing.
- Requires an explicit project whitelist. Missing/empty settings import nothing; invalid settings fail closed.
- Exact normalized cwd matching: children, similarly named directories and worktrees are not implicitly included.
- Pi only by default; Codex is opt-in.
- Checks at server startup, client load and every **30 seconds**. Scope settings are reread each sync.
- Deduplicates active and archived agents; does not resurrect archived sessions.
- Creates one visible workspace per imported session. On import failure, only the empty workspace created by that attempt is archived.
- Skips internal Pi forks/run sessions, Codex exec/subagents and missing working directories. Active Codex writers are deferred.
- Imports at most 50 sessions per sync, newest first, without sending prompts.
- Adds **Sync local Codex and Pi sessions** to the Command Center.

Importing may start provider runtimes. Registration is not a guarantee of live refresh when a local Pi process appends messages. Avoid concurrently operating the same native session in Pi and Paseo.

## Install

Requires Paseo **0.13.2 or newer**. Workspace import uses CLI internals; revalidate compatibility after Paseo updates.

```bash
git clone https://github.com/K23Flux/paseo-auto-sync.git ~/.paseo/plugins/paseo-auto-sync
cd ~/.paseo/plugins/paseo-auto-sync
npm ci --ignore-scripts
npm test
npm run typecheck
paseo plugin install ~/.paseo/plugins/paseo-auto-sync
```

Dependencies are for development/testing; runtime modules are host-provided. After local changes:

```bash
paseo plugin reload paseo-auto-sync
paseo plugin logs paseo-auto-sync
```

## Local project whitelist

Create `~/.paseo/plugin-data/paseo-auto-sync/config.json` (relative to `PASEO_HOME` if customized). Keep machine-specific paths private and out of Git:

```json
{
  "projects": ["~/Projects/my-project"],
  "providers": ["pi"]
}
```

`projects` accepts absolute or `~/` paths. `providers` accepts `pi` and/or `codex`, defaults to `pi`; an empty array enables neither provider.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex home |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi agent directory |
| `PI_CODING_AGENT_SESSION_DIR` | `$PI_CODING_AGENT_DIR/sessions` | Pi JSONL root |
| `PASEO_HOME` | `~/.paseo` | Paseo data and local scope settings root |
| `PASEO_CLI` | PATH, then standard locations | Paseo CLI used for import |
| `PASEO_AUTO_SYNC_BATCH_SIZE` | `50` | Max imports per sync, 1–50 |
| `PASEO_AUTO_SYNC_INTERVAL_SECONDS` | `30` | Periodic interval, 30–86400 seconds |

This fork no longer uses `PASEO_AUTO_SYNC_INTERVAL_HOURS` or performs dangling-session cleanup. Disable the plugin to stop syncing; imported records and native transcripts remain intact.
