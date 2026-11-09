import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputArg = process.argv.find((argument) => argument.startsWith("--out="));
const outputRoot = resolve(outputArg?.slice("--out=".length) ?? join(projectRoot, "tests/fixtures/audio-corpus"));
const includeLong = process.argv.includes("--include-long");
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const ffprobe = process.env.FFPROBE ?? "ffprobe";

execFileSync(ffmpeg, ["-version"], { stdio: "ignore" });
execFileSync(ffprobe, ["-version"], { stdio: "ignore" });

const tempRoot = mkdtempSync(join(tmpdir(), "opal-audio-corpus-"));

function writePcmWav(path, { sampleRate, bitDepth, durationSeconds, frequency = 221 }) {
  const channels = 2;
  const frameCount = Math.max(1, Math.round(sampleRate * durationSeconds));
  const bytesPerSample = bitDepth / 8;
  const dataSize = frameCount * channels * bytesPerSample;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  const descriptor = openSync(path, "w");
  try {
    writeFileSync(descriptor, header);
    const blockFrames = 16_384;
    for (let firstFrame = 0; firstFrame < frameCount; firstFrame += blockFrames) {
      const frames = Math.min(blockFrames, frameCount - firstFrame);
      const block = Buffer.alloc(frames * channels * bytesPerSample);
      for (let frame = 0; frame < frames; frame += 1) {
        const index = firstFrame + frame;
        const envelope = 0.58 + (0.28 * Math.sin((index / sampleRate) * Math.PI * 0.42));
        for (let channel = 0; channel < channels; channel += 1) {
          const tone = Math.sin((index / sampleRate) * Math.PI * 2 * (frequency + (channel * 91)));
          const value = Math.round(tone * envelope * ((2 ** (bitDepth - 1)) - 1) * 0.44);
          const offset = ((frame * channels) + channel) * bytesPerSample;
          if (bitDepth === 16) {
            block.writeInt16LE(value, offset);
          } else {
            block.writeIntLE(value, offset, bytesPerSample);
          }
        }
      }
      writeFileSync(descriptor, block);
    }
  } finally {
    closeSync(descriptor);
  }
}

function encode(source, destination, options) {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", source, ...options, destination], { stdio: "inherit" });
}

function inspect(path) {
  try {
    return JSON.parse(execFileSync(ffprobe, [
      "-v", "error",
      "-show_entries", "format=format_name,duration,bit_rate:stream=codec_name,codec_long_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample,bit_rate",
      "-of", "json", path,
    ], { encoding: "utf8" }));
  } catch {
    return null;
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function addEntry(entries, filename, source, expectation = "decode") {
  const path = join(outputRoot, filename);
  const inspected = inspect(path);
  const stream = inspected?.streams?.[0] ?? null;
  const format = inspected?.format ?? null;
  entries.push({
    file: filename,
    sha256: sha256(path),
    expected: expectation,
    ...(source ? { generatedFrom: source } : {}),
    ...(stream ? {
      container: format?.format_name ?? null,
      codec: stream.codec_name ?? null,
      codecDetails: stream.codec_long_name ?? null,
      sampleRateHz: Number(stream.sample_rate) || null,
      channels: Number(stream.channels) || null,
      bitsPerSample: Number(stream.bits_per_raw_sample || stream.bits_per_sample) || null,
      bitrateBps: Number(stream.bit_rate || format?.bit_rate) || null,
      durationSeconds: Number(format?.duration) || null,
    } : {}),
  });
}

try {
  const sources = {
    pcm16: join(tempRoot, "source-44k-16.wav"),
    pcm24: join(tempRoot, "source-96k-24.wav"),
    short: join(tempRoot, "source-short.wav"),
  };
  writePcmWav(sources.pcm16, { sampleRate: 44_100, bitDepth: 16, durationSeconds: 4 });
  writePcmWav(sources.pcm24, { sampleRate: 96_000, bitDepth: 24, durationSeconds: 4 });
  writePcmWav(sources.short, { sampleRate: 48_000, bitDepth: 16, durationSeconds: 0.08, frequency: 880 });

  const wav16 = join(outputRoot, "pcm-16bit-44k1.wav");
  const wav24 = join(outputRoot, "pcm-24bit-48k.wav");
  const wav96 = join(outputRoot, "pcm-24bit-96k.wav");
  const aiff = join(outputRoot, "aiff-24bit-48k.aiff");
  const unicodeM4a = "08 – 星明かりの余韻 – AAC 48 kHz.m4a";
  const entries = [];
  writePcmWav(wav16, { sampleRate: 44_100, bitDepth: 16, durationSeconds: 4 });
  writePcmWav(wav24, { sampleRate: 48_000, bitDepth: 24, durationSeconds: 4 });
  writePcmWav(wav96, { sampleRate: 96_000, bitDepth: 24, durationSeconds: 4 });
  encode(sources.pcm16, join(outputRoot, "mp3-cbr-192k.mp3"), ["-c:a", "libmp3lame", "-b:a", "192k", "-write_xing", "0"]);
  encode(sources.pcm16, join(outputRoot, "mp3-vbr-v4.mp3"), ["-c:a", "libmp3lame", "-q:a", "4"]);
  encode(sources.pcm24, join(outputRoot, "flac-24bit-96k.flac"), ["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24"]);
  encode(sources.pcm24, aiff, ["-ar", "48000", "-c:a", "pcm_s24be", "-f", "aiff"]);
  encode(sources.pcm24, join(outputRoot, unicodeM4a), ["-ar", "48000", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", "-f", "ipod"]);
  encode(sources.short, join(outputRoot, "very-short-80ms.wav"), ["-c:a", "pcm_s16le", "-f", "wav"]);

  for (const [filename, source] of [
    ["pcm-16bit-44k1.wav", "Original synthetic stereo tone"],
    ["pcm-24bit-48k.wav", "Original synthetic stereo tone"],
    ["pcm-24bit-96k.wav", "Original synthetic stereo tone"],
    ["mp3-cbr-192k.mp3", "Original synthetic stereo tone"],
    ["mp3-vbr-v4.mp3", "Original synthetic stereo tone"],
    ["flac-24bit-96k.flac", "Original synthetic stereo tone"],
    ["aiff-24bit-48k.aiff", "Original synthetic stereo tone"],
    [unicodeM4a, "Original synthetic stereo tone"],
    ["very-short-80ms.wav", "Original synthetic 80 ms tone"],
  ]) addEntry(entries, filename, source);

  const emptyPath = join(outputRoot, "invalid-empty.mp3");
  writeFileSync(emptyPath, Buffer.alloc(0));
  addEntry(entries, "invalid-empty.mp3", null, "reject:empty");
  const corruptPath = join(outputRoot, "invalid-corrupt.wav");
  writeFileSync(corruptPath, Buffer.from("OPAL synthetic audio corruption fixture\n", "utf8"));
  addEntry(entries, "invalid-corrupt.wav", null, "reject:corrupt");

  if (includeLong) {
    const longPath = join(outputRoot, "long-60-minute.mp3");
    execFileSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=233:sample_rate=48000:duration=3600",
      "-c:a", "libmp3lame", "-b:a", "32k", longPath,
    ], { stdio: "inherit" });
    addEntry(entries, "long-60-minute.mp3", "Original synthetic 60-minute sine", "decode:long-session");
  }

  writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify({
    title: "OPAL generated audio compatibility corpus",
    source: "Original synthetic test audio generated locally; no commercial recordings.",
    generator: "scripts/generate-audio-corpus.mjs",
    entries,
  }, null, 2)}\n`);
  console.log(`Generated ${entries.length} corpus files in ${outputRoot}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
