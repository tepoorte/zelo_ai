import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const venvDir = path.join(root, "ml", "intent-classifier", ".venv");
const python = path.join(venvDir, "bin", "python");
const requirements = path.join(root, "ml", "intent-classifier", "requirements.txt");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!fs.existsSync(python)) {
  run("python3", ["-m", "venv", venvDir]);
}

run(python, ["-m", "pip", "install", "--upgrade", "pip"]);
run(python, ["-m", "pip", "install", "-r", requirements]);
