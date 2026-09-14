# State

**2026-09-11 — rebuild complete, balance pass done, all gates green, shipped.**

The Canvas 2D build is tagged `canvas-v1` and the repo now holds the Three.js
rebuild described in `SPEC.md`.

## Where it stands

All twelve build-order steps are done. `./verify.sh` passes end to end:
7 structural and headless gates, then 9 browser gates.

| | |
| --- | --- |
| Headless simulation tests | 23 / 23 |
| Browser kill gate | 11 / 11 |
| Full mission, scripted gunner, Normal | won at 12.4 min, grade A, 14/14 extracted, 535 rounds spare |
| Difficulty spread (5 seeds): seconds pinned | 25 / 51 / 61 across Easy / Normal / Hard |
| Difficulty spread: rounds left over | 1237 / 535 / 130 |
| Unaided (silent gunship), **every** difficulty, 5 seeds | **lost** at ~30% of route, as required |
| p95 frame time, 1280×720, vsync off | 4.0 ms (threshold 20 ms), 294 draw calls, 47k triangles |
| Silhouette distance, worst of 9 civilian/armed pairs, default zoom | 0.369 (threshold 0.28); collapses to 0.000 under mutation |
| Shadowed ground pixels beside a unit | 169 (threshold 150); 0 under mutation |
| Phone, 390×844 | 16 controls, all reachable, no horizontal overflow |

## What the gates caught that review would not have

- The perf gate originally fast-forwarded past the end of the mission and
  reported a 2.8 ms p95 for an empty map. It now has to prove the scene was
  populated and the mission live while it measured.
- Shadows were effectively absent: a 0.6 m normal bias erased the shadow of a
  0.8 m-wide figure, and the ambient light was brighter than the sun, so a
  shadowed patch lost almost none of its illumination. The probe measured 0
  darkened pixels and said so.
- The whole battlefield was rendering at 7% luminance. The numeric gates were
  all green; opening the frame showed a nearly black screen.
- Eleven touch buttons were rendering unpositioned over the telemetry on every
  desktop screen, because the container was shown outside the media query that
  positions it.
- Four touch controls on the phone layout were visible but not pressable: the
  pad row ran underneath the direction pad and the fire button.
- The camera anchor eased toward the column at a fixed rate, so after a pause
  or a fast-forward the player stared at empty ground for several seconds.

## Second pass — the balance problem the first pass left open

The first shipped balance had every difficulty finishing identically, and the
escort could win unaided on Easy and on two seeds of five on Normal. Cause: the
ground team was strong enough to clear every wave on the approach, so with the
gunship flying only about one hostile per mission ever reached the column and
the "buy metres" loop never engaged. Fixed by weakening the ground team to a
suppressing force, adding close ambushes that cannot be pre-empted, and
widening the difficulty scaling. Both findings are now locked by tests.
Details and numbers in `DECISIONS.md`.

Also this pass: three house types instead of one rescaled model, three civilian
body types plus handcarts, a grouped after-action report, and a fix for the
radio repeating the same line four times in the log.

## Third pass — visibility

Owner feedback: "enemy colour should be easy to see, right now hard to read."
The cause turned out to be that cold clutter rendered as brightly as people, so
a frame with seven hostiles in it had no cue that any existed. Fixed by making
heat rather than albedo decide brightness, making hot bodies emissive, adding
muzzle flashes (now gated as G11), and giving masonry a little thermal mass so
buildings did not sink into the ground once terrain went dark. Details in
`DECISIONS.md`.

## Fourth pass — IFF and spawn realism

Ground team now wears infrared strobes *and* cold thermal identification
panels: the real identification-friend-or-foe kit, and the strobes alone left a
gap because a blinking light says nothing between flashes. Gated at G12 on
three counts — the beacon brightens the image, nothing armed carries either
marker, and with every beacon dark an operator still does not look like a
hostile.

Spawn distances made honest (infantry 170–260 m, vehicles 300–440 m), with
close contacts honoured only where there is real cover to emerge from.
Surfaced two genuine bugs: operators healed while the column was pinned, which
let an unaided run stalemate for fifty minutes instead of losing; and mortars
ranged only on the column head, so they effectively never endangered the
civilians the Hardcore rule is about. Details in `DECISIONS.md`.

## Not done

See `TODO.md`. Nothing outstanding blocks play; what remains needs a human at
the controls rather than another gate.
