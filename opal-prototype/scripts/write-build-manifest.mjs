import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8"));
const options = parseArgs(process.argv.slice(2));
const artifactPath = resolve(projectRoot, required(options, "artifact"));
const outputDirectory = resolve(projectRoot, required(options, "output-dir"));
const platform = required(options, "platform");
const architecture = required(options, "architecture");
const target = required(options, "target");
const checkedOutCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
const requestedCommit = process.env.OPAL_BUILD_COMMIT?.trim();

if (requestedCommit && requestedCommit !== checkedOutCommit) {
  throw new Error(`Build commit ${requestedCommit} does not match checked-out commit ${checkedOutCommit}.`);
}
if (!/^[0-9a-f]{40}$/i.test(checkedOutCommit)) throw new Error("Could not read a full Git commit for the build manifest.");

mkdirSync(outputDirectory, { recursive: true });
const artifact = {
  file: basename(artifactPath),
  sha256: await sha256(artifactPath),
  sizeBytes: statSync(artifactPath).size,
};
const manifest = {
  product: "OPAL",
  version: packageJson.version,
  commit: checkedOutCommit,
  platform,
  architecture,
  target,
  builtAt: new Date().toISOString(),
  artifacts: [artifact],
};

writeFileSync(resolve(outputDirectory, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(resolve(outputDirectory, "SHA256SUMS"), `${artifact.sha256}  ${artifact.file}\n`);
console.log(`Wrote build manifest and checksum for ${artifact.file}.`);

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function required(parsed, key) {
  if (!parsed[key]) throw new Error(`Missing required option --${key}`);
  return parsed[key];
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}
