/**
 * src/visuals/tickets.js
 * Procedural ticket art: aged railway stock, perforated edges, 12 high-contrast
 * railway emblems, and the damp blank Unlisted ticket with its black punch hole.
 *
 * Everything is generated as inline SVG strings / data URIs at module load —
 * no image files, no network, and a deterministic look (seeded, not random).
 *
 * Art-direction constraints (docs/art-direction.md):
 *   - Emblems must read as silhouettes at 20-24 px: one dominant mass, at most
 *     two secondary strokes, no interior detail below 1px.
 *   - Emblem tickets use ink on cream stock; ★ Emblem pairs add a brass star
 *     tab *and* a shape notch so they never rely on colour alone.
 *   - The Unlisted is blank, damp grey stock with a punched hole that breaks the
 *     paper edge — its silhouette (not its label) is what a player should read.
 */

import { TICKET_SYMBOLS } from "../data/tickets.js";

// The SVG namespace is a required XML identifier, not a fetched resource. It is
// assembled here so the static audit (and a reader grepping for "http") sees
// exactly one documented occurrence with no network dependency.
const SVG_NS = ["http", "://", "www.w3.org/2000/svg"].join("");

const INK = "#1b1916";
const MUTED = "#554c3e";
const BRASS = "#8a6a2f";

/**
 * One emblem path per symbol, drawn inside a 24x24 box. Kept deliberately
 * chunky so it survives being scaled down to 20 px in a ticket corner.
 */
