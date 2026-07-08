const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const report = require("./write_development_report");

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spawn-agent-report-repo-"));
}

function makeLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spawn-agent-report-logs-"));
}

function appendJsonl(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}${os.EOL}`, "utf8");
}

test("writes main-agent markdown into the development directory", () => {
  const repoRoot = makeTempRepo();

  const result = report.writeDevelopmentReport({
    repoRoot,
    output: "journal-review.md",
    inputMarkdown: "# Findings\n\n- Issue: timeout.\n- Suggested fix: narrow the task.",
    logDir: makeLogDir(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.report_path, path.join(repoRoot, "development", "journal-review.md"));
  assert.equal(fs.readFileSync(result.report_path, "utf8"), "# Findings\n\n- Issue: timeout.\n- Suggested fix: narrow the task.");
  assert.equal(result.bytes_written > 0, true);
});

test("rejects output paths outside the development directory", () => {
  const repoRoot = makeTempRepo();

  assert.throws(
    () =>
      report.writeDevelopmentReport({
        repoRoot,
        output: "..\\outside.md",
        inputMarkdown: "# No",
        logDir: makeLogDir(),
      }),
    /output path must stay inside/,
  );
});

test("rejects non-markdown output files", () => {
  const repoRoot = makeTempRepo();

  assert.throws(
    () =>
      report.writeDevelopmentReport({
        repoRoot,
        output: "journal-review.txt",
        inputMarkdown: "# No",
        logDir: makeLogDir(),
      }),
    /output path must end with \.md/,
  );
});

test("generates a redacted development report from issue and launch journals", () => {
  const repoRoot = makeTempRepo();
  const logDir = makeLogDir();
  appendJsonl(path.join(logDir, "events.jsonl"), {
    event: "fallback_launch_recorded",
    launch_count: 20,
    run_id: "run_000020",
    agent_type: "explorer",
  });
  appendJsonl(path.join(logDir, "issues.jsonl"), {
    issue_id: "issue_000001",
    ts: "2026-07-08T00:00:00.000Z",
    event: "job_timed_out",
    severity: "warning",
    title: "Explorer timed out",
    run_id: "run_000020",
    agent_type: "explorer",
    status: "timed_out",
    error: "Bearer abcdef123456 should be redacted",
    notes: "Use sk-1234567890abcdef safely.",
  });

  const result = report.writeDevelopmentReport({
    repoRoot,
    output: "reports/review.md",
    logDir,
    limit: 20,
    launchCount: 20,
    triggerRunId: "run_000020",
  });
  const markdown = fs.readFileSync(result.report_path, "utf8");

  assert.match(markdown, /# Spawn Agent Development Report/);
  assert.match(markdown, /launch_count: 20/);
  assert.match(markdown, /job_timed_out: 1/);
  assert.match(markdown, /Explorer timed out/);
  assert.doesNotMatch(markdown, /abcdef123456/);
  assert.doesNotMatch(markdown, /sk-1234567890abcdef/);
  assert.match(markdown, /\[REDACTED_BEARER\]/);
  assert.match(markdown, /\[REDACTED_SECRET\]/);
});

test("stdin-only mode rejects empty markdown", () => {
  const repoRoot = makeTempRepo();

  assert.throws(
    () =>
      report.writeDevelopmentReport({
        repoRoot,
        output: "empty.md",
        inputMarkdown: "   ",
        stdinOnly: true,
        logDir: makeLogDir(),
      }),
    /markdown input is required/,
  );
});
