# TODO

Everything from the first pass is closed. What is left needs a human at the
controls, not another gate.

## Needs real play, not more tuning

- **The balance is verified against a scripted gunner, which is a floor, not a
  player.** It never fires unsafely, never panics, and never loses track of the
  column, so it extracts 14/14 on every difficulty. The numbers that separate
  the difficulties for it are pinning (25 / 51 / 61 s), hostiles reaching the
  column (19 / 43 / 51) and ammunition left over (1237 / 535 / 130). Whether
  that feels like three difficulties from the seat is the one question the
  harness cannot answer.
- **Nobody has lost an operator with the gunship flying.** The scripted gunner
  finishes 6/6 on all three. That is plausible — it clears threats before they
  close — but it means the replacement-operator mechanic has never fired in a
  real game, only in its unit test.

## Cut, and staying cut

- **Exterior flyby camera.** Cut by the spec unless it earned its place during
  polish. It did not: the identity anchor is a sensor tape, and cutting away to
  a beauty shot of the aircraft breaks the one thing the whole presentation is
  built on. The helicopter arriving loud is the climax, and it is on the
  sensor where the player is already looking.
- **Night vision and optical sensor modes.** Cut by the spec. Thermal only.
- **Chasing photorealism.** The flatness is the point.

## Only with a specific reason

- **Blender tier 2.** It runs, it stays in step with the procedural pack, and
  it was judged at altitude and tied. `DECISIONS.md` has the numbers. Re-open
  it for a specific goal, never as general polish.
- **Bundle size.** 666 kB, 178 kB gzipped, essentially all Three.js. Code
  splitting would trade a simple build for a faster first paint on a page that
  already loads in well under a second.
