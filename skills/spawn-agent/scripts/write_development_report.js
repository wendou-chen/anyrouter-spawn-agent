const reportWriter = require("../../../agent-mcp/write_development_report");

if (require.main === module) {
  try {
    reportWriter.main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
