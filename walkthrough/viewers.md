# Click a map, model or collision file

Game files open in a viewer instead of the "binary file" notice.

| File | What you get |
| --- | --- |
| `.ymap`, `.ytyp` | Entities, interiors, rooms, portals and car generators with world coordinates. Copy a position as `vec3`, a door as a Lua table, or a room as an `ox_lib` box zone. Pick any point on the top-down map. Export binary files as XML. |
| `.ydr`, `.ydd`, `.yft` | A textured 3D preview with detail levels, materials and the model's size. |
| `.ybn` | The collision mesh, coloured by surface type. |
| `.ycd` | The clips of an animation dictionary played on a skeleton, with the Lua that plays one. |
| `.ytd`, `.dds` | Every texture with its mip levels and channels, and copyable names. In a `.ytd`, replace, add or delete textures from PNG files. |

Viewers refresh when the file changes, so they follow a re-export from CodeWalker
or Blender. Nothing is uploaded, and a file is written only when you save an
edited texture dictionary or export something.
