# Spawn Agent Rules

- Prefer Codex App native Sub Agent tools when they are visible, supported, and verifiable.
- If native Sub Agent tools are unavailable, hidden by provider/API mode, or cannot be verified, use the AnyRouter Spawn Agent MCP fallback.
- For fallback `codex exec` subagents, long tasks, exploration, research, review, multiple agents, or any task where progress/status may matter must use `spawn_agent_start`, record `run_id`, poll with `spawn_agent_status`, and fetch final output with `spawn_agent_result`.
- Use legacy synchronous `spawn_agent` only for short one-shot fixed-response checks.
- Do not call fallback jobs App native Sub Agents. They are detached `codex exec` children and do not appear in the App sidebar.
- Treat `possibly_stalled` as a warning only. A fallback job is complete only when status is `completed`, `failed`, `timed_out`, or `cancelled`.
- Do not present main-thread work as subagent output. Separate completed subagent results, partial subagent results, and main-thread synthesis.
