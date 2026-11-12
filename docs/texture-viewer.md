# Texture viewer and editor

Click a `.ytd` or `.dds` file in the Explorer, or run **FiveM: Open Texture Viewer**. The viewer lists the textures of the file and previews the selected one. In a `.ytd` you can also replace, add, rename and delete textures from PNG files; sizes, mip levels and compression are worked out for you. Everything happens on your machine.

## Viewing

Search by name, size or format. For the selected texture, choose a **Mip** level, the **Channels** to show (RGBA, RGB or alpha alone) and the **Scale** (fit or 100%). The checkerboard shows through transparent texels. The header shows how much texture memory the dictionary uses; above 16 MiB, FiveM reports a dictionary as an oversized asset.

| Action | Result |
| --- | --- |
| **Copy dictionary name** | The file name without `.ytd`, the name `RequestStreamedTextureDict` takes |
| **Copy name** | The texture's name |
| **Copy dictionary and name** | `'dictionary', 'texture'`, the first two arguments of `DrawSprite` |
| **Copy hash** | The texture name's hash as `0x1A2B3C4D` |
| **Export as PNG** | The texture's largest level as a PNG file |
| **Export all as PNG** | Every texture of the dictionary into a folder you choose |

## Editing a dictionary

| Action | Result |
| --- | --- |
| **Add or replace from PNG** | Choose one or more PNG files. Each becomes a texture named after its file. A file named like a texture that is already there replaces that texture. |
| **Replace with PNG** | The selected texture takes the image and keeps its name |
| **Rename** | A new name; models and scripts must use it too |
| **Delete** | Removes the selected texture |
| **FiveM: New Texture Dictionary from Images** | A new `.ytd` made from the PNG files you choose |

Edits are not written until you save the file. The tab shows the unsaved mark, **Undo** and **Redo** step through your edits, and **File: Revert File** discards them. If the file changes on disk while you have unsaved edits, they are kept.

What is done to an image:

- **Size:** each side is rounded to the nearest power of two, up to 4096, and the image is resampled to fit. A note says so when that happened.
- **Mip levels:** generated down to four pixels. Colours are averaged in linear light and weighted by opacity, so transparent pixels do not darken edges. Normal and specular maps (names ending in `_n`, `_nm`, `_nrm`, `_normal`, `_bump`, `_s`, `_spec` or `_specular`) and single-channel textures are averaged as stored.
- **Name:** the file name without its extension; spaces and other characters the game's names do not use become `_`.
- **Everything else stays:** the dictionary keeps its layout (Legacy or Gen9), a replaced texture keeps its usage flags, and textures you did not touch are written back byte for byte.

Two settings above the preview apply to the images you add next:

| Setting | Choices |
| --- | --- |
| **New images as** | **Automatic**: a replacement keeps the format of the texture it replaces; a new texture is BC1 (DXT1) when the image is opaque and BC3 (DXT5) when it has transparency. Or always **BC1**, **BC3**, **BC7** or **Uncompressed**. |
| **Mip levels** | **Automatic**: generate them, except for a replacement of a texture stored with a single level. Or **Always generate**, or **None**. |

## Limits

- Images are read from PNG files of any colour type and bit depth, up to 4096 × 4096.
- Written encodings: BC1, BC3, BC4, BC5, BC7, uncompressed 32-bit and 8-bit. A replaced BC2 (DXT3) texture is written as BC3, which holds the same channels.
- BC7 textures are written with one of the format's eight block modes. The result is a standard BC7 texture of higher quality than BC3; a slow offline encoder reaches higher quality still.
- A dictionary that holds a texture array, a cube or volume texture, or a texture whose layout cannot be measured opens read-only, and the header says which texture is the reason.
- `.dds` files are shown and exported, not edited.
- A dictionary holds at most 2,048 textures and expands to at most 128 MiB.
- Mip levels above one megapixel are listed but not previewed; pick a smaller one. Some converters leave the smallest mip levels out of a file; those are listed and say so when chosen.

## How it was checked

The reader and the writer are written for this extension; layouts were checked against CodeWalker at commit `485d56bec00262ed7fa472261cce7bbc6202b96e` ([Texture.cs](https://github.com/dexyfex/CodeWalker/blob/485d56bec00262ed7fa472261cce7bbc6202b96e/CodeWalker.Core/GameFiles/Resources/Texture.cs), [ResourceBuilder.cs](https://github.com/dexyfex/CodeWalker/blob/485d56bec00262ed7fa472261cce7bbc6202b96e/CodeWalker.Core/GameFiles/Resources/ResourceBuilder.cs)).

- 31 openly published dictionaries with 1,478 textures were read and written back, then loaded with CodeWalker: every texture kept its name, hash, size, format, flags and data. The same held after converting them to the Gen9 layout with CodeWalker's converter.
- In edited copies of each (one texture replaced, one deleted, three added), CodeWalker read the untouched textures unchanged and decoded the new BC1, BC3 and uncompressed textures at 41.8 dB or better against the source images.
- Every compressed encoding was decoded by a graphics driver through Direct3D 11 and compared with its source: BC1 42 dB, BC3 43 dB, BC7 46 to 48 dB, BC4 and BC5 above 53 dB.

An edited dictionary has not been loaded in the game itself, so try yours on a development server before you ship it.

Formats and preview limits are shared with the asset browser, which uses the same reader. See the [asset guide](assets.md) for the full list.
