// Is this finger scrolling the page, or picking a food up?
//
// Both gestures start identically — a finger goes down on a meal entry and
// moves — so something has to decide, once, which one is happening. Getting it
// wrong is not cosmetic in either direction: treat a scroll as a drag and the
// list stops scrolling where the foods are, which is most of the screen; treat
// a drag as a scroll and the food can never be picked up at all.
//
// The rule: a touch has to be HELD before it becomes a drag. Move further than
// SLOP_PX before the hold completes and it was a scroll, permanently — the
// caller latches that and stops asking. A mouse needs no hold, because a mouse
// cannot scroll by dragging the page and press-and-wait on a desktop feels
// broken.
//
// Pure on purpose: this is the part worth testing, and it needs no DOM to do
// it. Lives in utils/ for the reason CLAUDE.md gives — no DOM access at module
// scope, so a node test can import it directly.

// 200ms. Long enough that a flick down the day doesn't arm a drag, short enough
// that it doesn't read as a lag. iOS's own long-press is ~500ms, which is far
// too slow here: you are not opening a context menu, you are picking something
// up, and the feedback is immediate.
export const HOLD_MS = 200;

// 10 CSS px of travel before a pre-hold move counts as a scroll. Generous
// rather than tight, because this is measured against a FINGER: a stationary
// thumb still wanders a few pixels, and at 150% text with big targets on the
// primary user's phone it wanders more. Too tight and a deliberate hold is read
// as a scroll and nothing can ever be dragged.
export const SLOP_PX = 10;

// 'pending' — not enough has happened yet; keep watching.
// 'scroll'  — it is a scroll. Latch this and leave the browser alone.
// 'drag'    — pick the food up.
//
// Movement beats the clock, unconditionally. A finger that has travelled
// 40px is scrolling whether it has been down for 50ms or 300ms.
//
// The first draft gated that on `elapsedMs < HOLD_MS`, which reads as the same
// rule and is not: a slow deliberate scroll reaching 40px after 300ms came back
// 'drag'. In practice pointermove fires often enough that such a finger is
// caught inside the window and latched as a scroll long before — but "the
// caller samples fast enough" is not a property of this function, and the one
// time it is false (a dropped frame, a busy main thread on the first move after
// a render) the day lurches into a drag mid-scroll. A test caught it; the
// comment above it had described the intended order rather than the written one.
//
// So a touch drag arms on the HOLD alone, from a finger still inside the slop.
// That is what a pick-up is: hold still, feel it lift, then move. The caller
// stops consulting this the moment it latches.
export function gestureIntent({ dx, dy, elapsedMs, pointerType = 'touch' }) {
  const moved = Math.hypot(dx, dy);
  // A mouse has no scroll-by-drag to compete with, so distance alone decides
  // and there is no wait.
  if (pointerType === 'mouse') return moved >= SLOP_PX ? 'drag' : 'pending';
  if (moved >= SLOP_PX) return 'scroll';
  if (elapsedMs >= HOLD_MS) return 'drag';
  return 'pending';
}

// Viewport pixels → the layout pixels a `zoom`ed subtree reckons in.
//
// The whole scroll container runs at `zoom: var(--ui-scale)` (the text-scaling
// feature), so a row's getBoundingClientRect() is its VISUAL size in viewport
// px while its own CSS box is 1/scale of that. The drag ghost is appended to
// <body>, outside the zoom, so it has to be laid out at the unzoomed size and
// then scaled back up — otherwise at 150% it renders two thirds the size of the
// row it is standing in for.
export const unzoom = (px, scale) => (scale > 0 ? px / scale : px);
