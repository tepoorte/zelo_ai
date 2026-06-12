import { spawnSync } from "node:child_process";
import process from "node:process";

const steps = [
  {
    label: "Sync production catalog",
    command: "node",
    args: ["./ml/discover-meals/sync-catalog.mjs", "--apply"],
  },
  {
    label: "Retrain discover_meals",
    command: "npm",
    args: ["run", "train:discover-meals", "--", "--full"],
  },
  {
    label: "Discover regression tests",
    command: "npm",
    args: ["run", "test:discover-meals"],
  },
  {
    label: "Discover budget UI audit",
    command: "npm",
    args: ["run", "audit:discover-budget"],
    skipWhen: () => process.env.SKIP_DISCOVER_UI_AUDIT === "1",
  },
  {
    label: "Add-items regression tests",
    command: "npm",
    args: ["run", "test:add-items"],
  },
  {
    label: "Agent formatting tests",
    command: "npm",
    args: ["run", "test:agent-formatting"],
  },
  {
    label: "TypeScript build",
    command: "npm",
    args: ["run", "build"],
  },
];

for (const step of steps) {
  if (step.skipWhen?.()) {
    console.log(`\n== ${step.label}: skipped ==`);
    continue;
  }

  console.log(`\n== ${step.label} ==`);
  const result = spawnSync(step.command, step.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if ((result.status ?? 1) !== 0) {
    console.error(`\n[refresh:discover-meals] failed at step: ${step.label}`);
    process.exit(result.status ?? 1);
  }
}

console.log("\n[refresh:discover-meals] completed successfully.");
