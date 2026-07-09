# Spawn Agent Tool Exposure Diagnostic

## Summary
- diagnosis: model_tool_injection_missing
- ok: false
- server_has_required_tools: true
- config_has_required_tools: true
- model_has_required_tools: false

## Missing Tools
- missing_model_tools: spawn_agent_start, spawn_agent_status, spawn_agent_result
- missing_server_tools: none
- missing_config_tools: none

## Interpretation
- The MCP server and config expose required observable tools, but the active model-visible tool surface does not. This points to deferred tool loading, session/tool injection, or current-provider gating.

## Recommended Next Step
- If this is a model injection gap, search/load deferred tools for spawn_agent_start/status/result first. If they still do not appear, do not silently downgrade to unobservable shell fallback for long or parallel subagent work.
