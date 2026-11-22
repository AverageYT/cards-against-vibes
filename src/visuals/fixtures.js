/**
 * src/visuals/fixtures.js
 * Where every physical HUD fixture sits in the compartment.
 *
 * Art Phase 3 turns the interface into objects in the room: a punched station
 * strip taped beside the window, a brass counter under the Inspector's hands, a
 * bell with three filing notches, three recessed stamp wells in the table's near
 * edge, a paper slip in a clip holder, and a ledger at the table corner.
 *
 * All coordinates are **percentages of the stage frame** (the 16:9 carriage
 * picture), because that is the box the HUD is laid over. They are derived from
 * the same projected geometry `layout.js` gives the renderer, so a fixture sits
 * on the furniture it belongs to instead of near it.
 *
 * Design rule for the whole phase: **no large opaque panels.** A fixture is a
 * small object with a readable silhouette that "sticks out" enough to be found —
 * a brass edge, a lit lamp, a paper tab — but never a rectangle that reads as a
 * UI panel. Anything that must stay legible gets a dark scrim *behind its own
 * text only*, not behind the whole region.
 *
 * The design-language constraint also means fixtures are **anchored to objects,
 * not to viewport edges**. If the compartment ever changes, these numbers move
 * and the HUD follows; that is the point of putting them here rather than in CSS.
 */

/**
 * Primary fixture positions, in percent of the stage frame.
 *
 * `x`/`y` are the fixture's centre; `w`/`h` are its nominal size. Sizes are in
 * percent of the frame too, so type and hit targets scale with the picture.
 *
 * The numbers were read off `describeLayout()` output and the rendered frames:
 * the window occupies x 51–64 %, the Inspector's hands meet at about y 52 %,
 * the far fan band sits at y 49–57 %, and the near fan / well row is y 61–65 %.
 */
export const FIXTURES = Object.freeze({
  /**
   * Punched station strip: a pale card with five oval perforations, clipped to
   * the luggage rack so it hangs just right of the window's lower corner.
   * Reads as a ticket-stub run, not a progress bar.
   */
  strip: Object.freeze({ x: 72.5, y: 20.5, w: 12.5, h: 4.2 }),

  /**
   * Brass deal counter: a small engraved plate lying on the table in front of
   * the Inspector, just under the hands. It carries "You 1–0 Insp".
   */
  counter: Object.freeze({ x: 25.0, y: 57.5, w: 12, h: 3.2 }),

  /**
   * Three lamp cells on the luggage rack above the Inspector's left shoulder.
   * Each cell is a small glass lamp; lit cells glow amber, spent cells are dark
   * glass with a visible ash line — state is shape *and* colour.
   */
  lamps: Object.freeze({ x: 37.5, y: 12.5, w: 10, h: 3.4 }),

  /**
   * Paper slip in a clip holder: the turn/action prompt. The clip is the
   * affordance (a brass bulldog clip biting the paper's top edge); the paper is
   * narrow and translucent-topped so it never reads as a panel.
   */
  slip: Object.freeze({ x: 64.0, y: 88.5, w: 24, h: 5.6 }),

  /**
   * Bell fixture: an oval brass bell sitting on the table's right side, with
   * three filing notches along its rim. The notches are the streak; the label
   * "FINAL CALL" appears on the little brass plate under it when armed.
   */
  bell: Object.freeze({ x: 74.0, y: 72.5, w: 8.0, h: 6.0 }),

  /**
   * Manifest ledger: a small dark book with a brass corner, at the table's left
   * corner. It expands upward when opened, so it never covers the well row.
   */
  manifest: Object.freeze({ x: 26.0, y: 66.5, w: 9.0, h: 5.0 }),

  /**
   * Three recessed stamp wells in the table's near edge. Each is a dark oval
   * cut into the varnish with a brass rim; an empty well shows pale felt.
   */
  wells: Object.freeze({ x: 30.0, y: 88.5, w: 30, h: 4.6 }),

  /**
   * Tool rack on the near rail: two small brass hooks that hold the Gauge and
   * the Edge keepsakes. Hidden until the locker grants them.
   */
  rack: Object.freeze({ x: 72, y: 85.5, w: 13, h: 3.4 }),
});

/**
 * The station strip's five perforations. Positions are fractions of the strip
 * body, so the holes line up with the route's five stops regardless of how the
 * strip is sized.
 */
export const STRIP_STOPS = Object.freeze([0.1, 0.3, 0.5, 0.7, 0.9]);

/** Bell notches along the rim: the Unlisted streak's three states. */
export const BELL_NOTCHES = Object.freeze([0.32, 0.5, 0.68]);

/**
 * The two card fans, as centre-lines in the same frame percentages.
 *
 * Taken straight from `describeLayout()`: the drawn far fan occupies rows
 * 98-102 and the near fan 125-132 on the 180-unit frame. The DOM fans are
 * centred on those rows so the real cards sit where the renderer's card shapes
 * are, and the picture and the playable cards read as one object.
 */
export const FAN_BANDS = Object.freeze({
  far: Object.freeze({ y: 55.6 }),
  near: Object.freeze({ y: 71.4 }),
});

/**
 * Where each fixture is *allowed* to grow while staying on its object.
 * `expand` is the direction an open state may unfold, so the manifest opens up
 * and to the left (over empty table) rather than down over the stamp wells.
 */
export const FIXTURE_EXPANSION = Object.freeze({
  strip: "right",
  counter: "none",
  lamps: "right",
  slip: "down",
  bell: "none",
  manifest: "up",
  wells: "none",
  rack: "right",
});

/**
 * Per-framing nudges.
 *
 * The portrait camera is pulled back and nearer, so the table occupies a
 * different band of the picture. Rather than conditionally shoving fixtures
 * around in CSS, each framing gets its own small delta table. Values are added
 * to the base position; anything omitted is unchanged.
 */
export const FIXTURE_DELTAS = Object.freeze({
  wide: Object.freeze({}),
  portrait: Object.freeze({
    // The portrait frame pushes the near edge down and crops the side walls, so
    // the corner fixtures move inward to stay clear of the rounded rails.
    strip: Object.freeze({ x: 73.5, y: 21 }),
    lamps: Object.freeze({ x: 30, y: 12.5 }),
    bell: Object.freeze({ x: 74, y: 54.5 }),
    manifest: Object.freeze({ x: 26, y: 54.5 }),
    rack: Object.freeze({ x: 74, y: 70 }),
  }),
});

/** Resolve the fixture table for one framing into a flat, render-ready map. */
export function resolveFixtures(framing = "wide") {
  const delta = FIXTURE_DELTAS[framing] || {};
  const out = {};
  for (const [name, base] of Object.entries(FIXTURES)) {
    out[name] = Object.freeze({ ...base, ...(delta[name] || {}) });
  }
  return Object.freeze(out);
}

/**
 * Build the CSS custom properties for one framing.
 *
 * Emitted as `--fx-<name>-x|y|w|h` percentages on the stage host, so a fixture
 * can be placed with `left: var(--fx-bell-x)` and stays glued to the bell the
 * renderer draws.
 */
export function fixtureCustomProperties(framing = "wide") {
  const out = {};
  for (const [name, f] of Object.entries(resolveFixtures(framing))) {
    out[`--fx-${name}-x`] = `${f.x}%`;
    out[`--fx-${name}-y`] = `${f.y}%`;
    out[`--fx-${name}-w`] = `${f.w}%`;
    out[`--fx-${name}-h`] = `${f.h}%`;
  }
  return out;
}
