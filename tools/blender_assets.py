"""
Tier 2 asset pipeline: the optional Blender upgrade.

    npm run assets:blender        # blender --background --python tools/blender_assets.py

Targets Blender 5.2 LTS. This rebuilds the same 25 models with native Blender
primitives, exports replacement GLBs over public/models/, and saves an editable
tools/spectre-assets.blend with one collection per model.

Nothing depends on this ever being run. Tier 1 (tools/export_models.ts) ships
by default, is already proven by the kill gate, and needs no Blender at all. If
this script is never executed the game is unchanged.

Coordinates
-----------
The game's geometry is authored Y-up / +Z-forward, matching Three.js. Blender
works Z-up / -Y-forward and the glTF exporter converts on the way out, so every
position, size and rotation below is passed in the game's frame and converted
by `to_blender`. Keeping one authoring frame is what stops the two pipelines
drifting apart.

Sensor extras
-------------
`optical` (integer sRGB hex) and `heat` (0-1) are written as custom properties
on each material and exported into glTF `extras`. The material name also
carries a `_heat_0.90` suffix, which is the fallback the loader reads if the
extras are stripped. Without these the whole scene renders cold and the game
loses its sensor.
"""

import math
import os
import sys

try:
    import bpy
    from mathutils import Vector
except ImportError:  # pragma: no cover - only reachable outside Blender
    sys.exit("This script must be run inside Blender: blender --background --python tools/blender_assets.py")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MODELS = os.path.join(ROOT, "public", "models")
BLEND = os.path.join(HERE, "spectre-assets.blend")

STONE, ROOF, DARK = 0x777364, 0x55584E, 0x202C2A
# Stone and roofing re-radiate the day's heat well into the night.
MASONRY, ROOF_HEAT = 0.13, 0.10
SKIN, TORSO, LIMB = 0.98, 0.92, 0.86


# --------------------------------------------------------------------------
# Frame conversion
# --------------------------------------------------------------------------

def to_blender(p):
    """Game (x, y, z) -> Blender (x, -z, y). A +90 degree turn about X."""
    x, y, z = p
    return (x, -z, y)


def size_to_blender(s):
    """Game (width, height, depth) -> Blender (width, depth, height)."""
    w, h, d = s
    return (w, d, h)


def rot_to_blender(rx=0.0, ry=0.0, rz=0.0):
    """
    Under the same +90 degree turn about X, the game's axes map to Blender's
    as X->X, Y->Z and Z->-Y, so an authored rotation has to be re-ordered and
    the Z term negated.
    """
    return (rx, -rz, ry)


# --------------------------------------------------------------------------
# Scene helpers
# --------------------------------------------------------------------------

_materials = {}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material(color, heat=0.0):
    """One shared material per (colour, heat) pair, carrying the sensor extras."""
    key = (color, round(heat, 4))
    if key in _materials:
        return _materials[key]
    name = "m_%06x_heat_%.2f" % (color, heat)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    r = srgb_to_linear(((color >> 16) & 0xFF) / 255)
    g = srgb_to_linear(((color >> 8) & 0xFF) / 255)
    b = srgb_to_linear((color & 0xFF) / 255)
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
        bsdf.inputs["Roughness"].default_value = 1.0
        bsdf.inputs["Metallic"].default_value = 0.0
    # Read by AssetLibrary through glTF extras; the name suffix is the fallback.
    mat["optical"] = color
    mat["heat"] = heat
    _materials[key] = mat
    return mat


def _finish(obj, collection, position, rotation, material_):
    obj.location = to_blender(position)
    obj.rotation_euler = rot_to_blender(*rotation)
    obj.data.materials.append(material_)
    for polygon in obj.data.polygons:
        polygon.use_smooth = False
    for other in list(obj.users_collection):
        other.objects.unlink(obj)
    collection.objects.link(obj)
    return obj


