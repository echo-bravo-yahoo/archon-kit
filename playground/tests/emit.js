// Prints the YAML for a workflow JSON read from stdin: node tests/emit.js < workflow.json
const { toYaml } = require("../src/yaml.js");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => process.stdout.write(toYaml(JSON.parse(input))));
