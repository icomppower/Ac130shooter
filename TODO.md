# TODO

Nothing here blocks play. Ordered by how much it would actually improve the
game, not by how easy it is.

## Worth doing

- **Difficulty barely changes the outcome.** The scripted gunner wins Easy,
  Normal and Hard at 11.4 minutes with 14/14 civilians extracted; only the
  ammunition left over really moves (1219 / 670 / 111). That is fine as proof
  the mission is winnable, but it means the difficulty curve is currently
  expressed almost entirely in spare rounds. A human will feel it differently,
  and it should be watched once someone has actually played all three.

- **Easy is winnable with a silent gunship.** Normal and Hard are not, and the
  headless test asserts that. Easy surviving unaided is defensible for an easy
  mode, but it does mean the aircraft is optional there.

- **The column never gets meaningfully pinned when the gunship plays well.**
  With the scripted gunner it spends about one second stopped across the whole
  mission, against 297 seconds unaided. The mechanic works, but the
  well-played path never feels the pressure it was built to create. Worth
  tuning the pin radius or the spawn pressure once there is human play data.

- **Exterior flyby camera.** Cut from the spec unless it earns its place
  during polish. It has not been built.

## Smaller

- The buildings all use one house model rescaled. The chokepoint would read
  better with two or three footprint types.
- Civilians only carry a handcart on every fourth slot. More variety in the
  column would help identification at wide zoom.
- The after-action report is dense; it could group the escort numbers apart
  from the gunnery numbers.

## Deliberately not doing

- **Night vision and optical sensor modes.** Cut by the spec. The identity
  anchor is a thermal tape and nothing else.
- **Chasing photorealism.** The flatness is the point.
- **Moving the Blender pack onto the critical path.** It ran, it was judged
  against the procedural pack at altitude, and it tied. `DECISIONS.md` has the
  numbers. Re-open it only with a specific reason, not as general polish.
