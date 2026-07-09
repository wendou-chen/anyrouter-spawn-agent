# Spawn Agent Tool Exposure Issue

## Finding
- `spawn_agent_start` is implemented and exposed by the local MCP server when queried directly with JSON-RPC `tools/list`.
- `C:\Users\admin\.codex\config.toml` has `mcp_servers.spawn_agent.enabled = true` and `enabled_tools` includes `spawn_agent_start`, `spawn_agent_status`, `spawn_agent_result`, `spawn_agent_list`, `spawn_agent_cancel`, and issue tools.
- The active Codex model session still does not expose these tools in its callable tool list.

## Interpretation
- This is not evidence that `spawn_agent_start` is undeveloped.
- It is evidence of a tool-injection/session-loading problem: the MCP server and config are ready, but the active conversation did not receive the MCP tools.

## Impact
- The observable fallback technology works only when the model can call the MCP tools or when a wrapper invokes the MCP server directly.
- If the main Agent bypasses MCP and starts `codex exec` through ad hoc shell commands, observability features such as `run_id`, status polling, cancellation, launch counting, every-20 review cadence, and issue journal workflow will not reliably trigger.

## Recommended Fix Direction
- Add a startup diagnostic instruction or helper that checks actual model-visible MCP tools before launching subagents.
- If `spawn_agent_start` is missing from the active model tool list, the main Agent must report: `observable spawn_agent MCP tools are not exposed in this session`.
- Do not silently downgrade to unobservable shell-launched child processes for long or parallel subagent tasks.
- Investigate Codex App MCP reload/tool injection behavior for sessions started before config changes or API/provider modes that hide MCP tools.
