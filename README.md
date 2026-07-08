# AnyRouter Spawn Agent

Observable `spawn_agent` MCP fallback for Codex sessions that use `anyrouter.top` or other API providers where Codex App native Sub Agents are unavailable.

## What This Is

Codex has two different subagent paths:

1. **Codex App native Sub Agent**: preferred when the current Codex runtime exposes native Sub Agent tools and App sidebar integration.
2. **This MCP fallback**: a local MCP server that launches registered agents through detached `codex exec` child processes, then exposes job status through MCP tools.

Use native Sub Agents first. Use this repository when native Sub Agents are hidden or unavailable, for example when a session is routed through `https://anyrouter.top/v1` and the App native Sub Agent tool is not exposed to the model.

This fallback is intentionally honest about its limits:

- It does **not** create App sidebar-visible native Sub Agents.
- It does **not** fake native Sub Agent success.
- It starts real local `codex exec` child processes.
- It can observe queued/running/completed/failed/timed_out/cancelled fallback jobs through MCP.

## Tools

The MCP server exposes:

| Tool | Use |
| --- | --- |
| `spawn_agent` | Legacy synchronous one-shot fallback. Best for short fixed-response checks. |
| `spawn_agent_start` | Start an observable fallback job and return `run_id` immediately. |
| `spawn_agent_status` | Check status, pid, thread id, last activity, output tails, and `possibly_stalled`. |
| `spawn_agent_result` | Fetch final answer and metadata when ready. |
| `spawn_agent_list` | List recent jobs in the current MCP server process. |
| `spawn_agent_cancel` | Cancel queued/running jobs. On Windows it tries `taskkill /T /F /PID` before `child.kill()`. |

`possibly_stalled` becomes true after five minutes without stdout/stderr activity. It is a warning, not automatic failure.

## Repository Layout

```text
agent-mcp/
  spawn_agent_server.js
  spawn_agent_server.test.js
agents/
  explorer.toml
  reviewer.toml
  docs-researcher.toml
  conversation-analyzer.toml
  agent-evaluator.toml
  spec-miner.toml
skills/
  spawn-agent/
  spawn-agent-observer/
examples/
  config.spawn-agent.toml
  AGENTS.spawn-agent.md
```

## Install

Clone the repo:

```powershell
git clone git@github.com:wendou-chen/anyrouter-spawn-agent.git
cd anyrouter-spawn-agent
```

Copy the files into your Codex home:

```powershell
$codexHome = "$env:USERPROFILE\.codex"
New-Item -ItemType Directory -Force -Path "$codexHome\agent-mcp", "$codexHome\agents", "$codexHome\skills" | Out-Null
Copy-Item -Recurse -Force .\agent-mcp\* "$codexHome\agent-mcp\"
Copy-Item -Recurse -Force .\agents\* "$codexHome\agents\"
Copy-Item -Recurse -Force .\skills\spawn-agent "$codexHome\skills\spawn-agent"
Copy-Item -Recurse -Force .\skills\spawn-agent-observer "$codexHome\skills\spawn-agent-observer"
```

Add the snippets from `examples/config.spawn-agent.toml` to `C:\Users\<you>\.codex\config.toml`, adjusting absolute paths if needed.

Add the rules from `examples/AGENTS.spawn-agent.md` to your global `C:\Users\<you>\.codex\AGENTS.md` or to a project-local `AGENTS.md`.

Restart Codex App or reload the session so MCP tools and skills are rediscovered.

## Agent Selection Rule

Use this decision flow:

1. Try Codex App native Sub Agent tools when they are visible and supported.
2. If native Sub Agents are unavailable, hidden by provider/API mode, or cannot be verified, use the MCP fallback tools from this repository.
3. For long-running, exploratory, research, review, or parallel work, use `spawn_agent_start` and keep the returned `run_id`.
4. Use `spawn_agent_status` while the job runs and `spawn_agent_result` when it completes.
5. Use legacy `spawn_agent` only for short one-shot requests where progress does not matter.

## Example

Start an observable explorer job:

```json
{
  "agent_type": "explorer",
  "message": "Inspect the current configuration. Do not edit files.",
  "timeout_ms": 900000
}
```

Then poll:

```json
{ "run_id": "run_000001" }
```

Report status from observed state, for example:

```text
explorer run_000001: running, pid 1234, thread_id pending, last activity 42s ago, not stalled.
docs_researcher run_000002: completed, thread_id 019..., result ready.
```

## Verify

Run the unit tests:

```powershell
node --test .\agent-mcp\spawn_agent_server.test.js
```

Check the server schema directly:

```powershell
$messages = @(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
)
$messages | node .\agent-mcp\spawn_agent_server.js
```

Expected tools:

```text
spawn_agent
spawn_agent_start
spawn_agent_status
spawn_agent_result
spawn_agent_list
spawn_agent_cancel
```

## Notes

- Job state is in-memory only. If the MCP server restarts, historical `run_id` state is lost.
- Child timeouts default to 15 minutes and are capped at 30 minutes.
- Registered agents live in `[agents.*]` entries in `config.toml`; each `config_file` must stay inside `CODEX_HOME`.
- On API-key `codex exec` sessions, external MCP tools may not be available to the child. Put all required context in `message`.
