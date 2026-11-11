import * as Crypto from 'expo-crypto';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import type { OpalProjectPackageV1, ProjectPackageAsset } from './models';

const stagingDirectory = new Directory(Paths.document, 'OPAL', 'Staging');
const maxArchiveBytes = 0xffff_ffff;
const maxManifestBytes = 8 * 1024 * 1024;
const maxCentralDirectoryBytes = 32 * 1024 * 1024;
const maxEntries = 20_000;
const chunkBytes = 1024 * 1024;
const audioExtension = /^(wav|mp3|flac|aiff|aif|m4a)$/;
const artworkExtension = /^(png|jpg|jpeg|webp)$/;

type CentralEntry = {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  centralOffset: number;
};

export type StagedPackageAsset = {
  asset: ProjectPackageAsset;
  file: File;
};

export type ValidatedProjectPackage = {
  manifest: OpalProjectPackageV1;
  archiveBytes: number;
  assets: StagedPackageAsset[];
};

export async function readAndStageProjectPackage(packageFile: File): Promise<ValidatedProjectPackage> {
  if (packageFile.size === null || packageFile.size < 22 || packageFile.size > maxArchiveBytes) {
    throw new Error('This project package is empty or larger than the supported 4 GB package limit.');
  }
  stagingDirectory.create({ idempotent: true, intermediates: true });
  const input = packageFile.open(FileMode.ReadOnly);
  const stagedAssets: StagedPackageAsset[] = [];
  try {
    const entries = await readCentralDirectory(input, packageFile.size);
    const manifestEntry = entries.get('manifest.json');
    if (!manifestEntry || manifestEntry.uncompressedSize > maxManifestBytes) {
      throw new Error('This file does not contain a supported OPAL project manifest.');
    }
    const manifestBytes = await readEntryBytes(input, manifestEntry, maxManifestBytes);
    const manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
    const manifest = await validateProjectManifest(JSON.parse(manifestText) as unknown);
    const expectedPaths = new Set(['manifest.json', ...manifest.assets.map((asset) => asset.path)]);
    if (entries.size !== expectedPaths.size || [...entries.keys()].some((path) => !expectedPaths.has(path))) {
      throw new Error('This package contains files that are not described by its manifest.');
    }

    const expectedBytes = manifest.assets.reduce((total, asset) => total + asset.sizeBytes, 0);
    if (expectedBytes + 64 * 1024 * 1024 > Paths.availableDiskSpace) {
      throw new Error('There is not enough free space to import this project and verify its assets.');
    }

    for (const asset of manifest.assets) {
      const entry = entries.get(asset.path);
      if (!entry || entry.uncompressedSize !== asset.sizeBytes) {
        throw new Error(`The package is missing a complete copy of ${asset.role} data.`);
      }
      const stagedFile = new File(stagingDirectory, `${Crypto.randomUUID()}.partial`);
      stagedFile.create({ intermediates: true, overwrite: true });
      try {
        await copyEntryToFile(input, entry, stagedFile);
        const digest = await stagedFile.digest('SHA-256');
        if (digest.toLowerCase() !== asset.sha256) {
          throw new Error(`The ${asset.role} file failed its SHA-256 check.`);
        }
        stagedAssets.push({ asset, file: stagedFile });
      } catch (error) {
        if (stagedFile.exists) stagedFile.delete();
        throw error;
      }
    }

    return { manifest, archiveBytes: packageFile.size, assets: stagedAssets };
  } catch (error) {
    for (const staged of stagedAssets) {
      try { if (staged.file.exists) staged.file.delete(); } catch { /* Startup cleanup retries it. */ }
    }
    if (error instanceof SyntaxError) throw new Error('The OPAL project manifest is not valid JSON.');
    throw error;
  } finally {
    input.close();
  }
}

export function cleanupStagedPackage(staged: ValidatedProjectPackage) {
  for (const asset of staged.assets) {
    try { if (asset.file.exists) asset.file.delete(); } catch { /* Startup cleanup retries it. */ }
  }
}

