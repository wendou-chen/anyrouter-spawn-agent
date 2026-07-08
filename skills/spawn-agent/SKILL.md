---
name: spawn-agent
description: Use only for short one-shot detached codex exec fallback launcher requests; for long-running, multiple, progress/status, stalled, timeout, or cancellation cases use spawn-agent-observer instead. Never use for Codex app native Sub Agent/sidebar workflows.
---

# Spawn Agent

## Overview

Use this skill only as a fallback launcher for detached child `codex exec` sessions. Do not use it for Codex app native Sub Agent/sidebar workflows, because detached `codex exec` sessions are not attached to the app's parent/subagent UI.

Registered agents:
- `explorer`: read-only path, config, command, and execution-flow exploration.
- `reviewer`: read-only correctness, security, regression, and test-gap review.
- `docs_researcher`: read-only primary-source documentation checking.
- `conversation-analyzer`: read-only conversation-pattern analysis for repeated issues worth solidifying.
- `agent-evaluator`: read-only quality scoring for newly changed skill or agent behavior.
- `spec-miner`: mines requirements and invariants into `.learning/specs/`.

## Workflow

1. Put all necessary context into the child message. Do not rely on inherited context.
2. For long-running, multiple, progress/status, stalled, timeout, or cancellation-sensitive work, stop this workflow and use `spawn-agent-observer`.
3. Run the script with the exact requested `agent_type`.
4. Treat success as: the command exits 0, returns a child `thread_id`, and the answer reflects that agent's constraints.
5. If the command fails, report the stderr summary and do not pretend the agent ran.
6. This legacy path is still a fallback subagent launch. It is recorded in the MCP event journal with `run_id: "legacy/no_run_id"` and counts toward the 20-launch diagnostic review interval.

## Observable MCP Jobs

The MCP bridge also exposes observable fallback jobs for long-running tasks:

For coordinating or monitoring multiple observable jobs, use the `spawn-agent-observer` skill.

- `spawn_agent_start`: start a detached `codex exec` fallback job and return a `run_id` immediately.
- `spawn_agent_status`: check `queued`, `running`, `completed`, `failed`, `timed_out`, or `cancelled` state, including `pid`, `thread_id`, last activity, and output tails.
- `spawn_agent_result`: fetch the final result when ready.
- `spawn_agent_list`: list recent jobs held in the current MCP server process.
- `spawn_agent_cancel`: cancel a queued or running job. On Windows it attempts process-tree cleanup with `taskkill /T /PID` before falling back to direct process kill.
- `spawn_agent_issue_record`: record a redacted fallback MCP issue or follow-up note.
- `spawn_agent_issue_list`: list recent fallback MCP diagnostic issues.
- `spawn_agent_issue_report`: summarize recent fallback MCP diagnostic issues as Markdown.

These observable jobs are still fallback `codex exec` children, not Codex App native Sub Agents, and they do not appear in the App sidebar. Job state is in-memory only and is lost if the MCP server restarts. A running job is marked `possibly_stalled` after five minutes without stdout or stderr activity; this is only a hint, not automatic cancellation.

The diagnostic journal is persistent by default under `$CODEX_HOME/spawn-agent-logs/`. If this fallback path fails, times out, returns partial output, behaves unexpectedly, or reveals a workflow gap, record a short redacted issue through `spawn_agent_issue_record` or switch to `spawn-agent-observer` for coordinated monitoring. Do not store full prompts, full answers, stdout/stderr tails, tokens, or credentials in issue notes.

Every 20 fallback subagent launches, the main Agent should inspect the journal with `spawn_agent_issue_report` and report the issues plus recommended MCP/project fixes to the human.

PowerShell example:

```powershell
@'
Inspect the current Codex custom-agent setup. Do not edit files.
'@ | node 'C:\Users\admin\.codex\skills\spawn-agent\scripts\invoke_spawn_agent.js' --agent-type explorer --timeout-ms 900000
```

Direct message example:

```powershell
node 'C:\Users\admin\.codex\skills\spawn-agent\scripts\invoke_spawn_agent.js' --agent-type reviewer --message 'Review the current staged changes. Do not edit files.'
```

## Notes

- The native `spawn_agent` tool and external MCP tools may not appear in API-key `codex exec` sessions even when MCP `tools/list` succeeds. This skill is the fallback execution path.
- Registered fallback agents must exist in `$CODEX_HOME/config.toml`, and their `config_file` must resolve inside `$CODEX_HOME`.
- Child `codex exec` sessions should inherit the parent workspace cwd so project files stay readable under sandbox policy.
- The default child execution timeout is 15 minutes; use `--timeout-ms` only when a task needs a shorter or longer bound.
- The parent Codex session must be allowed to execute `node`; a read-only parent sandbox can reject the launcher before the child agent starts.
- Keep the agents read-only unless their TOML explicitly says otherwise.
- Do not set `fork_context = true`; put context in the message.
