export function createInitialListenState() {
  return {
    carouselSurface: { type: "closed" },
    listen: {
      transition: "closed",
      binding: { type: "playback" },
      utility: { type: "closed" },
    },
  };
}

function normalizeBinding(binding) {
  if (binding?.type !== "preview" || !binding.projectId || !binding.trackId) return { type: "playback" };
  return {
    type: "preview",
    projectId: binding.projectId,
    trackId: binding.trackId,
    pendingSeekMs: clampPreviewPosition(binding.pendingSeekMs),
  };
}

export function clampPreviewPosition(positionMs, durationMs = 0) {
  const position = Math.max(0, Number(positionMs) || 0);
  const duration = Number(durationMs);
  return Number.isFinite(duration) && duration > 0 ? Math.min(position, duration) : position;
}

export function listenStateReducer(state, action) {
  switch (action.type) {
    case "OPEN_CAROUSEL_SURFACE": {
      if (!["tracks", "notes"].includes(action.surface) || !action.projectId) return state;
      return {
        ...state,
        carouselSurface: { type: action.surface, projectId: action.projectId },
        listen: { ...state.listen, transition: "closed", utility: { type: "closed" } },
      };
    }
    case "CLOSE_CAROUSEL_SURFACE":
      if (action.projectId && state.carouselSurface.projectId !== action.projectId) return state;
      return { ...state, carouselSurface: { type: "closed" } };
    case "OPEN_LISTEN":
      return {
        ...state,
        carouselSurface: { type: "closed" },
        listen: {
          ...state.listen,
          transition: "opening",
          binding: normalizeBinding(action.binding ?? state.listen.binding),
          utility: { type: "closed" },
        },
      };
    case "LISTEN_OPENED":
      return state.listen.transition === "opening"
        ? { ...state, listen: { ...state.listen, transition: "open" } }
        : state;
    case "CLOSE_LISTEN":
      return state.listen.transition === "closed"
        ? state
        : { ...state, listen: { ...state.listen, transition: "closing", utility: { type: "closed" } } };
    case "LISTEN_CLOSED":
      return state.listen.transition === "closing"
        ? { ...state, listen: { transition: "closed", binding: { type: "playback" }, utility: { type: "closed" } } }
        : state;
    case "BIND_LISTEN_PLAYBACK":
      return { ...state, listen: { ...state.listen, binding: { type: "playback" } } };
    case "BIND_LISTEN_PREVIEW":
      return {
        ...state,
        listen: {
          ...state.listen,
          binding: normalizeBinding({
            type: "preview",
            projectId: action.projectId,
            trackId: action.trackId,
            pendingSeekMs: action.pendingSeekMs,
          }),
        },
      };
    case "UPDATE_LISTEN_PREVIEW_SEEK":
      if (state.listen.binding.type !== "preview") return state;
      if (action.projectId && state.listen.binding.projectId !== action.projectId) return state;
      if (action.trackId && state.listen.binding.trackId !== action.trackId) return state;
      return {
        ...state,
        listen: {
          ...state.listen,
          binding: {
            ...state.listen.binding,
            pendingSeekMs: clampPreviewPosition(action.pendingSeekMs, action.durationMs),
          },
        },
      };
    case "OPEN_LISTEN_UTILITY": {
      const allowed = ["notes", "queue", "volume", "moment-composer", "overflow"];
      if (!allowed.includes(action.utility)) return state;
      return { ...state, listen: { ...state.listen, utility: { type: action.utility } } };
    }
    case "CLOSE_LISTEN_UTILITY":
      return state.listen.utility.type === "closed"
        ? state
        : { ...state, listen: { ...state.listen, utility: { type: "closed" } } };
    default:
      return state;
  }
}