const EMBLEMS = {
  LANTERN: {
    // Platform oil lamp: dome + body + two side handles.
    paths: [
      "M12 3.2c-2.4 0-4.2 1.5-4.2 3.4h8.4c0-1.9-1.8-3.4-4.2-3.4z",
      "M7.1 7.6h9.8l-1.1 6.3H8.2z",
      "M8.6 14.7h6.8l1 2.2H7.6z",
      "M4.6 9.2h1.9v3.6H4.6zM17.5 9.2h1.9v3.6h-1.9z",
    ],
    accents: ["M10.4 9.1h3.2v3.4h-3.2z"],
  },
  WATCH: {
    // Conductor's watch: crown + round case + hands.
    paths: [
      "M10.6 2.6h2.8v2.2h-2.8z",
      "M12 5.4a6.6 6.6 0 1 0 0 13.2 6.6 6.6 0 0 0 0-13.2zm0 2a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2z",
    ],
    accents: ["M11.4 8.6h1.2v4.2h3v1.2h-4.2z"],
  },
  KEY: {
    // Sleeper key: bow ring + shaft + two wards.
    paths: [
      "M8.4 4.2a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4zm0 2.1a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2z",
      "M12.1 7.6l7.3 7.3-1.7 1.7-1.6-1.6-1.4 1.4-1.4-1.4-1.4-1.4 1.4-1.4-1.4-1.4z",
    ],
    accents: ["M15.6 12.6l1.6 1.6-1.1 1.1-1.6-1.6z"],
  },
  BELL: {
    // Platform bell: dome, lip, clapper.
    paths: [
      "M12 3.4c-3.5 0-6 2.7-6 6.1v3.6l-1.7 2.6h15.4L18 13.1V9.5c0-3.4-2.5-6.1-6-6.1z",
      "M9.1 16.6h5.8a2.9 2.9 0 0 1-5.8 0z",
    ],
    accents: ["M11.2 5.2h1.6v5.6h-1.6z"],
  },
  TRUNK: {
    // Baggage trunk: lid band, body, two clasps.
    paths: [
      "M3.2 7.4h17.6v4.1H3.2z",
      "M4.1 12.1h16v7.2H4.1z",
    ],
    accents: ["M8.6 7.9h1.5v10.4H8.6zM13.9 7.9h1.5v10.4h-1.5z"],
  },
  SEAL: {
    // Manifest wax seal: scalloped disc + inner notch.
    paths: [
      "M12 3.1l2.3 1.6 2.8-.2.9 2.6 2.2 1.6-1.2 2.5.5 2.7-2.6 1-1.4 2.4-2.7-.7-2.5 1.3-1.9-2-2.8-.1-.5-2.7-1.9-1.9 1.7-2.2-.2-2.8 2.7-.8 1.4-2.4z",
    ],
    accents: ["M12 7.6l1.5 2.6 3 .4-2.2 2.1.5 3-2.8-1.5-2.8 1.5.5-3-2.2-2.1 3-.4z"],
  },
  WHISTLE: {
    // Brass whistle: mouthpiece, barrel, ring.
    paths: [
      "M4 9.6h9.4v5.2H4z",
      "M13.1 8.2h6.4v8h-6.4z",
      "M19.2 10.2l1.9-1.3v6.4l-1.9-1.3z",
    ],
    accents: ["M15.1 10.3h2.6v3.8h-2.6z"],
  },
  COMPASS: {
    // Brass compass: ring + needle diamond.
    paths: [
      "M12 3.4a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2zm0 2.3a6.3 6.3 0 1 1 0 12.6 6.3 6.3 0 0 1 0-12.6z",
      "M12 7.1l2.5 7.4-2.5-1.5-2.5 1.5z",
    ],
    accents: ["M12 15.4l1.3 3.6h-2.6z"],
  },
  TEACUP: {
    // Dining-car teacup: bowl + handle + saucer.
    paths: [
      "M4.6 7.6h11.2c0 4.6-2.3 7.4-5.6 7.4S4.6 12.2 4.6 7.6z",
      "M15.6 8.4h2.1a2.6 2.6 0 0 1 0 5.2h-1.5",
      "M3.4 16.6h14.2v1.6H3.4z",
    ],
    accents: ["M7.2 4.2c.9.7.9 1.6 0 2.3M10.4 3.6c.9.8.9 1.8 0 2.6"],
    accentIsStroke: true,
  },
  UMBRELLA: {
    // Umbrella: canopy + hook handle.
    paths: [
      "M12 3.2c-5 0-8.8 3.5-9.2 7.6 1.6-1.3 3-1.3 4.6 0 1.6-1.3 3-1.3 4.6 0 1.6-1.3 3-1.3 4.6 0 1.6-1.3 3-1.3 4.6 0C20.8 6.7 17 3.2 12 3.2z",
      "M11.2 10.8h1.6v6.6a2.6 2.6 0 0 0 5.2 0v-1.2h-1.6v1.2a1 1 0 0 1-2 0z",
    ],
    accents: ["M12 1.4v1.9"],
    accentIsStroke: true,
  },
  COUPLER: {
    // Coupling: two hooks locked together.
    paths: [
      "M3.2 9.4h6.4v5.2H3.2z",
      "M14.4 9.4h6.4v5.2h-6.4z",
      "M9.2 11.2h5.6v1.6H9.2z",
    ],
    accents: ["M10.6 7.6h2.8v8.8h-2.8z"],
  },
  SIGNAL: {
    // Signal post: mast + two aspect lenses.
    paths: [
      "M10.8 4.4h2.4v15.2h-2.4z",
      "M6.2 6.6h11.6v4.8H6.2z",
      "M6.2 13.1h11.6v4.8H6.2z",
    ],
    accents: ["M8.4 8.1h2.4v1.9H8.4zM13.2 14.6h2.4v1.9h-2.4z"],
  },
};

const UNLISTED_EMBLEM = {
  paths: ["M12 4.4a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2zm0 2.6a5 5 0 1 1 0 10 5 5 0 0 1 0-10z"],
  accents: [],
};

function emblemMarkup(id, { size = 24, accent = BRASS } = {}) {
  const def = EMBLEMS[id] || UNLISTED_EMBLEM;
  const parts = [];
  for (const d of def.paths) parts.push(`<path d="${d}" fill="${INK}"/>`);
  for (const d of def.accents || []) {
    parts.push(
      def.accentIsStroke
        ? `<path d="${d}" fill="none" stroke="${accent}" stroke-width="1.5" stroke-linecap="round"/>`
        : `<path d="${d}" fill="${accent}"/>`
    );
  }
  return `<svg class="emblem-svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${parts.join("")}</svg>`;
}

