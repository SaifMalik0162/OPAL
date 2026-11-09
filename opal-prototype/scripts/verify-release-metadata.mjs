import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const tauriConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const cargoToml = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const cargoLock = readFileSync(new URL("../src-tauri/Cargo.lock", import.meta.url), "utf8");

const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const lockedCargoVersion = cargoLock.match(/\[\[package\]\]\r?\nname = "opal"\r?\nversion = "([^"]+)"/)?.[1];
const versions = {
  "package.json": packageJson.version,
  "package-lock.json": packageLock.version,
  "package-lock root package": packageLock.packages?.[""]?.version,
  "Cargo.toml": cargoVersion,
  "Cargo.lock": lockedCargoVersion,
  "Tauri bundle": tauriConfig.version,
};
const mismatches = Object.entries(versions).filter(([, version]) => version !== packageJson.version);

if (packageJson.name !== "opal" || packageLock.name !== "opal" || packageLock.packages?.[""]?.name !== "opal") {
  console.error("OPAL package names must match in package.json and package-lock.json.");
  process.exit(1);
}

if (mismatches.length) {
  console.error(`Version mismatch; expected ${packageJson.version}:`);
  for (const [file, version] of mismatches) console.error(`  ${file}: ${version ?? "missing"}`);
  process.exit(1);
}

console.log(`OPAL ${packageJson.version} metadata is aligned.`);
