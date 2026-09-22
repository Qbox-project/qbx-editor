# Qbox Lua (FiveM)

Lua language support for FiveM resources. The VS Code extension bundles
[`qbx-lua-ls`](https://github.com/Qbox-project/qbx-lua-ls) for completion,
diagnostics, navigation and formatting. It reads `fxmanifest.lua` to understand
which scripts run on the client or server and which resources they depend on.

This repository also includes [setup examples for other editors](docs/editors.md).
The VS Code extension ID is `qbox.qbx-lua`.

## Install in VS Code

Download the `.vsix` for your operating system and architecture from
[Releases](https://github.com/Qbox-project/qbx-editor/releases). Packages cover Windows x64,
Linux x64/ARM64 and macOS x64/ARM64. You can also [build one from source](#build-from-source).

Run **Extensions: Install from VSIX** in the Command Palette and select the file.
You can also install it from a terminal, using the path to your package:

```sh
code --install-extension "/path/to/downloaded-package.vsix"
```

See the [VS Code installation instructions](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)
for details. The package includes the language server; a separate Lua server
installation is not needed.

Open a resource folder containing `fxmanifest.lua`, or your server's `resources`
folder. Disable other Lua language-server extensions for that workspace to avoid
duplicate diagnostics and completions. If a dependency is outside the workspace
and cannot be found beside the resource, add its directory to `qbxLua.library`.

## Features

- Completion and hover for Lua, FiveM natives, exports, events and LuaCATS types.
- Definitions, references and rename across resource files.
- Diagnostics and quick fixes from [`qbx-lint`](https://github.com/Qbox-project/qbx-lint),
  including manifest, event, export and client/server checks.
- Document formatting, configured through `[format]` in `qbxlint.toml`.
- CfxLua and LuaCATS syntax highlighting, signature help and parameter hints.
- Snippets for common resource code and a status bar showing the active file's side.

Use **Qbox Lua: Show Snippets** to browse snippets. **Show Status** and
**Show Output** help diagnose server startup and indexing problems.
**Reindex Workspace** refreshes files and manifests; **Restart Language Server**
also reloads library and workspace configuration.

## Settings

Search for `qbxLua` in VS Code Settings. A `qbxlint.toml` in the project configures
lint rules and formatting for both the editor and command-line linter.

| Setting | Default | Description |
| --- | --- | --- |
| `qbxLua.server.path` | `""` | Absolute path to a custom server binary; empty uses the bundled server. |
| `qbxLua.library` | `[]` | Extra folders to index, such as a server's `resources` directory. |
| `qbxLua.diagnostics.enable` | `true` | Show diagnostics. |
| `qbxLua.diagnostics.workspace` | `true` | Include files that are not open in the Problems panel. |
| `qbxLua.diagnostics.rules` | `{}` | Override rule levels: `off`, `hint`, `info`, `warning` or `error`. |
| `qbxLua.inlayHints.enable` | `true` | Show parameter names for literal arguments. |
| `qbxLua.semanticTokens.enable` | `true` | Enable semantic highlighting. |
| `qbxLua.warnAboutOtherLuaExtensions` | `true` | Warn when another Lua language-server extension is active. |
| `qbxLua.trace.server` | `"off"` | Log LSP traffic: `off`, `messages` or `verbose`. |

## Other editors

The [editor setup guide](docs/editors.md) includes Neovim 0.11+ and Helix
configurations for the standalone language server. Those examples have not been
integration-tested in the editors. VS Code has an automated integration suite.

Other LSP clients need their own configuration or adapter. JetBrains IDEs need
a compatible integration; this repository does not provide one. VS Code's
commands, status bar and syntax grammar are part of its extension package.

## Build from source

Use Node.js 22, npm and a current stable Rust toolchain. Clone all three
repositories into the same parent directory; the server uses sibling Cargo paths:

```sh
git clone https://github.com/Qbox-project/qbx-lint.git
git clone https://github.com/Qbox-project/qbx-lua-ls.git
git clone https://github.com/Qbox-project/qbx-editor.git
cd qbx-editor
npm ci
npm run server
npm run build
```

`npm run server` builds the sibling language server in release mode and copies
the executable into `server/<platform>-<arch>/`. To make a VSIX, choose the target
matching the machine on which you built the server. For example, on Windows x64:

```sh
npm run package -- --target win32-x64
```

The other release targets are `linux-x64`, `linux-arm64`, `darwin-x64` and
`darwin-arm64`. Changing the package target does not cross-compile the server.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development host and test commands,
and [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

[GPL-3.0-or-later](LICENSE).
