import React, { useEffect, useRef } from "react";

export function DialogFrame({ titleId, onClose, children, className = "", backdrop, dismissOnBackdrop = true }) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll("button, input, textarea, select, [tabindex]:not([tabindex='-1'])") ?? []).filter((element) => !element.matches(":disabled") && element.getAttribute("aria-hidden") !== "true");
    const focusTimer = window.setTimeout(() => {
      if (!dialogRef.current?.contains(document.activeElement)) focusable()[0]?.focus();
    }, 0);
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (dismissOnBackdrop && event.target === event.currentTarget) onClose(); }}
    >
      {backdrop}
      <section ref={dialogRef} className={`import-prompt glass modal-form ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        {children}
      </section>
    </div>
  );
}
