const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER_NAME = "codex-local-spawn-agent";
const SERVER_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 900000;
const MAX_TIMEOUT_MS = 1800000;
const DEFAULT_MAX_FALLBACK_THREADS = 10;
const STALLED_THRESHOLD_MS = 300000;
const JOB_TAIL_MAX_LENGTH = 4000;
const DEFAULT_POLL_AFTER_MS = 2000;

let activeCodexAgentRuns = 0;
const queuedCodexAgentRuns = [];

function createJobRegistry(options = {}) {
  return {
    runs: new Map(),
    nextId: 1,
    now: options.now || (() => new Date()),
  };
}

const defaultJobRegistry = createJobRegistry();

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function stripInlineComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === '"' || char === "'") && value[i - 1] !== "\\") {
      quote = quote === char ? null : quote || char;
    }
    if (char === "#" && !quote) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function parseTomlValue(rawValue) {
  const value = stripInlineComment(rawValue);
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return value;
}

function parseFlatToml(text) {
  const result = {};
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) {
      continue;
    }

    const tripleMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*"""(.*)$/);
    if (tripleMatch) {
      const key = tripleMatch[1];
      const first = tripleMatch[2];
      const chunks = [];
      if (first.endsWith('"""')) {
        chunks.push(first.slice(0, -3));
      } else {
        if (first) chunks.push(first);
        i += 1;
        while (i < lines.length && !lines[i].includes('"""')) {
          chunks.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) {
          chunks.push(lines[i].slice(0, lines[i].indexOf('"""')));
        }
      }
      result[key] = chunks.join("\n").trim();
      continue;
    }

    const keyValue = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (keyValue) {
      result[keyValue[1]] = parseTomlValue(keyValue[2]);
    }
  }

  return result;
}

function parseAgentRegistry(configText) {
  const registry = {};
  let currentAgent = null;

  for (const line of configText.split(/\r?\n/)) {
    const trimmed = line.trim();
    const section = trimmed.match(/^\[agents\.([A-Za-z0-9_-]+)\]$/);
    if (section) {
      currentAgent = section[1];
      registry[currentAgent] = {};
      continue;
    }
    if (trimmed.startsWith("[")) {
      currentAgent = null;
      continue;
    }
    if (!currentAgent || !trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const keyValue = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (keyValue) {
      registry[currentAgent][keyValue[1]] = parseTomlValue(keyValue[2]);
    }
  }

  return registry;
}

function parseAgentsSettings(configText) {
  const settings = {};
  let inAgentsSection = false;

  for (const line of configText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "[agents]") {
      inAgentsSection = true;
      continue;
    }
    if (trimmed.startsWith("[")) {
      inAgentsSection = false;
      continue;
    }
    if (!inAgentsSection || !trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const keyValue = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (keyValue) {
      settings[keyValue[1]] = parseTomlValue(keyValue[2]);
    }
  }

  return settings;
}

function normalizeMaxFallbackThreads(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return Math.floor(parsed);
  }
  return DEFAULT_MAX_FALLBACK_THREADS;
}

function isPathInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function loadAgentDefinition(agentType, options = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(agentType || "")) {
    throw new Error(`Invalid agent_type: ${agentType}`);
  }

  const codexHome = path.resolve(options.codexHome || defaultCodexHome());
  const configPath = path.join(codexHome, "config.toml");
  const configText = fs.readFileSync(configPath, "utf8");
  const agentsSettings = parseAgentsSettings(configText);
  const registry = parseAgentRegistry(configText);
  const registration = registry[agentType];

  if (!registration || !registration.config_file) {
    throw new Error(`Agent is not registered in config.toml: ${agentType}`);
  }

  const configFile = path.resolve(codexHome, registration.config_file);
  if (!isPathInside(configFile, codexHome)) {
    throw new Error(`Agent config_file escapes CODEX_HOME: ${registration.config_file}`);
  }

  const agentConfig = parseFlatToml(fs.readFileSync(configFile, "utf8"));
  const sandboxMode = agentConfig.sandbox_mode || "read-only";
  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandboxMode)) {
    throw new Error(`Unsupported sandbox_mode for ${agentType}: ${sandboxMode}`);
  }

  return {
    agentType,
    description: registration.description || "",
    configFile,
    model: agentConfig.model || null,
    modelReasoningEffort: agentConfig.model_reasoning_effort || null,
    sandboxMode,
    developerInstructions: agentConfig.developer_instructions || "",
    maxThreads: normalizeMaxFallbackThreads(agentsSettings.max_threads),
  };
}

