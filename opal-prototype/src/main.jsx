import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./tokens.css";
import "./styles.css";
import "./library.css";
import "./workspace.css";
import "./player.css";
import "./overlays.css";
import "./workflows.css";
import "./accessibility.css";
import "./projects-carousel.css";
import "./project-detail.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
