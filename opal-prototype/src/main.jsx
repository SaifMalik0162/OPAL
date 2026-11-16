import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { initializeAppearance } from "./appearance/themes.js";
import { readAppearancePreference } from "./appearance/preferences.js";
import "./tokens.css";
import "./styles.css";
import "./library.css";
import "./workspace.css";
import "./player.css";
import "./overlays.css";
import "./workflows.css";
import "./accessibility.css";
import "./carousel-preview.css";
import "./project-detail.css";
import "./appearance/appearance.css";

const appearancePreference = readAppearancePreference();
initializeAppearance(appearancePreference.appearance);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App
      initialAppearance={appearancePreference.appearance}
      canReconcileAppearanceAssets={appearancePreference.canReconcileAssets}
    />
  </React.StrictMode>,
);
