# Resource assets

Run **FiveM: Browse Resource Assets**, or use **FiveM → Browse Resource Assets** on a resource folder in Explorer. The command also accepts a resource manifest URI when invoked by another editor command. The browser opens in a normal editor tab and reuses that tab when you choose another resource. It reads local files and the language server's current source index; it does not connect to a game or modify assets.

Use **Assets** to search paths, names, decimal hashes or `0x` hashes, then narrow the type filter. Select a YTD to browse its texture names, choose a mip, and switch between **RGBA**, **RGB** and **Alpha**. **Fit** and **100%** control preview scale. **Copy name** copies the filename stem; **Copy hash** copies its lowercase ASCII JOAAT name hash. Non-ASCII names remain browsable but do not receive a guessed hash.

**Open file** uses the editor's normal file handler. **Show references** resolves the selected asset against the retained source snapshot, including broad manifest patterns whose displayed asset links are capped. **Show all references** clears that asset filter. Use **Refresh** after rebuilding, replacing or adding files; asset bytes are read from disk on demand. Search, selection and view state survive hiding the tab.

## Formats

| Format | What the browser provides |
| --- | --- |
| `.ytd`, RSC7 version 13 | Legacy texture dictionary names, dimensions, mip levels and supported texture previews. |
| `.ytd`, RSC7 version 5 | Gen9/Enhanced texture dictionary metadata and supported linear/automatic-layout 2D texture previews. |
| `.dds` | 2D textures with DXT1/BC1, DXT3/BC2, DXT5/BC3, unsigned BC4/BC5, BC7, RGBA8, BGRA8, BGRX8, R8 or A8 data. DX10 headers are supported for those encodings. |
| PNG, JPEG, WebP, GIF, BMP | Image preview. |
| WAV, MP3, OGG, M4A, WebM, MP4 | Browser playback controls where VS Code supports the codec. |
| `.xml`, `.meta`, `.json` | Text preview, JSON syntax result, and common XML asset/model/texture-dictionary fields. XML extraction is a text summary, not schema validation. CodeWalker XML exports can be inspected as `.xml` files. |
| YDR, YDD, YFT, YBN, YMAP, YTYP, YMT, YNV, YND, YPT, YCD, YLD, AWC | Inventory, name/hash lookup, file size and available container header metadata. No 3D, map geometry, animation or audio-bank playback is implemented. |
| RSC8 or FXAP | Explicit format/support status. RSC8 payloads and encrypted asset-escrow content are not decoded. |

RSC8 is a container family, **not a synonym for GTA V Enhanced**. The supported Gen9 YTD layout uses RSC7 version 5. An identified layout does not guarantee an asset will work with a particular game build.

Cube maps, texture arrays, volumes, unsupported tiled layouts, signed BC4/BC5, BC6H and padded uncompressed row layouts have no pixel preview. Supported mip data is decoded locally; no conversion service or game asset catalog is downloaded. Previews show stored color/alpha channels, not the game's material and lighting result.

## References and health checks

**References** combines literal manifest declarations with known Lua model, texture dictionary, texture, particle and audio-bank native arguments. It supports literal names, known hash wrappers, FiveM backtick hashes and numeric hashes where the source analysis can prove the native call. Source buttons open the exact declaration or native argument, including the language server's unsaved Lua/manifest view.

Manifest file patterns are compared with the local inventory. `*` and `?` match inside one directory; `**/` includes nested directories and can match no directory. Brackets in names such as `[cars]` are literal. `AUDIO_WAVEPACK` declarations match directories. Other-resource paths and external URLs are shown as unchecked. A found texture dictionary does not prove it contains the texture named by `DrawSprite`; inspect its texture list to verify that name.

**Health checks** reports confirmed missing manifest targets, empty files, malformed supported headers and duplicate streamed filename stems with the same extension. Selecting a YTD or DDS performs deeper bounded texture parsing and reports invalid pointers, dimensions, mip data or compressed payloads there. These checks are not a complete validator for game models, maps or resource compatibility.

Lua references without a local match are informational: they may refer to a base-game asset or another resource. The browser does not label them missing. A partial or excluded scan also leaves unmatched declarations **unverified**, rather than incorrectly reporting them missing.

## Limits and coverage

Each resource scan covers at most 5,000 files, 20,000 directory entries and 20 directory levels. Symbolic links, hidden directories, `.git`, `node_modules`, `vendor`, `.vscode-test` and `.svn` are skipped. Glob matching has a shared work budget. Coverage notes appear with References and Health checks.

Texture inspection accepts files up to 64 MiB, RSC7 data expanding to at most 128 MiB and dictionaries with at most 2,048 textures. Each decoded preview is limited to one megapixel; larger textures can use a smaller existing mip. Media input is limited to 16 MiB. Metadata input is limited to 1 MiB with a 16,384-character text preview. Lists are paged in groups of 50; each source reference links at most 50 matching assets and reports any additional match count.

The source snapshot contains at most 1,000 manifest declarations and 2,000 Lua references, using at most 2,000 source files, 2 MiB per file and 32 MiB in total. Truncation and unavailable-source notes remain visible while the file inventory stays usable. No game archives, remote URLs, other-resource contents or proprietary game code are loaded.

## Implementation sources and licenses

The TypeScript resource/DDS container reader is independently authored from public format documentation and observable structure descriptions; it does not incorporate Rockstar game code or CodeWalker source. Synthetic tests construct their own RSC7 version 13/version 5 dictionaries and DDS blocks, including known RGB565 red BC1 blocks and a valid zero-endpoint BC7 block. No game asset fixture is distributed.

Format references checked on 2026-09-26:

- [Microsoft DDS programming guide](https://learn.microsoft.com/en-us/windows/win32/direct3ddds/dx-graphics-dds-pguide), for headers, FourCC/DX10 formats and row pitch differences.
- CodeWalker at commit `485d56bec00262ed7fa472261cce7bbc6202b96e`: [Texture layouts](https://github.com/dexyfex/CodeWalker/blob/485d56bec00262ed7fa472261cce7bbc6202b96e/CodeWalker.Core/GameFiles/Resources/Texture.cs), [YTD container handling](https://github.com/dexyfex/CodeWalker/blob/485d56bec00262ed7fa472261cce7bbc6202b96e/CodeWalker.Core/GameFiles/FileTypes/YtdFile.cs), and [resource page structure](https://github.com/dexyfex/CodeWalker/blob/485d56bec00262ed7fa472261cce7bbc6202b96e/CodeWalker.Core/GameFiles/Resources/ResourceBuilder.cs).
- CitizenFX [RSC7 container reader](https://github.com/citizenfx/fivem/blob/master/code/components/tool-formats/src/ConvertFormats.cpp) and [RSC8 header reader](https://github.com/citizenfx/fivem/blob/master/code/components/rage-formats-x/src/pgBase.cpp), for container recognition and support distinctions.
- [Official resource manifest documentation](https://docs.fivem.net/docs/scripting-reference/resource-manifest/), for file declarations, globs and audio wavepack directory semantics.

Pixel decoding uses the pinned [`@bis-toolkit/bcn` 1.0.2](https://www.npmjs.com/package/@bis-toolkit/bcn/v/1.0.2) package, licensed GPL-3.0-or-later, bundled only into the lazy asset webview. Its [upstream project](https://github.com/Koncord/BIS-Toolkit/tree/main/packages/bcn) includes the BCn decoder attribution. See the extension's `THIRD_PARTY_NOTICES.md` and `LICENSE` for distributed notices.