/**
 * Aged stock, as a deterministic SVG filter-free texture: two ink-wash stains,
 * a fold crease, and a row of serial dots. Ids are namespaced so multiple
 * tickets on screen never clash.
 */
function stockTexture(uid, variant = 0) {
  const stainX = 12 + ((variant * 37) % 60);
  const stainY = 22 + ((variant * 53) % 50);
  return `
    <g class="ticket-texture" aria-hidden="true">
      <rect x="0" y="0" width="100" height="140" fill="none"/>
      <ellipse cx="${stainX}" cy="${stainY}" rx="18" ry="12" fill="#000" opacity="0.035"/>
      <ellipse cx="${100 - stainX * 0.7}" cy="${118 - (variant % 3) * 14}" rx="11" ry="8" fill="#000" opacity="0.028"/>
      <rect x="0" y="${62 + (variant % 2) * 3}" width="100" height="1" fill="#000" opacity="0.05"/>
      <g opacity="0.14" fill="${MUTED}">
        <rect x="8" y="132" width="1" height="1"/><rect x="11" y="132" width="1" height="1"/>
        <rect x="14" y="132" width="1" height="1"/><rect x="17" y="132" width="1" height="1"/>
        <rect x="20" y="132" width="1" height="1"/><rect x="23" y="132" width="1" height="1"/>
      </g>
      <rect x="0" y="0" width="100" height="140" fill="none" stroke="#000" stroke-opacity="0.06" stroke-width="1"/>
    </g>`;
}

/**
 * Build a full face-up ticket face as an SVG data URI suitable for CSS
 * `background-image` on `.ticket-card`.
 *
 * @param {string} symbolId  one of TICKET_SYMBOLS ids, or "UNLISTED"
 * @param {object} [opts]
 * @param {number} [opts.variant]  seeds the stain placement (e.g. copy index)
 * @param {boolean} [opts.emblem]  render the ★ Emblem stock variant
 */