function pumpCodexAgentRunQueue() {
  const next = queuedCodexAgentRuns[0];
  if (!next) {
    return;
  }
  if (next.run && next.run.status === "cancelled") {
    queuedCodexAgentRuns.shift();
    next.resolve(null);
    pumpCodexAgentRunQueue();
    return;
  }
  if (activeCodexAgentRuns >= next.maxConcurrent) return;

  queuedCodexAgentRuns.shift();
  activeCodexAgentRuns += 1;
  next.resolve(() => {
    activeCodexAgentRuns = Math.max(0, activeCodexAgentRuns - 1);
    pumpCodexAgentRunQueue();
  });
}

function acquireCodexAgentRunSlot(maxConcurrent, run = null) {
  return new Promise((resolve) => {
    queuedCodexAgentRuns.push({
      maxConcurrent: normalizeMaxFallbackThreads(maxConcurrent),
      run,
      resolve,
    });
    pumpCodexAgentRunQueue();
  });
}

async function runWithCodexAgentRunSlot(maxConcurrent, task) {
  const release = await acquireCodexAgentRunSlot(maxConcurrent);
  try {
    return await task();
  } finally {
    release();
  }
}

function removeQueuedCodexAgentRun(run) {
  const index = queuedCodexAgentRuns.findIndex((entry) => entry.run === run);
  if (index === -1) return false;
  const [entry] = queuedCodexAgentRuns.splice(index, 1);
  entry.resolve(null);
  pumpCodexAgentRunQueue();
  return true;
}

function getRunQueuePosition(run) {
  let position = 0;
  for (const entry of queuedCodexAgentRuns) {
    if (entry.run && entry.run.status !== "cancelled") {
      position += 1;
    }
    if (entry.run === run) return position;
  }
  return 0;
}

function buildChildPrompt(agent, message) {
  return [
    `You are Codex custom agent "${agent.agentType}".`,
    "You were launched as a subagent by the local spawn_agent MCP bridge.",
    "If any local skill says dispatched subagents should skip that skill, follow the skip instruction.",
    "",
    "Developer instructions for this custom agent:",
    agent.developerInstructions || "(none)",
    "",
    `Runtime sandbox_mode: ${agent.sandboxMode}.`,
    "Do not edit files unless this agent's instructions explicitly allow it.",
    "",
    "Parent request:",
    message,
  ].join("\n");
}

function findCodexInvocation() {
  if (process.env.CODEX_CLI_PATH) {
    return { command: process.env.CODEX_CLI_PATH, argsPrefix: [] };
  }

  const npmCodexJs = path.join(
    os.homedir(),
    "AppData",
    "Roaming",
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  if (fs.existsSync(npmCodexJs)) {
    return { command: process.execPath, argsPrefix: [npmCodexJs] };
  }

  return { command: process.platform === "win32" ? "codex.cmd" : "codex", argsPrefix: [] };
}

function extractCodexResult(stdout) {
  const result = {
    thread_id: null,
    answer: "",
    raw_event_count: 0,
  };

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    result.raw_event_count += 1;
    if (event.thread_id && !result.thread_id) {
      result.thread_id = event.thread_id;
    }

    const item = event.item || {};
    if (item.type === "agent_message" && typeof item.text === "string") {
      result.answer = item.text;
    } else if (event.type === "agent_message" && typeof event.text === "string") {
      result.answer = event.text;
    } else if (event.type === "message" && typeof event.message === "string") {
      result.answer = event.message;
    }
  }

  if (!result.answer) {
    result.answer = stdout.trim();
  }

  return result;
}

