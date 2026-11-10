import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.error("OPAL Windows installer packaging must run on Windows.");
  process.exit(1);
}

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(resolve(projectRoot, "package.json"), "utf8")));
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  console.error("Run the Windows packager with npm run release:windows.");
  process.exit(2);
}

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
const environment = { ...process.env, OPAL_BUILD_COMMIT: commit, VITE_OPAL_BUILD_COMMIT: commit };

if (process.env.OPAL_SKIP_VERIFY !== "1") {
  runNpm(["run", "verify"]);
}

const target = "x86_64-pc-windows-msvc";
const createUpdaterArtifacts = Boolean(environment.TAURI_SIGNING_PRIVATE_KEY);
const buildArguments = [
  "run", "tauri", "--", "build", "--target", target, "--bundles", "nsis",
  "--config", "src-tauri/tauri.windows.conf.json",
  "--ci",
];
if (createUpdaterArtifacts) {
  buildArguments.splice(buildArguments.length - 1, 0, "--config", "src-tauri/tauri.updater.conf.json");
} else {
  buildArguments.push("--no-sign");
}
runNpm(buildArguments);

const nsisDirectory = resolve(projectRoot, "src-tauri/target", target, "release/bundle/nsis");
const installer = readdirSync(nsisDirectory)
  .filter((file) => /-setup\.exe$/i.test(file))
  .map((file) => resolve(nsisDirectory, file))
  .sort((left, right) => left.localeCompare(right))[0];

if (!installer) throw new Error(`Tauri did not create an NSIS setup executable in ${nsisDirectory}.`);

const artifactDirectory = resolve(projectRoot, "artifacts/release", packageJson.version, "windows-x64");
mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = resolve(artifactDirectory, `OPAL-${packageJson.version}-windows-x64-setup.exe`);
cpSync(installer, artifactPath);

if (createUpdaterArtifacts) {
  const updaterBundle = readdirSync(nsisDirectory).find((file) => /\.nsis\.zip$/i.test(file));
  if (!updaterBundle) throw new Error(`Tauri did not create an NSIS update bundle in ${nsisDirectory}.`);
  const updaterBundlePath = resolve(nsisDirectory, updaterBundle);
  const updaterSignaturePath = `${updaterBundlePath}.sig`;
  const releaseUpdaterBundle = resolve(artifactDirectory, `OPAL-${packageJson.version}-windows-x64.nsis.zip`);
  if (!readdirSync(nsisDirectory).includes(`${updaterBundle}.sig`)) {
    throw new Error(`The NSIS update bundle signature is missing: ${updaterSignaturePath}`);
  }
  cpSync(updaterBundlePath, releaseUpdaterBundle);
  cpSync(updaterSignaturePath, `${releaseUpdaterBundle}.sig`);

  execFileSync(process.execPath, [
    resolve(projectRoot, "scripts/write-build-manifest.mjs"),
    "--output-dir", artifactDirectory,
    "--artifact", releaseUpdaterBundle,
    "--platform", "windows-updater",
    "--architecture", "x86_64",
    "--target", target,
  ], { cwd: projectRoot, env: environment, stdio: "inherit" });
}

execFileSync(process.execPath, [
  resolve(projectRoot, "scripts/write-build-manifest.mjs"),
  "--output-dir", artifactDirectory,
  "--artifact", artifactPath,
  "--platform", "windows",
  "--architecture", "x86_64",
  "--target", target,
], { cwd: projectRoot, env: environment, stdio: "inherit" });

console.log(`OPAL ${packageJson.version} Windows installer: ${artifactPath}`);
if (createUpdaterArtifacts) console.log("Signed NSIS updater bundle and signature are ready.");

function runNpm(args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: projectRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
