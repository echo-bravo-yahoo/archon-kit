// Runs the page's validator over a JSON list of workflows from stdin and prints a JSON list of issue lists.
const { validateWorkflow } = require("../src/validate.js");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => process.stdout.write(JSON.stringify(JSON.parse(input).map((wf) => validateWorkflow(wf)))));
