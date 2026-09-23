<p align="center">
  <img src="images/icon.png" alt="Qbox duck logo" width="112" height="112">
</p>

<h1 align="center">Qbox Lua</h1>

<p align="center">CfxLua language tools for FiveM resource development.</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Qbox.qbx-lua">Install from VS Code Marketplace</a>
  · <a href="https://github.com/Qbox-project/qbx-editor/releases">Release notes</a>
  · <a href="https://github.com/Qbox-project/qbx-editor/issues">Report an issue</a>
</p>

Write Lua resources with native completion, diagnostics, formatting and navigation
in one extension. Qbox Lua understands CfxLua syntax and reads `fxmanifest.lua` to
track client, server and shared scripts, resource dependencies, exports and events.

The language server is included. You can work on a single resource or an entire
`resources` folder, without installing Rust or a separate language server.

## Built for resource development

| Feature | What it helps you do |
| --- | --- |
| Completion and hover | Look up FiveM natives, runtime globals, exports and LuaCATS types as you write. |
| Diagnostics and quick fixes | Find Lua mistakes, missing manifest imports and event/export mismatches in the Problems panel. |
| Client/server context | Catch calls used on the wrong side and see the current file's side in the status bar. |
| Navigation and rename | Follow definitions and references across your workspace and rename supported symbols. |
| Formatting | Format Lua with shared project settings in `qbxlint.toml`. |
| Syntax and editor hints | Read CfxLua backtick hashes, LuaCATS annotations, semantic highlighting, signature help and parameter hints. |
| Resource snippets | Add common manifest and resource patterns from the editor. |

Analysis comes from [qbx-lua-ls](https://github.com/Qbox-project/qbx-lua-ls) and
[qbx-lint](https://github.com/Qbox-project/qbx-lint). The editor and command-line
linter share rule configuration, so your local feedback and CI checks can agree.

## Get started

1. Install **Qbox Lua - CfxLua & FiveM** from the
   [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Qbox.qbx-lua).
2. Open a resource folder containing `fxmanifest.lua`, or your server's `resources` folder.
3. Open a Lua file. Disable other Lua language-server extensions for that workspace
   if they produce duplicate diagnostics or completions.

Resources referenced by the manifest and located beside the open resource are
found automatically. If a dependency lives elsewhere, add its folder to
`qbxLua.library` in VS Code settings:

```json
{
  "qbxLua.library": [
    "/path/to/server/resources/[ox]/ox_lib",
    "/path/to/server/resources/[qbx]/qbx_core"
  ]
}
```

This extension runs in your editor. It does not need to be added to `server.cfg`
or started as a FiveM resource.

### Supported environments

- VS Code 1.85 or newer on **Windows x64**, **Linux x64/ARM64**, and **macOS x64/ARM64**.
- FiveM / GTA V resources using CfxLua, including client, server and shared scripts.
- Qbox-specific checks are included; the Lua and FiveM tooling also works with resources
  that do not use Qbox.

**RedM:** the manifest completion includes `rdr3`, but the bundled native database
targets FiveM and currently excludes RedM-specific natives. Full RedM language
support is not advertised. Dynamic code, encrypted scripts and dependencies outside
the indexed workspace can also limit analysis.

## Project configuration

Add `qbxlint.toml` to your workspace to share lint and formatting preferences with
the [qbx-lint CLI and GitHub Action](https://github.com/Qbox-project/qbx-lint).
For example:

```toml
exclude = ["web/**", "**/vendor/**"]

[rules]
"unused-argument" = "off"

[format]
indent_width = 4
use_tabs = false
quote_style = "preserve"
```

See the [configuration reference](https://github.com/Qbox-project/qbx-lint/blob/main/docs/reference.md)
and [rule list](https://github.com/Qbox-project/qbx-lint/blob/main/docs/rules.md).

## Editor settings

Search for `qbxLua` in VS Code Settings.

| Setting | Default | Description |
| --- | --- | --- |
| `qbxLua.library` | `[]` | Extra dependency folders to index. |
| `qbxLua.diagnostics.enable` | `true` | Show diagnostics. |
| `qbxLua.diagnostics.workspace` | `true` | Include files that are not open. |
| `qbxLua.diagnostics.rules` | `{}` | Override rule levels: `off`, `hint`, `info`, `warning` or `error`. |
| `qbxLua.inlayHints.enable` | `true` | Show parameter names beside literal arguments. |
| `qbxLua.semanticTokens.enable` | `true` | Enable semantic highlighting. |
| `qbxLua.warnAboutOtherLuaExtensions` | `true` | Warn about other active Lua language servers. |
| `qbxLua.server.path` | `""` | Advanced: use a custom language-server binary. |
| `qbxLua.trace.server` | `"off"` | Advanced: trace language-server communication with `messages` or `verbose`. |

## Commands and troubleshooting

Open the Command Palette and search for **Qbox Lua**:

- **Show Snippets** opens the snippet picker.
- **Show Status** and **Show Output** help diagnose server startup and indexing.
- **Reindex Workspace** refreshes indexed files and manifests.
- **Restart Language Server** also reloads library and workspace configuration.

If a resource dependency is missing from completion or navigation, check that it
is available beside the workspace or included in `qbxLua.library`. When reporting
an issue, include the extension version, operating system and a small reproduction.

## Other editors

The bundled server, `qbx-lua-ls`, is also available as a standalone executable.
The [editor setup guide](https://github.com/Qbox-project/qbx-editor/blob/main/docs/editors.md)
covers the Zed extension in `integrations/zed` and includes Neovim 0.11+ and Helix
configuration examples. None of these has been integration-tested in its editor;
VS Code has an automated integration suite.

Other LSP clients need their own configuration or adapter. The VS Code commands,
status bar and syntax grammars are part of this extension. A JetBrains integration
is not included.

## Manual installation

Marketplace installation selects the matching platform package and supports normal
extension updates. For an offline or manual installation, download your platform's
`.vsix` from [GitHub Releases](https://github.com/Qbox-project/qbx-editor/releases)
and run **Extensions: Install from VSIX** in VS Code.

You can also install from the Marketplace through the terminal:

```sh
code --install-extension qbox.qbx-lua
```

## Development

To build the extension, run its tests or use the Extension Development Host, see
[CONTRIBUTING.md](https://github.com/Qbox-project/qbx-editor/blob/main/CONTRIBUTING.md).

## License

[GPL-3.0-or-later](https://github.com/Qbox-project/qbx-editor/blob/main/LICENSE).