function truncateText(text, maxLength = 4000) {
  if (!text || text.length <= maxLength) return text || "";
  return `${text.slice(0, maxLength)}\n... <truncated ${text.length - maxLength} chars>`;
}

function normalizeTimeoutMs(timeoutMs) {
  return Math.min(Math.max(Number(timeoutMs || DEFAULT_TIMEOUT_MS), 1000), MAX_TIMEOUT_MS);
}

function nowIso(registry) {
  return registry.now().toISOString();
}

function appendTail(current, text, maxLength = JOB_TAIL_MAX_LENGTH) {
  const next = `${current || ""}${text || ""}`;
  return next.length <= maxLength ? next : next.slice(next.length - maxLength);
}

function createRunId(registry) {
  const id = `run_${String(registry.nextId).padStart(6, "0")}`;
  registry.nextId += 1;
  return id;
}

function createJob(registry, agent, message, options = {}) {
  const timestamp = nowIso(registry);
  return {
    run_id: createRunId(registry),
    agent_type: agent.agentType,
    config_file: agent.configFile,
    sandbox_mode: agent.sandboxMode,
    model: agent.model,
    cwd: options.cwd || process.cwd(),
    message_preview: truncateText(message, 240),
    status: "queued",
    created_at: timestamp,
    queued_at: timestamp,
    started_at: null,
    completed_at: null,
    last_activity_at: timestamp,
    timeout_ms: normalizeTimeoutMs(options.timeoutMs),
    pid: null,
    child: null,
    thread_id: null,
    exit_code: null,
    signal: null,
    timed_out: false,
    raw_event_count: 0,
    stdout_tail: "",
    stderr_tail: "",
    answer: "",
    answer_preview: "",
    error: null,
    result: null,
    completionPromise: null,
  };
}

function msBetween(startIso, endDate) {
  if (!startIso) return null;
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, endDate.getTime() - start);
}

function summarizeJob(job, registry, options = {}) {
  const now = registry.now();
  const idleMs = job.last_activity_at ? msBetween(job.last_activity_at, now) : null;
  const elapsedMs = msBetween(job.started_at || job.created_at, job.completed_at ? new Date(job.completed_at) : now);
  const base = {
    ok: !["failed", "timed_out", "cancelled"].includes(job.status),
    run_id: job.run_id,
    agent_type: job.agent_type,
    status: job.status,
    pid: job.pid,
    cwd: job.cwd,
    created_at: job.created_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    last_activity_at: job.last_activity_at,
    elapsed_ms: elapsedMs,
    idle_ms: idleMs,
    possibly_stalled: job.status === "running" && idleMs !== null && idleMs >= STALLED_THRESHOLD_MS,
    timeout_ms: job.timeout_ms,
    thread_id: job.thread_id,
    exit_code: job.exit_code,
    timed_out: job.timed_out,
    raw_event_count: job.raw_event_count,
    stdout_tail: job.stdout_tail,
    stderr_tail: job.stderr_tail,
    answer_preview: job.answer_preview,
    error: job.error,
  };
  if (options.includeAnswer) {
    base.answer = job.answer;
  }
  return base;
}

function recordJobOutput(job, streamName, text, registry) {
  if (!job || !text) return;
  job.last_activity_at = nowIso(registry);
  if (streamName === "stderr") {
    job.stderr_tail = appendTail(job.stderr_tail, text);
    return;
  }
  job.stdout_tail = appendTail(job.stdout_tail, text);
  job.stdout_line_buffer = `${job.stdout_line_buffer || ""}${text}`;
  let newlineIndex = job.stdout_line_buffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = job.stdout_line_buffer.slice(0, newlineIndex).trim();
    job.stdout_line_buffer = job.stdout_line_buffer.slice(newlineIndex + 1);
    if (line) ingestCodexJsonLine(job, line);
    newlineIndex = job.stdout_line_buffer.indexOf("\n");
  }
}

