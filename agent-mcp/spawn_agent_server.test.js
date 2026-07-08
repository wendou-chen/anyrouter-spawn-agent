const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const server = require("./spawn_agent_server");

function makeCodexHome() {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-agent-mcp-"));
  fs.mkdirSync(path.join(codexHome, "agents"));
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    [
      "[agents]",
      "max_threads = 3",
      "",
      "[agents.explorer]",
      'description = "Explore only"',
      'config_file = "agents/explorer.toml"',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(codexHome, "agents", "explorer.toml"),
    [
      'model = "gpt-5.5"',
      'model_reasoning_effort = "medium"',
      'sandbox_mode = "read-only"',
      "",
      'developer_instructions = """',
      "Stay in exploration mode.",
      "Do not edit files.",
      '"""',
      "",
    ].join("\n"),
  );
  return codexHome;
}

test("loads a registered agent definition from CODEX_HOME", () => {
  const codexHome = makeCodexHome();

  const agent = server.loadAgentDefinition("explorer", { codexHome });

  assert.equal(agent.agentType, "explorer");
  assert.equal(agent.model, "gpt-5.5");
  assert.equal(agent.modelReasoningEffort, "medium");
  assert.equal(agent.sandboxMode, "read-only");
  assert.match(agent.developerInstructions, /exploration mode/);
  assert.equal(agent.configFile, path.join(codexHome, "agents", "explorer.toml"));
});

test("lists the spawn_agent MCP tool", async () => {
  const response = await server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });

  assert.equal(response.id, 1);
  const toolNames = response.result.tools.map((tool) => tool.name);
  assert.deepEqual(toolNames, [
    "spawn_agent",
    "spawn_agent_start",
    "spawn_agent_status",
    "spawn_agent_result",
    "spawn_agent_list",
    "spawn_agent_cancel",
  ]);
  assert.deepEqual(response.result.tools[0].inputSchema.required, ["agent_type", "message"]);
});

test("returns empty MCP resources and prompts for discovery calls", async () => {
  const resources = await server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 10,
    method: "resources/list",
  });
  const prompts = await server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 11,
    method: "prompts/list",
  });

  assert.deepEqual(resources.result.resources, []);
  assert.deepEqual(prompts.result.prompts, []);
});


test("tools/call delegates to the injected Codex runner with the loaded agent", async () => {
  const codexHome = makeCodexHome();
  const calls = [];

  const response = await server.handleJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "spawn_agent",
        arguments: {
          agent_type: "explorer",
          message: "Say READY.",
        },
      },
    },
    {
      codexHome,
      runCodexAgent: async (agent, message) => {
        calls.push({ agent, message });
        return {
          agent_type: agent.agentType,
          sandbox_mode: agent.sandboxMode,
          answer: "READY",
        };
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent.agentType, "explorer");
  assert.equal(calls[0].agent.sandboxMode, "read-only");
  assert.equal(calls[0].message, "Say READY.");
  assert.equal(response.result.isError, false);
  assert.match(response.result.content[0].text, /READY/);
});

test("spawn_agent_start returns a run id and exposes running status", async () => {
  const codexHome = makeCodexHome();
  const registry = server.createJobRegistry({ now: () => new Date("2026-07-07T00:00:00.000Z") });
  let resolveRun;

  const startResponse = await server.handleJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "spawn_agent_start",
        arguments: {
          agent_type: "explorer",
          message: "Work slowly.",
          timeout_ms: 900000,
        },
      },
    },
    {
      codexHome,
      registry,
      runCodexAgent: async () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    },
  );

  assert.equal(startResponse.result.isError, false);
  const started = startResponse.result.structuredContent;
  assert.equal(started.status, "queued");
  assert.match(started.run_id, /^run_/);
  assert.equal(started.timeout_ms, 900000);

  await new Promise((resolve) => setImmediate(resolve));

  const statusResponse = await server.handleJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "spawn_agent_status",
        arguments: { run_id: started.run_id },
      },
    },
    { registry },
  );

  assert.equal(statusResponse.result.isError, false);
  assert.equal(statusResponse.result.structuredContent.status, "running");
  assert.equal(statusResponse.result.structuredContent.agent_type, "explorer");
  assert.equal(statusResponse.result.structuredContent.possibly_stalled, false);

  resolveRun({
    agent_type: "explorer",
    ok: true,
    exit_code: 0,
    timed_out: false,
    thread_id: "thread-1",
    answer: "DONE",
    stderr: "",
    raw_event_count: 3,
  });
  await new Promise((resolve) => setImmediate(resolve));
});

