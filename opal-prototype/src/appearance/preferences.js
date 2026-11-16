export const APPEARANCE_STORAGE_KEY = "opal.appearance.v1";
export const DEFAULT_APPEARANCE = Object.freeze({ version: 1, themeId: "opal", custom: null });

const THEME_IDS = new Set(["opal", "lavender", "deep-plum", "cream", "obsidian", "custom"]);
const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function clampNumber(value, minimum, maximum, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeCustom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.assetId !== "string" || !ASSET_ID_PATTERN.test(value.assetId)) return null;

  return {
    assetId: value.assetId.toLowerCase(),
    suggestedAccent: HEX_COLOR_PATTERN.test(value.suggestedAccent) ? value.suggestedAccent.toUpperCase() : "#C3BBEF",
    accentOverride: HEX_COLOR_PATTERN.test(value.accentOverride) ? value.accentOverride.toUpperCase() : null,
    x: Math.round(clampNumber(value.x, 0, 100, 50)),
    y: Math.round(clampNumber(value.y, 0, 100, 50)),
    dim: clampNumber(value.dim, 0.2, 0.7, 0.4),
    blur: clampNumber(value.blur, 0, 24, 8),
  };
}

export function normalizeAppearance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
    return DEFAULT_APPEARANCE;
  }

  const custom = normalizeCustom(value.custom);
  const themeId = THEME_IDS.has(value.themeId) ? value.themeId : "opal";
  if (themeId === "custom" && !custom) return DEFAULT_APPEARANCE;

  return { version: 1, themeId, custom };
}

export function readAppearancePreference(storage) {
  try {
    const target = storage ?? window.localStorage;
    const raw = target.getItem(APPEARANCE_STORAGE_KEY);
    if (raw === null) return { appearance: DEFAULT_APPEARANCE, canReconcileAssets: true };

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
      return { appearance: DEFAULT_APPEARANCE, canReconcileAssets: false };
    }

    return { appearance: normalizeAppearance(parsed), canReconcileAssets: true };
  } catch {
    return { appearance: DEFAULT_APPEARANCE, canReconcileAssets: false };
  }
}

export function writeAppearancePreference(value, storage) {
  const appearance = normalizeAppearance(value);
  try {
    const target = storage ?? window.localStorage;
    target.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
    return { ok: true, appearance };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export function appearanceHasChanges(draft, applied) {
  return JSON.stringify(normalizeAppearance(draft)) !== JSON.stringify(normalizeAppearance(applied));
}