export function extensionForAssetPath(path: string) {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

async function readCentralDirectory(input: ReturnType<File['open']>, fileSize: number) {
  const tailLength = Math.min(fileSize, 65_557);
  input.offset = fileSize - tailLength;
  const tail = await input.readBytes(tailLength);
  let eocdIndex = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (readU32(tail, index) === 0x06054b50 && index + 22 + readU16(tail, index + 20) === tail.length) {
      eocdIndex = index;
      break;
    }
  }
  if (eocdIndex < 0) throw new Error('The project archive directory is missing or damaged.');
  const diskNumber = readU16(tail, eocdIndex + 4);
  const centralDisk = readU16(tail, eocdIndex + 6);
  const diskEntries = readU16(tail, eocdIndex + 8);
  const entryCount = readU16(tail, eocdIndex + 10);
  const centralSize = readU32(tail, eocdIndex + 12);
  const centralOffset = readU32(tail, eocdIndex + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount === 0xffff || entryCount > maxEntries) {
    throw new Error('Multi-part and ZIP64 project archives are not supported.');
  }
  if (centralSize > maxCentralDirectoryBytes || centralOffset + centralSize > fileSize || centralOffset + centralSize > fileSize - tailLength + eocdIndex) {
    throw new Error('The project archive directory exceeds safe limits.');
  }

  input.offset = centralOffset;
  const directory = await input.readBytes(centralSize);
  const entries = new Map<string, CentralEntry>();
  let cursor = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > directory.length || readU32(directory, cursor) !== 0x02014b50) {
      throw new Error('The project archive directory contains a damaged entry.');
    }
    const flags = readU16(directory, cursor + 8);
    const method = readU16(directory, cursor + 10);
    const crc32 = readU32(directory, cursor + 16);
    const compressedSize = readU32(directory, cursor + 20);
    const uncompressedSize = readU32(directory, cursor + 24);
    const nameLength = readU16(directory, cursor + 28);
    const extraLength = readU16(directory, cursor + 30);
    const commentLength = readU16(directory, cursor + 32);
    const startDisk = readU16(directory, cursor + 34);
    const localOffset = readU32(directory, cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > directory.length || startDisk !== 0 || (flags & 0x0009) !== 0 || (flags & ~0x0800) !== 0 || method !== 0 || extraLength !== 0) {
      throw new Error('The project archive uses an unsupported or unsafe ZIP feature.');
    }
    const nameBytes = directory.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    validateArchivePath(name);
    if (compressedSize !== uncompressedSize || localOffset >= centralOffset || entries.has(name)) {
      throw new Error('The project archive contains a duplicate or inconsistent file entry.');
    }
    entries.set(name, { name, method, crc32, compressedSize, uncompressedSize, localOffset, centralOffset });
    cursor = end;
  }
  if (cursor !== directory.length) throw new Error('The project archive directory contains trailing data.');
  const localRanges: { start: number; end: number }[] = [];
  for (const entry of entries.values()) {
    const dataOffset = await getDataOffset(input, entry);
    const dataEnd = dataOffset + entry.compressedSize;
    if (dataEnd > entry.centralOffset) throw new Error('The project archive file overlaps its directory.');
    localRanges.push({ start: entry.localOffset, end: dataEnd });
  }
  localRanges.sort((left, right) => left.start - right.start);
  if (localRanges.some((range, index) => index > 0 && range.start < localRanges[index - 1]!.end)) {
    throw new Error('The project archive contains overlapping files.');
  }
  return entries;
}

async function readEntryBytes(input: ReturnType<File['open']>, entry: CentralEntry, maximumBytes: number) {
  if (entry.uncompressedSize > maximumBytes) throw new Error('A project manifest exceeds the supported size.');
  const parts = await readEntry(input, entry, maximumBytes);
  return parts;
}

async function readEntry(input: ReturnType<File['open']>, entry: CentralEntry, maximumBytes: number) {
  const dataOffset = await getDataOffset(input, entry);
  if (entry.uncompressedSize > maximumBytes) throw new Error('An archive entry exceeds the supported size.');
  input.offset = dataOffset;
  const data = await input.readBytes(entry.uncompressedSize);
  if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc32) {
    throw new Error('The project manifest failed its ZIP integrity check.');
  }
  return data;
}

async function copyEntryToFile(input: ReturnType<File['open']>, entry: CentralEntry, outputFile: File) {
  const dataOffset = await getDataOffset(input, entry);
  input.offset = dataOffset;
  const output = outputFile.open(FileMode.WriteOnly);
  let remaining = entry.compressedSize;
  let crc = 0xffff_ffff;
  try {
    while (remaining > 0) {
      const chunk = await input.readBytes(Math.min(chunkBytes, remaining));
      if (!chunk.length) throw new Error('The project archive ended before an asset was complete.');
      crc = updateCrc32(crc, chunk);
      await output.writeBytes(chunk);
      remaining -= chunk.length;
    }
  } finally {
    output.close();
  }
  if (((crc ^ 0xffff_ffff) >>> 0) !== entry.crc32) {
    throw new Error('An imported file failed its ZIP integrity check.');
  }
}

