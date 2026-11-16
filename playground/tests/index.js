// `node --test tests/` resolves the directory to this file, which loads every *.test.js in this process.
const fs = require("node:fs");
for (const f of fs.readdirSync(__dirname).sort()) if (f.endsWith(".test.js")) require("./" + f);
