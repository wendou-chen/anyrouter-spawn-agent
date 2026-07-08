# Spawn Agent Development Report

## Context
- Trigger: user requested three Explorer agents and one docs-researcher to design a mechanism for persisting journal-review findings into the anyrouter-spawn-agent development directory.
- Fallback subagents launched: explorer-server-interface, explorer-script-design, explorer-rules-docs, docs-researcher-interface.
- Launch counts observed in this run: 14, 15, 16, 17. No journal_review_due trigger occurred during this run.

## Findings
- The existing MCP already returns spawn_agent_issue_report Markdown and structured issue data, but it did not provide a repository-local script for writing the main Agent's final review findings into the project.
- The current rules required reporting journal-review findings to the human, but did not require persisting the same findings as Markdown for future MCP development sessions.
- Adding a new MCP write tool would broaden the MCP write surface and require more enabled-tools configuration; the lower-risk first step is a standalone repository script.
- The report must stay redacted. It should not store full prompts, full answers, stdout/stderr tails, tokens, API keys, or credentials.

## Recommended Changes Implemented
- Add agent-mcp/write_development_report.js, a Node script that writes redacted Markdown into development/*.md.
- Add agent-mcp/write_development_report.test.js with coverage for writing reports, path safety, .md enforcement, journal-based generation, redaction, and empty stdin-only rejection.
- Add skills/spawn-agent/scripts/write_development_report.js as the global skill wrapper, so other projects can call the report writer from the user's .codex skill installation.
- Add npm run report:issues as the repository-local no-argument command for journal-generated reports.
- Update README, AGENTS, examples, and spawn-agent skills so future main Agents report findings to the human and then write the same redacted findings into development/.

## Usage
- Main-Agent-authored report from any project root: node "$env:USERPROFILE\.codex\skills\spawn-agent\scripts\write_development_report.js" --stdin-only --output journal-review.md
- Default journal-generated report: npm run report:issues

## Follow-up Risks
- The script is intentionally repo-local and does not add a new MCP tool. If users later need remote MCP-driven writeback, add a tool wrapper with the same path-safety rules.
- The default journal-generated report provides generic recommendations. High-quality fix plans still depend on the main Agent writing a human-reviewed Markdown summary through stdin.
