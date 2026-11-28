import { useLayoutEffect, useRef } from "react";
import { registerOverlayLayer } from "./overlay-coordinator.js";

export function useOverlayLayer({ active = true, elementRef, onEscape, modal = false, trapFocus = false, initialFocus = true, getInitialFocus } = {}) {
  const optionsRef = useRef({ onEscape, getInitialFocus });
  optionsRef.current = { onEscape, getInitialFocus };

  useLayoutEffect(() => {
    if (!active) return undefined;
    return registerOverlayLayer({
      element: elementRef?.current,
      modal,
      trapFocus,
      initialFocus,
      getInitialFocus: () => optionsRef.current.getInitialFocus?.(),
      onEscape: () => optionsRef.current.onEscape?.(),
    });
  }, [active, elementRef, initialFocus, modal, trapFocus]);
}
