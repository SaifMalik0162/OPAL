import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureName = process.argv[2];
const environment = { ...process.env, VITE_OPAL_DEVELOPMENT: "1" };

if (fixtureName) {
  if (!/^[a-z0-9-]+$/.test(fixtureName)) {
    console.error("Fixture name must use lowercase letters, numbers, and hyphens.");
    process.exit(2);
  }

  const fixtureManifestPath = resolve(projectRoot, "src-tauri", "target", "opal-fixtures.json");
  if (!existsSync(fixtureManifestPath)) {
    console.error("Fixture libraries are missing. Run npm run fixtures:create first.");
    process.exit(2);
  }
  const fixtureManifest = JSON.parse(readFileSync(fixtureManifestPath, "utf8"));
  const fixturePath = fixtureManifest[fixtureName];
  if (typeof fixturePath !== "string") {
    console.error(`Unknown fixture “${fixtureName}”. Run npm run fixtures:create to list available fixtures.`);
    process.exit(2);
  }
  const fixtureDirectory = resolve(fixturePath);
  if (!existsSync(resolve(fixtureDirectory, "opal.sqlite"))) {
    console.error(`Fixture “${fixtureName}” is missing. Run npm run fixtures:create first.`);
    process.exit(2);
  }
  environment.OPAL_DEV_DATA_DIR = fixtureDirectory;
  console.log(`Launching OPAL Development with the “${fixtureName}” isolated library.`);
} else {
  delete environment.OPAL_DEV_DATA_DIR;
  console.log("Launching OPAL Development with its separate development profile.");
}

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("Run this launcher through npm run tauri:dev so it can locate npm's CLI.");
  process.exit(2);
}

const child = spawn(
  process.execPath,
  [npmCli, "run", "tauri", "--", "dev", "--config", "src-tauri/tauri.dev.conf.json"],
  { cwd: projectRoot, env: environment, stdio: "inherit" },
);

child.on("error", (error) => {
  console.error(`Could not start the OPAL development app: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});