async function getDataOffset(input: ReturnType<File['open']>, entry: CentralEntry) {
  input.offset = entry.localOffset;
  const header = await input.readBytes(30);
  if (header.length !== 30 || readU32(header, 0) !== 0x04034b50) {
    throw new Error('The project archive contains an invalid file header.');
  }
  const flags = readU16(header, 6);
  const method = readU16(header, 8);
  const crc = readU32(header, 14);
  const compressedSize = readU32(header, 18);
  const uncompressedSize = readU32(header, 22);
  const nameLength = readU16(header, 26);
  const extraLength = readU16(header, 28);
  if ((flags & 0x0009) !== 0 || (flags & ~0x0800) !== 0 || method !== entry.method ||
      crc !== entry.crc32 || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize ||
      nameLength < 1 || nameLength > 1024 || extraLength !== 0) {
    throw new Error('The project archive contains an unsupported file header.');
  }
  const localName = new TextDecoder('utf-8', { fatal: true }).decode(await input.readBytes(nameLength));
  if (localName !== entry.name) throw new Error('The project archive file names do not match its directory.');
  return entry.localOffset + 30 + nameLength + extraLength;
}

async function validateProjectManifest(value: unknown): Promise<OpalProjectPackageV1> {
  if (!isRecord(value) || value.format !== 'opal-project' || value.formatVersion !== 1) {
    throw new Error('This OPAL project package version is not supported by this app.');
  }
  const manifest = value as unknown as OpalProjectPackageV1;
  if (!isRecord(manifest.project) || !isId(manifest.packageId) || !isHexHash(manifest.snapshotId) || manifest.project.id !== manifest.packageId) {
    throw new Error('The OPAL project package has invalid identity information.');
  }
  if (!Number.isSafeInteger(manifest.createdAt) || !isId(manifest.project.id) || !isText(manifest.project.title, 256) ||
      !isText(manifest.project.description, 10_000) || !Array.isArray(manifest.tracks) || manifest.tracks.length > 10_000 ||
      !Array.isArray(manifest.transitions) || manifest.transitions.length > 10_000 ||
      !Array.isArray(manifest.assets) || manifest.assets.length > maxEntries - 1 ||
      !Number.isSafeInteger(manifest.project.createdAt) || manifest.project.createdAt < 0 ||
      !Number.isSafeInteger(manifest.project.updatedAt) || manifest.project.updatedAt < 0 ||
      manifest.createdAt < 0 || !manifest.project.title.trim() ||
      !(manifest.project.artworkAsset === null || typeof manifest.project.artworkAsset === 'string') ||
      !isOptionalNote(manifest.project.note)) {
    throw new Error('The project manifest contains missing or out-of-range information.');
  }

  const assets = new Map<string, ProjectPackageAsset>();
  let totalAssetBytes = 0;
  for (const asset of manifest.assets) {
    if (!isRecord(asset) || !isAssetPath(asset.path, asset.role) || !isHexHash(asset.sha256) ||
        !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0 || !isText(asset.mimeType, 128) || assets.has(asset.path)) {
      throw new Error('The project manifest contains invalid asset metadata.');
    }
    const fileHash = asset.path.split('/').at(-1)?.split('.')[0];
    if (fileHash !== asset.sha256) throw new Error('An asset path does not match its content hash.');
    assets.set(asset.path, asset as ProjectPackageAsset);
    totalAssetBytes += asset.sizeBytes;
  }
  if (totalAssetBytes > maxArchiveBytes) throw new Error('The project contains more audio than a supported package can hold.');

  const groupIds = new Set<string>();
  const currentByGroup = new Map<string, number>();
  const trackIds = new Set<string>();
  const momentIds = new Set<string>();
  for (const track of manifest.tracks) {
    if (!isRecord(track) || !isId(track.id) || !isId(track.groupId) || !isText(track.groupTitle, 256) ||
        !isText(track.title, 256) || !track.title.trim() || !isText(track.sourceTitle, 512) || !Number.isSafeInteger(track.position) || track.position < 0 ||
        !isText(track.versionName, 256) || !Number.isSafeInteger(track.versionPosition) || track.versionPosition < 0 ||
        typeof track.isCurrent !== 'boolean' || !Number.isSafeInteger(track.durationMs) || track.durationMs < 0 ||
        !isText(track.format, 16) || !isHexHash(track.sha256) || !Number.isSafeInteger(track.sizeBytes) || track.sizeBytes < 0 ||
        !isOptionalNote(track.note) || trackIds.has(track.id)) {
      throw new Error('The project manifest contains invalid song or mix information.');
    }
    const asset = assets.get(track.assetPath);
    if (!asset || asset.role !== 'audio' || asset.sha256 !== track.sha256 || asset.sizeBytes !== track.sizeBytes) {
      throw new Error(`The audio for ${track.groupTitle} ${track.versionName} is not verified by the manifest.`);
    }
    if (!audioExtension.test(extensionForAssetPath(track.assetPath))) throw new Error('The project contains an unsupported audio format.');
    trackIds.add(track.id);
    groupIds.add(track.groupId);
    if (track.isCurrent) currentByGroup.set(track.groupId, (currentByGroup.get(track.groupId) ?? 0) + 1);
    if (!Array.isArray(track.moments) || track.moments.length > 100_000) throw new Error('A mix contains too many review moments.');
    for (const moment of track.moments) {
      if (!isRecord(moment) || !isId(moment.id) || momentIds.has(moment.id) || moment.trackId !== track.id ||
          !isId(moment.lineageId) || !Number.isSafeInteger(moment.timeMs) || moment.timeMs < 0 ||
          moment.timeMs > track.durationMs || !['keep', 'change', 'question', 'idea'].includes(moment.state) ||
          !isText(moment.text, 10_000) || typeof moment.isResolved !== 'boolean' ||
          !(moment.parentId === null || isId(moment.parentId)) || !Number.isSafeInteger(moment.createdAt) ||
          !Number.isSafeInteger(moment.updatedAt) || moment.createdAt < 0 || moment.updatedAt < 0) {
        throw new Error('A review moment in this package is incomplete or attached to the wrong mix.');
      }
      momentIds.add(moment.id);
    }
  }
  if ([...currentByGroup.values()].some((count) => count !== 1) || [...groupIds].some((id) => !currentByGroup.has(id))) {
    throw new Error('Every song must have exactly one designated current mix.');
  }
  if (manifest.project.artworkAsset !== null) {
    const artwork = assets.get(manifest.project.artworkAsset);
    if (!artwork || artwork.role !== 'artwork' || !artworkExtension.test(extensionForAssetPath(artwork.path))) {
      throw new Error('The project artwork is missing or uses an unsupported image format.');
    }
  }
  if (assets.size !== manifest.assets.length || manifest.assets.some((asset) =>
    asset.role === 'audio' ? !manifest.tracks.some((track) => track.assetPath === asset.path) : asset.path !== manifest.project.artworkAsset,
  )) {
    throw new Error('The project manifest contains unused assets.');
  }
  for (const transition of manifest.transitions) {
    if (!isRecord(transition) || !isId(transition.id) || transition.projectId !== manifest.project.id ||
        !groupIds.has(transition.fromGroupId) || !groupIds.has(transition.toGroupId) || transition.fromGroupId === transition.toGroupId ||
        !Number.isSafeInteger(transition.gapMs) || transition.gapMs < 0 || transition.gapMs > 600_000 ||
        !isText(transition.note, 10_000) || !Number.isSafeInteger(transition.updatedAt) || transition.updatedAt < 0) {
      throw new Error('The project contains a sequence transition with invalid references.');
    }
  }

  const snapshotPayload = JSON.stringify({
    project: manifest.project,
    tracks: manifest.tracks,
    transitions: manifest.transitions,
    assets: manifest.assets,
  });
  const calculatedSnapshot = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, snapshotPayload);
  if (calculatedSnapshot.toLowerCase() !== manifest.snapshotId) {
    throw new Error('The project manifest snapshot hash does not match its contents.');
  }

  return manifest;
}

