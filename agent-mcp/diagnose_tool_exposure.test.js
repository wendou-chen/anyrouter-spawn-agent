const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const exposure = require("./diagnose_tool_exposure");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function configText(enabledTools) {
  return [
    "[mcp_servers.spawn_agent]",
    "enabled = true",
    `enabled_tools = [${enabledTools.map((tool) => `"${tool}"`).join(", ")}]`,
    "",
  ].join("\n");
}

test("diagnoses model tool injection missing when server and config expose observable tools", async () => {
  const repoRoot = makeTempDir("spawn-agent-diagnose-repo-");
  const logDir = makeTempDir("spawn-agent-diagnose-log-");
  const result = await exposure.diagnoseToolExposure({
    repoRoot,
    logDir,
    configText: configText(exposure.REQUIRED_OBSERVABLE_TOOLS),
    serverTools: [
      "spawn_agent",
      "spawn_agent_start",
      "spawn_agent_status",
      "spawn_agent_result",
      "spawn_agent_list",
      "spawn_agent_cancel",
    ],
    visibleTools: ["shell_command", "apply_patch"],
    writeIssue: true,
    writeReport: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnosis, "model_tool_injection_missing");
  assert.deepEqual(result.missing_model_tools, exposure.REQUIRED_OBSERVABLE_TOOLS);
  assert.equal(result.server_has_required_tools, true);
  assert.equal(result.config_has_required_tools, true);

  const issues = readJsonl(path.join(logDir, "issues.jsonl"));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].event, "tool_not_exposed_in_model_surface");
  assert.match(issues[0].notes, /server and config expose required observable tools/);

  assert.equal(fs.existsSync(result.report_path), true);
  const markdown = fs.readFileSync(result.report_path, "utf8");
  assert.match(markdown, /# Spawn Agent Tool Exposure Diagnostic/);
  assert.match(markdown, /model_tool_injection_missing/);
});

test("accepts prefixed MCP tool names as visible", async () => {
  const result = await exposure.diagnoseToolExposure({
    configText: configText(exposure.REQUIRED_OBSERVABLE_TOOLS),
    serverTools: exposure.REQUIRED_OBSERVABLE_TOOLS,
    visibleTools: [
      "mcp__spawn_agent__spawn_agent_start",
      "mcp__spawn_agent__spawn_agent_status",
      "mcp__spawn_agent__spawn_agent_result",
    ],
    writeIssue: false,
    writeReport: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.diagnosis, "observable_tools_exposed");
  assert.deepEqual(result.missing_model_tools, []);
});

test("distinguishes config allow-list gaps from model injection gaps", async () => {
  const result = await exposure.diagnoseToolExposure({
    configText: configText(["spawn_agent_start"]),
    serverTools: exposure.REQUIRED_OBSERVABLE_TOOLS,
    visibleTools: [],
    writeIssue: false,
    writeReport: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnosis, "config_missing_enabled_tools");
  assert.deepEqual(result.missing_config_tools, ["spawn_agent_status", "spawn_agent_result"]);
});

test("distinguishes MCP server schema gaps from model injection gaps", async () => {
  const result = await exposure.diagnoseToolExposure({
    configText: configText(exposure.REQUIRED_OBSERVABLE_TOOLS),
    serverTools: ["spawn_agent_start"],
    visibleTools: [],
    writeIssue: false,
    writeReport: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnosis, "mcp_server_missing_tools");
  assert.deepEqual(result.missing_server_tools, ["spawn_agent_status", "spawn_agent_result"]);
});