function ingestCodexJsonLine(job, line) {
  if (!line.startsWith("{")) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  job.raw_event_count += 1;
  if (event.thread_id && !job.thread_id) {
    job.thread_id = event.thread_id;
  }

  const item = event.item || {};
  let answer = "";
  if (item.type === "agent_message" && typeof item.text === "string") {
    answer = item.text;
  } else if (event.type === "agent_message" && typeof event.text === "string") {
    answer = event.text;
  } else if (event.type === "message" && typeof event.message === "string") {
    answer = event.message;
  }
  if (answer) {
    job.answer = answer;
    job.answer_preview = truncateText(answer, 1000);
  }
}

function finalizeJob(job, result, registry) {
  if (!job || job.completed_at) return result;
  job.completed_at = nowIso(registry);
  job.last_activity_at = job.last_activity_at || job.completed_at;
  job.result = result;

  if (job.status === "cancelled") {
    job.error = job.error || "cancelled";
    return result;
  }

  job.exit_code = result.exit_code ?? job.exit_code;
  job.timed_out = Boolean(result.timed_out);
  job.thread_id = result.thread_id || job.thread_id;
  job.raw_event_count = result.raw_event_count ?? job.raw_event_count;
  job.answer = result.answer || job.answer;
  job.answer_preview = truncateText(job.answer || job.answer_preview, 1000);
  job.error = result.error || null;
  if (result.stderr) {
    job.stderr_tail = appendTail(job.stderr_tail, result.stderr);
  }

  if (job.timed_out) {
    job.status = "timed_out";
  } else if (result.ok === false || result.error) {
    job.status = "failed";
  } else {
    job.status = "completed";
  }
  return result;
}

function killJobProcess(job, options = {}) {
  const platform = options.platform || process.platform;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  if (!job || !job.child) return { method: "none" };

  if (platform === "win32" && job.pid) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(job.pid)], { stdio: "ignore" });
      return { method: "taskkill" };
    } catch {
      // Fall through to child.kill for direct-process cleanup when taskkill fails.
    }
  }

  if (typeof job.child.kill === "function") {
    job.child.kill();
    return { method: "child.kill" };
  }
  return { method: "none" };
}

function buildCodexExecInvocation(agent, options = {}) {
  const cwd = options.cwd || os.homedir();
  const codex = findCodexInvocation();
  const args = [
    ...codex.argsPrefix,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    agent.sandboxMode,
    "--cd",
    cwd,
  ];

  if (agent.model) {
    args.push("-m", agent.model);
  }
  if (agent.modelReasoningEffort) {
    args.push("-c", `model_reasoning_effort="${agent.modelReasoningEffort}"`);
  }
  args.push("-");

  return { command: codex.command, args, cwd };
}

function runCodexAgent(agent, message, options = {}) {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const invocation = buildCodexExecInvocation(agent, options);
  const prompt = buildChildPrompt(agent, message);
  const job = options.job || null;
  const registry = options.registry || defaultJobRegistry;

  return new Promise((resolve) => {
    const child = childProcess.spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env, CODEX_SPAWN_AGENT_CHILD: agent.agentType },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (job) {
      job.child = child;
      job.pid = child.pid || null;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (job) job.timed_out = true;
      killJobProcess(job || { child, pid: child.pid });
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      recordJobOutput(job, "stdout", text, registry);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      recordJobOutput(job, "stderr", text, registry);
    });
    child.on("error", (error) => {
      finish({
        agent_type: agent.agentType,
        ok: false,
        error: error.message,
        answer: "",
        stderr: truncateText(stderr),
      });
    });
    child.on("close", (exitCode, signal) => {
      const parsed = extractCodexResult(stdout);
      finish({
        agent_type: agent.agentType,
        ok: exitCode === 0 && !timedOut && !(job && job.status === "cancelled"),
        exit_code: exitCode,
        signal,
        timed_out: timedOut,
        thread_id: parsed.thread_id,
        answer: parsed.answer,
        stderr: truncateText(stderr),
        raw_event_count: parsed.raw_event_count,
      });
    });

    child.stdin.end(prompt);
  });
}

