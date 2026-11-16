import test from "node:test";
import assert from "node:assert/strict";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  appearanceHasChanges,
  normalizeAppearance,
  readAppearancePreference,
  writeAppearancePreference,
} from "./preferences.js";
import {
  THEMES,
  accentForegroundColor,
  accessibleAccentColor,
  contrastRatio,
  customImageScrim,
  customPlayerPalette,
} from "./themes.js";

const VALID_ASSET_ID = "4e9ac589-23d9-4b80-b8c1-02ce42c4c9ee";

function memoryStorage(initial = null) {
  let value = initial;
  return {
    getItem(key) {
      assert.equal(key, APPEARANCE_STORAGE_KEY);
      return value;
    },
    setItem(key, next) {
      assert.equal(key, APPEARANCE_STORAGE_KEY);
      value = next;
    },
    read() { return value; },
  };
}

function compositeCssColor(color, background) {
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (!rgba) return color;
  const base = [1, 3, 5].map((index) => Number.parseInt(background.slice(index, index + 2), 16));
  const alpha = Number(rgba[4]);
  const channels = [1, 2, 3].map((index, channel) => Math.round(Number(rgba[index]) * alpha + base[channel] * (1 - alpha)));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

test("missing preference selects the shipped OPAL theme", () => {
  assert.deepEqual(readAppearancePreference(memoryStorage()), {
    appearance: DEFAULT_APPEARANCE,
    canReconcileAssets: true,
  });
});

test("invalid or unreadable preferences skip managed asset cleanup", () => {
  assert.equal(readAppearancePreference(memoryStorage("not-json")).canReconcileAssets, false);
  assert.equal(readAppearancePreference(memoryStorage(JSON.stringify({ version: 2 }))).canReconcileAssets, false);
  assert.equal(readAppearancePreference({ getItem() { throw new Error("blocked"); } }).canReconcileAssets, false);
});

test("custom preferences clamp values and accept only generated IDs and hex colors", () => {
  const result = normalizeAppearance({
    version: 1,
    themeId: "custom",
    custom: {
      assetId: VALID_ASSET_ID,
      suggestedAccent: "#ef5533",
      accentOverride: "invalid",
      x: 129,
      y: -4,
      dim: 1,
      blur: 40,
    },
  });
  assert.deepEqual(result, {
    version: 1,
    themeId: "custom",
    custom: {
      assetId: VALID_ASSET_ID,
      suggestedAccent: "#EF5533",
      accentOverride: null,
      x: 100,
      y: 0,
      dim: 0.7,
      blur: 24,
    },
  });
  assert.deepEqual(normalizeAppearance({ version: 1, themeId: "custom", custom: { assetId: "../../outside" } }), DEFAULT_APPEARANCE);
});

test("writes a normalized versioned appearance preference", () => {
  const storage = memoryStorage();
  const result = writeAppearancePreference({ version: 1, themeId: "cream", custom: null }, storage);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(storage.read()), { version: 1, themeId: "cream", custom: null });
});

test("storage write failures leave the caller with a recoverable result", () => {
  const result = writeAppearancePreference(DEFAULT_APPEARANCE, { setItem() { throw new Error("quota"); } });
  assert.equal(result.ok, false);
  assert.match(result.error, /quota/);
});

test("appearance comparisons ignore malformed values and detect changed presets", () => {
  assert.equal(appearanceHasChanges(DEFAULT_APPEARANCE, { version: 1, themeId: "unknown", custom: null }), false);
  assert.equal(appearanceHasChanges({ version: 1, themeId: "lavender", custom: null }, DEFAULT_APPEARANCE), true);
});

test("preset text and accent colors meet their foreground contrast targets", () => {
  for (const theme of THEMES) {
    assert.ok(contrastRatio(theme.colors.canvas, theme.colors.text) >= 4.5, `${theme.label} primary text`);
    const muted = compositeCssColor(theme.colors.muted, theme.colors.canvas);
    assert.ok(contrastRatio(theme.colors.canvas, muted) >= 4.5, `${theme.label} muted text`);
    assert.ok(contrastRatio(theme.colors.canvas, theme.colors.accent) >= 3, `${theme.label} accent`);
    assert.ok(contrastRatio(theme.colors.accent, theme.colors.accentForeground) >= 4.5, `${theme.label} accent foreground`);
  }
});

test("custom accents are adjusted for control contrast and receive a readable foreground", () => {
  const surface = "#292734";
  const accent = accessibleAccentColor("#444444", surface);
  assert.ok(contrastRatio(accent, surface) >= 3);
  assert.ok(contrastRatio(accent, accentForegroundColor(accent)) >= 4.5);
});

test("custom photo scrim keeps white text readable at minimum dim", () => {
  const minimumDim = 0.2;
  const scrim = customImageScrim(minimumDim);
  const effectiveDim = 1 - (1 - minimumDim) * (1 - scrim);
  const remainingWhitePixel = `#${Math.round(255 * (1 - effectiveDim)).toString(16).padStart(2, "0").repeat(3)}`;
  assert.ok(contrastRatio("#F2F0F7", remainingWhitePixel) >= 4.5);
  assert.equal(customImageScrim(0.7), 0);
});

test("the custom player adapts its glass and controls while keeping the play glyph readable", () => {
  const pink = customPlayerPalette("#E63B85");
  const green = customPlayerPalette("#39BA85");
  assert.notEqual(pink["--custom-player-glass"], green["--custom-player-glass"]);
  assert.notEqual(pink["--custom-player-center"], green["--custom-player-center"]);
  for (const color of ["#E63B85", "#39BA85", "#010201", "#FFFFFF", null]) {
    const palette = customPlayerPalette(color);
    assert.ok(contrastRatio(palette["--custom-player-highlight"], palette["--custom-player-ink"]) >= 4.5);
  }
});

test("custom photo dimming darkens the preview throughout the slider range", () => {
  const visibleLight = (dim) => (1 - dim) * (1 - customImageScrim(dim));
  assert.ok(visibleLight(0.2) > visibleLight(0.4));
  assert.ok(visibleLight(0.4) > visibleLight(0.7));
});
