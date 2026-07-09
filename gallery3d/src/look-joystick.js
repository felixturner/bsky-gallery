// Yaw-only virtual joystick for the click-to-walk tour (approach #3). A fixed
// thumb pad in the corner; horizontal drag yields a normalised x in [-1, 1]
// that the camera turns by (no pitch). Springs back to centre on release.

export function createLookJoystick(base, thumb) {
  let active = false;
  let x = 0;
  let pointerId = null;
  let cx = 0;
  let half = 1;

  function start(e) {
    active = true;
    pointerId = e.pointerId;
    const r = base.getBoundingClientRect();
    cx = r.left + r.width / 2;
    half = r.width / 2 || 1;
    try { base.setPointerCapture(pointerId); } catch {}
    move(e);
  }
  function move(e) {
    if (!active || e.pointerId !== pointerId) return;
    let dx = (e.clientX - cx) / half;
    dx = Math.max(-1, Math.min(1, dx));
    x = dx;
    // Thumb tracks the finger but stays inside the ring (0.6 of the radius).
    thumb.style.transform = `translate(${dx * half * 0.6}px, 0)`;
    e.preventDefault();
  }
  function end(e) {
    if (e.pointerId !== pointerId) return;
    active = false;
    pointerId = null;
    x = 0;
    thumb.style.transform = 'translate(0, 0)';
  }

  base.addEventListener('pointerdown', start);
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);

  return {
    get x() { return x; },
    get active() { return active; },
  };
}
