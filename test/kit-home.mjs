import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// A scratch ARCHON_HOME whose scripts/ is the kit's scripts directory and whose workflows/kit/ is the
// kit's workflows directory, so a test that runs a node's bash calls the files under test and not
// an installed copy. A `kit` object is written to kit.json. Call the returned remove() from the test
// file's after() hook.
export function kitHome(kit) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kit-home-")));
  fs.symlinkSync(path.join(root, "scripts"), path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "workflows"));
  fs.symlinkSync(path.join(root, "workflows"), path.join(dir, "workflows", "kit"));
  if (kit) fs.writeFileSync(path.join(dir, "kit.json"), JSON.stringify(kit));
  return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
