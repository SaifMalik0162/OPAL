import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCli = process.env.npm_execpath;
const target = process.argv[2] ?? "macos";

if (!new Set(["macos", "windows"]).has(target)) {
  console.error("Target must be either macos or windows.");
  process.exit(2);
}

if (!npmCli) {
  console.error("Run this builder through npm run tauri:build:development.");
  process.exit(2);
}

const environment = { ...process.env, VITE_OPAL_DEVELOPMENT: "1" };
let buildArguments = ["build", "--debug", "--bundles", "app", "--config", "src-tauri/tauri.dev.conf.json"];

if (target === "windows") {
  if (process.platform === "darwin") {
    const llvmPrefix = execFileSync("brew", ["--prefix", "llvm"], { encoding: "utf8" }).trim();
    const lldPrefix = execFileSync("brew", ["--prefix", "lld"], { encoding: "utf8" }).trim();
    for (const tool of [join(llvmPrefix, "bin", "llvm-rc"), join(lldPrefix, "bin", "lld-link")]) {
      if (!existsSync(tool)) {
        console.error(`Missing Windows cross-build tool: ${tool}`);
        process.exit(2);
      }
    }
    environment.PATH = [join(llvmPrefix, "bin"), join(lldPrefix, "bin"), environment.PATH].filter(Boolean).join(delimiter);
    buildArguments = [
      "build",
      "--debug",
      "--no-bundle",
      "--target",
      "x86_64-pc-windows-msvc",
      "--runner",
      "cargo-xwin",
      "--config",
      "src-tauri/tauri.dev.conf.json",
    ];
  } else {
    buildArguments = ["build", "--debug", "--no-bundle", "--config", "src-tauri/tauri.dev.conf.json"];
  }
}

const child = spawn(process.execPath, [npmCli, "run", "tauri", "--", ...buildArguments], {
  cwd: projectRoot,
  env: environment,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Could not build OPAL Development: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});
