# SPECTRE 1-3 — AC-130 Close Air Support

A browser AC-130 gunner sim in the style of *GHOST: AC-130 Close Air Support*.
Vanilla Canvas 2D + Web Audio — zero dependencies, no build step.

## Play

Live: https://icomppower.github.io/Ac130shooter/

Or open `index.html` in a browser (double-click works). Click **ENGAGE** to lock the mouse and start.

On phones/tablets: drag to slew the sensor, hold the **FIRE** button to shoot,
and use the **WPN / ZM / IR** buttons. Best in landscape.

## Mission

Ghost 1-1 (6 operators, marked with flashing IR strobes) moves through a hostile
town to the extraction LZ, then holds for 45 seconds until the helo arrives.
Enemy riflemen, RPG teams and technicals converge on them in escalating waves.
Keep the squad alive. If you kill a friendly, the mission ends immediately.

## Controls

| Input | Action |
|---|---|
| Mouse | Slew the sensor (aim) |
| LMB | Fire |
| RMB / Q / Tab | Switch weapon |
| 1 / 2 / 3 | 25mm gatling / 40mm Bofors / 105mm howitzer |
| Wheel | Zoom (WIDE / MED / NARO) |
| N | IR polarity (white-hot / black-hot) |
| Esc | Pause |

Shells have real flight time (0.5s for 25mm up to ~2s for the 105) — lead moving
targets. The 105 levels buildings. Watch for the flashing **DANGER CLOSE** warning
when aiming near friendlies.

## Debug

- `index.html?autostart` — skip the menu
- `&ff=120` — fast-forward 120 sim seconds
- `&autofire` — bot aims at the nearest enemy and cycles weapons (smoke testing)
