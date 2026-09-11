# State

**2026-09-11 — rebuild complete, all gates green, shipped.**

The Canvas 2D build is tagged `canvas-v1` and the repo now holds the Three.js
rebuild described in `SPEC.md`.

## Where it stands

All twelve build-order steps are done. `./verify.sh` passes end to end:
7 structural and headless gates, then 9 browser gates.

| | |
| --- | --- |
| Headless simulation tests | 19 / 19 |
| Browser kill gate | 9 / 9 |
| Full mission, scripted gunner, Normal | won at 11.4 min, grade S, 14/14 extracted, 670 rounds spare |
| Hard | won at 11.4 min, grade A, 14/14 extracted, 111 rounds spare |
| Unaided (silent gunship), Normal and Hard | **lost** at 77–80% of route, as required |
| p95 frame time, 1280×720, vsync off | 4.0 ms (threshold 20 ms), 294 draw calls, 47k triangles |
| Civilian/hostile silhouette distance, default zoom | 0.403 (threshold 0.28); collapses to 0.000 under mutation |
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

## Not done

See `TODO.md`. Nothing outstanding blocks play.