function startTrackedCodexAgent(agent, message, options = {}) {
  const registry = options.registry || defaultJobRegistry;
  const job = createJob(registry, agent, message, {
    cwd: options.cwd || process.cwd(),
    timeoutMs: options.timeoutMs,
  });
  registry.runs.set(job.run_id, job);

  const runner = options.runCodexAgent || runCodexAgent;
  job.completionPromise = (async () => {
    const release = await acquireCodexAgentRunSlot(agent.maxThreads, job);
    if (!release) {
      return job.result;
    }
    if (job.status === "cancelled") {
      release();
      return job.result;
    }

    job.status = "running";
    job.started_at = nowIso(registry);
    job.last_activity_at = job.started_at;

    try {
      const result = await runner(agent, message, {
        timeoutMs: job.timeout_ms,
        cwd: job.cwd,
        job,
        registry,
      });
      return finalizeJob(job, result, registry);
    } catch (error) {
      return finalizeJob(
        job,
        {
          agent_type: agent.agentType,
          ok: false,
          error: error.message,
          answer: "",
        },
        registry,
      );
    } finally {
      release();
    }
  })();

  return job;
}

async function runTrackedCodexAgent(agent, message, options = {}) {
  const job = startTrackedCodexAgent(agent, message, options);
  await job.completionPromise;
  return job.result || {
    agent_type: agent.agentType,
    ok: false,
    error: job.error || "spawn_agent did not produce a result",
    answer: "",
  };
}

function getJobOrError(registry, runId) {
  const job = registry.runs.get(runId);
  if (!job) {
    return {
      error: toolError(`job not found: ${runId}`, {
        code: "job_not_found",
        run_id: runId,
      }),
    };
  }
  return { job };
}

function cancelJob(job, registry, options = {}) {
  if (["completed", "failed", "timed_out", "cancelled"].includes(job.status)) {
    return { cancelled: false, status: job.status, method: "none" };
  }

  job.status = "cancelled";
  job.completed_at = nowIso(registry);
  job.last_activity_at = job.completed_at;
  job.error = "cancelled";
  job.result = {
    agent_type: job.agent_type,
    ok: false,
    error: "cancelled",
    answer: "",
    timed_out: false,
    thread_id: job.thread_id,
  };

  if (removeQueuedCodexAgentRun(job)) {
    return { cancelled: true, status: job.status, method: "queue" };
  }

  const killResult = killJobProcess(job, options);
  return { cancelled: true, status: job.status, method: killResult.method };
}

function toolResult(text, structuredContent = {}, isError = false) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    isError,
  };
}

function toolError(text, structuredContent = {}) {
  return toolResult(text, { ok: false, ...structuredContent }, true);
}

function spawnAgentDescriptor() {
  return {
    name: "spawn_agent",
    description:
      "Run a registered local Codex custom agent in a separate codex exec session. Use explicit agent_type and put all needed context in message.",
    inputSchema: {
      type: "object",
      properties: {
        agent_type: {
          type: "string",
          description: "Agent type registered in CODEX_HOME/config.toml, for example explorer, reviewer, conversation-analyzer, or spec-miner.",
        },
        message: {
          type: "string",
          description: "Complete task/context for the child agent.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: MAX_TIMEOUT_MS,
          description: "Optional child Codex execution timeout. Defaults to 15 minutes.",
        },
      },
      required: ["agent_type", "message"],
      additionalProperties: false,
    },
  };
}

function startDescriptor() {
  return {
    name: "spawn_agent_start",
    description:
      "Start a registered local Codex custom agent as an observable codex exec fallback job and return immediately with a run_id.",
    inputSchema: {
      type: "object",
      properties: {
        agent_type: {
          type: "string",
          description: "Agent type registered in CODEX_HOME/config.toml.",
        },
        message: {
          type: "string",
          description: "Complete task/context for the child agent.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: MAX_TIMEOUT_MS,
          description: "Optional child Codex execution timeout. Defaults to 15 minutes.",
        },
      },
      required: ["agent_type", "message"],
      additionalProperties: false,
    },
  };
}

function runIdDescriptor(name, description) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "Run id returned by spawn_agent_start.",
        },
      },
      required: ["run_id"],
      additionalProperties: false,
    },
  };
}

