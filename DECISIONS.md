# Decisions

Decisions that are not recoverable from the code, and the pre-registered
thresholds the kill gate is judged against. Thresholds were written here
**before** the gate was first run. If one fails, the build gets fixed — the
number does not get moved.

## Owner decisions taken before the build

**Civilian/hostile distinguishability gate → scripted pixel-difference.**
The spec flagged this clause as unsatisfiable by an autonomous loop: nothing in
the loop can decide "a human could tell these apart". Resolved as a measurement
(below) rather than a human review gate, so the ladder is fully binary. Paired
with a mutation test, because a metric that cannot fail is not a gate.

**Replacement operators exist in both casualty modes.** Not Score-only. In
Hardcore they are the only way back from operator losses, and Hardcore is
already punishing enough through the civilian rule — a mode that is unforgiving
about civilians *and* unrecoverable about operators is just a shorter mode.

## Build decisions

**Perspective camera, not orthographic.** The reference build used an
`OrthographicCamera`, which is the mechanical cause of its flat look: with no
perspective divide, near and far buildings never slide against each other as
the aircraft comes round, so the orbit stops being a depth cue. Altitude 330 m
over an orbit radius of 400 m gives a depression angle of about 39°, which is
oblique enough for the parallax to be obvious and steep enough to see into
streets.

**Zoom is field-of-view, five steps, default step 2 (12°).** Slant range is
~520 m, so at the widest step a 2.4 m figure is a few pixels tall and nobody
could identify it — that step is for finding things, not naming them. This is
also why the identification gate is measured at the mission's default zoom
rather than at maximum zoom: passing only when fully zoomed in would prove
nothing about how the game is actually played.

**Weapon table carried over from ac130astra unchanged.** No recorded reason to
move any of it yet. The headless mission finishes with ammunition in hand on
every difficulty (111 rounds spare on Hard), so the reserves are tight rather
than generous, which is the intent.

**The column is pinned by contact inside 95 m.** This is the core loop: the
player is not defending a place, they are buying metres. Mortars deliberately
sit outside that radius — they bleed the column without stopping it, so they
have to be hunted rather than waited out.

**Contact shadows are separate from the shadow map, and both ship.** The shadow
map gives a correct directional shadow; at this altitude a single low sun still
leaves a small figure with almost nothing under it, so a soft blob is pressed
under every unit as well. Removing either one brings back the decal look.

**Sim is zero-dependency and has no Three.js import anywhere.** `src/sim/`
never imports a renderer. `verify.sh` checks this rather than trusting it.

**Audio module copied from ac130astra verbatim.** Only the import path and the
`speechSynthesis` guards changed; the helicopter, engine bed, warning tones and
firefight layer are appended below the copied code, not woven into it. The
helicopter synthesis is ported directly from the Canvas build.

## Pre-registered gate thresholds

| Gate | Measure | Threshold |
| --- | --- | --- |
| G0 boot | console errors; GLB load failures | 0 errors; 0 fallbacks (whole pack loaded) |
| G1 build | `tsc --noEmit` and `vite build` | exit 0 |
| G2 manifest | bare imports under `src/` and `tools/` declared in `package.json` | every one declared |
| G3 headless | `npm test` | all pass, including full-mission victory |
| G4 negative: unaided | mission flown with a silent gunship, every difficulty, 3 seeds | must be **lost** |
| G5 phases | phases observed across fast-forward captures | all 5, non-decreasing |
| G6 shadows | ground pixels darkened by the shadow map, near one figure | ≥ 150 darkened; reverse < ⅓ of that |
| G6n shadows, negative | same probe on a `mutate=noshadows` build | < 50 darkened |
| G7 silhouette | Jaccard distance, **worst** civilian-variant/armed-figure pair, zoom step 2 | ≥ 0.28 |
| G7n silhouette, negative | same, on a `mutate=samemodel` build | < 0.10 |
| G8 performance | p95 frame time, 1280×720, vsync off, ≥ 400 samples | ≤ 20 ms |
| G9 phone | 390×844: touch controls hit-test to themselves; no horizontal overflow | all reachable; `scrollWidth ≤ clientWidth` |
| G10 live loop | 20 s of real frames, no input | sim time advances ≥ 15 s and the on-screen timecode changes |