def box(collection, position, size, color, heat=0.0, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    obj = bpy.context.active_object
    obj.scale = size_to_blender(size)
    return _finish(obj, collection, position, rotation, material(color, heat))


def cylinder(collection, position, radius, height, color, sides=8, heat=0.0, rotation=(0, 0, 0)):
    """A game-frame cylinder stands along Y, which is Blender's Z. No extra turn."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=radius, depth=height)
    obj = bpy.context.active_object
    return _finish(obj, collection, position, rotation, material(color, heat))


def sphere(collection, position, radius, color, heat=0.0, scale=(1, 1, 1), subdivisions=2):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=radius)
    obj = bpy.context.active_object
    obj.scale = size_to_blender(scale)
    return _finish(obj, collection, position, (0, 0, 0), material(color, heat))


def dodecahedron(collection, position, radius, color, heat=0.0, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=radius)
    obj = bpy.context.active_object
    obj.scale = size_to_blender(scale)
    return _finish(obj, collection, position, (0, 0, 0), material(color, heat))


# --------------------------------------------------------------------------
# Models. These mirror src/assets/ModelFactory.ts one to one.
# --------------------------------------------------------------------------

def figure(c, kind):
    civilian = kind in ("civilian", "civilian2", "child")
    uniform = 0x918877 if civilian else 0x657567 if kind == "operator" else 0x615F50

    box(c, (0, 1.3, 0), (0.8, 1.1, 0.46), uniform, TORSO)
    sphere(c, (0, 2.13, 0), 0.3, 0xAF9B7F, SKIN)
    box(c, (-0.25, 0.48, 0), (0.23, 0.88, 0.27), uniform, LIMB)
    box(c, (0.25, 0.48, 0.12), (0.23, 0.88, 0.27), uniform, LIMB)

    if kind == "civilian2":
        # Stooped under a tall back load, no headload. Different from the first
        # civilian from above, and still nothing horizontal anywhere on it.
        box(c, (-0.5, 1.26, 0.06), (0.22, 0.84, 0.22), uniform, LIMB, rotation=(0.22, 0, 0))
        box(c, (0.5, 1.26, 0.06), (0.22, 0.84, 0.22), uniform, LIMB, rotation=(0.3, 0, 0))
        box(c, (0, 1.86, -0.46), (0.86, 1.5, 0.62), 0x8A7F68, 0.32, rotation=(0.2, 0, 0))
        box(c, (0, 2.62, -0.5), (0.66, 0.42, 0.48), 0x7F7460, 0.28)
        return

    if kind == "child":
        # Nothing carried at all. Scaled down after the fact, as in the
        # Three.js factory, so the proportions stay identical.
        box(c, (0, 1.9, 0), (0.4, 0.24, 0.34), 0x93876D, 0.3)
        box(c, (-0.44, 1.3, 0.02), (0.18, 0.72, 0.18), uniform, LIMB, rotation=(-0.2, 0, 0))
        box(c, (0.44, 1.3, 0.02), (0.18, 0.72, 0.18), uniform, LIMB, rotation=(0.2, 0, 0))
        for obj in c.objects:
            obj.scale = tuple(v * 0.66 for v in obj.scale)
            obj.location = obj.location * 0.66
        return

    if civilian:
        # Arms down, load on the back and head. Nothing projects sideways:
        # that absence is what tells a civilian from a hostile at altitude.
        box(c, (-0.5, 1.3, 0.02), (0.22, 0.86, 0.22), uniform, LIMB, rotation=(-0.12, 0, 0))
        box(c, (0.5, 1.3, 0.02), (0.22, 0.86, 0.22), uniform, LIMB, rotation=(0.14, 0, 0))
        box(c, (0, 1.34, -0.5), (0.78, 0.94, 0.56), 0x8A7F68, 0.34, rotation=(0.12, 0, 0))
        box(c, (0, 2.56, 0), (1.12, 0.34, 0.86), 0x93876D, 0.30)
        box(c, (0, 2.78, 0), (0.72, 0.24, 0.56), 0x8D8064, 0.26)
        return

    box(c, (-0.53, 1.36, 0.1), (0.23, 0.82, 0.22), uniform, LIMB, rotation=(-0.85, 0, 0))
    box(c, (0.53, 1.36, 0.1), (0.23, 0.82, 0.22), uniform, LIMB, rotation=(-0.72, 0, 0))
    cylinder(c, (0, 2.28, 0), 0.34, 0.22, uniform, 8, 0.42)
    box(c, (0, 1.4, -0.32), (0.66, 0.72, 0.3), 0x3E493F, 0.5)

    if kind == "rpg":
        # Yawed across the body: aimed straight ahead the tube foreshortens to
        # nothing from the orbit and the launcher reads as a lumpy civilian.
        cylinder(c, (-0.12, 1.9, 0.0), 0.18, 2.9, DARK, 8, 0.66,
                 rotation=(math.pi / 2, 0.62, 0.16))
        box(c, (0.62, 2.02, 1.02), (0.34, 0.34, 0.52), DARK, 0.6)
        box(c, (-0.86, 1.78, -1.02), (0.3, 0.3, 0.42), DARK, 0.5)
        box(c, (-0.1, 1.5, 0.3), (0.2, 0.46, 0.24), DARK, 0.55)
    elif kind == "mg":
        box(c, (0.3, 1.22, 1.0), (0.28, 0.3, 2.3), DARK, 0.6)
        box(c, (0.3, 0.6, 1.8), (0.14, 1.24, 0.14), DARK, 0.35)
        box(c, (0.3, 1.34, 0.3), (0.44, 0.36, 0.56), 0x3B463C, 0.5)
    elif kind != "operator":
        box(c, (0.2, 1.36, 0.78), (0.22, 0.24, 2.0), DARK, 0.58, rotation=(0, 0.22, 0))
        box(c, (-0.1, 1.3, -0.1), (0.2, 0.3, 0.5), DARK, 0.45)
    else:
        box(c, (0.29, 1.4, 0.66), (0.17, 0.19, 1.34), DARK, 0.4)
        box(c, (-0.32, 2.2, -0.34), (0.06, 1.5, 0.06), 0x2C3630, 0.25, rotation=(-0.16, 0, 0))


def build(name, c):
    if name in ("house", "building"):
        box(c, (0, 3.4, 0), (12, 6.8, 10), STONE, MASONRY)
        box(c, (0, 6.8, 0), (12.6, 0.45, 10.6), ROOF, ROOF_HEAT)
        for x in (-6, 6):
            box(c, (x, 7.2, 0), (0.35, 0.8, 10.4), 0x919080)
        for z in (-5, 5):
            box(c, (0, 7.2, z), (12, 0.8, 0.35), 0x919080)
        box(c, (-3, 7.5, -2), (2.7, 1.1, 2.4), 0x626659)
        cylinder(c, (3, 8, -2), 1.2, 2, 0x444D49, 10)
        box(c, (0, 1.7, 5.06), (1.6, 3.4, 0.12), DARK)
        for x in (-3.8, 3.8):
            for z in (-5.03, 5.03):
                box(c, (x, 3.6, z), (1.5, 1.7, 0.09), 0xB9A478, 0.12)
        for z in (-2.5, 2.5):
            box(c, (6.04, 3.6, z), (0.1, 1.5, 1.4), DARK)

    elif name == "house2":
        # Flat roof behind a parapet, with a stair head and water tanks.
        box(c, (0, 3.5, 0), (12, 7, 10), 0x6F6C5F, MASONRY)
        box(c, (0, 7.05, 0), (12.4, 0.3, 10.4), 0x5A5D52, ROOF_HEAT)
        for x in (-6.1, 6.1):
            box(c, (x, 7.5, 0), (0.3, 0.9, 10.4), 0x8A8878)
        for z in (-5.1, 5.1):
            box(c, (0, 7.5, z), (12.4, 0.9, 0.3), 0x8A8878)
        box(c, (-3.4, 8.0, 2.4), (2.8, 2.0, 2.6), 0x6A685C)
        for x in (2.2, 4.4):
            cylinder(c, (x, 8.1, -2.6), 0.85, 1.6, 0x7D7A68, 10, 0.22)
        box(c, (0, 1.8, 5.06), (1.8, 3.6, 0.12), DARK)
        for x in (-3.6, 0, 3.6):
            for z in (-5.03, 5.03):
                box(c, (x, 4.0, z), (1.4, 1.8, 0.09), 0xB9A478, 0.12)

    elif name == "house3":
        # L-shaped compound around a walled yard: the one non-rectangular
        # footprint in the pack when seen from above.
        box(c, (-2.6, 3.1, 0), (6.8, 6.2, 10), STONE, MASONRY)
        box(c, (-2.6, 6.35, 0), (7.2, 0.4, 10.4), ROOF, ROOF_HEAT)
        box(c, (3.2, 2.5, -3.0), (5.2, 5.0, 4), 0x716E60, MASONRY)
        box(c, (3.2, 5.15, -3.0), (5.6, 0.4, 4.4), ROOF, ROOF_HEAT)
        box(c, (3.2, 1.1, 3.6), (5.4, 2.2, 0.5), 0x807C6B)
        box(c, (5.7, 1.1, 1.2), (0.5, 2.2, 5.4), 0x807C6B)
        cylinder(c, (-4.4, 7.2, -3.2), 0.9, 1.8, 0x444D49, 10)
        box(c, (-2.6, 1.7, 5.06), (1.6, 3.4, 0.12), DARK)
        for z in (-3.2, 2.4):
            box(c, (-6.04, 3.4, z), (0.1, 1.6, 1.4), 0xB9A478, 0.12)
        box(c, (2.4, 0.4, 1.6), (2.6, 0.8, 1.2), 0x6B6759, 0.08)

    elif name == "wall":
        box(c, (0, 1.2, 0), (10, 2.4, 0.8), STONE, MASONRY)
        for i in range(-4, 5, 2):
            box(c, (i, 2.6, 0), (1, 0.5, 1), 0x8D8875)

    elif name == "road":
        box(c, (0, 0.01, 0), (10, 0.04, 30), 0x494D42)

    elif name == "tree":
        cylinder(c, (0, 3, 0), 0.38, 6, 0x514C3C, 6, rotation=(0, 0, 0.12))
        for i in range(7):
            box(c, (math.sin(i * 0.9) * 1.7, 6.2, math.cos(i * 0.9) * 1.7),
                (0.8, 0.2, 5), 0x485644, rotation=(0.25, i * 0.9, 0))

    elif name == "rock":
        dodecahedron(c, (0, 0.45, 0), 1.4, 0x767366, 0.0, scale=(1.2, 0.6, 1))

    elif name == "market":
        for x in (-2.5, 2.5):
            for z in (-1.6, 1.6):
                box(c, (x, 1.8, z), (0.15, 3.6, 0.15), 0x695842)
        box(c, (0, 1, 0), (4.8, 1.8, 2.8), 0x746349)
        for i in range(6):
            box(c, (-2.1 + i * 0.83, 3.7, 0), (0.84, 0.15, 3.8),
                0x8C8671 if i % 2 else 0x55665E)
        for i in range(5):
            box(c, (-1.8 + i * 0.85, 2, 0), (0.6, 0.4, 0.8), 0x9A8057)

    elif name == "cart":
        box(c, (0, 0.9, 0), (1.7, 0.6, 2.6), 0x6D6350, 0.12)
        box(c, (0, 1.3, -1.0), (1.6, 0.7, 0.5), 0x7B6F57, 0.2)
        for x in (-0.92, 0.92):
            cylinder(c, (x, 0.55, 0.3), 0.55, 0.16, 0x3B3830, 10, 0.08,
                     rotation=(0, 0, math.pi / 2))
        box(c, (0, 1.05, 1.5), (0.12, 0.12, 1.2), 0x5C5344, 0.1)

    elif name in ("civilian", "civilian2", "child", "operator", "rifle", "mg", "rpg"):
        figure(c, name)

    elif name == "mortar":
        crew_offset = 1.2
        # The crew figure is rebuilt in place rather than instanced, so the
        # collection stays a flat list of meshes the exporter can merge.
        _with_offset(c, "rifle", (crew_offset, 0, 0))
        cylinder(c, (0, 0.12, 0), 0.85, 0.22, 0x39443D, 8, 0.4)
        cylinder(c, (0, 1.05, 0), 0.2, 2.1, 0x454F44, 8, 0.72, rotation=(0, 0, 0.28))
        box(c, (-0.45, 0.6, 0), (0.1, 1.1, 0.1), 0x39443D, 0.3)
        box(c, (0.5, 0.35, -0.9), (0.9, 0.5, 0.6), 0x4A5347, 0.2)

    elif name in ("technical", "transport", "assault", "wreck"):
        transport = name == "transport"
        armored = name == "assault"
        wreck = name == "wreck"
        length = 7 if transport else 6
        color = 0x282925 if wreck else 0x686951 if armored else 0x646D56
        box(c, (0, 1.1, 0), (2.9, 0.55, length), color, 0.6)
        box(c, (0, 1.9, 1.7), (2.7, 1.35, 2), color, 0.5)
        box(c, (0, 2.2, 2.73), (2.2, 0.7, 0.05), 0x293632, 0.1)
        box(c, (0, 1.6, -1.2), (2.8, 0.6, 3.2), color, 0.4)
        if transport:
            box(c, (0, 2.55, -1.1), (2.7, 1.5, 3.9), 0x776F54, 0.3)
        if armored:
            box(c, (0, 2.55, -1), (2.6, 1.2, 2.5), color, 0.4)
        if not transport and not wreck:
            cylinder(c, (0, 2.6, -1), 0.6, 0.5, color, 8, 0.4)
            box(c, (0, 2.95, 0.1), (0.25, 0.25, 2.4), DARK, 0.8)
        for x in (-1.55, 1.55):
            for z in (-2.1, 2.1):
                cylinder(c, (x, 0.7, z), 0.66, 0.4, 0x202821, 10, 0.2,
                         rotation=(0, 0, math.pi / 2))
        if wreck:
            box(c, (1, 1.5, 0), (0.6, 0.2, 4), 0x191E1B)

    elif name == "lzpad":
        for i in range(24):
            a = i / 24 * math.pi * 2
            box(c, (math.cos(a) * 15, 0.06, math.sin(a) * 15), (1.6, 0.1, 1.6), 0x8D8B70, 0.15)
        for x, z in ((-11, -11), (11, -11), (-11, 11), (11, 11)):
            box(c, (x, 0.3, z), (0.7, 0.6, 0.7), 0xD8D6A8, 0.95)
        box(c, (0, 0.07, 0), (3, 0.1, 14), 0xA9A688, 0.2)
        box(c, (0, 0.07, 0), (14, 0.1, 3), 0xA9A688, 0.2)

    elif name == "helo":
        # A capsule body: Blender has no capsule primitive, so it is a cylinder
        # capped with two hemispheres, which merges to the same silhouette.
        cylinder(c, (0, 2.6, 0.4), 1.5, 4.2, 0x4F5C56, 12, 0.3, rotation=(math.pi / 2, 0, 0))
        sphere(c, (0, 2.6, 2.5), 1.5, 0x4F5C56, 0.3)
        sphere(c, (0, 2.6, -1.7), 1.5, 0x4F5C56, 0.3)
        box(c, (0, 2.9, -5.6), (0.7, 0.7, 6.4), 0x4B5852, 0.28)
        box(c, (0, 4.1, -8.4), (0.3, 2.2, 1.5), 0x4B5852, 0.25)
        box(c, (0, 4.1, 0.2), (2.1, 0.9, 2.6), 0x5D6A62, 0.78)
        for x in (-1.4, 1.4):
            box(c, (x, 0.35, 0.4), (0.16, 0.16, 5.4), 0x3A453F, 0.15)
            box(c, (x, 1.1, 1.6), (0.14, 1.4, 0.14), 0x3A453F, 0.12)
            box(c, (x, 1.1, -1.4), (0.14, 1.4, 0.14), 0x3A453F, 0.12)
        cylinder(c, (0, 4.9, 0.2), 0.22, 0.9, 0x39443E, 8, 0.5)
        for i in range(4):
            box(c, (0, 5.3, 0.2), (15.5, 0.12, 0.62), 0x2F3A34, 0.2,
                rotation=(0, i * math.pi / 4, 0))
        for i in range(2):
            box(c, (0.35, 4.1, -8.4), (0.1, 3.4, 0.34), 0x2F3A34, 0.2,
                rotation=(i * math.pi / 2, 0, 0))

    elif name == "gunship":
        cylinder(c, (0, 1, 0), 1.8, 22, 0x55635F, 12, rotation=(math.pi / 2, 0, 0))
        sphere(c, (0, 1, 11), 1.75, 0x62736D, 0.0, scale=(1, 1, 1.6), subdivisions=3)
        box(c, (0, 1.6, 1), (31, 0.42, 4), 0x56655F)
        box(c, (0, 2, -8.5), (12, 0.35, 2.3), 0x56655F)
        box(c, (0, 4, -9), (0.4, 5, 3), 0x53665D)
        for x in (-11, -6, 6, 11):
            cylinder(c, (x, 1, 1.5), 0.7, 4, 0x3F4F48, 10, 0.55, rotation=(math.pi / 2, 0, 0))
            box(c, (x, 1, 3.7), (0.16, 4, 0.15), 0x293833)
            box(c, (x, 1, 3.7), (4, 0.16, 0.15), 0x293833)
        for z in (-1, -4, -6):
            box(c, (-2.6, 0.3, z), (3, 0.3, 0.3), 0x293D33, rotation=(0, -0.1, 0))

    else:
        raise ValueError("unknown model: %s" % name)


def _with_offset(collection, name, offset):
    """Build `name` into `collection`, shifted. Used for the mortar's crew."""
    before = set(collection.objects)
    build(name, collection)
    for obj in collection.objects:
        if obj in before:
            continue
        obj.location = obj.location + Vector(to_blender(offset))


MODEL_NAMES = [
    "house", "house2", "house3", "building", "wall", "road", "tree", "rock", "market",
    "gunship", "helo", "lzpad",
    "civilian", "civilian2", "child", "cart", "operator", "rifle", "mg", "rpg", "mortar",
    "technical", "transport", "assault", "wreck",
]


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.objects):
        for item in list(block):
            block.remove(item)
    _materials.clear()


