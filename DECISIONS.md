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
| G12 IFF | friendly beacon brightens pixels; armed figures carrying one; operator-vs-hostile shape with every beacon dark | ≥ 25 lit; **0** armed; ≥ 0.22 unlit |
| G11 muzzle flash | ground pixels brightened by a firing figure, zoom step 2 | ≥ 80 |
| G8 performance | p95 frame time, 1280×720, vsync off, ≥ 400 samples | ≤ 20 ms |
| G9 phone | 390×844: touch controls hit-test to themselves; no horizontal overflow | all reachable; `scrollWidth ≤ clientWidth` |
| G10 live loop | 20 s of real frames, no input | sim time advances ≥ 15 s and the on-screen timecode changes |
| G13 clutter present (§24) | clutter instances inside the sensor frustum, at every G5 phase capture | ≥ 40 at the fewest |
| G14 clutter stays cold (§24) | p95 luminance of pixels clutter brightens, at every G5 phase capture | ≤ 0.70 at the brightest |
| G15 long shadows (§24) | the G6 probe, held to twice the §18 baseline of 169 | ≥ 338 darkened |
| G16 bloom selectivity (§24) | 105 mm impact at view centre, glow buffer only | < 2% of pixels beyond 30 m touched; impact region ≥ 20× the far mean |

| G17 TV identification (§25) | G7's worst-pair Jaccard, on the TV channel, figure = pixels darker than 0.20 | ≥ 0.28; every mask > 20 px |

G8 and G10's pace clause are wall-clock measurements and only mean anything on
the reference machine (Mac, Metal). Off it — a Linux box, a cloud session — the
browser falls back to SwiftShader, which renders a frame every few seconds. The
gate then reports G8 as **SKIP**, not pass, and G10 asserts liveness only, and
both say so in their titles. A cloud run cannot sign off performance.

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

## Visibility pass — "enemy colour should be easy to see"

Owner feedback after playing. Investigating it found that the complaint was
not really about colour: a frame containing seven hostiles had no cue that any
of them existed, and the cause was that **cold clutter rendered as brightly as
people**. With a 0.55 albedo term a pale rock came out at 0.57 against a body
at 0.97, so a battlefield read as a field of pebbles.

Four changes, in order of how much they mattered:

1. **Heat, not albedo, decides brightness.** The albedo term dropped from 0.55
   to 0.20 so every cold thing clusters in one narrow band just above the
   floor, whatever colour it happens to be. This is also simply what a thermal
   image looks like.
2. **Hot things emit.** Emissive went from a flat `heat * 0.42` to
   `warm^1.4 * 0.95`, so a body is bright on its own account rather than
   depending on how the sun catches it. At the default zoom a figure is only a
   few pixels wide and a merely light-grey one is averaged away by
   antialiasing before it reaches the eye; a self-lit one survives being small
   and stays visible inside a shadow.
3. **Muzzle flashes**, with brighter, longer-lived tracers. This is the only
   identification channel in the game that sidesteps the silhouette problem: a
   figure shooting at the ground team has identified itself by its own action,
   exactly as it would in reality, and civilians never produce one. Gated by
   **G11**, because catching one by luck in a screenshot is not evidence — it
   measures 164 lit pixels against a threshold of 80.
4. **Masonry carries a little heat** (0.13 walls, 0.10 roofs). Real — stone
   gives back the day's warmth for hours — and necessary once cold things all
   sat in one band, or the buildings sank into the ground. A chokepoint whose
   objective is "watch the rooftops" needs visible rooftops.

Spawn range for infantry waves came in from 120–185 m to 100–155 m, so contact
walks into the default view instead of always having to be panned to. Balance
stayed ordered and winnable: pinning 31/54/74 s and breaches 25/50/73 across
Easy/Normal/Hard, unaided still lost 5/5 everywhere.

**Tried and reverted: widening the default zoom to step 1.** It shows more
ground, but at 19° a figure is about ten pixels tall and three wide and
antialiasing washes it out, so the wider view made people *harder* to see —
the opposite of the point. Finding contacts is the minimap's job; the default
step is sized so that what is on screen is legible.

## Identification-friend-or-foe, and honest spawn distances

Two pieces of owner feedback: the player needed better IFF, and spawns were
too close to be believable.

**Infrared strobes on the ground team.** The real system, and the one the
mission had been claiming all along — the opening radio call has always said
"we have your strobes" and there were none. Friendly troops wear an infrared
beacon a gunship sensor sees and the naked eye does not.

This is the only marking that does not damage the identification problem, and
the reason is what it does *not* say. A strobe means "certainly friendly". No
strobe means "unknown" — civilian or hostile, still the player's job to work
out by silhouette and movement. Marking your own people is free; marking the
enemy never is. **G12** gates both halves: the beacon must brighten the image,
and no armed figure may carry one. The second assertion is the important one.

Beacons blink at 0.75 s with a 0.25 s on-time, phase-staggered per operator, so
the team reads as several independent lights and roughly two of six are lit at
any instant.

