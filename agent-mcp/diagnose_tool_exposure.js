const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const server = require("./spawn_agent_server");
const reportWriter = require("./write_development_report");

const REQUIRED_OBSERVABLE_TOOLS = [
  "spawn_agent_start",
  "spawn_agent_status",
  "spawn_agent_result",
];

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function defaultLogDir(codexHome = defaultCodexHome()) {
  return process.env.SPAWN_AGENT_LOG_DIR || path.join(codexHome, "spawn-agent-logs");
}

function splitToolList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((tool) => tool.trim())
    .filter(Boolean);
}

function parseSpawnAgentConfig(configText = "") {
  const result = {
    enabled: false,
    enabled_tools: [],
    has_section: false,
  };
  let inSection = false;

  for (const line of configText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "[mcp_servers.spawn_agent]") {
      inSection = true;
      result.has_section = true;
      continue;
    }
    if (trimmed.startsWith("[") && trimmed !== "[mcp_servers.spawn_agent]") {
      inSection = false;
      continue;
    }
    if (!inSection || !trimmed || trimmed.startsWith("#")) continue;

    const enabled = trimmed.match(/^enabled\s*=\s*(true|false)/);
    if (enabled) {
      result.enabled = enabled[1] === "true";
      continue;
    }

    const enabledTools = trimmed.match(/^enabled_tools\s*=\s*\[(.*)\]/);
    if (enabledTools) {
      result.enabled_tools = [...enabledTools[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    }
  }
  return result;
}

async function listServerTools(options = {}) {
  if (options.serverTools) return splitToolList(options.serverTools);
  const response = await server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  return response.result.tools.map((tool) => tool.name);
}

function toolVisible(tool, visibleTools) {
  return visibleTools.includes(tool) || visibleTools.includes(`mcp__spawn_agent__${tool}`);
}

function missingRequired(required, tools) {
  return required.filter((tool) => !tools.includes(tool));
}

function missingVisibleRequired(required, visibleTools) {
  return required.filter((tool) => !toolVisible(tool, visibleTools));
}

function buildDiagnosticMarkdown(result) {
  return [
    "# Spawn Agent Tool Exposure Diagnostic",
    "",
    "## Summary",
    `- diagnosis: ${result.diagnosis}`,
    `- ok: ${result.ok}`,
    `- server_has_required_tools: ${result.server_has_required_tools}`,
    `- config_has_required_tools: ${result.config_has_required_tools}`,
    `- model_has_required_tools: ${result.model_has_required_tools}`,
    "",
    "## Missing Tools",
    `- missing_model_tools: ${result.missing_model_tools.join(", ") || "none"}`,
    `- missing_server_tools: ${result.missing_server_tools.join(", ") || "none"}`,
    `- missing_config_tools: ${result.missing_config_tools.join(", ") || "none"}`,
    "",
    "## Interpretation",
    result.diagnosis === "model_tool_injection_missing"
      ? "- The MCP server and config expose required observable tools, but the active model-visible tool surface does not. This points to deferred tool loading, session/tool injection, or current-provider gating."
      : "- The missing observable tools are explained by server/config/visible-tool state above.",
    "",
    "## Recommended Next Step",
    "- If this is a model injection gap, search/load deferred tools for spawn_agent_start/status/result first. If they still do not appear, do not silently downgrade to unobservable shell fallback for long or parallel subagent work.",
    "",
  ].join("\n");
}

async function recordIssue(result, options = {}) {
  const registry = server.createJobRegistry({ logDir: options.logDir || defaultLogDir(options.codexHome) });
  const response = await server.handleJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "spawn_agent_issue_record",
        arguments: {
          event: "tool_not_exposed_in_model_surface",
          severity: result.diagnosis === "model_tool_injection_missing" ? "warning" : "info",
          title: "Observable spawn_agent MCP tools are not exposed in the active model session",
          tool: "spawn_agent_start",
          status: result.diagnosis,
          notes: [
            `diagnosis=${result.diagnosis}`,
            `missing_model_tools=${result.missing_model_tools.join(",") || "none"}`,
            `missing_server_tools=${result.missing_server_tools.join(",") || "none"}`,
            `missing_config_tools=${result.missing_config_tools.join(",") || "none"}`,
            "server and config expose required observable tools only when both server_has_required_tools and config_has_required_tools are true",
          ].join("; "),
        },
      },
    },
    { registry },
  );
  return response.result.structuredContent;
}

