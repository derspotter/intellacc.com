/**
 * Hover-to-expand for clamped long posts (Van skin).
 *
 * The markup and CSS live in PostItem / styles.css: a hidden
 * `.post-content-hover-overlay` inside `.post-content.clamped.has-hover-overlay`
 * becomes visible when the container carries the `hover-open` class. This
 * controller is the JS half that was lost in the VanJS → Solid port: it
 * adds/removes that class via delegated pointer events on one root.
 *
 * Behaviour (matches the legacy VanJS feed):
 * - trigger zone is the clamped text or the open overlay, never the card
 * - opens after a 1s dwell so scrolling past posts does not flash overlays
 * - one open post at a time; leaving the zone closes it
 * - stays open during scroll while the cursor is still over it
 * - not installed on touch / coarse-pointer devices
 */
const OPEN_DELAY_MS = 1000;
const ZONE = '.post-content-text, .post-content-hover-overlay';
const CONTAINER = '.post-content.clamped.has-hover-overlay';

export const installPostHoverExpand = (root = document.body, { openDelay = OPEN_DELAY_MS } = {}) => {
  if (typeof window === 'undefined' || !root) return () => {};
  if (window.matchMedia && !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return () => {};

  let openEl = null;
  let pendingEl = null;
  let timer = null;
  let lastMouse = { x: 0, y: 0, valid: false };

  const containerFrom = (node) => {
    if (!node || !node.closest) return null;
    const zone = node.closest(ZONE);
    if (!zone) return null;
    const el = zone.closest(CONTAINER);
    return el && root.contains(el) ? el : null;
  };

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pendingEl = null;
  };

  const close = () => {
    if (openEl) openEl.classList.remove('hover-open');
    openEl = null;
  };

  const openAfterDelay = (el) => {
    clearTimer();
    pendingEl = el;
    timer = setTimeout(() => {
      if (pendingEl !== el) return;
      if (openEl && openEl !== el) close();
      openEl = el;
      el.classList.add('hover-open');
    }, openDelay);
  };

  const onPointerOver = (e) => {
    const el = containerFrom(e.target);
    if (!el) return;
    if (containerFrom(e.relatedTarget) === el) return; // moving within the same zone
    openAfterDelay(el);
  };

  const onPointerOut = (e) => {
    const el = containerFrom(e.target);
    if (!el) return;
    if (containerFrom(e.relatedTarget) === el) return;
    clearTimer();
    if (openEl === el) close();
  };

  const onPointerMove = (e) => {
    lastMouse = { x: e.clientX, y: e.clientY, valid: true };
    if (!openEl) return;
    const over = containerFrom(document.elementFromPoint(e.clientX, e.clientY));
    if (over !== openEl) close();
  };

  // Browsers may drop :hover mid-scroll; keep the overlay open while the
  // cursor is still over it, otherwise close so it does not float away.
  const onScroll = () => {
    if (!openEl || !lastMouse.valid) return;
    const over = containerFrom(document.elementFromPoint(lastMouse.x, lastMouse.y));
    if (over !== openEl) close();
  };

  root.addEventListener('pointerover', onPointerOver);
  root.addEventListener('pointerout', onPointerOut);
  root.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });

  return () => {
    clearTimer();
    close();
    root.removeEventListener('pointerover', onPointerOver);
    root.removeEventListener('pointerout', onPointerOut);
    root.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('scroll', onScroll);
  };
};
