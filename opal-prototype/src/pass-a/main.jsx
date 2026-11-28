import React from "react";
import { createRoot } from "react-dom/client";
import { PassAPreview } from "./PassAPreview.jsx";
import "./pass-a.css";

createRoot(document.getElementById("pass-a-root")).render(
  <React.StrictMode>
    <PassAPreview />
  </React.StrictMode>,
);
