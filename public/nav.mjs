// iOS-like decelerating scroll to the check form (past the pool chart).
// Hash is not written after the tween — setting location.hash would snap.
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
// CSS cubic-bezier(0.25, 0.1, 0.25, 1).
const easeIos = (() => {
  const cx = 3 * 0.25,
    bx = 3 * (0.25 - 0.25) - cx,
    ax = 1 - cx - bx;
  const cy = 3 * 0.1,
    by = 3 * (1 - 0.1) - cy,
    ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  return (x) => {
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (sampleX(mid) < x) lo = mid;
      else hi = mid;
    }
    return sampleY((lo + hi) / 2);
  };
})();

let jumpFrame = 0;
const scrollToForm = (form) => {
  const margin =
    Number.parseFloat(getComputedStyle(form).scrollMarginTop) || 96;
  const target = Math.max(
    0,
    form.getBoundingClientRect().top + window.scrollY - margin,
  );
  const start = window.scrollY;
  const distance = target - start;
  if (Math.abs(distance) < 1) return;
  if (reducedMotion.matches) {
    window.scrollTo(0, target);
    return;
  }
  // Longer trips get a touch more time; cap so it never feels sticky.
  const duration = Math.min(920, Math.max(520, Math.abs(distance) * 0.6));
  const t0 = performance.now();
  cancelAnimationFrame(jumpFrame);
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    window.scrollTo(0, start + distance * easeIos(t));
    if (t < 1) jumpFrame = requestAnimationFrame(tick);
  };
  jumpFrame = requestAnimationFrame(tick);
};

document.querySelectorAll('[data-jump="check"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    const form = document.getElementById("flow-form");
    if (!form) return;
    event.preventDefault();
    scrollToForm(form);
  });
});

// Shared site menu: hamburger open/close, Escape, outside click, focus return.
const toggle = document.getElementById("nav-toggle");
const menu = document.getElementById("site-menu");
if (!toggle || !menu) {
  /* Pages without the shared header skip this module. */
} else {
  let lastFocus = null;

  const open = () => {
    lastFocus = document.activeElement;
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    document.documentElement.classList.add("nav-open");
    const first = menu.querySelector("a");
    first?.focus();
  };

  const close = ({ restore = true } = {}) => {
    if (menu.hidden) return;
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    document.documentElement.classList.remove("nav-open");
    if (restore) (lastFocus || toggle).focus?.();
  };

  toggle.addEventListener("click", () => {
    if (menu.hidden) open();
    else close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  document.addEventListener("pointerdown", (event) => {
    if (menu.hidden) return;
    const target = event.target;
    if (target instanceof Node && !menu.contains(target) && !toggle.contains(target))
      close({ restore: false });
  });
}
