const DURATION = 260;
const EASING = "cubic-bezier(.22, .72, .22, 1)";

// A tilted sleeve projects to a trapezoid. Sample its four corners so the
// flying image can match the same perspective as it leaves or lands.
function measureTilt(cover, width, height) {
  const probes = [[0, 0], [100, 0], [100, 100], [0, 100]].map(([x, y]) => {
    const probe = document.createElement("span");
    probe.style.cssText = `position:absolute; left:${x}%; top:${y}%; width:0; height:0; pointer-events:none`;
    return probe;
  });
  cover.append(...probes);
  const [origin, ...corners] = probes.map((probe) => probe.getBoundingClientRect());
  probes.forEach((probe) => probe.remove());
  const [[bx, by], [cx, cy], [dx, dy]] = corners.map(({ x, y }) => [x - origin.x, y - origin.y]);
  const ux = bx - cx;
  const uy = by - cy;
  const vx = dx - cx;
  const vy = dy - cy;
  const determinant = ux * vy - vx * uy;
  if (!determinant) return null;
  const ex = cx - bx - dx;
  const ey = cy - by - dy;
  const g = (ex * vy - vx * ey) / determinant;
  const h = (ux * ey - ex * uy) / determinant;
  const matrix = [
    bx * (1 + g) / width, by * (1 + g) / width, 0, g / width,
    dx * (1 + h) / height, dy * (1 + h) / height, 0, h / height,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
  return { left: origin.x, top: origin.y, width, height, transform: `matrix3d(${matrix.join(", ")})` };
}

export function measureCover(cover, { requireLoaded = true } = {}) {
  const image = cover?.querySelector("img");
  if (!image || (requireLoaded && (!image.complete || !image.naturalWidth))) return null;
  const { left, top, right, bottom, width, height } = cover.getBoundingClientRect();
  if (!width || !height || right <= 0 || bottom <= 0 || left >= window.innerWidth || top >= window.innerHeight) return null;

  const style = getComputedStyle(cover);
  const side = Boolean(cover.closest(".sleeve:not(.is-selected)"));
  const tilt = side ? measureTilt(cover, parseFloat(style.width), parseFloat(style.height)) : null;
  const frame = tilt ?? { left, top, width, height, transform: "none" };

  return {
    side,
    src: image.currentSrc || image.src,
    frame: {
      left: `${frame.left}px`,
      top: `${frame.top}px`,
      width: `${frame.width}px`,
      height: `${frame.height}px`,
      transform: frame.transform,
      borderRadius: style.borderRadius,
    },
  };
}

export function animateCover(stage, source, cover, { details, carousel }) {
  const target = measureCover(cover, { requireLoaded: false });
  if (!target || source.src !== target.src) return;

  const overlay = document.createElement("img");
  overlay.className = "project-cover-transition";
  overlay.alt = "";
  overlay.setAttribute("aria-hidden", "true");
  overlay.src = source.src;
  Object.assign(overlay.style, source.frame);
  stage.append(overlay);

  const motion = overlay.animate([source.frame, target.frame], { duration: DURATION, easing: EASING, fill: "both" });
  // At the end of a side landing, hand off to the real sleeve behind its neighbors.
  const handoff = target.side ? overlay.animate(
    [{ opacity: 1 }, { opacity: 1, offset: .78 }, { opacity: 0 }],
    { duration: DURATION, fill: "both" },
  ) : null;
  const hiddenCover = cover.animate(
    [{ opacity: 0 }, { opacity: 0, offset: .78 }, { opacity: target.side ? 1 : 0 }],
    { duration: DURATION, fill: "both" },
  );
  const reveal = details?.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }], {
    duration: DURATION,
    easing: EASING,
  });
  // Let the Carousel fade in around the artwork without shifting its landing point.
  const carouselReveal = carousel?.animate(
    [{ opacity: 0 }, { opacity: 0, offset: .25 }, { opacity: 1 }],
    { duration: DURATION, easing: "ease-in-out", fill: "both" },
  );

  function cleanup() {
    motion.cancel();
    hiddenCover.cancel();
    handoff?.cancel();
    reveal?.cancel();
    carouselReveal?.cancel();
    overlay.remove();
  }

  motion.onfinish = cleanup;
  return cleanup;
}
