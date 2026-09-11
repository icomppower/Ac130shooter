# SPECTRE — Night Watch

An AC-130 gunship escort mission. The full design spec lives in Notion
(`3d81f269-eaea-8112-a709-dabd8372d2e2`); this file is the working summary the
build is checked against.

## What it is

You are the sensor and guns of an AC-130 — a fixed-wing gunship that orbits a
target area and fires from its left side. A ground team, Ghost One-One, is
walking fourteen civilians 1.4 km across open country to a landing zone. You
cannot move them and you cannot be everywhere. All you can do is clear the
ground in front of them.

**Identity anchor: 1990s AC-130 gun-camera tape.** Thermal only, with a
white-hot/black-hot polarity switch. No night vision. No optical mode.
Scanlines, sensor grain, frame judder, horizontal tearing on hard slews, and
burned-in corner telemetry. The flatness is a commitment, not a shortfall.

## The loop

The column advances only while no hostile is within 95 m of its head. Every
metre it gains is a metre the player bought. Mortars sit deliberately outside
that radius: they bleed the column without stopping it, so they have to be
hunted rather than waited out.

Five phases, and they are route legs rather than arbitrary waves — departure,
open ground, built-up chokepoint, final approach, and the hold at the landing
zone with the extraction inbound. Threats are always called relative to the
column's axis of advance: ahead, left flank, right flank, trailing. There are
no named roads to memorise.

## The moral core

Civilians are the escorted party, not set dressing. They straggle, bunch up,
panic and scatter under fire, so danger-close is continuous and emergent rather
than scripted.

**Every person on the ground is hot.** Heat can never tell a civilian from a
hostile. What tells them apart is silhouette and movement: a hostile carries
something long, thin and horizontal; a civilian carries a bundle, a headload,
or pushes a handcart. That distinction is measured by the kill gate, not
assumed.

Two casualty modes. **Score** penalises. **Hardcore** ends the mission on any
civilian death, including one caused by enemy mortar fire.

## The minimap

Promoted from decoration to a primary instrument, because a moving column means
the player can no longer learn where to look.

**Hard rule: it shows unclassified contacts and never labelled enemies.** It
tells the player *where* to look, never *what* a contact is. Blips carry a
position and an expiry and nothing else, and they decay if not re-observed —
stale intel, not omniscience. Hard difficulty shortens their life. The moment
the map labels hostiles, identification is solved for free and the civilian
system dies with it.

## Architecture

- `src/sim/` — the simulation. Headless, zero runtime dependencies, no Three.js
  import anywhere. Seeded throughout: determinism is a gate.
- `src/render/`, `src/assets/` — Three.js, scoped to drawing. Reads sim state,
  never owns it.
- `src/ui/`, `src/game/` — HUD, minimap, input, lifecycle.
- `src/audio/` — synthesized, no external assets.

## The three rendering fixes

The reference build's flat look traces to three decisions, all reversed here.

1. **One directional shadow-casting light**, low in the sky, its volume riding
   with the view. Without ground contact shadows every unit reads as a decal.
2. **Contact darkening under every unit**, on top of the shadow map, because a
   single low sun still leaves a small figure with nothing beneath it.
3. **A screen flash on 105 mm impact** — a full-frame luminance spike plus a
   lit patch of ground, so the heavy round reads as heavier and not just
   louder.

Supporting all three: the camera is a **perspective** camera on an orbit, tuned
so near objects visibly slide against far ones. The orbit is the only
continuous depth cue available from altitude and an orthographic projection
throws it away.

## Carried over

From `ac130astra`: the five-phase director, the civilian system and both
casualty modes, difficulty scaling, S–F grading, the bounded priority radio
queue, staged building damage, headless mission tests, the tuned weapon table,
and `src/audio/` verbatim.

From the Canvas build: the power bar and weapons-free window, the infrared
polarity toggle, replacement operators on a kill threshold, the loud helicopter
extraction, and the debug flags that make the kill gate possible.

## Verification

`./verify.sh` runs the whole ladder. Thresholds are pre-registered in
`DECISIONS.md` and two gates carry paired negative tests. See `README.md` for
the debug flags.
