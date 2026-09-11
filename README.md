# SPECTRE — Night Watch

**[Play it](https://icomppower.github.io/Ac130shooter/)**

An AC-130 gunship escort mission, rendered as 1990s gun-camera tape. A ground
team is walking fourteen civilians across 1.4 km of open country to a landing
zone, and the column only moves while the ground in front of it is clear.

Your sensor is infrared. Everyone down there is hot, so heat will never tell
you who is who — a hostile carries something long and horizontal, a civilian
carries a bundle or pushes a cart. Look before you fire.

Acronyms, spelled out once: **AC-130** is a fixed-wing gunship that orbits a
target area and fires from its left side. **LZ** is the landing zone. **IR** is
infrared. **RPG** is a shoulder-fired rocket. **MG** is a machine-gun team.
**ROE** is the rules of engagement — who you are permitted to shoot.

## Run it

Requires Node.js 20.19+ or 22.12+.

```sh
npm install
npm run dev        # development server
npm run build      # type-check and build to dist/
npm run preview    # serve the production build
npm test           # headless simulation tests
./verify.sh        # the full verification ladder, including the browser gate
./verify.sh --fast # everything except the browser gate
```

No accounts, API keys, paid services, content delivery networks or runtime
network calls. Three.js is the only runtime dependency, and only the rendering
layer imports it. All audio is synthesized in the browser.

Do not open `index.html` over `file://` — use the dev or preview server.

## Controls

| Input | Action |
| --- | --- |
| Mouse | Aim the sensor |
| Hold left mouse | Fire |
| 1 / 2 / 3 | 25 mm, 40 mm, 105 mm |
| R | Reload |
| WASD or arrows | Pan the view around the column |
| Wheel, or + / − | Zoom, five steps |
| Q | Infrared polarity, white hot / black hot |
| Tab | Slew to the next called-out threat |
| Space | Hold the aim point |
| F | Spend a full power bar for a weapons-free window |
| Esc | Pause |

On a touch screen: hold FIRE, pan with the direction pad, and use the button
row for weapons, zoom, reload, polarity, next threat, aim hold and the
weapons-free window. The layout is checked at 390×844 by the kill gate.

## The mission

Five phases, and they are route legs rather than timed waves: departure, open
ground, built-up chokepoint, final approach, and the hold at the landing zone
while the extraction helicopter comes in. Threats are called relative to the
column's axis of advance — ahead, flanking, trailing — because there are no
named roads to learn.

The column stops whenever a hostile gets within 95 m of it. Mortars stay
further out than that: they will bleed you without stopping you, so you have to
go and find them.

**Score mode** penalises civilian casualties. **Hardcore** ends the mission on
any civilian death, including one caused by enemy mortar fire. Replacement
operators link up on a kill threshold in both modes.

The minimap shows unclassified contacts. It tells you where something is, never
what it is, and blips decay if nobody re-observes them.

## Debug flags

These are what make the build checkable, and they are why the kill gate exists
at all.

| Flag | Effect |
| --- | --- |
| `?autostart` | Skip the menu |
| `&ff=N` | Fast-forward N simulated seconds before rendering |
| `&autofire` | Run the scripted gunner |
| `&mode=hardcore` / `&diff=hard` / `&seed=N` | Mission setup |
| `&zoom=0..4` / `&polarity=black` | Sensor setup |
| `&nonoise` | Disable sensor grain, for pixel comparisons |
| `&idprobe=<model>` | Stand one figure alone with the camera nailed down |
| `&mutate=noshadows` | Compile the shadow map out, to prove the shadow gate can fail |
| `&mutate=samemodel` | Render civilians as hostiles, to prove the silhouette gate can fail |

`window.__spectre` exposes the numeric state the gate asserts on, plus
`fastForward`, `silhouette` and `shadowProbe`.

## Assets

The shipped pack is 25 GLB models generated procedurally with Three.js
(`npm run assets`). They are low-poly and untextured, merged by material before
export, so there is no compression decoder and nothing to download.

A Blender 5.2 path exists and has been run (`npm run assets:blender`). It
produced models indistinguishable from the procedural pack once they were grey
shapes at gunship altitude, so the procedural pack ships — see `DECISIONS.md`
for the comparison. Either way, swapping visuals means replacing
`public/models/<name>.glb`: AI, collision, damage, mission logic and scoring
are untouched by asset swaps, and a GLB that fails to load falls back to the
matching procedural mesh rather than breaking the game.

Materials carry two extras the sensor reads: `optical` (integer sRGB hex) and
`heat` (0–1). The loader also accepts a `_heat_0.90` suffix on a material name.
Conventions: one metre per unit, origin at ground centre, Y-up / +Z-forward in
the exported GLB, characters around 2.4 m tall for readability from altitude.

## Verification

`./verify.sh` runs a progressive ladder: the simulation/renderer boundary, the
dependency manifest, the asset pack, the Pages base path, the type check, the
headless mission tests, the production build, then the browser kill gate.

Thresholds are pre-registered in `DECISIONS.md`. Two gates carry paired
negative tests — the shadow check is re-run on a build with shadows compiled
out and must fail, and the silhouette check is re-run with civilians rendered
as hostiles and must collapse — because a gate that cannot fail is not a gate.
The headless suite includes the same idea at the gameplay level: a mission
flown with a silent gunship must be **lost**, or the ground team is winning it
without you and the aircraft is decoration.

## History

This repo previously held a vanilla Canvas 2D build, tagged
[`canvas-v1`](https://github.com/icomppower/Ac130shooter/releases/tag/canvas-v1).
This is a ground-up rebuild using [`ac130astra`](https://github.com/icomppower/ac130astra)
as a read-only systems reference.
