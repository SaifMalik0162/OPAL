import React, { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, CircleNotch, ImageSquare, Play, SlidersHorizontal, Trash, X } from "@phosphor-icons/react";
import { DialogFrame } from "../DialogFrame.jsx";
import { appearanceHasChanges, DEFAULT_APPEARANCE } from "./preferences.js";
import { waitForImage } from "./image.js";
import { customPlayerPalette, THEMES } from "./themes.js";

const DEFAULT_CUSTOM = Object.freeze({
  assetId: null,
  suggestedAccent: "#C3BBEF",
  accentOverride: null,
  x: 50,
  y: 50,
  dim: 0.4,
  blur: 8,
});

function copyAppearance(value) {
  return {
    ...value,
    custom: value.custom ? { ...value.custom } : null,
  };
}

function customSettings(value) {
  return { ...DEFAULT_CUSTOM, ...(value ?? {}) };
}

function ThemeTile({ label, colors, customAccent, imageUrl, selected, onSelect }) {
  const customPalette = colors ? null : customPlayerPalette(customAccent);
  const previewStyle = {
    "--swatch-background": colors?.background ?? customPalette["--custom-player-solid"],
    "--swatch-player": colors?.glassStrong ?? customPalette["--custom-player-glass"],
    "--swatch-player-tint": colors?.canvas ?? customPalette["--custom-player-center"],
    "--swatch-accent": colors?.accent ?? customPalette["--custom-player-highlight"],
    "--swatch-control-ink": colors?.accentForeground ?? customPalette["--custom-player-ink"],
  };

  return (
    <button
      type="button"
      className={`appearance-theme-tile${selected ? " is-selected" : ""}`}
      style={previewStyle}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="appearance-theme-swatch" aria-hidden="true">
        {imageUrl && <img src={imageUrl} alt="" />}
        <span className="appearance-theme-mini-library"><i /><i /><i /></span>
        <span className="appearance-theme-mini-player">
          <span className="appearance-theme-mini-play"><Play size={6} weight="fill" /></span>
          <span className="appearance-theme-mini-progress" />
        </span>
      </span>
      <span className="appearance-theme-tile-footer">
        <span className="appearance-theme-label">{label}</span>
        {selected && <span className="appearance-theme-check" aria-hidden="true"><Check size={8} weight="bold" /></span>}
      </span>
    </button>
  );
}

