import React from "react";
import { ArrowUpRight, Cards, ImageSquare, Palette, Waveform } from "@phosphor-icons/react";
import { ThemeSwatch, themeSwatchStyle } from "./appearance/ThemeSwatch.jsx";
import { THEME_BY_ID, THEMES } from "./appearance/themes.js";
import "./whats-new.css";

export const WHATS_NEW_RELEASE = {
  version: "0.1.0-alpha.5.2",
  label: "Alpha 5.2",
};

const highlights = [
  { Icon: Palette, title: "Five built-in themes", detail: "Preview OPAL, Lavender, Deep Plum, Cream, and Obsidian before you apply one." },
  { Icon: ImageSquare, title: "Bring your own background", detail: "Choose an image from your Mac or PC, then adjust its framing, dimming, and blur. It stays on your device." },
  { Icon: Waveform, title: "A player that matches", detail: "Player colors follow your theme. OPAL can pull an accent from your image, or you can choose your own." },
  { Icon: Cards, title: "Glass throughout the Library", detail: "Flipped covers keep their artwork behind the track list. Audio drop highlights match your theme." },
];

function ThemeGallery({ appearance, backgroundUrl }) {
  const custom = appearance?.themeId === "custom" && backgroundUrl ? appearance.custom : null;
  const previewImage = custom ? backgroundUrl : null;
  const previewStyle = custom
    ? themeSwatchStyle(null, custom.accentOverride ?? custom.suggestedAccent)
    : themeSwatchStyle((THEME_BY_ID[appearance?.themeId] ?? THEME_BY_ID.opal).colors);

  return (
    <div className="whats-new-art-panel" aria-hidden="true">
      <span className="whats-new-art-brand"><img src="/opal-mark.png" alt="" />OPAL</span>
      <div className="whats-new-theme-gallery">
        <figure className="whats-new-theme-hero">
          <ThemeSwatch imageUrl={previewImage} style={previewStyle} />
          <figcaption>{previewImage ? "Your custom background" : "Theme preview"}</figcaption>
        </figure>
        <div className="whats-new-theme-presets">
          {THEMES.map(({ id, label, colors }) => (
            <figure key={id}>
              <ThemeSwatch style={themeSwatchStyle(colors)} />
              <figcaption>{label}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}

export function WhatsNew({ appearance, backgroundUrl, onClose, onTryTheme }) {
  return (
    <div className="whats-new-layout">
      <ThemeGallery appearance={appearance} backgroundUrl={backgroundUrl} />
      <div className="whats-new-copy">
        <span className="whats-new-kicker">{WHATS_NEW_RELEASE.label} · What’s new</span>
        <h2 id="whats-new-title">Make OPAL <em>yours.</em></h2>
        <ul className="whats-new-highlights">
          {highlights.map(({ Icon, title, detail }) => (
            <li key={title}>
              <span className="whats-new-icon"><Icon size={18} aria-hidden="true" /></span>
              <span><strong>{title}</strong><small>{detail}</small></span>
            </li>
          ))}
        </ul>
        <footer className="whats-new-footer">
          <button type="button" className="button button-ghost" onClick={onClose}>Done</button>
          <button type="button" className="button button-primary" onClick={onTryTheme}>Try a theme<ArrowUpRight size={15} aria-hidden="true" /></button>
        </footer>
      </div>
    </div>
  );
}
