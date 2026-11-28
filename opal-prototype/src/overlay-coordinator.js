export function createOverlayCoordinator(documentRef = globalThis.document) {
  const layers = new Map();
  let nextId = 0;
  let nextOrder = 0;
  let installed = false;
  let lockSnapshot = null;
  let backgroundInert = null;

  function orderedLayers() {
    return [...layers.values()].sort((left, right) => left.order - right.order);
  }

  function applyInert(element, inert) {
    if (!element) return;
    if (inert && !element.inert) {
      element.dataset.overlayWasInert = "false";
      element.inert = true;
    } else if (!inert && element.inert && element.dataset.overlayWasInert === "false") {
      element.inert = false;
      delete element.dataset.overlayWasInert;
    }
  }

  function syncModalState() {
    const stack = orderedLayers();
    const highestModal = [...stack].reverse().find((layer) => layer.modal);
    const background = documentRef?.querySelector?.("[data-overlay-background]");

    if (highestModal && !lockSnapshot) {
      lockSnapshot = {
        htmlOverflow: documentRef.documentElement?.style.overflow ?? "",
        bodyOverflow: documentRef.body?.style.overflow ?? "",
      };
      backgroundInert = background ? { element: background, wasInert: background.inert } : null;
      if (documentRef.documentElement) documentRef.documentElement.style.overflow = "hidden";
      if (documentRef.body) documentRef.body.style.overflow = "hidden";
    }

    if (background) applyInert(background, Boolean(highestModal));
    for (const layer of stack) {
      const isBehindTopModal = highestModal && layer.order < highestModal.order;
      applyInert(layer.element, Boolean(isBehindTopModal));
    }

    if (!highestModal && lockSnapshot) {
      if (documentRef.documentElement) documentRef.documentElement.style.overflow = lockSnapshot.htmlOverflow;
      if (documentRef.body) documentRef.body.style.overflow = lockSnapshot.bodyOverflow;
      if (backgroundInert?.element?.isConnected) backgroundInert.element.inert = backgroundInert.wasInert;
      lockSnapshot = null;
      backgroundInert = null;
    }
  }

  function focusable(layer) {
    return [...(layer.element?.querySelectorAll?.("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])") ?? [])]
      .filter((element) => element.getAttribute("aria-hidden") !== "true" && !element.inert);
  }

  function handleKeyDown(event) {
    const stack = orderedLayers();
    const topLayer = stack.at(-1);
    if (!topLayer) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      topLayer.onEscape?.();
      return;
    }
    if (event.key !== "Tab") return;
    const layer = topLayer.trapFocus ? topLayer : [...stack].reverse().find((item) => item.modal && item.trapFocus);
    if (!layer) return;
    const elements = focusable(layer);
    if (!elements.length) {
      event.preventDefault();
      layer.element?.focus?.({ preventScroll: true });
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && (documentRef.activeElement === first || !layer.element?.contains(documentRef.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (documentRef.activeElement === last || !layer.element?.contains(documentRef.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  function install() {
    if (installed || !documentRef?.addEventListener) return;
    installed = true;
    documentRef.addEventListener("keydown", handleKeyDown, true);
  }

  function uninstall() {
    if (!installed || layers.size) return;
    installed = false;
    documentRef.removeEventListener("keydown", handleKeyDown, true);
    syncModalState();
  }

  return {
    register(options) {
      const id = ++nextId;
      const layer = {
        ...options,
        id,
        order: ++nextOrder,
        previousFocus: documentRef.activeElement,
        originalZIndex: options.element?.parentElement === documentRef.body ? options.element.style.zIndex : null,
      };
      layers.set(id, layer);
      if (layer.originalZIndex !== null) layer.element.style.zIndex = String(100 + layer.order);
      install();
      syncModalState();
      if (layer.initialFocus !== false) {
        layer.focusTimer = documentRef.defaultView?.setTimeout(() => {
          if (!layers.has(id) || layers.get(id) !== layer || layer.element?.contains(documentRef.activeElement)) return;
          (layer.getInitialFocus?.() ?? focusable(layer)[0])?.focus?.({ preventScroll: true });
        }, 0);
      }
      return () => {
        if (!layers.delete(id)) return;
        documentRef.defaultView?.clearTimeout(layer.focusTimer);
        if (layer.originalZIndex !== null && layer.element?.isConnected) layer.element.style.zIndex = layer.originalZIndex;
        syncModalState();
        const previousFocus = layer.previousFocus;
        if (previousFocus?.isConnected && !previousFocus.inert) previousFocus.focus?.({ preventScroll: true });
        uninstall();
      };
    },
    getActiveLayer() {
      return orderedLayers().at(-1) ?? null;
    },
    getLayerCount() {
      return layers.size;
    },
  };
}

const overlayCoordinator = createOverlayCoordinator();

export function registerOverlayLayer(options) {
  return overlayCoordinator.register(options);
}

export function hasActiveOverlay() {
  return overlayCoordinator.getLayerCount() > 0;
}