function RangeControl({ label, min = 0, max = 100, value, unit, onChange }) {
  return (
    <label className="appearance-range-control">
      <span>{label}<output>{value}{unit}</output></span>
      <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export function AppearanceDialog({
  appliedAppearance = DEFAULT_APPEARANCE,
  backgroundUrl = null,
  assetMissing = false,
  nativeAvailable = isTauri(),
  assetStorageReady = true,
  onPreview,
  onApply,
  onClose,
}) {
  const [draft, setDraft] = useState(() => copyAppearance(appliedAppearance));
  const [draftBackgroundUrl, setDraftBackgroundUrl] = useState(backgroundUrl);
  const [cropOverflow, setCropOverflow] = useState({ x: null, y: null });
  const [operation, setOperation] = useState(null);
  const busy = operation !== null;
  const [error, setError] = useState("");
  const operationRef = useRef(null);
  const ownedAssetsRef = useRef(new Set());
  const mountedRef = useRef(false);
  const importVersionRef = useRef(0);
  const committedRef = useRef(false);
  const hasChanges = useMemo(() => appearanceHasChanges(draft, appliedAppearance), [draft, appliedAppearance]);
  const custom = draft.custom;
  const customImageReady = Boolean(custom?.assetId && draftBackgroundUrl && (!assetMissing || custom.assetId !== appliedAppearance.custom?.assetId));
  const needsCustomImage = draft.themeId === "custom" && !customImageReady;
  const accent = custom?.accentOverride ?? custom?.suggestedAccent ?? DEFAULT_CUSTOM.suggestedAccent;
  const importing = operation === "import";
  const saving = operation === "apply";
  const preparing = nativeAvailable && !assetStorageReady;
  const status = saving ? "Saving theme" : importing ? "Importing background image" : preparing && draft.themeId === "custom" ? "Preparing image storage" : "";

  useEffect(() => {
    setCropOverflow({ x: null, y: null });
    if (!draftBackgroundUrl) {
      return undefined;
    }

    const image = new Image();
    let active = true;
    let listening = false;
    const measure = () => {
      if (!image.naturalWidth || !image.naturalHeight) return;
      const width = window.innerWidth;
      const height = window.innerHeight;
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      setCropOverflow({
        x: image.naturalWidth * scale > width + 1,
        y: image.naturalHeight * scale > height + 1,
      });
    };

    image.src = draftBackgroundUrl;
    image.decode().then(() => {
      if (!active) return;
      measure();
      window.addEventListener("resize", measure);
      listening = true;
    }).catch(() => { if (active) setCropOverflow({ x: null, y: null }); });

    return () => {
      active = false;
      if (listening) window.removeEventListener("resize", measure);
    };
  }, [draftBackgroundUrl]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      importVersionRef.current += 1;
      if (!committedRef.current) {
        for (const assetId of ownedAssetsRef.current) {
          void invoke("removeAppearanceBackground", { assetId }).catch(() => {});
        }
      }
    };
  }, []);

  useEffect(() => {
    const appliedAssetId = appliedAppearance.custom?.assetId;
    if (backgroundUrl && appliedAssetId === draft.custom?.assetId && !ownedAssetsRef.current.has(appliedAssetId)) {
      setDraftBackgroundUrl(backgroundUrl);
    }
  }, [appliedAppearance.custom?.assetId, backgroundUrl, draft.custom?.assetId]);

  function preview(next, imageUrl = draftBackgroundUrl) {
    setDraft(next);
    setError("");
    onPreview(next, imageUrl);
  }

  function selectTheme(themeId) {
    if (operationRef.current) return;
    const next = {
      ...draft,
      themeId,
      custom: themeId === "custom" ? customSettings(draft.custom) : draft.custom,
    };
    preview(next);
  }

  function updateCustom(name, value) {
    if (operationRef.current) return;
    const next = {
      ...draft,
      custom: { ...customSettings(draft.custom), [name]: value },
    };
    preview(next);
  }

  async function chooseImage() {
    if (!nativeAvailable || !assetStorageReady || operationRef.current) return;
    const requestVersion = ++importVersionRef.current;
    operationRef.current = "import";
    setOperation("picker");
    setError("");
    try {
      const choice = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Background image", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (typeof choice !== "string" || !mountedRef.current || requestVersion !== importVersionRef.current) return;

      setOperation("import");
      const imported = await invoke("importAppearanceBackground", { sourcePath: choice });
      const imageUrl = convertFileSrc(imported.path);
      try {
        await waitForImage(imageUrl);
      } catch {
        await invoke("removeAppearanceBackground", { assetId: imported.assetId }).catch(() => {});
        throw new Error("OPAL saved the image but could not preview it. Try another image.");
      }

      if (!mountedRef.current || requestVersion !== importVersionRef.current) {
        await invoke("removeAppearanceBackground", { assetId: imported.assetId }).catch(() => {});
        return;
      }

      const previousDraftAsset = draft.custom?.assetId;
      const next = {
        ...draft,
        themeId: "custom",
        custom: {
          ...customSettings(draft.custom),
          assetId: imported.assetId,
          suggestedAccent: imported.suggestedAccent,
          accentOverride: draft.custom?.accentOverride ?? null,
        },
      };
      ownedAssetsRef.current.add(imported.assetId);
      setDraftBackgroundUrl(imageUrl);
      setDraft(next);
      onPreview(next, imageUrl);

      if (previousDraftAsset && ownedAssetsRef.current.has(previousDraftAsset) && previousDraftAsset !== imported.assetId) {
        ownedAssetsRef.current.delete(previousDraftAsset);
        await invoke("removeAppearanceBackground", { assetId: previousDraftAsset }).catch(() => {});
      }
    } catch (importError) {
      if (mountedRef.current && requestVersion === importVersionRef.current) {
        setError(importError instanceof Error ? importError.message : String(importError));
      }
    } finally {
      if (mountedRef.current && requestVersion === importVersionRef.current) {
        operationRef.current = null;
        setOperation(null);
      }
    }
  }

  function removeImage() {
    if (operationRef.current) return;
    const next = { ...draft, themeId: "opal", custom: null };
    setDraftBackgroundUrl(null);
    preview(next, null);
  }

  async function applyDraft() {
    if (!hasChanges || needsCustomImage || operationRef.current) return;
    operationRef.current = "apply";
    setOperation("apply");
    setError("");
    try {
      const result = await onApply(draft, draftBackgroundUrl);
      if (!result?.ok) {
        setError(result?.error ?? "OPAL could not save the appearance. Try again.");
        return;
      }

      const retainedAssetId = result.appearance?.custom?.assetId;
      const unusedAssets = [...ownedAssetsRef.current].filter((assetId) => assetId !== retainedAssetId);
      ownedAssetsRef.current.clear();
      committedRef.current = true;
      for (const assetId of unusedAssets) void invoke("removeAppearanceBackground", { assetId }).catch(() => {});
      onClose();
    } catch (applyError) {
      setError(String(applyError));
    } finally {
      operationRef.current = null;
      if (mountedRef.current) setOperation(null);
    }
  }

  function dismiss() {
    if (operationRef.current !== "apply") onClose();
  }

  return (
    <DialogFrame titleId="appearance-title" onClose={dismiss} className="appearance-dialog" dismissOnBackdrop={false}>
      <div className="appearance-dialog-heading">
        <div>
          <h2 id="appearance-title">Appearance</h2>
        </div>
        <button className="popover-close" type="button" onClick={dismiss} aria-label="Close appearance settings"><X size={17} /></button>
      </div>

      <div className="appearance-dialog-content">
        <fieldset className="appearance-theme-group" disabled={busy}>
          <legend>Theme</legend>
          <div className="appearance-theme-grid">
            {THEMES.map((theme) => (
              <ThemeTile key={theme.id} label={theme.label} colors={theme.colors} selected={draft.themeId === theme.id} onSelect={() => selectTheme(theme.id)} />
            ))}
            <ThemeTile label="Custom" imageUrl={draftBackgroundUrl} customAccent={accent} selected={draft.themeId === "custom"} onSelect={() => selectTheme("custom")} />
          </div>
        </fieldset>

        {draft.themeId === "custom" && (
          <section className="appearance-custom-section" aria-labelledby="custom-appearance-title">
            <div className="appearance-image-row">
              <span className="appearance-image-icon">
                {customImageReady ? <img src={draftBackgroundUrl} alt="" /> : <ImageSquare size={20} aria-hidden="true" />}
              </span>
              <div className="appearance-image-copy">
                <h3 id="custom-appearance-title">Custom background</h3>
                <p>{assetMissing && !customImageReady ? "Saved image unavailable"
                  : customImageReady ? "Stored on this device"
                  : nativeAvailable ? "PNG, JPG or WebP · up to 25 MB" : "Available in the desktop app"}</p>
              </div>
              <button type="button" className="button button-ghost appearance-image-action" onClick={chooseImage} disabled={!nativeAvailable || !assetStorageReady || busy} aria-busy={importing || preparing}>
                {(importing || preparing) && <CircleNotch className="appearance-spinner" size={14} aria-hidden="true" />}
                {importing ? "Importing…" : preparing ? "Preparing…" : customImageReady ? "Replace" : "Choose image"}
              </button>
              {custom?.assetId && <button type="button" className="appearance-remove-image" onClick={removeImage} disabled={busy} aria-label="Remove background image" title="Remove image"><Trash size={16} /></button>}
            </div>

            {customImageReady && (
              <fieldset className="appearance-controls" aria-labelledby="appearance-adjustments-title" disabled={busy}>
                <h4 id="appearance-adjustments-title" className="appearance-controls-heading"><SlidersHorizontal size={14} aria-hidden="true" />Adjustments</h4>
                <RangeControl label="Dim" min={20} max={70} value={Math.round(custom.dim * 100)} unit="%" onChange={(value) => updateCustom("dim", value / 100)} />
                <RangeControl label="Blur" max={24} value={custom.blur} unit=" px" onChange={(value) => updateCustom("blur", value)} />
                {cropOverflow.x && <RangeControl label="Horizontal crop" value={custom.x} unit="%" onChange={(value) => updateCustom("x", value)} />}
                {cropOverflow.y && <RangeControl label="Vertical crop" value={custom.y} unit="%" onChange={(value) => updateCustom("y", value)} />}
                <div className="appearance-accent-control">
                  <label htmlFor="appearance-accent-color">Player accent</label>
                  <button type="button" className="appearance-accent-auto" aria-pressed={!custom.accentOverride} onClick={() => updateCustom("accentOverride", null)}>Auto</button>
                  <input id="appearance-accent-color" aria-label="Choose player accent color" type="color" value={accent} onChange={(event) => updateCustom("accentOverride", event.target.value.toUpperCase())} />
                </div>
              </fieldset>
            )}
          </section>
        )}
        {error && <p className="appearance-error" role="alert">{error}</p>}
        <span className="sr-only" role="status">{status}</span>
      </div>

      <footer className="appearance-dialog-footer">
        <div>
          <button type="button" className="button button-ghost" onClick={dismiss}>Cancel</button>
          <button type="button" className="button button-primary" onClick={applyDraft} disabled={!hasChanges || needsCustomImage || busy} aria-busy={saving}>
            {saving && <CircleNotch className="appearance-spinner" size={14} aria-hidden="true" />}
            {saving ? "Saving…" : "Apply theme"}
          </button>
        </div>
      </footer>
    </DialogFrame>
  );
}
