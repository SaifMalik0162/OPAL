import React from "react";
import { Play } from "@phosphor-icons/react";
import { customPlayerPalette } from "./themes.js";

export function themeSwatchStyle(colors, customAccent) {
  const customPalette = colors ? null : customPlayerPalette(customAccent);
  return {
    "--swatch-background": colors?.background ?? customPalette["--custom-player-solid"],
    "--swatch-player": colors?.glassStrong ?? customPalette["--custom-player-glass"],
    "--swatch-player-tint": colors?.canvas ?? customPalette["--custom-player-center"],
    "--swatch-accent": colors?.accent ?? customPalette["--custom-player-highlight"],
    "--swatch-control-ink": colors?.accentForeground ?? customPalette["--custom-player-ink"],
  };
}

export function ThemeSwatch({ imageUrl, style }) {
  return (
    <span className="appearance-theme-swatch" style={style} aria-hidden="true">
      {imageUrl && <img src={imageUrl} alt="" draggable={false} />}
      <span className="appearance-theme-mini-library"><i /><i /><i /></span>
      <span className="appearance-theme-mini-player">
        <span className="appearance-theme-mini-play"><Play size={6} weight="fill" /></span>
        <span className="appearance-theme-mini-progress" />
      </span>
    </span>
  );
}