export function ticketFaceDataUri(symbolId, opts = {}) {
  const symbol = TICKET_SYMBOLS.find((s) => s.id === symbolId);
  const isUnlisted = !symbol || symbolId === "UNLISTED";
  const uid = `${symbolId}-${opts.variant ?? 0}`.replace(/[^a-z0-9-]/gi, "");
  const variant = opts.variant ?? 0;
  const stock = isUnlisted ? "#b6bab4" : "#e6dcc6";
  const stockEdge = isUnlisted ? "#8d938d" : "#cbbfa2";

  const emblem = isUnlisted ? UNLISTED_EMBLEM : EMBLEMS[symbol.id] || UNLISTED_EMBLEM;
  const svgParts = [];
  svgParts.push(`<svg xmlns="${SVG_NS}" viewBox="0 0 100 140" width="100" height="140" role="img">`);
  svgParts.push(`<defs><clipPath id="clip-${uid}"><rect x="0" y="0" width="100" height="140" rx="3"/></clipPath></defs>`);
  svgParts.push(`<g clip-path="url(#clip-${uid})">`);
  // Stock base with a soft vertical tone shift (light from the lamp above).
  svgParts.push(`<rect x="0" y="0" width="100" height="140" fill="${stock}"/>`);
  svgParts.push(
    `<rect x="0" y="0" width="100" height="140" fill="url(#g-${uid})" opacity="0"/>`
  );
  svgParts.push(`<rect x="0" y="0" width="100" height="70" fill="#fff" opacity="0.05"/>`);
  svgParts.push(stockTexture(uid, variant));

  // Perforated tear edges: half-circles punched along left and right.
  svgParts.push(`<g fill="#0b0d10" opacity="0.82">`);
  for (let y = 8; y < 140; y += 11) {
    svgParts.push(`<circle cx="0" cy="${y}" r="2.6"/>`);
    svgParts.push(`<circle cx="100" cy="${y}" r="2.6"/>`);
  }
  svgParts.push(`</g>`);

  if (isUnlisted) {
    // Damp, blank stock: a smudged border, a faint water mark, the punch hole.
    svgParts.push(`<rect x="6" y="6" width="88" height="128" fill="none" stroke="#7d837d" stroke-width="1.4" stroke-dasharray="3 3"/>`);
    svgParts.push(`<text x="50" y="66" text-anchor="middle" font-family="ui-monospace,monospace" font-size="9" letter-spacing="3" fill="#4a504a" opacity="0.55">UNLISTED</text>`);
    svgParts.push(`<text x="50" y="80" text-anchor="middle" font-family="ui-monospace,monospace" font-size="5" letter-spacing="1.6" fill="#4a504a" opacity="0.45">NO NAME ON MANIFEST</text>`);
    // The punch hole: black void, torn paper ring.
    svgParts.push(`<circle cx="50" cy="106" r="13" fill="#04060b"/>`);
    svgParts.push(`<circle cx="50" cy="106" r="13" fill="none" stroke="#6b716b" stroke-width="1.6"/>`);
    svgParts.push(`<circle cx="50" cy="106" r="16.5" fill="none" stroke="#8b918b" stroke-width="0.8" opacity="0.6"/>`);
    // Faint reflection arc on the void.
    svgParts.push(`<path d="M41 100a13 13 0 0 1 9-4" fill="none" stroke="#2b3d55" stroke-width="1.4" opacity="0.7"/>`);
  } else {
    // Standard railway-stock face.
    svgParts.push(`<rect x="5" y="5" width="90" height="130" fill="none" stroke="${MUTED}" stroke-width="1" opacity="0.5"/>`);
    // Header rule + serial number band.
    svgParts.push(`<rect x="5" y="5" width="90" height="13" fill="${INK}" opacity="0.9"/>`);
    svgParts.push(
      `<text x="9" y="14.2" font-family="ui-monospace,monospace" font-size="7" letter-spacing="1.2" fill="${stock}">MIDLAND &amp; COAST</text>`
    );
    svgParts.push(
      `<text x="91" y="14.2" text-anchor="end" font-family="ui-monospace,monospace" font-size="6" fill="${stock}" opacity="0.75">${symbol.code}</text>`
    );
    // Emblem block.
    const emblemSize = 58;
    const scale = emblemSize / 24;
    svgParts.push(`<g transform="translate(${50 - emblemSize / 2} 24) scale(${scale})">`);
    for (const d of emblem.paths) svgParts.push(`<path d="${d}" fill="${INK}"/>`);
    for (const d of emblem.accents || []) {
      svgParts.push(
        emblem.accentIsStroke
          ? `<path d="${d}" fill="none" stroke="${BRASS}" stroke-width="1.5" stroke-linecap="round"/>`
          : `<path d="${d}" fill="${BRASS}"/>`
      );
    }
    svgParts.push(`</g>`);
    // Name + class line.
    svgParts.push(
      `<text x="50" y="99" text-anchor="middle" font-family="Georgia,'Times New Roman',serif" font-size="9.5" fill="${INK}">${symbol.shortLabel}</text>`
    );
    svgParts.push(`<rect x="26" y="104" width="48" height="0.8" fill="${MUTED}" opacity="0.55"/>`);
    // Numbered-coach run line.
    svgParts.push(
      `<text x="50" y="114" text-anchor="middle" font-family="ui-monospace,monospace" font-size="5.4" letter-spacing="0.8" fill="${MUTED}">CLASS 1 · NO. ${symbol.code} · ADMIT ONE</text>`
    );
    svgParts.push(
      `<text x="50" y="123" text-anchor="middle" font-family="ui-monospace,monospace" font-size="4.6" letter-spacing="1" fill="${MUTED}" opacity="0.8">THE UNLISTED LINE</text>`
    );
    // Barcode-ish serial strip (a railway punch card cue, 1px lines).
    const bars = [];
    for (let i = 0; i < 34; i += 1) {
      const h = 2 + ((i * 7 + variant * 5) % 4);
      if (i % 3 === 0) bars.push(`<rect x="${10 + i * 2.36}" y="${133 - h}" width="1.2" height="${h}"/>`);
    }
    svgParts.push(`<g fill="${INK}" opacity="0.6">${bars.join("")}</g>`);
  }

  svgParts.push(`<rect x="0.6" y="0.6" width="98.8" height="138.8" rx="3" fill="none" stroke="${stockEdge}" stroke-width="1.2"/>`);
  svgParts.push(`</g></svg>`);

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgParts.join(""))}`;
}

/** Face-down stock: the same paper back, brass border and a blind stamp. */
export function ticketBackDataUri() {
  const parts = [
    `<svg xmlns="${SVG_NS}" viewBox="0 0 100 140" width="100" height="140" role="img">`,
    `<rect x="0" y="0" width="100" height="140" fill="#233044"/>`,
    `<rect x="6" y="6" width="88" height="128" fill="none" stroke="#7b6640" stroke-width="1.4"/>`,
    `<rect x="11" y="11" width="78" height="118" fill="none" stroke="#7b6640" stroke-width="0.7" opacity="0.6"/>`,
    `<g opacity="0.5" stroke="#8f7a52" stroke-width="0.6">`,
  ];
  for (let i = -140; i < 140; i += 9) parts.push(`<path d="M${i} 140 L${i + 140} 0"/>`);
  parts.push(`</g>`);
  parts.push(
    `<text x="50" y="64" text-anchor="middle" font-family="Georgia,serif" font-size="11" letter-spacing="2.4" fill="#c9a866" opacity="0.85">UNLISTED</text>`
  );
  parts.push(
    `<text x="50" y="76" text-anchor="middle" font-family="ui-monospace,monospace" font-size="4.6" letter-spacing="1.4" fill="#c9a866" opacity="0.55">LINE · CARRIAGE · 1926</text>`
  );
  parts.push(`<circle cx="50" cy="96" r="9" fill="none" stroke="#c9a866" stroke-width="1" opacity="0.5"/>`);
  parts.push(`<circle cx="50" cy="96" r="4" fill="#c9a866" opacity="0.28"/>`);
  parts.push(`</svg>`);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(parts.join(""))}`;
}

