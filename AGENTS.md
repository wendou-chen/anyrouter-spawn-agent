# Repository Agent Rules

- Prefer Codex App native Sub Agent tools when they are visible, supported, and verifiable.
- Use this repository's MCP fallback only when native Sub Agent tools are unavailable, hidden by API/provider mode, or cannot be verified.
- For fallback `codex exec` subagents, long tasks, exploration, research, review, multiple agents, or any task where progress/status may matter must use `spawn_agent_start`, record `run_id`, poll with `spawn_agent_status`, and fetch final output with `spawn_agent_result`.
- Use legacy synchronous `spawn_agent` only for short one-shot fixed-response checks.
- Do not call fallback jobs App native Sub Agents. They are detached `codex exec` children and do not appear in the App sidebar.
- Treat `possibly_stalled` as a warning only. A fallback job is complete only when status is `completed`, `failed`, `timed_out`, or `cancelled`.
- Do not present main-thread work as subagent output. Separate completed subagent results, partial subagent results, and main-thread synthesis.
- When the fallback MCP misbehaves, times out, returns partial output, exposes a missing capability, or creates a repeated workflow problem, record a redacted diagnostic issue with `spawn_agent_issue_record`.
- Before debugging recurring fallback MCP problems, inspect `spawn_agent_issue_list` or generate `spawn_agent_issue_report`.
- Do not put full prompts, full answers, stdout/stderr tails, tokens, or credentials in diagnostic issue notes.
- Every fallback subagent launch is recorded in the MCP event journal. Track `launch_count` and `journal_review_due` from `spawn_agent_start` responses when present.
- When `journal_review_due: true` appears, call `spawn_agent_issue_report` and tell the human what recurring issues were found and what MCP/project changes are recommended.
- Legacy synchronous `spawn_agent` launches are also recorded as fallback launches with `run_id: "legacy/no_run_id"` and count toward the 20-launch review interval.