function validateArchivePath(path: string) {
  if (path === 'manifest.json') return;
  if (!/^assets\/(audio|artwork)\/[a-f0-9]{64}\.[a-z0-9]{1,8}$/.test(path) || path.includes('..') || path.startsWith('/')) {
    throw new Error('The project archive contains an unsafe file path.');
  }
}

function isAssetPath(path: unknown, role: unknown): path is string {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('..')) return false;
  const prefix = role === 'audio' ? 'assets/audio/' : role === 'artwork' ? 'assets/artwork/' : '';
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return Boolean(prefix) && path.startsWith(prefix) && /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/.test(path.slice(prefix.length)) &&
    (role === 'audio' ? audioExtension : artworkExtension).test(extension);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalNote(value: unknown) {
  if (value === null) return true;
  return isRecord(value) && isId(value.id) && isText(value.text, 10_000) &&
    Number.isSafeInteger(value.updatedAt) && (value.updatedAt as number) >= 0;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isText(value: unknown, maximum: number) {
  return typeof value === 'string' && value.length <= maximum;
}

function isHexHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function updateCrc32(crc: number, bytes: Uint8Array) {
  let value = crc;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return value >>> 0;
}

function crc32(bytes: Uint8Array) {
  return (updateCrc32(0xffff_ffff, bytes) ^ 0xffff_ffff) >>> 0;
}

function readU16(bytes: Uint8Array, offset: number) {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number) {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}
