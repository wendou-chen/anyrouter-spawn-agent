#!/usr/bin/env node
const path = require("node:path");

const bridge = require(path.join(__dirname, "..", "..", "..", "agent-mcp", "spawn_agent_server.js"));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--agent-type") {
      args.agentType = argv[++i];
    } else if (arg === "--message") {
      args.message = argv[++i];
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[++i]);
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input.trim()));
    if (process.stdin.isTTY) resolve("");
  });
}

function printHelp() {
  console.log(`Usage:
  node invoke_spawn_agent.js --agent-type explorer --message "Task"
  "Task" | node invoke_spawn_agent.js --agent-type conversation-analyzer

Options:
  --agent-type <name>  Any agent registered in CODEX_HOME/config.toml
  --message <text>     Child agent request. If omitted, stdin is used.
  --timeout-ms <ms>    Optional timeout for child Codex execution. Defaults to 15 minutes.
  --json               Print only machine-readable JSON.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.agentType) {
    throw new Error("--agent-type is required");
  }

  const message = args.message || (await readStdin());
  if (!message) {
    throw new Error("--message or stdin is required");
  }

  const agent = bridge.loadAgentDefinition(args.agentType);
  const result = await bridge.runCodexAgent(agent, message, {
    timeoutMs: args.timeoutMs,
    cwd: process.cwd(),
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  console.log(`agent_type: ${result.agent_type}`);
  console.log(`ok: ${result.ok}`);
  if (result.thread_id) console.log(`thread_id: ${result.thread_id}`);
  if (result.exit_code !== undefined) console.log(`exit_code: ${result.exit_code}`);
  if (result.answer) {
    console.log("");
    console.log(result.answer);
  }
  if (result.stderr) {
    console.error(result.stderr);
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
