# Art Direction — *The Unlisted*

Locked visual brief for the procedural 2.5D midnight railway presentation.
Everything here is implemented in `src/data/palette.js`, `src/visuals/scene.js`,
`src/visuals/stage.js` and `src/visuals/tickets.js`. No binary art, no fonts, no
CDN — every pixel is generated at runtime.

## 1. Technical frame (locked)

| Property | Value | Notes |
| --- | --- | --- |
| Renderer | Canvas 2D software rasteriser + WebGL post pass | WebGL 1 (`webgl`) fragment shader; automatic Canvas 2D software-shader fallback |
| Internal resolution | **320 × 180** (16:9) | True pixel grid. Never scaled down; the display canvas upscales by integer-friendly nearest sampling |
| Pixelation on | 320×180 buffer → nearest upscale + dither | Default |
| Pixelation off | 640×360 ambient-occluded buffer → smooth upscale | Live toggle, `P` |
| Frame rate | ~30 fps (throttled), 0 fps when the tab is hidden | One `requestAnimationFrame` loop owned by the stage |
| Colour depth | 5 bits per channel (32 levels) + ordered Bayer 4×4 | PS1-style banding and dither |
| Camera | 62° vertical FOV, seated passenger eye height (y = 1.22 m), 1 unit = 1 m | Counter-angled low-poly interior |
| Lighting | One amber lamp (point, inverse-square-ish, falloff 0.34) + one cold window fill + 20 % ambient | One light direction per object; facet shading is intentional |
| UI layer | DOM + inline SVG only | Crisp text, ticket symbols, badges, focus rings — never passes through the shader |

## 2. Visual system

**Shape language.** Rectilinear railway hardware (benches, window frame, table
apron) against one soft organic mass (the hooded Inspector). Emblems are chunky,
single-mass silhouettes with at most two accent strokes.

**Value structure.** Dark ink frame → mid-value wood → one amber pool → one cold
window. The brightest 10 % of the frame is always the lamp bulb and the paper
stock; the darkest 40 % is the carriage walls and coat.

**Palette roles** (`src/data/palette.js`, edit there only):

| Role | Ids | Use |
| --- | --- | --- |
| Night / ink | `ink0`, `ink1`, `night2`, `night3` | Frame, walls, vignette, shadows |
| Glass / rain | `rain0`–`rain3` | Window, rain, cold fill, reflections |
| Wood | `wood0`–`wood4` | Table, bench, panelling, straps |
| Brass | `brass0`–`brass3` | Trim, lamp shade, hinges, buckles |
| Amber | `amber0`–`amber2` | Bulb, light cone, halo |
| Coat | `coat0`–`coat4` | Hood, coat, lighting ramp |
| Skin | `skin0`–`skin2` | Face and hands only |
| Seal | `seal0`, `seal1` | Accents only (conditions, wax) |
| Paper | `paper0`, `paper1`, `unlisted0` | Ticket stock |

**Edge treatment.** No outlines on 3D geometry (PS1 lineage); the 2D sprite keeps
a 1 px dark rim only on the hood so it separates from the wall.

**Detail density.** Geometry carries form; the sprite carries character. No
interior detail thinner than 1 internal pixel (≈ 4 screen px at 1280 wide).

## 3. The Inspector sprite

Composed procedurally from primitives (ellipses, quadratic shoulder curve,
tapering coat trapezoid) on the 1 px grid, so the silhouette is exactly
symmetric. 72 × 56 px.

- **Silhouette read**: hood arch + shoulder slope must be legible in one colour.
- **Secondary action**: 1 px breathing (~0.25 Hz), occasional 1 px head tilt,
  1 px hand lift. Four-frame idle — subtle, never distracting.
- **Window reflection**: a 10 % alpha mirrored smear inside the glass.
- **Mood grade**: `warm` (mid-duel) tints him toward amber; `cold` (results)
  tints toward rain-blue.

## 4. Ticket stock

