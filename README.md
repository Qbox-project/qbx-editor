# Qbox Lua (FiveM) for VS Code

FiveM Lua support that is built for FiveM instead of adapted to it. The extension ships
[`qbx-lua-ls`](../qbx-lua-ls), a small Rust language server, and needs neither
`sumneko.lua` nor a multi-megabyte natives library.

> Status: proof of concept.

## Why

The usual setup is `sumneko.lua` plus `overextended.cfxlua-vscode`, which feeds LuaLS ~10,000
native declarations and a patched grammar. It works, but LuaLS keeps full syntax trees and type
information for every file and library in memory; on a server with a few hundred resources that
means hundreds of megabytes to gigabytes of RAM and long "loading workspace" phases.

`qbx-lua-ls` keeps only a compact summary of closed files and looks natives up in a sorted table
embedded in the binary.

| | LuaLS + cfxlua | Qbox Lua |
| --- | --- | --- |
| Memory, 5 real resources (qbx_core, ox_lib, ox_inventory, qbx_police, qbx_vehicleshop; 224 files) | 458 MB | 12 MB |
| Time until that workspace is loaded | 6.5 s | 0.2 s |
| Natives | generated `.lua` library parsed at startup | binary-searched in place, client/server aware |
| Knows `fxmanifest.lua` (sides, `@resource/file.lua` imports) | no | yes |
| Event, export and callback name completion | no | yes |
| Lint rules | generic Lua | the same FiveM-aware rules as `qbx-lint` in CI |

Measured on Windows 11 with LuaLS 3.19.1 plus the cfxlua natives library, using
`scripts/bench-luals.mjs` and `scripts/bench.mjs` from the server repository. LuaLS does deeper
type checking than this server does, so the comparison is about cost, not feature parity.

## Features

- **Completion** for locals, globals of the *current resource and side*, natives (filtered by
  client/server), class members, `exports.resource:Function`, event and callback names inside
  `TriggerEvent('…')`, `require` paths, table fields expected by a call (`lib.notify({ | })`),
  LuaCATS tags and types, and `fxmanifest.lua` directives and paths.
- **Hover** with signatures, LuaCATS documentation, native documentation and examples, the side a
  native runs on, and where an event is handled. Tables show an overview of their fields with
  types and values, limited to what is in scope: hovering `Config` shows this resource's `Config`,
  not every `Config` in the workspace.
- **Go to definition / references / rename** across files for locals, globals, fields and
  methods, including `require` targets, event registrations, exports of other resources and
  locale keys (jumps into `locales/en.json`).
- **Formatter** (Format Document / format on save). Conservative about style, and it re-checks its
  own output: the formatted file must contain exactly the same tokens and comments or it is left
  alone. Configure it with a `[format]` table in `qbxlint.toml`.
- **Cross-file checks**: events triggered with more arguments than the handler takes or towards
  the wrong side, export calls that do not match the export, server handlers that trust
  client-sent ids or pass unchecked client values into money/item/command calls, SQL built by
  concatenation, unknown and unused locale keys, exports used without a `dependency`.
- **Project knowledge in completion**: locale keys with their text, convars from code and
  `.cfg` files, state bag keys.
- **Signature help** and **inlay parameter hints**.
- **Diagnostics and quick fixes** from [`qbx-lint`](../qbx-lint): undefined globals resolved
  through the manifest, client natives used on the server, loops without `Wait`, `source` read
  after a yield, manifest mistakes, `Citizen.Wait` → `Wait`, ``GetHashKey('x')`` → `` `x` ``, ...
- **Semantic highlighting** for natives, library tables, globals, parameters and methods.
- **CfxLua syntax**: `` `hash` `` literals, `a?.b`, `+=` and friends, `/* */` comments, plus
  highlighting for LuaCATS annotations.
- **Outline** that includes event handlers, threads, commands and exports.
- **Problems panel for the whole workspace**, not only for open files
  (`qbxLua.diagnostics.workspace`).
- **Client/server awareness**: the status bar shows which side the active file runs on according
  to `fxmanifest.lua`; natives, globals and event names are filtered accordingly.
- **Snippets**: `CreateThread`, thread loop, `RegisterNetEvent`, `AddEventHandler`,
  `RegisterCommand`, `lib.callback.register`, `lib.callback.await`, `onCache` (with a pick list of
  the cache keys your ox_lib version really has), loops, functions, `fxmanifest`, `qbxconfig`.

Type information comes from LuaCATS annotations, so ox_lib, qbx_core and any other annotated
resource light up automatically when they are in the workspace, next to the opened resource, or in
`qbxLua.library`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `qbxLua.server.path` | bundled | Path to a custom `qbx-lua-ls` binary. |
| `qbxLua.library` | `[]` | Extra folders to index (for example your server's `resources`). |
| `qbxLua.diagnostics.enable` | `true` | Toggle diagnostics. |
| `qbxLua.diagnostics.workspace` | `true` | Report problems for files that are not open. |
| `qbxLua.diagnostics.rules` | `{}` | Per-rule levels; a `qbxlint.toml` in the workspace also applies. |
| `qbxLua.inlayHints.enable` | `true` | Parameter name hints for literal arguments. |
| `qbxLua.semanticTokens.enable` | `true` | Semantic highlighting. |
| `qbxLua.warnAboutOtherLuaExtensions` | `true` | Warn when LuaLS/cfxlua run alongside. |

Commands: **Qbox Lua: Restart Language Server**, **Reindex Workspace**, **Show Status**,
**Show Output**.

## Development

```bash
npm install
npm run server      # copy ../qbx-lua-ls/target/release/qbx-lua-ls into server/<platform>-<arch>/
npm run build
npm test            # launches an isolated VS Code and runs the integration tests
npm run package     # produces qbx-lua-<version>.vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host. Without a bundled server
the extension falls back to `../qbx-lua-ls/target/{release,debug}` and finally to `qbx-lua-ls` on
`PATH`.

For a release, CI should build `qbx-lua-ls` for every platform and publish platform-specific
packages (`vsce package --target win32-x64`, `linux-x64`, `darwin-arm64`, ...), each containing only
its own `server/<platform>-<arch>/` folder.

## License

GPL-3.0-or-later