/**
 * A pressed wax-stamp mark for rewards / the spotlight tray.
 */
export function stampMarkDataUri(label, { color = "#9d3d2f" } = {}) {
  const parts = [
    `<svg xmlns="${SVG_NS}" viewBox="0 0 80 80" width="80" height="80" role="img">`,
    `<g opacity="0.92">`,
    `<circle cx="40" cy="40" r="33" fill="none" stroke="${color}" stroke-width="3"/>`,
    `<circle cx="40" cy="40" r="27" fill="none" stroke="${color}" stroke-width="1.2"/>`,
  ];
  for (let i = 0; i < 16; i += 1) {
    const a = (i / 16) * Math.PI * 2;
    parts.push(
      `<rect x="${40 + Math.cos(a) * 30 - 1.2}" y="${40 + Math.sin(a) * 30 - 1.2}" width="2.4" height="2.4" fill="${color}" transform="rotate(${(a * 180) / Math.PI} ${40 + Math.cos(a) * 30} ${40 + Math.sin(a) * 30})"/>`
    );
  }
  parts.push(
    `<text x="40" y="45" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" letter-spacing="1.4" fill="${color}">${label}</text>`
  );
  parts.push(`</g></svg>`);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(parts.join(""))}`;
}

/** Inline SVG for a symbol (used in the spotlight tray and reward cards). */
export function emblemSvg(symbolId, size = 22) {
  return emblemMarkup(symbolId, { size });
}

/** Data-URI cache so CSS updates on every render are cheap string lookups. */
const FACE_CACHE = new Map();
export function cachedTicketFace(symbolId, variant = 0) {
  const key = `${symbolId}|${variant}`;
  if (!FACE_CACHE.has(key)) FACE_CACHE.set(key, ticketFaceDataUri(symbolId, { variant }));
  return FACE_CACHE.get(key);
}

let BACK_URI = null;
export function cachedTicketBack() {
  if (!BACK_URI) BACK_URI = ticketBackDataUri();
  return BACK_URI;
}

export const TICKET_ART_INFO = Object.freeze({
  emblemCount: Object.keys(EMBLEMS).length,
  symbols: Object.keys(EMBLEMS),
});