| Element | Spec |
| --- | --- |
| Aspect | 100 × 140 viewBox, rendered into a 5.5 rem card (4.55 rem on phones) |
| Stock | `#e6dcc6` with a 4 % stain wash, a fold crease and serial dots |
| Tear edge | Half-circle perforations down both long edges |
| Header | Solid ink band with the line name and symbol code |
| Emblem | 58 px, ink fill, brass accent |
| Emblem pair (★) | Brass corner tab + notched corner (shape, not only colour) |
| Unlisted | Damp grey stock, dashed border, "NO NAME ON MANIFEST", 13 px black punch hole with a torn paper ring |
| Card back | Indigo stock, brass double rule, diagonal hatch, blind stamp |
| Variants | `variant` seeds the stain placement per slot, so no two tickets are identical |

## 5. Motion vocabulary

| Beat | Full profile | Reduced profile |
| --- | --- | --- |
| Card lift | 120 ms overshoot | 50 ms |
| Settle | 150 ms ease-out | 50 ms |
| Draw arrive | 170 ms overshoot + 2.4° arc | 60 ms |
| Pair snap | 190 ms scale + brass ring | 60 ms |
| Commit suspense | 460 ms darken + halfturn | 120 ms |
| Punch | 260 ms stepped squash | 60 ms |
| Lantern loss | 420 ms 6-step flicker + shake 2 | 60 ms, no shake |
| Ambient sway | sin/cos drift, 9.5 s period | off |

Every effect writes only `transform`/`opacity`/CSS variables and returns exactly
to its rest value. Reduced motion also disables rain drift, dust motes and film
grain.

## 6. Audio direction

Two buses under one master gain: `sfx` and `ambience`. Everything is synthesized.

| Cue | Recipe |
| --- | --- |
| Draw | Band-passed noise sweep 900 → 2600 Hz + low triangle |
| Flip | Short noise click + 700 → 420 Hz sine |
| Match | Paper snap (3 kHz noise) + A5/C6 brass triangle pair |
| Punch | 120 → 54 Hz thud + high-pass click + 1.18 kHz metal ring |
| Stamp | Soft 190 → 96 Hz thud + 1.2 kHz noise |
| Lantern loss | Glass rattle + descending minor third (G4 → D4) |
| Ambience | 190 Hz low-passed rumble with 0.23 Hz rocking wobble, gated rail clatter at 620 ms, A-minor drone (A2/E3/A3/E4) |

Mute is a single master-gain move (instant, total). Volume is remembered in
`the_unlisted_audio_v1`. The context is created only on a user gesture.

## 7. Asset manifest & provenance

| Asset | Source | Licence | Notes |
| --- | --- | --- | --- |
| Carriage geometry (442 tris) | Generated in `src/visuals/scene.js` | Project code | Procedural, deterministic |
| Inspector sprite | Generated in `src/visuals/scene.js` | Project code | `buildInspectorGrid()` |
| Ticket faces, back, emblems, wax marks | Generated in `src/visuals/tickets.js` | Project code | Inline SVG data URIs |
| All audio | Generated in `src/audio/sound.js` | Project code | Oscillators + one seeded noise buffer |
| Typography | System font stacks (`ui-monospace`, `Georgia`, `system-ui`) | System | Zero webfonts |
| Dev-only rasterisers (`tools/`) | Project code | — | Not shipped, not imported by the game |

No third-party art, audio, textures, or fonts are used, so there is no licence
obligation and no AI-disclosure surface for generated imagery.

## 8. Anti-patterns explicitly avoided

- Mixing styles: the 3D carriage, the 2D sprite and the SVG tickets share one
  palette and one light direction.
- Working at final resolution: all art is authored at 320×180 and upscaled.
- Over-detailing the background: the walls are three flat values; detail lives at
  the table.
- Colour-only state: locks, reveals, Emblem pairs, Gauge/Edge clues and Final
  Call all carry text and a distinct border shape.
- Shake on routine actions: only the punch and lantern loss shake, and never
  under reduced motion.

## 9. Verification

- `npm test` → Phase 4 suite #10–19 cover palette/quantisation, deterministic
  scene traces, stage fallback + disposal, ticket art, motion profiles, WebAudio,
  rapid-input lockout, keyboard/non-colour indicators, and responsive limits.
- Dev harness `node tools/renderPreview.js tools/out [time…]` renders PNG frames
  for human inspection; `tools/svgRaster.js` rasterises the ticket SVGs.
- Human check still required: look at the live preview on a real phone
  (390×844) and on desktop 1280×800 and confirm the lamp pool, the hood
  silhouette and the ticket text read.