**Spawn distances made honest.** Infantry now approach from 170–260 m rather
than 100–155, rocket teams from 160–240, vehicles from 300–440. People do not
materialise beside a column in open ground; they walk in from somewhere, and
that walk is the player's window to deal with them.

Close contacts survive, but only where they are explicable: the simulation now
honours a close spawn **only where there is real cover within 60 m**, places the
figure on the far side of it from the column, and otherwise downgrades the
request to an ordinary distant approach. Legs with no buildings therefore have
no ambushes at all — which is exactly right for the open-ground leg, whose
whole identity is that there is nothing to hide behind. Cover was added along
the departure and final-approach legs so those can still surprise you; the open
leg was deliberately left bare, and its danger is wheels closing from the
horizon. Gated by a test that asserts every close spawn came out of cover.

### Two bugs this surfaced

- **Operators healed while the column was pinned.** Recovery keyed off "no
  enemy within engagement range" (70 m) while pinning happens at 95 m, so a
  contact sitting in the gap stopped the column *and* let the team regenerate.
  An unaided mission could stalemate on the line of departure for fifty
  minutes instead of being lost. Recovery now also requires the column to be
  moving.
- **Mortars ranged on the column head only**, so rounds landed near the lead
  operators and effectively never near the civilians trailing eight to forty
  metres back. That quietly cancelled the rule that an enemy tube can end a
  Hardcore run. Tubes now bracket the length of the column.

Balance after all of it, scripted gunner, five seeds — pinning 9/17/33 s,
breaches 6/14/30, ammunition spare 1244/483/43, all won 5/5, unaided lost 5/5
on every difficulty in six to seven minutes with no stalemate.

### Also fixed

`verify.sh`'s dependency-manifest scanner treated a test named
"...cover to appear from" as an import, because it allowed `from` to be
followed immediately by a quote. It now requires whitespace and forbids a
specifier spanning a newline.

## Thermal identification panels — the continuous half of IFF

Owner feedback after the strobes: *"enemy should not be same color despite they
are in infrared. Special force could wear reflective so they could see them
from above."*

The proposed fix is the right one, and it is the half the strobes were missing:
a beacon that blinks tells you nothing between flashes. The ground team now
also wears **thermal identification panels** — real kit, and they work by being
*cold*. A panel that does not radiate reads as a dark bar lying across a
white-hot body, and nothing else on this battlefield produces that signature by
accident. Shoulders, helmet top, and one down the back so the marking survives
being seen from behind.

So a friendly is now: a hot figure, cut by dark bars, with an occasional bright
flash. An unmarked hot blob is not one of yours.

**What was not done, and why.** Colour-coding hostiles. Everything in this game
is one sensor channel, so "a different colour for the enemy" can only mean
tagging figures the player has not identified yet — which deletes the civilian
identification problem outright and with it the reason the premise is
interesting. Marking the *friendlies* answers the same need from the other
side: it says "this one is ours" and never "that one is not a civilian". The
information only ever runs one way, and G12 enforces that by asserting no armed
figure carries either marker.

G12 now gates both halves: the beacon must brighten the image (123 pixels
against a threshold of 25), no armed figure may carry one, and with **every
beacon dark** an operator must still differ from a hostile by 0.22 Jaccard
distance — measured at 0.258. The first attempt scored 0.206 and the panels
were enlarged rather than the threshold lowered.

## Visual upgrade — the trailer reference (§24)

Owner direction: make SPECTRE look like an unlisted Unity trailer (one 0:10
still supplied). Engine stays Three.js — the trailer is a visual target, and
everything it asks for lives in `src/render/`, `src/assets/` and `src/ui/`.
`src/sim/` was not touched; all 23 headless tests are unchanged and green.

What the reference frame has that SPECTRE did not, and what was done:

- **Clutter.** Nine new procedural models — corrugated fence, pickup, sedan,
  junk pile, trailer, dead tree, grass, scrub, drums — scattered by a seeded
  pass along fence lines, yards and roadsides, kept off the track, out of
  building footprints and away from the identification probe's patch. Drawn
  instanced, so the whole lot is a couple of dozen draw calls.
- **Pale ground, black shadows.** The reference is hard-lit: long shadows cut
  into a light surface. That needs two things at once, and the first attempt
  had only one. Lowering the sun and thinning the ambient made long shadows,
  but the ground still sat at ~0.15 luminance and the shadows had nothing to
  cut into. So the ground and track are lifted with a per-material
  `coldGain` (1.6 / 1.45), the sun sits about 15° up at 7.5 intensity, the
  hemisphere fill is 0.45, and the shadow filter is PCF rather than PCFSoft
  so edges stay hard.
- **Clutter one step below the cold band.** At the plain band the low sun hit
  fence sheets and car panels square-on and their lit faces reached 0.73,
  failing G14's pre-registered 0.70 on the first run. The threshold stayed;
  clutter's `coldGain` came down to 0.82 (0.67 measured after).
- **Explosions.** White-hot core with selective bloom (only effects are drawn
  into the glow buffer, so bodies never bloom and silhouettes are never
  smeared), dark plumes that cool within the first fifth of their life and
  drift on the wind, thrown dirt, and smouldering wrecks and buildings.