test("spawn_agent_result reports not ready before completion and final result after completion", async () => {
  const codexHome = makeCodexHome();
  const registry = server.createJobRegistry();
  let resolveRun;

  const startResponse = await server.handleJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: {
        name: "spawn_agent_start",
        arguments: {
          agent_type: "explorer",
          message: "Return later.",
        },
      },
    },
    {
      codexHome,
      registry,
      runCodexAgent: async () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    },
  );
  const runId = startResponse.result.structuredContent.run_id;
  await new Promise((resolve) => setImmediate(resolve));

  const pendingResponse = await server.handleJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: {
        name: "spawn_agent_result",
        arguments: { run_id: runId },
      },
    },
    { registry },
  );

  assert.equal(pendingResponse.result.isError, false);
  assert.equal(pendingResponse.result.structuredContent.ready, false);
  assert.equal(pendingResponse.result.structuredContent.status, "running");

  resolveRun({
    agent_type: "explorer",
    ok: true,
    exit_code: 0,
    timed_out: false,
    thread_id: "thread-2",
    answer: "FINAL",
    stderr: "",
    raw_event_count: 4,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const finalResponse = await server.handleJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: {
        name: "spawn_agent_result",
        arguments: { run_id: runId },
      },
    },
    { registry },
  );

  assert.equal(finalResponse.result.isError, false);
  assert.equal(finalResponse.result.structuredContent.ready, true);
  assert.equal(finalResponse.result.structuredContent.status, "completed");
  assert.equal(finalResponse.result.structuredContent.thread_id, "thread-2");
  assert.equal(finalResponse.result.structuredContent.answer, "FINAL");
});

test("spawn_agent_status marks a running job as possibly stalled after five minutes idle", async () => {
  const codexHome = makeCodexHome();
  let nowMs = Date.parse("2026-07-07T00:00:00.000Z");
  const registry = server.createJobRegistry({ now: () => new Date(nowMs) });
  let resolveRun;

  const startResponse = await server.handleJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "spawn_agent_start",
        arguments: {
          agent_type: "explorer",
          message: "Stay running.",
        },
      },
    },
    {
      codexHome,
      registry,
      runCodexAgent: async () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  nowMs += 300000;

  const statusResponse = await server.handleJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "spawn_agent_status",
        arguments: { run_id: startResponse.result.structuredContent.run_id },
      },
    },
    { registry },
  );

  assert.equal(statusResponse.result.structuredContent.possibly_stalled, true);
  assert.equal(statusResponse.result.structuredContent.idle_ms, 300000);

  resolveRun({ agent_type: "explorer", ok: true, answer: "DONE" });
  await new Promise((resolve) => setImmediate(resolve));
});

test("spawn_agent_cancel cancels queued jobs and running jobs", async () => {
  const codexHome = makeCodexHome();
  const registry = server.createJobRegistry();
  let resolveFirst;
  let killCalled = false;

  const first = await server.handleJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: {
        name: "spawn_agent_start",
        arguments: {
          agent_type: "explorer",
          message: "Hold slot.",
        },
      },
    },
    {
      codexHome,
      registry,
      runCodexAgent: async (agent, message, options) => {
        options.job.child = { pid: 1234, kill: () => { killCalled = true; } };
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));

  const runningCancel = await server.handleJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: {
        name: "spawn_agent_cancel",
        arguments: { run_id: first.result.structuredContent.run_id },
      },
    },
    {
      registry,
      killProcessTree: () => false,
    },
  );

  assert.equal(runningCancel.result.structuredContent.status, "cancelled");
  assert.equal(killCalled, true);

  resolveFirst({ agent_type: "explorer", ok: false, error: "cancelled" });
  await new Promise((resolve) => setImmediate(resolve));
});

test("killJobProcess uses Windows taskkill before falling back to child.kill", () => {
  const calls = [];
  let childKilled = false;
  const job = {
    pid: 4321,
    child: { kill: () => { childKilled = true; } },
  };

  const result = server.killJobProcess(job, {
    platform: "win32",
    execFileSync: (command, args) => {
      calls.push({ command, args });
      throw new Error("taskkill failed");
    },
  });

  assert.equal(result.method, "child.kill");
  assert.equal(calls[0].command, "taskkill");
  assert.deepEqual(calls[0].args, ["/T", "/F", "/PID", "4321"]);
  assert.equal(childKilled, true);
});

test("builds codex exec args without injecting an incomplete MCP override", () => {
  const invocation = server.buildCodexExecInvocation(
    {
      agentType: "explorer",
      model: "gpt-5.5",
      modelReasoningEffort: "medium",
      sandboxMode: "read-only",
      developerInstructions: "Stay read-only.",
    },
    { cwd: "C:\\Users\\admin" },
  );

  assert.equal(invocation.args.includes("mcp_servers.spawn_agent.enabled=false"), false);
  assert.equal(invocation.args.at(-1), "-");
  assert.equal(invocation.args.includes("--sandbox"), true);
  assert.equal(invocation.args.includes("read-only"), true);
  assert.equal(invocation.args.includes('model_reasoning_effort="medium"'), true);
});
