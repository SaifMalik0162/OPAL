import React, { useRef } from "react";
import { createPortal } from "react-dom";
import { useOverlayLayer } from "./useOverlayLayer.js";

export function DialogFrame({ titleId, onClose, children, className = "", backdrop, dismissOnBackdrop = true }) {
  const layerRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useOverlayLayer({ elementRef: layerRef, modal: true, trapFocus: true, onEscape: () => onCloseRef.current() });

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={layerRef}
      data-overlay-layer
      tabIndex={-1}
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (dismissOnBackdrop && event.target === event.currentTarget) onClose(); }}
    >
      {backdrop}
      <section className={`import-prompt glass modal-form ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        {children}
      </section>
    </div>,
    document.body,
  );
}
