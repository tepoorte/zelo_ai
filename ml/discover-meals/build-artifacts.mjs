import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const script = path.join(root, "ml", "discover-meals", "train_model.py");
const venvPython = path.join(root, "ml", "discover-meals", ".venv", "bin", "python");
const python = fs.existsSync(venvPython) ? venvPython : "python3";
const args = [script, ...process.argv.slice(2)];

const result = spawnSync(python, args, {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
