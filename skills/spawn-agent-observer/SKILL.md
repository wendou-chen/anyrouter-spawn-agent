---
name: spawn-agent-observer
description: Use when starting, monitoring, or coordinating long-running or multiple spawn_agent fallback jobs, especially explorer, reviewer, docs_researcher, progress/status checks, stalled/hanging jobs, timeout, cancellation, or partial results.
---

# Spawn Agent Observer

## Overview

Use this skill to coordinate observable `spawn_agent` fallback jobs through MCP tools. These jobs are detached `codex exec` children, not Codex App native Sub Agents, and they do not appear in the App sidebar.

Core rule: if you may need to know whether a fallback subagent is alive later, start it observably and keep a run ledger. Every started job must have a `run_id`, current status, last activity, and final result or cancellation reason before you summarize it.

## When To Use Observable Start

Use `spawn_agent_start` by default when any of these are true:

- The task is exploratory, research-heavy, review-heavy, or likely to run longer than one minute.
- The user asks to launch two or more fallback subagents.
- The user names agents such as `explorer`, `docs_researcher`, or `reviewer` for parallel or background work.
- The user may ask for progress, status, whether a subagent is still running, whether it is stuck, or whether it disconnected.
- A partial answer would be useful if the job times out.

Use legacy synchronous `spawn_agent` only for short one-shot checks where status will not matter, such as asking one agent to return a fixed token.

## Tool Surface

Use these MCP tools when they are available:

| Need | Tool |
| --- | --- |
| Start an observable fallback job | `spawn_agent_start` |
| Check one job | `spawn_agent_status` |
| Fetch final answer | `spawn_agent_result` |
| See active/recent jobs | `spawn_agent_list` |
| Stop a queued/running job | `spawn_agent_cancel` |
| Legacy one-shot answer | `spawn_agent` |

Use `spawn_agent` only for short one-shot tasks. For long exploration, multiple agents, or anything the user may ask about while it runs, use `spawn_agent_start`.

## Workflow

1. Start each subagent with `spawn_agent_start`.
   - Put all required context in `message`; do not rely on inherited context.
   - Record `run_id`, `agent_type`, `status`, `timeout_ms`, and task purpose.
   - Use registered names such as `explorer`, `docs_researcher`, `reviewer`, `conversation-analyzer`, `agent-evaluator`, or `spec-miner`.
2. Poll each active `run_id` with `spawn_agent_status`.
   - Treat `queued` as not started yet.
   - Treat `running` as active; report `pid`, `thread_id` when present, `last_activity_at`, `idle_ms`, and `possibly_stalled`.
   - Treat `possibly_stalled: true` as a warning only. Do not call the job failed until it reaches `failed`, `timed_out`, or `cancelled`.
3. Fetch completed output with `spawn_agent_result`.
   - If `ready:false`, continue polling unless the user asked to stop.
   - If ready, record `status`, `thread_id`, `answer`, `stderr_tail`, and `raw_event_count`.
4. Use `spawn_agent_list` when you lost the ledger or need a quick snapshot of recent jobs in the current MCP server process.
5. Use `spawn_agent_cancel` only when the user asks to stop, the task is obsolete, or the job is clearly stuck and continuing is harmful.

## Status Semantics

| Status | Meaning | Main-agent action |
| --- | --- | --- |
| `queued` | Waiting for a concurrency slot | Keep polling; do not say it started |
| `running` | Child `codex exec` process is active | Monitor activity and tails |
| `completed` | Finished successfully | Fetch and summarize result |
| `failed` | Finished with an error | Report failure source and stderr/error |
| `timed_out` | Hit `timeout_ms` | Report partial output as partial |
| `cancelled` | Cancel was requested | Report cancellation, not task completion |

## Reporting Pattern

When the user asks for status, answer from observed state:

```text
explorer run_000001: running, pid 1234, thread_id pending, last activity 42s ago, not stalled.
docs_researcher run_000002: completed, thread_id ..., result ready.
reviewer run_000003: timed_out, partial answer available.
```

When summarizing final work, separate sources:

- `Completed subagent result`: answer from `spawn_agent_result`.
- `Partial subagent result`: `timed_out` or `failed` with available tails.
- `Main-thread synthesis`: your own conclusion after reading the results.

Do not present main-thread reading as a subagent result.

## Common Mistakes

- Do not say "native SubAgent" or imply App sidebar visibility. This is fallback `codex exec` observability.
- Do not start long or multiple fallback subagents with legacy synchronous `spawn_agent`; then you cannot inspect progress until the call returns.
- Do not lose `run_id`. Without it, use `spawn_agent_list` and say the mapping is inferred.
- Do not wait silently on long jobs. Poll and report meaningful status when asked.
- Do not treat `possibly_stalled` as failure by itself.
- Do not mark fallback success as native App SubAgent success.
