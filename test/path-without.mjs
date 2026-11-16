import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A PATH like `base` (default: the current one) with the commands in `names` hidden: each directory
// that holds one is replaced by a directory of symlinks to everything else in it. The directories
// are pushed onto `made`, which the caller removes.
export function pathWithout(names, made, base = process.env.PATH || "") {
  const hidden = new Set([].concat(names));
  const dirs = base
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => {
      if (![...hidden].some((n) => fs.existsSync(path.join(dir, n)))) return dir;
      const alt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "path-without-")));
      made.push(alt);
      for (const f of fs.readdirSync(dir)) {
        if (hidden.has(f)) continue;
        try {
          fs.symlinkSync(path.join(dir, f), path.join(alt, f));
        } catch {
          // a name that appears twice in the listing is not worth stopping for
        }
      }
      return alt;
    });
  return dirs.join(path.delimiter);
}
