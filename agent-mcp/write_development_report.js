const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_LIMIT = 20;
const DEFAULT_OUTPUT = "spawn-agent-diagnostic-report.md";
const MAX_FIELD_LENGTH = 2000;

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function defaultLogDir() {
  return process.env.SPAWN_AGENT_LOG_DIR || path.join(defaultCodexHome(), "spawn-agent-logs");
}

function isPathInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveOutputPath(repoRoot, output = DEFAULT_OUTPUT) {
  const resolvedRepoRoot = path.resolve(repoRoot || path.join(__dirname, ".."));
  const developmentRoot = path.join(resolvedRepoRoot, "development");
  const normalizedOutput = String(output || DEFAULT_OUTPUT);
  let resolvedOutput;

  if (path.isAbsolute(normalizedOutput)) {
    resolvedOutput = path.resolve(normalizedOutput);
  } else {
    const firstSegment = normalizedOutput.split(/[\\/]/)[0];
    resolvedOutput = path.resolve(
      firstSegment === "development" ? resolvedRepoRoot : developmentRoot,
      normalizedOutput,
    );
  }

  if (!resolvedOutput.toLowerCase().endsWith(".md")) {
    throw new Error("output path must end with .md");
  }
  if (!isPathInside(resolvedOutput, developmentRoot)) {
    throw new Error(`output path must stay inside ${developmentRoot}`);
  }
  return resolvedOutput;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function truncateText(text, maxLength = MAX_FIELD_LENGTH) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n... <truncated ${value.length - maxLength} chars>`;
}

function redactSensitiveText(text) {
  return String(text || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED_BEARER]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_SECRET]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[REDACTED_SECRET]")
    .replace(/(api[_-]?key|token|password)\s*[:=]\s*[^,\s)]+/gi, "$1=[REDACTED_SECRET]");
}

function safeField(value) {
  return redactSensitiveText(truncateText(value)).replace(/\r?\n/g, " ");
}

function filterIssues(issues, filters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit || DEFAULT_LIMIT), 1), 100);
  return issues
    .filter((issue) => !filters.runId || issue.run_id === filters.runId)
    .filter((issue) => !filters.status || issue.status === filters.status)
    .filter((issue) => !filters.event || issue.event === filters.event)
    .slice(-limit)
    .reverse();
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || "unknown";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function maxLaunchCount(events) {
  return events
    .filter((event) => event.event === "fallback_launch_recorded")
    .reduce((max, event) => Math.max(max, Number(event.launch_count) || 0), 0);
}

function buildDevelopmentReport(options = {}) {
  const logDir = path.resolve(options.logDir || defaultLogDir());
  const issues = filterIssues(readJsonl(path.join(logDir, "issues.jsonl")), {
    limit: options.limit,
    runId: options.runId,
    status: options.status,
    event: options.event,
  });
  const events = readJsonl(path.join(logDir, "events.jsonl"));
  const launchCount = Number(options.launchCount) || maxLaunchCount(events);
  const eventCounts = countBy(issues, "event");
  const severityCounts = countBy(issues, "severity");

  const lines = [
    "# Spawn Agent Development Report",
    "",
    "## Trigger",
    `- launch_count: ${launchCount}`,
    `- trigger_run_id: ${safeField(options.triggerRunId || "n/a")}`,
    `- source_log_dir: ${safeField(logDir)}`,
    `- filters: limit=${Math.min(Math.max(Number(options.limit || DEFAULT_LIMIT), 1), 100)}, run_id=${safeField(options.runId || "any")}, status=${safeField(options.status || "any")}, event=${safeField(options.event || "any")}`,
    "",
    "## Summary",
    `- total_issues: ${issues.length}`,
    `- total_recorded_launches: ${launchCount}`,
    "",
    "## Event Counts",
  ];

  if (Object.keys(eventCounts).length === 0) {
    lines.push("- none: 0");
  } else {
    for (const [event, count] of Object.entries(eventCounts).sort()) {
      lines.push(`- ${safeField(event)}: ${count}`);
    }
  }

  lines.push("", "## Severity Counts");
  if (Object.keys(severityCounts).length === 0) {
    lines.push("- none: 0");
  } else {
    for (const [severity, count] of Object.entries(severityCounts).sort()) {
      lines.push(`- ${safeField(severity)}: ${count}`);
    }
  }

  lines.push("", "## Recommended Changes");
  if (issues.length === 0) {
    lines.push("- No diagnostic issues were found in the selected window.");
  } else {
    lines.push("- Review repeated event types above and decide whether MCP defaults, agent instructions, timeout policy, or observability fields need to change.");
    lines.push("- For each recurring failure, add or update a regression test before changing MCP behavior.");
    lines.push("- Keep issue records redacted; do not copy full prompts, answers, stdout tails, stderr tails, tokens, or credentials into reports.");
  }

  lines.push("", "## Recent Issues");
  if (issues.length === 0) {
    lines.push("- No recent issues matched the selected filters.");
  } else {
    for (const issue of issues) {
      lines.push(`- ${safeField(issue.ts || "unknown")} ${safeField(issue.issue_id || "issue")} [${safeField(issue.severity || "info")}] ${safeField(issue.title || issue.event || "untitled")}`);
      lines.push(`  - run_id: ${safeField(issue.run_id || "n/a")}; agent_type: ${safeField(issue.agent_type || "n/a")}; status: ${safeField(issue.status || "n/a")}; tool: ${safeField(issue.tool || "n/a")}`);
      if (issue.error) lines.push(`  - error: ${safeField(issue.error)}`);
      if (issue.notes) lines.push(`  - notes: ${safeField(issue.notes)}`);
      if (issue.message_preview) lines.push(`  - message_preview: ${safeField(issue.message_preview)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function writeDevelopmentReport(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, ".."));
  const outputPath = resolveOutputPath(repoRoot, options.output);
  const hasInputMarkdown = typeof options.inputMarkdown === "string" && options.inputMarkdown.trim().length > 0;

  if (options.stdinOnly && !hasInputMarkdown) {
    throw new Error("markdown input is required in stdin-only mode");
  }

  const markdown = hasInputMarkdown
    ? redactSensitiveText(options.inputMarkdown.trim())
    : buildDevelopmentReport(options);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, markdown, "utf8");
  return {
    ok: true,
    report_path: outputPath,
    bytes_written: Buffer.byteLength(markdown, "utf8"),
  };
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
    if (arg === "--repo-root") options.repoRoot = next();
    else if (arg === "--output") options.output = next();
    else if (arg === "--log-dir") options.logDir = next();
    else if (arg === "--limit") options.limit = Number(next());
    else if (arg === "--run-id") options.runId = next();
    else if (arg === "--status") options.status = next();
    else if (arg === "--event") options.event = next();
    else if (arg === "--launch-count") options.launchCount = Number(next());
    else if (arg === "--trigger-run-id") options.triggerRunId = next();
    else if (arg === "--stdin-only") options.stdinOnly = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function helpText() {
  return [
    "Usage: node agent-mcp/write_development_report.js [options]",
    "",
    "Writes a redacted spawn-agent development Markdown report into ./development/.",
    "",
    "Options:",
    "  --output <path>          Output path inside development/. Defaults to spawn-agent-diagnostic-report.md.",
    "  --log-dir <path>         Journal directory. Defaults to SPAWN_AGENT_LOG_DIR or CODEX_HOME/spawn-agent-logs.",
    "  --limit <n>              Issue limit, 1..100. Defaults to 20.",
    "  --run-id <id>            Optional issue run_id filter.",
    "  --status <status>        Optional issue status filter.",
    "  --event <event>          Optional issue event filter.",
    "  --launch-count <n>       Launch count to record in the report.",
    "  --trigger-run-id <id>    Run id that triggered the review.",
    "  --stdin-only             Require Markdown from stdin instead of generating from journal.",
  ].join("\n");
}

function readStdinIfAvailable() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const inputMarkdown = readStdinIfAvailable();
  const result = writeDevelopmentReport({ ...options, inputMarkdown });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  buildDevelopmentReport,
  defaultLogDir,
  filterIssues,
  parseArgs,
  readJsonl,
  redactSensitiveText,
  resolveOutputPath,
  writeDevelopmentReport,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