- **Ground texture.** Tiled dirt/gravel with soft soil patches to break the
  repeat, and tyre ruts down the track.
- **Characters.** Torso and limbs are capsules with exactly the footprint of
  the boxes they replace — the silhouettes were tuned box by box against G7,
  so only the corners went. Identification *improved*: worst
  civilian/armed pair 0.369 → 0.400, operator vs hostile with beacons dark
  0.276 → 0.299. Slimmer corners did cost shadow area (G15 dropped to 327 on
  that run), recovered by the 0.45 fill and a slightly lower sun — to 341.
  That margin is thin; if a GPU difference tips it, lower the sun before
  touching the threshold.
- **Camera and HUD.** Orbit radius 400 → 330 m (about 45° depression, closer
  to the reference framing). The radio log keeps three lines of history and
  no longer duplicates the subtitle on air.

### Gates added

G13–G16, thresholds in the table above, all set before their first run. G14
and G15 each failed once and in both cases the build was changed, not the
number.

### Not verifiable here

This pass was built in a cloud session with no GPU. Every gate except
performance was run there on SwiftShader; G8 reports SKIP and G10 asserts
liveness only. **Run `./verify.sh` on the Mac before calling the frame time
good.** Scene load went from ~47k to ~400k triangles, almost all of it
instanced clutter; the first thing to cut if G8 fails is clutter density
(grass and junk counts in `Terrain.scatterClutter`), not shadows.

## TV channel — closer to the reference (§25)

Owner, after §24: *"I want graphic closer to [the] picture."* Putting the two
frames side by side showed the gap was not detail but **channel**: the
reference is daylight/low-light TV footage — dark figures, a pale lit ground,
black shadows, white fire — and SPECTRE was thermal, where people are the
brightest thing in frame. No amount of clutter closes that.

Owner chose: **TV channel added and made the default; thermal one key away.**
§2's "thermal only" is amended accordingly. Q now cycles TV → IR white-hot →
IR black-hot.

- **How it works.** `SensorRenderer.apply` computes both a thermal and a TV
  response for every material and stores them; switching channel is one loop
  over known materials, no reload. TV albedo comes from the sRGB optical
  colour (an early version used the linearised value and rendered the whole
  ground black). Figure materials are tagged at build time with a dark `tv`
  value — clothing, kit, skin and weapons all — so people read dark on any
  ground. Dry plants carry `tvGain` 0.55 so grass never reads paler than dirt.
  The post shader adds a TV exposure (1.2) into a soft shoulder plus contrast,
  neutral grey with no phosphor tint.
- **IFF on TV.** Strobes and thermal panels are infrared kit and are invisible
  on the TV channel, by physics: the beacon is hidden whenever TV is on. The
  HUD's GHOST tags still mark the ground team; the IR kit is there to confirm
  in thermal. This is the honest trade of a TV default.
- **Sun per channel.** The reference sun is higher than §24's (shadows about
  1.5 figure-heights, not 4). TV raises the sun to roughly 30°; thermal keeps
  the low sun that G6/G15 were registered against. The probes run in thermal,
  so neither gate's meaning changed.
- **Framing.** Default zoom TIGHT (8°) instead of NARO (12°). The reference is
  shot about as tight as MAX. §21 found a *wider* default made people harder
  to see; tighter does the opposite, and finding contacts stays with the
  minimap and pan keys.
- **Scene.** Long fence walls (5–15 segments) instead of stubs, 26 walled
  yards with a gap facing the route, board fences with ragged tops, 110 dead
  tree stands (was 64), twice the grass clumps weighted toward the track with
  taller, fuller tufts, denser and darker soil patches, finer gravel (the old
  dabs read as polka dots on TV), darker rocks, and a faint thin impact ring
  in place of the hard white disc.
- **Figures.** Legs in mid-stride instead of standing stiff. Identification
  held on both channels: thermal worst pair 0.418, TV worst pair 0.391.

### Gates

The identification probes (`&idprobe`) default to the thermal channel, the
channel their thresholds were registered on. G14 forces thermal inside its
probe, since it asks whether clutter can pass for a body on IR. **G17** is
new: G7's worst-pair rule on the TV channel, with a figure's mask being its
dark pixels, plus a floor on mask area so an empty mask cannot pass.

### Clutter chunking

The denser scene first measured **886k triangles** under load. Cause: each
clutter kind was one InstancedMesh spanning the whole route, and an
InstancedMesh is frustum-culled as a unit, so every fence, tree and tuft on
the map drew every frame. Clutter is now bucketed into 140 m chunks, one
InstancedMesh per kind, part and chunk, sharing one material per source.
Measured after: **129k** at the default TIGHT zoom, 206k at NARO — lower than
§24's 393k despite roughly twice the clutter. The off-reference G10 failure on
that heavy build (0.4 s of game time in 20 s of SwiftShader) was this.

### What still separates the frames

The reference is hand-made art: sculpted, animated characters mid-run,
textured wrecks, debris piles. SPECTRE's models are procedural low-poly
boxes and capsules, and figures do not animate. That is the remaining gap,
and closing it is an asset job (Blender tier 2, or animated rigs), not a
rendering one.
