# Map viewer

Click a `.ymap` or `.ytyp` file in the Explorer, or run **FiveM: Open Map Viewer**. The viewer opens in a normal editor tab, reads the file from disk and refreshes when the file changes, so it follows a re-export from CodeWalker or Blender. It never modifies a file and does not connect to a game.

Binary files (RSC7 Meta) and XML files are both read. XML `.ymap` and `.ytyp` files open in the text editor by default, because they are meant to be edited by hand; use the **Open Map Viewer** button in the editor title bar, or set `qbxLua.mapViewer.xmlFiles` to `viewer`. CodeWalker exports named `*.ymap.xml` and `*.ytyp.xml` open as text and offer the viewer through **Reopen Editor With** and the same button.

## What each tab shows

| Tab | Contents |
| --- | --- |
| **Overview** | Name, parent map, entity and car generator counts, decoded flags, extents, physics dictionaries, and the related files the viewer read from the same resource. |
| **Entities** | Every placed entity with its world position and heading. Search by model name or hash, filter by group, and select a row for rotation, size, LOD distance and copy actions. |
| **Top-down map** | Entity positions, room outlines, portals and car generators, north up. Drag to pan, scroll to zoom. Click an entity to select it. Click empty space to pick a point; hold Shift and drag to pick a point with a heading. |
| **Interiors** | For each interior (MLO): its placement, rooms, portals and entity sets. |
| **Archetypes** | For `.ytyp` files: each archetype's kind, size, LOD distance and dictionaries, and how often maps in the resource place it. |
| **Car generators** | Model or population group, position and heading. |

## Copying coordinates

**Copy as** chooses the spelling: `vec3(x, y, z)`, `vector3(x, y, z)`, `{ x =, y =, z = }` or plain numbers. **Decimals** sets the rounding. Positions copied with a heading use four components.

| Action | Result |
| --- | --- |
| **Copy position** / **Copy with heading** | `vec3(441.2, -982.13, 30.69)` or `vec4(441.2, -982.13, 30.69, 90.0)` |
| **Copy model** | `` `prop_name` `` when the name is known, otherwise the hash as `0x1A2B3C4D` |
| **Copy as Lua table** | ``{ model = `v_ilev_door`, coords = vec4(...) }``, the shape door and prop configurations use |
| Room **Center** / **Corners** | The room's centre, or its four floor corners as a Lua list |
| Room **Box zone** | An `ox_lib` `lib.zones.box({ coords, size, rotation })` call covering the room |
| **Copy interior lookup** | `local interior = GetInteriorAtCoords(x, y, z)` |
| Entity set **Activate** | The lookup followed by `ActivateInteriorEntitySet` and `RefreshInterior` |

Headings follow `GetEntityHeading`: 0 faces north (+Y) and values grow counter-clockwise.

### Coordinates inside an interior

A `.ytyp` stores an interior's rooms, portals and entities relative to the interior's origin. A `.ymap` places the interior in the world. When both files are in the same resource, the viewer combines them: opening either one shows rooms, portals, doors and props at their world positions. The Overview tab lists which file supplied the other half.

- Entities attached to a portal are usually its door or window; the **Where** column names the portal and the two rooms it joins.
- A point picked inside a room takes its height from the interior's collision: the surface under the point. A standing ped is about 1.0 higher. Where several surfaces lie under the point, such as a floor and a platform, the lowest is chosen and the others are offered as buttons. The Interiors tab shows each room's floor the same way, measured at the room's centre.
- Collision is read from the `.ybn` named after the interior, and from `.ybn` files named after entities placed inside it, when they are in the same resource. The Interiors tab names the files used. Without one, heights fall back to the bottom of the room's bounding box, which can lie well below the real floor.
- Outside rooms the height of the nearest entity is used. The detail panel always says which source applied.
- An interior that no map in the resource places is shown in local coordinates, with a note saying so. An interior placed several times uses the first placement, also noted.

## Model names

Binary files store model names only as hashes. The viewer recovers names from:

1. asset files of the same resource (`prop_x.ydr` names the model `prop_x`), and
2. the name lists in the `qbxLua.assets.nameLists` setting.

A name list is any text, INI or JSON file that contains names, for example a list of base-game object names with one name per line. **FiveM: Add Asset Name List** adds files to the setting. The setting is stored per machine. Unresolved models are shown as `0x…` hashes and stay searchable and copyable.

## XML export

**Open as XML** writes a binary file's contents as XML in a new untitled editor. The output follows the layout CodeWalker writes and reads: structure and field names, `hash_XXXXXXXX` for unresolved hashes, enum names, and row-wrapped arrays. Resolved model names are written as names. Save it as `name.ymap.xml` or `name.ytyp.xml` to import it into CodeWalker. The export is limited to 32 MiB of text.

## Limits

- Files up to 64 MiB; RSC7 pages expanding to at most 128 MiB; XML up to 32 MiB and 500,000 elements.
- At most 60,000 entities are listed; the Overview says when a file has more.
- Related files: at most 200 `.ymap`/`.ytyp` files of 16 MiB or less in the same resource, found by walking up to the nearest `fxmanifest.lua`. Outside a resource, the file's own folder is used.
- PSO and RBF containers are identified but not decoded. Extension data on entities and archetypes, LOD lights, occluders and grass batches are counted, not listed.
- Room outlines and box zones come from the room definitions, which are bounding boxes. Collision is limited to 48 files per map file and 600,000 triangles per interior; surfaces of walls and of entity sets that are off by default are not counted.

## Format sources

The Meta reader, XML reader and XML writer are written for this extension. Layouts were checked against CodeWalker at commit `485d56bec00262ed7fa472261cce7bbc6202b96e` ([Meta.cs](https://github.com/dexyfex/CodeWalker/blob/485d56bec00262ed7fa472261cce7bbc6202b96e/CodeWalker.Core/GameFiles/MetaTypes/Meta.cs), [MetaXml.cs](https://github.com/dexyfex/CodeWalker/blob/485d56bec00262ed7fa472261cce7bbc6202b96e/CodeWalker.Core/GameFiles/MetaTypes/MetaXml.cs), [YmapFile.cs](https://github.com/dexyfex/CodeWalker/blob/485d56bec00262ed7fa472261cce7bbc6202b96e/CodeWalker.Core/GameFiles/FileTypes/YmapFile.cs)) and against openly published map resources. The dictionary of structure, field and enum names lists the identifiers of the game's Meta schemas; each entry was verified to hash to the value CodeWalker's `MetaNames` records. See `THIRD_PARTY_NOTICES.md`.

Tests build their own Meta containers and XML; no game asset is distributed.
