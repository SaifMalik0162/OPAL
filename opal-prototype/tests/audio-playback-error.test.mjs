import test from "node:test";
import assert from "node:assert/strict";
import { playbackErrorMessage } from "../src/audio-playback-error.js";

test("unsupported native WebView codecs identify the format and conversion path", () => {
  const message = playbackErrorMessage({ code: 4, format: "FLAC" });
  assert.match(message, /FLAC/);
  assert.match(message, /WAV, MP3, or AAC M4A/);
});

test("incomplete files and unavailable managed assets have distinct recovery guidance", () => {
  assert.match(playbackErrorMessage({ code: 3, format: "MP3" }), /damaged or incomplete/);
  assert.match(playbackErrorMessage({ code: 2, format: "MP3" }), /managed audio file/);
});

test("audio output rejections are actionable and M4A is named precisely", () => {
  assert.match(playbackErrorMessage({ rejectionName: "NotAllowedError" }), /audio output/);
  assert.match(playbackErrorMessage({ code: 4, format: "M4A" }), /M4A\/AAC/);
});
