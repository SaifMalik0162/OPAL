import React from "react";
import { ArrowUpRight, ArrowsDownUp, Check, Checks, Info, Palette } from "@phosphor-icons/react";
import { ThemeSwatch, themeSwatchStyle } from "./appearance/ThemeSwatch.jsx";
import { THEME_BY_ID } from "./appearance/themes.js";
import "./whats-new.css";

export const WHATS_NEW_RELEASE = {
  version: "0.1.0-alpha.5.3",
  label: "Alpha 5.3",
};

const highlights = [
  { Icon: ArrowsDownUp, title: "More sorting options", detail: "Sort by name, date created, or date modified in either direction. Your sort order is saved for each project." },
  { Icon: Info, title: "Updated track details", detail: "See original filenames and audio details, and switch between versions of a track." },
  { Icon: Checks, title: "Select multiple tracks", detail: "Shift-click a range or Cmd/Ctrl-click individual tracks to move, delete, or reorder them together." },
  { Icon: Palette, title: "Burgundy and Jade themes", detail: "Two new themes, with matching colors across the app and player." },
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
          <div className="whats-new-track-preview" style={previewStyle}>
            {previewImage && <img className="whats-new-preview-background" src={previewImage} alt="" />}
            {["Untitled track 1", "Untitled track 2", "Untitled track 3"].map((title, index) => <div key={title} className={`whats-new-preview-track${index < 2 ? " is-selected" : ""}`}>
              <span className="whats-new-preview-check">{index < 2 ? <Check size={11} weight="bold" /> : "3"}</span>
              <span><strong>{title}</strong><small>{index === 1 ? "Warm mix · 3 versions" : "Original"}</small></span><time>{["2:41", "3:12", "2:58"][index]}</time>
            </div>)}
          </div>
        </figure>
        <div className="whats-new-theme-presets">
          {[THEME_BY_ID.burgundy, THEME_BY_ID.jade].map(({ id, label, colors }) => (
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
        <h2 id="whats-new-title">New in<br /><em>Alpha 5.3</em></h2>
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
