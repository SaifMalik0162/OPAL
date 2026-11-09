import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [outputDirectory, notesPath] = process.argv.slice(2);
if (!outputDirectory || !notesPath) throw new Error("Usage: node scripts/create-update-manifest.mjs <artifact-directory> <release-notes-file>");

const version = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version;
const directory = resolve(outputDirectory);
const notes = await readFile(resolve(notesPath), "utf8");
if (!notes.trim()) throw new Error("Release notes must not be empty.");
const releaseUrl = `https://github.com/SaifMalik0162/OPAL/releases/download/opal-alpha`;
const assets = {
  "darwin-aarch64": `OPAL-${version}-macos-universal.app.tar.gz`,
  "darwin-x86_64": `OPAL-${version}-macos-universal.app.tar.gz`,
  "windows-x86_64": `OPAL-${version}-windows-x64.nsis.zip`,
};
const platforms = {};

for (const [target, file] of Object.entries(assets)) {
  const artifactPath = resolve(directory, file);
  const signaturePath = resolve(directory, `${file}.sig`);
  const artifactInfo = await stat(artifactPath);
  if (!artifactInfo.isFile() || artifactInfo.size === 0) throw new Error(`Updater artifact is missing or empty: ${artifactPath}`);
  const signature = (await readFile(signaturePath, "utf8")).trim();
  if (!signature) throw new Error(`Updater signature is empty: ${signaturePath}`);
  platforms[target] = { url: `${releaseUrl}/${encodeURIComponent(file)}`, signature };
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};
await writeFile(resolve(directory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared OPAL ${version} updater manifest for macOS and Windows.`);
