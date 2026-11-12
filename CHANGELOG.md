# Changelog

Notable changes to the Qbox Lua extension. Releases follow the version of the
[qbx-lua](https://github.com/Qbox-project/qbx-lua) language server they bundle;
its changes are in that repository's release notes.

## Unreleased

### Added

- **Restart the resource you are editing:** `Ctrl+Alt+R` (`Ctrl+Cmd+R` on macOS),
  the editor and tab menus, and an editor title button act on the resource of
  the active file. **Ensure Resource** and **Refresh Server Resource List** are
  new, and a reply that the server cannot find a resource offers a refresh.
- **Tool list on the status bar:** clicking **Qbox Lua** lists every tool, with
  the actions for the resource being edited first. The item now also shows in
  editors that are not Lua, in a workspace with resources.
- **Map, model, texture and animation viewers:** `.ymap`, `.ytyp`, `.ydr`, `.ydd`,
  `.yft`, `.ybn`, `.ytd`, `.dds` and `.ycd` files open in viewers, with a FiveM
  sidebar and a getting-started walkthrough.
- **Check Resource Data:** vehicle and weapon metadata against streamed files,
  data files clients never receive, mod kit and siren IDs used twice, assets two
  resources stream under one name, assets too large to stream reliably, and
  Asset Escrow settings. Escrowed resources show a lock in the sidebar.
- **Locale Matrix:** missing translations and placeholder differences per language.
- **server.cfg support:** highlighting, completion, hovers, `exec` links and
  checks of what a server starts against the resources beside the file.
- **Reference catalogs:** blip sprites and colours, markers, and vehicle, ped
  and weapon models in the FiveM reference tab.
- **Save PNG** in the asset browser for the texture mip and channels shown.
- **Texture editing:** replace, add, rename and delete the textures of a `.ytd`
  from PNG files in the texture viewer, with undo and an ordinary save. Sizes,
  mip levels and BC1, BC3 or BC7 compression are worked out from the image.
  **New Texture Dictionary from Images** makes a `.ytd`, and textures export
  as PNG at full size.
- **Runtime log:** the followed file is remembered per workspace, errors and
  warnings are coloured and can be shown alone, and `@resource/file.lua:12`
  traces are links in the integrated terminal.
- **Copy MCP Configuration** for Claude Code, Cursor, VS Code and other
  assistants, with a launcher path that survives extension updates.
- **Restricted Mode:** language features, the reference and the viewers work in
  a workspace that is not trusted.
- Tool tabs are restored after a window reload.
- Packages for Windows ARM64 and Alpine Linux x64/ARM64.

### Changed

- A resource action returns once the server has answered instead of always
  waiting three seconds.
- `qbxLua.library`, `diagnostics`, `inlayHints` and `semanticTokens` are window
  settings, as one language server serves the whole window.
- The whole-manifest snippet is offered in manifest files only.
- The warning about other Lua extensions appears only in workspaces with FiveM resources.
- The shared SQL highlighting grammar keeps at most 256 query functions and is
  written atomically; **Reset SQL Highlighting Functions** drops those of other workspaces.

### Fixed

- Restarting the language server while it was starting could leave two servers running.
- A build that emptied or created a folder without Lua files, such as `web/dist`,
  caused a full reindex.
- Activation no longer waits for the language server to index the workspace.
- Every Lua completion asked the language server for the quote style.

## 1.2.1 and earlier

See [GitHub Releases](https://github.com/Qbox-project/qbx-editor/releases).