async function diagnoseToolExposure(options = {}) {
  const codexHome = options.codexHome || defaultCodexHome();
  const configPath = options.configPath || path.join(codexHome, "config.toml");
  const configText = options.configText ?? (fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "");
  const config = parseSpawnAgentConfig(configText);
  const serverTools = await listServerTools(options);
  const visibleTools = splitToolList(options.visibleTools);

  const missingServerTools = missingRequired(REQUIRED_OBSERVABLE_TOOLS, serverTools);
  const enabledTools = config.enabled_tools.length ? config.enabled_tools : [];
  const missingConfigTools = config.enabled
    ? missingRequired(REQUIRED_OBSERVABLE_TOOLS, enabledTools)
    : [...REQUIRED_OBSERVABLE_TOOLS];
  const missingModelTools = missingVisibleRequired(REQUIRED_OBSERVABLE_TOOLS, visibleTools);

  const serverHasRequired = missingServerTools.length === 0;
  const configHasRequired = config.enabled && missingConfigTools.length === 0;
  const modelHasRequired = missingModelTools.length === 0;

  let diagnosis = "observable_tools_exposed";
  if (!serverHasRequired) {
    diagnosis = "mcp_server_missing_tools";
  } else if (!configHasRequired) {
    diagnosis = "config_missing_enabled_tools";
  } else if (!modelHasRequired) {
    diagnosis = "model_tool_injection_missing";
  }

  const result = {
    ok: diagnosis === "observable_tools_exposed",
    diagnosis,
    required_tools: [...REQUIRED_OBSERVABLE_TOOLS],
    visible_tools: visibleTools,
    server_tools: serverTools,
    config_enabled: config.enabled,
    config_enabled_tools: config.enabled_tools,
    server_has_required_tools: serverHasRequired,
    config_has_required_tools: configHasRequired,
    model_has_required_tools: modelHasRequired,
    missing_model_tools: missingModelTools,
    missing_server_tools: missingServerTools,
    missing_config_tools: missingConfigTools,
  };

  if (options.writeIssue && diagnosis !== "observable_tools_exposed") {
    result.issue = await recordIssue(result, options);
  }
  if (options.writeReport && diagnosis !== "observable_tools_exposed") {
    const markdown = buildDiagnosticMarkdown(result);
    const written = reportWriter.writeDevelopmentReport({
      repoRoot: options.repoRoot || process.cwd(),
      output: options.output || "tool-exposure-diagnostic-report.md",
      inputMarkdown: markdown,
      stdinOnly: true,
      logDir: options.logDir || defaultLogDir(codexHome),
    });
    result.report_path = written.report_path;
  }

  return result;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--visible-tools") options.visibleTools = next();
    else if (arg === "--server-tools") options.serverTools = next();
    else if (arg === "--config") options.configPath = next();
    else if (arg === "--codex-home") options.codexHome = next();
    else if (arg === "--log-dir") options.logDir = next();
    else if (arg === "--repo-root") options.repoRoot = next();
    else if (arg === "--output") options.output = next();
    else if (arg === "--write-issue") options.writeIssue = true;
    else if (arg === "--write-report") options.writeReport = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const result = await diagnoseToolExposure(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

module.exports = {
  REQUIRED_OBSERVABLE_TOOLS,
  buildDiagnosticMarkdown,
  diagnoseToolExposure,
  missingRequired,
  missingVisibleRequired,
  parseArgs,
  parseSpawnAgentConfig,
  toolVisible,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