### Why the negative tests are there

A gate that passes regardless of build state is worse than no gate, because it
reads as evidence. G6 could pass on ambient shading alone, so G6n runs the same
probe on a build with the shadow map compiled out and requires it to fail. G7
could pass on sensor noise or a position difference, so G7n renders the
civilian using the hostile model and requires the distance to collapse. Both
negatives are asserted, not assumed.

## Tier 2 Blender comparison — run, judged, closed

Blender 5.2.1 LTS was present on this machine, so unlike the reference build
the tier 2 script actually executed (21 models at the time; 25 now), exported over
`public/models/`, with `tools/spectre-assets.blend` saved alongside.

One comparison pass, as pre-registered. Same still, in thermal, at gunship
altitude, procedural pack beside Blender pack:

| | procedural (tier 1) | Blender (tier 2) |
| --- | --- | --- |
| civilian/hostile distance, zoom 2 | 0.4032 | 0.3984 |
| civilian/hostile distance, zoom 4 | 0.4286 | 0.4239 |
| shadowed ground pixels | 169 | 172 |
| scene triangles | 39,498 | 40,442 |
| GLB load failures | 0 | 0 |

**Verdict: tier 1 ships.** The two captures are indistinguishable at altitude,
which is what the spec predicted would happen — geometry that reads well up
close is just a grey shape from the orbit. The bar was "visibly better", the
result was "identical", and the tie-break is the procedural pack. It costs
nothing, carries no external dependency, and is already the pack the kill gate
passed on.

Tier 2 stays in the repo as a working, executed, optional path. Running
`npm run assets:blender` swaps the pack; running `npm run assets` puts it back.
No gameplay, damage, mission or scoring code is touched either way.

## Balance pass — closing out the difficulty problem

The first shipped balance had a real hole: measured across five seeds, all
three difficulties finished in 11.4 minutes with 14/14 civilians extracted and
six operators alive, and the only thing that moved was leftover ammunition.
Worse, the escort could win *unaided* on Easy and on two seeds out of five on
Normal, so for part of the difficulty range the gunship was decoration.

The cause was the ground team, not the difficulty numbers. Six operators with
96 m of reach and ~20 damage per second each cleared every wave on the approach
— with the gunship flying, only about **one** hostile per mission ever got
within the 95 m stopping distance, so the column was essentially never pinned
and the "buy metres" loop never engaged.

Three changes:

- **Operators suppress, they do not clear.** Reach 96 → 70 m, damage 24 → 17,
  cycle 1.2 → 1.45 s, out-of-contact recovery 3.5 → 2.0 hp/s.
- **Ambushes.** A per-wave quota of contacts that spawn at 48–88 m, stepping
  out of the nearest cover, from the second leg onward. Everything else spawns
  120 m or further out and can be killed on the approach; an ambush cannot be
  pre-empted because it was not there to shoot at. This is the only pressure
  that survives a competent gunner.
- **Wider difficulty scaling** on spawn count, spawn pace, enemy damage,
  operator health and ammunition reserve.

Measured again over five seeds with the scripted gunner, which is the *floor* —
a human sees a wider spread, not a narrower one:

| | Easy | Normal | Hard |
| --- | ---: | ---: | ---: |
| won | 5/5 | 5/5 | 5/5 |
| seconds pinned | 25 | 51 | 61 |
| hostiles reaching the column | 19 | 43 | 51 |
| rounds left over | 1237 | 535 | 130 |
| **unaided (silent gunship)** | **0/5** | **0/5** | **0/5** |

Both findings are now locked by tests: `without the gunship the escort is
overrun on every difficulty` covers all three difficulties over three seeds,
and `difficulty changes the pressure, not just the leftovers` asserts that
pinning, kill load and ammunition margin are all ordered across difficulties.

## Radio repetition

The scrollback was showing the same sentence up to four times. Fixed with a
26-second per-line repeat window plus a pool of alternative lines for routine
chatter. The window is checked when a line is *offered*, never when a queued
line is promoted to air — checking on promotion would silence every message
that had to wait behind a higher-priority one, which is a bug the first
implementation actually had and a test now covers.