function listDescriptor() {
  return {
    name: "spawn_agent_list",
    description: "List recent observable spawn_agent fallback jobs in this MCP server process.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Optional status filter: queued, running, completed, failed, timed_out, or cancelled.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum jobs to return. Defaults to 20.",
        },
      },
      additionalProperties: false,
    },
  };
}

function toolDescriptors() {
  return [
    spawnAgentDescriptor(),
    startDescriptor(),
    runIdDescriptor("spawn_agent_status", "Get current status for an observable spawn_agent fallback job."),
    runIdDescriptor("spawn_agent_result", "Get the final result for an observable spawn_agent fallback job."),
    listDescriptor(),
    runIdDescriptor("spawn_agent_cancel", "Cancel a queued or running observable spawn_agent fallback job."),
  ];
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function writeServerLog(entry) {
  if (process.env.SPAWN_AGENT_MCP_LOG === "0") return;
  const logPath = path.join(__dirname, "spawn_agent_server.log");
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(logPath, `${line}${os.EOL}`, "utf8");
}

async function handleJsonRpcMessage(message, options = {}) {
  if (!message || message.jsonrpc !== "2.0") {
    return jsonRpcError(message && message.id, -32600, "Invalid JSON-RPC message");
  }

  if (message.method && message.method.startsWith("notifications/")) {
    return null;
  }

  if (message.method === "initialize") {
    return jsonRpcResult(message.id, {
      protocolVersion: (message.params && message.params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (message.method === "ping") {
    return jsonRpcResult(message.id, {});
  }

  if (message.method === "tools/list") {
    return jsonRpcResult(message.id, { tools: toolDescriptors() });
  }

  if (message.method === "resources/list") {
    return jsonRpcResult(message.id, { resources: [] });
  }

  if (message.method === "resources/templates/list") {
    return jsonRpcResult(message.id, { resourceTemplates: [] });
  }

  if (message.method === "prompts/list") {
    return jsonRpcResult(message.id, { prompts: [] });
  }

  if (message.method === "tools/call") {
    const params = message.params || {};
    const registry = options.registry || defaultJobRegistry;

    try {
      const args = params.arguments || {};
      if (params.name === "spawn_agent") {
        if (typeof args.agent_type !== "string" || typeof args.message !== "string") {
          throw new Error("spawn_agent requires string agent_type and message arguments");
        }
        const agent = loadAgentDefinition(args.agent_type, options);
        const runner = options.runCodexAgent || runCodexAgent;
        const result = await runWithCodexAgentRunSlot(agent.maxThreads, () =>
          runner(agent, args.message, {
            timeoutMs: args.timeout_ms,
            cwd: options.cwd || process.cwd(),
          }),
        );
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return jsonRpcResult(message.id, {
          content: [{ type: "text", text }],
          isError: result && result.ok === false,
        });
      }

      if (params.name === "spawn_agent_start") {
        if (typeof args.agent_type !== "string" || typeof args.message !== "string") {
          throw new Error("spawn_agent_start requires string agent_type and message arguments");
        }
        const agent = loadAgentDefinition(args.agent_type, options);
        const job = startTrackedCodexAgent(agent, args.message, {
          timeoutMs: args.timeout_ms,
          cwd: options.cwd || process.cwd(),
          registry,
          runCodexAgent: options.runCodexAgent,
        });
        const structured = {
          ok: true,
          run_id: job.run_id,
          agent_type: job.agent_type,
          status: job.status,
          queue_position: getRunQueuePosition(job),
          timeout_ms: job.timeout_ms,
          poll_after_ms: DEFAULT_POLL_AFTER_MS,
          fallback_mode: "detached_codex_exec",
        };
        return jsonRpcResult(
          message.id,
          toolResult(`spawn_agent job ${job.run_id} queued for ${job.agent_type}`, structured),
        );
      }

      if (params.name === "spawn_agent_status") {
        if (typeof args.run_id !== "string") throw new Error("spawn_agent_status requires string run_id");
        const found = getJobOrError(registry, args.run_id);
        if (found.error) return jsonRpcResult(message.id, found.error);
        const structured = { ok: true, ...summarizeJob(found.job, registry) };
        return jsonRpcResult(
          message.id,
          toolResult(`spawn_agent job ${found.job.run_id} is ${found.job.status}`, structured),
        );
      }

      if (params.name === "spawn_agent_result") {
        if (typeof args.run_id !== "string") throw new Error("spawn_agent_result requires string run_id");
        const found = getJobOrError(registry, args.run_id);
        if (found.error) return jsonRpcResult(message.id, found.error);
        const ready = ["completed", "failed", "timed_out", "cancelled"].includes(found.job.status);
        const structured = {
          ok: found.job.status === "completed",
          ready,
          ...summarizeJob(found.job, registry, { includeAnswer: ready }),
        };
        return jsonRpcResult(
          message.id,
          toolResult(
            ready
              ? `spawn_agent job ${found.job.run_id} finished with status ${found.job.status}`
              : `spawn_agent job ${found.job.run_id} is not ready`,
            structured,
            false,
          ),
        );
      }

      if (params.name === "spawn_agent_list") {
        const status = typeof args.status === "string" ? args.status : null;
        const limit = Math.min(Math.max(Number(args.limit || 20), 1), 100);
        const jobs = Array.from(registry.runs.values())
          .filter((job) => !status || job.status === status)
          .slice(-limit)
          .reverse()
          .map((job) => summarizeJob(job, registry));
        return jsonRpcResult(
          message.id,
          toolResult(`listed ${jobs.length} spawn_agent jobs`, { ok: true, jobs }),
        );
      }

      if (params.name === "spawn_agent_cancel") {
        if (typeof args.run_id !== "string") throw new Error("spawn_agent_cancel requires string run_id");
        const found = getJobOrError(registry, args.run_id);
        if (found.error) return jsonRpcResult(message.id, found.error);
        const cancellation = cancelJob(found.job, registry, {
          platform: options.platform,
          execFileSync: options.execFileSync,
        });
        return jsonRpcResult(
          message.id,
          toolResult(`spawn_agent job ${found.job.run_id} is ${found.job.status}`, {
            ok: true,
            run_id: found.job.run_id,
            ...cancellation,
          }),
        );
      }

      return jsonRpcError(message.id, -32602, `Unknown tool: ${params.name}`);
    } catch (error) {
      return jsonRpcResult(message.id, {
        content: [{ type: "text", text: error.message }],
        structuredContent: { ok: false, error: error.message },
        isError: true,
      });
    }
  }

  return jsonRpcError(message.id, -32601, `Method not found: ${message.method}`);
}

function startStdioServer() {
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32700, error.message))}\n`);
          newlineIndex = buffer.indexOf("\n");
          continue;
        }
        writeServerLog({
          direction: "in",
          id: message.id,
          method: message.method,
          tool: message.params && message.params.name,
          agent_type:
            message.params &&
            message.params.arguments &&
            message.params.arguments.agent_type,
        });
        handleJsonRpcMessage(message)
          .then((response) => {
            if (response) {
              writeServerLog({
                direction: "out",
                id: response.id,
                is_error:
                  response.result &&
                  Object.prototype.hasOwnProperty.call(response.result, "isError") &&
                  response.result.isError,
                error: response.error && response.error.message,
              });
              process.stdout.write(`${JSON.stringify(response)}\n`);
            }
          })
          .catch((error) => {
            writeServerLog({ direction: "out", id: message.id, error: error.message });
            process.stdout.write(`${JSON.stringify(jsonRpcError(message.id, -32603, error.message))}\n`);
          });
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
}

module.exports = {
  buildChildPrompt,
  buildCodexExecInvocation,
  createJobRegistry,
  extractCodexResult,
  handleJsonRpcMessage,
  killJobProcess,
  loadAgentDefinition,
  parseAgentsSettings,
  parseAgentRegistry,
  parseFlatToml,
  recordJobOutput,
  runCodexAgent,
  runTrackedCodexAgent,
  startTrackedCodexAgent,
  runWithCodexAgentRunSlot,
  startStdioServer,
};

if (require.main === module) {
  startStdioServer();
}
