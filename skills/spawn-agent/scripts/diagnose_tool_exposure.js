const diagnosis = require("../../../agent-mcp/diagnose_tool_exposure");

if (require.main === module) {
  diagnosis
    .diagnoseToolExposure(diagnosis.parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