def merge_by_material(collection):
    """
    Join meshes that share a material, so each model exports as one draw call
    per material. This mirrors what the Three.js pipeline does before export.
    """
    buckets = {}
    for obj in list(collection.objects):
        if obj.type != "MESH" or not obj.data.materials:
            continue
        buckets.setdefault(obj.data.materials[0].name, []).append(obj)
    for objects in buckets.values():
        if len(objects) < 2:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()


def supported_kwargs(operator, kwargs):
    """
    Drop any argument this Blender's exporter does not know about. The glTF
    operator's signature has moved between 4.x and 5.x and there is no value
    in the script dying over a renamed flag.
    """
    known = set(operator.get_rna_type().properties.keys())
    dropped = sorted(set(kwargs) - known)
    if dropped:
        print("  note: this Blender ignores %s" % ", ".join(dropped))
    return {k: v for k, v in kwargs.items() if k in known}


def export(collection, name):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in collection.objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next(iter(collection.objects), None)
    path = os.path.join(MODELS, "%s.glb" % name)
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_extras=True,       # carries `optical` and `heat` into glTF extras
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_texcoords=False,
        export_normals=True,
    )
    bpy.ops.export_scene.gltf(**supported_kwargs(bpy.ops.export_scene.gltf, kwargs))
    return path


def main():
    os.makedirs(MODELS, exist_ok=True)
    clear_scene()
    scene = bpy.context.scene

    for name in MODEL_NAMES:
        collection = bpy.data.collections.new(name)
        scene.collection.children.link(collection)
        build(name, collection)
        merge_by_material(collection)

    # Export one collection at a time, hiding the rest.
    for name in MODEL_NAMES:
        for other in MODEL_NAMES:
            layer = bpy.context.view_layer.layer_collection.children[other]
            layer.exclude = other != name
        path = export(bpy.data.collections[name], name)
        print("exported %s" % os.path.relpath(path, ROOT))

    for other in MODEL_NAMES:
        bpy.context.view_layer.layer_collection.children[other].exclude = False
    bpy.ops.wm.save_as_mainfile(filepath=BLEND)
    print("saved %s" % os.path.relpath(BLEND, ROOT))
    print("\n%d models written. Compare them against tier 1 in-game, in thermal,"
          "\nat gunship altitude — never in the Blender viewport." % len(MODEL_NAMES))


if __name__ == "__main__":
    main()
