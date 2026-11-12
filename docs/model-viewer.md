# Model viewer

Click a `.ydr`, `.ydd`, `.yft` or `.ybn` file in the Explorer, or run **FiveM: Open Model Viewer**. The file opens in a 3D preview that refreshes when the file changes on disk. The preview is read-only and local: nothing is uploaded, and no game archive is read.

## Controls

| Input | Action |
| --- | --- |
| Drag | Orbit |
| Shift-drag or right-drag | Pan |
| Scroll, `+`, `-` | Zoom |
| Arrow keys | Orbit in steps |
| `0` or **Reset view** | Frame the model again |

Z is up. The green axis points north (+Y), the red axis east (+X). The axes start at the model's origin, which is the pivot scripts use when attaching or placing it. A collision file in world coordinates has no origin nearby, so its axes sit at the centre of its floor.

## Models

| Format | What is shown |
| --- | --- |
| `.ydr` | The drawable. |
| `.ydd` | Each drawable of the dictionary, chosen from a list. |
| `.yft` | The main drawable of the fragment. Damaged variants, glass, cloth and physics are not shown. |

The detail panel lists the size and bounding box, the triangles and vertices of the shown detail level, the distances of all detail levels, embedded textures, and whether the model has a skeleton or lights. **Copy size** and **Copy box** give the dimensions as `vec3` values; **Copy model** gives a backtick hash.

**Shading** switches between textured, solid, one colour per material, and normals. **Wireframe**, **Grid** and **Bounding box** are overlays.

### Textures

Each material's diffuse texture is looked up by name, in this order:

1. textures embedded in the model file,
2. the texture dictionary that an archetype file (`.ytyp`) in the resource names for this model,
3. a `.ytd` with the model's name,
4. other `.ytd` files of the resource, the model's own folder first.

At most 16 dictionaries are opened per model. The Materials list says where each texture was found, or that it was not found in the resource: base-game textures are not available, and those materials are drawn in their material colour. Textures are previewed at 512 pixels or less. Materials whose shader is a cutout, decal, glass, fence, foliage or hair shader discard transparent texels; other blending, normal maps, specular maps and tinting are not reproduced, so the preview shows shape and base colour, not the in-game result.

## Collision

A `.ybn` is drawn as its collision surfaces, coloured by surface type, with flat shading. The detail panel counts bounds by kind and triangles by surface type. Composite children are placed with their stored transforms. Sphere, capsule and cylinder polygons are tessellated coarsely; top-level capsule, cylinder and disc bounds are shown as their bounding boxes. The extent is measured from the surfaces themselves, because exported files often carry a stale root box.

Surface types are shown by number. The game's material names are not bundled.

## Limits

- Files up to 64 MiB; RSC7 pages expanding to at most 128 MiB.
- Legacy and Gen9 (GTA V Enhanced) models: `.ydr`/`.ydd` resource versions 165 and 159, `.yft` versions 162 and 171. A note under the Materials list says when a file uses the Gen9 layout. Other resource versions are rejected with the version named.
- Gen9 geometry with indices wider than 16 bits is not shown, and a Gen9 normal stored in a packed 10-bit format is replaced by a normal computed from the triangles. Neither occurred in the files checked.
- A detail level of at most 4 million vertices; a collision file of at most 3 million triangles.
- 4,096 drawables per dictionary, 1,024 materials per drawable, 96 textures per model.
- WebGL 2 is required. When it is unavailable the panel still lists the model's details and says why nothing is drawn.

## Format sources

The readers are written for this extension. Layouts were checked against CodeWalker at commit `485d56bec00262ed7fa472261cce7bbc6202b96e` ([Drawable.cs](https://github.com/dexyfex/CodeWalker/blob/485d56bec00262ed7fa472261cce7bbc6202b96e/CodeWalker.Core/GameFiles/Resources/Drawable.cs), [VertexType.cs](https://github.com/dexyfex/CodeWalker/blob/485d56bec00262ed7fa472261cce7bbc6202b96e/CodeWalker.Core/GameFiles/Resources/VertexType.cs), [Bounds.cs](https://github.com/dexyfex/CodeWalker/blob/485d56bec00262ed7fa472261cce7bbc6202b96e/CodeWalker.Core/GameFiles/Resources/Bounds.cs)) and against openly published resources: 3,283 models decoded with every vertex inside its bounding box, and 23 collision files. Texture decoding uses the same pinned decoder as the asset browser.

The Gen9 reader was checked on those same 3,283 models after converting them to the Gen9 layout with CodeWalker's own converter at that commit, plus one drawable dictionary of eight of them written in both layouts. Every Gen9 file decoded with every vertex inside its bounding box, and its positions, normals, texture coordinates, colours and indices were byte-identical to the legacy original at every detail level. Shader names and diffuse texture names matched for all 6,207 materials, and the 1,329 embedded textures matched in name, size, format and the pixels of every mip level of 4×4 pixels or more. No Gen9 file built by the game's own tools was available, so the check shows agreement with CodeWalker's writer rather than with Rockstar's: the converted files use one vertex layout family (32-bit float positions, normals and texture coordinates, 8-bit colours), and the half-float formats are covered by the tests only.

Two things differ from the legacy layout and are visible in the panel: a Gen9 material lists its textures in the order of the Gen9 shader's parameter table, which puts a tint palette before the diffuse texture, and Gen9 parameter names differ (`DiffuseTex` instead of `DiffuseSampler`). The diffuse texture is chosen by name in both layouts.

Tests build their own legacy and Gen9 drawables and bounds; no game asset is distributed.
