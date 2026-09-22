# Editor setup

`qbx-editor` contains the VS Code adapter and configuration examples for other
editors. They use the [qbx-lua-ls](https://github.com/Qbox-project/qbx-lua-ls)
language server.

| Editor | Current status |
| --- | --- |
| VS Code | Extension package with an automated integration suite. See the [installation guide](../README.md#install-in-vs-code). |
| Neovim 0.11+ | Configuration example below; not integration-tested in Neovim. |
| Helix | Configuration example below; not integration-tested in Helix. |
| Other LSP clients | Need client-specific configuration or an adapter, followed by validation. |
| JetBrains IDEs | Need a compatible LSP integration or a dedicated adapter; none is shipped here. |

A `.vsix` is the VS Code adapter, not a universal editor package. Other clients
run the standalone server. JetBrains describes its adapter API in the
[IntelliJ Platform LSP documentation](https://plugins.jetbrains.com/docs/intellij/language-server-protocol.html).

## Obtain the server

Download the archive for your operating system and architecture from
[qbx-lua-ls releases](https://github.com/Qbox-project/qbx-lua-ls/releases).
Extract the executable before configuring the editor.

To build locally, follow the [source setup](../README.md#build-from-source) to
clone the sibling repositories, then run this from the `qbx-editor` root:

```sh
cargo build --release --locked --manifest-path ../qbx-lua-ls/Cargo.toml
```

The built executable is `../qbx-lua-ls/target/release/qbx-lua-ls` (`qbx-lua-ls.exe`
on Windows). Add its directory to `PATH`, or use its absolute path in the client
configuration. `qbx-lua-ls --version` should work in the editor's environment.
The server speaks LSP over standard input/output when launched with no arguments.

## Neovim 0.11+

Copy [`integrations/neovim/qbx.lua`](../integrations/neovim/qbx.lua) to
`lua/qbx.lua` inside your Neovim configuration directory and add this to `init.lua`:

```lua
require('qbx')
```

The example starts a server only for Lua files beneath `fxmanifest.lua` or
`__resource.lua`, with one connection per resource root. Add absolute library
folders in `init_opts.library` if dependencies live outside that resource.
Disable other Lua servers for these buffers to avoid duplicate results.

Open a resource's Lua file and run `:checkhealth vim.lsp`. Try `K` for hover,
`grn` for rename, `<C-x><C-o>` for completion, and
`:lua vim.lsp.buf.format()` for formatting. These use Neovim's built-in client;
no `nvim-lspconfig` plugin is required. See the
[Neovim LSP manual](https://neovim.io/doc/user/lsp.html) for client configuration
and UI options.

## Helix

Merge [`integrations/helix/languages.toml`](../integrations/helix/languages.toml)
into `.helix/languages.toml` in the resource directory. It selects
`qbx-lua-ls` for Lua and uses the manifest files as root markers. From that resource
directory, run `hx --health lua` in a terminal to inspect server discovery, then open Helix.
The example's `library` list accepts absolute folders for external dependencies.

The example replaces the resource's Lua server list. Remove another explicit
`formatter` setting if formatting should use the language server. See the
[Helix language configuration documentation](https://docs.helix-editor.com/languages.html)
for configuration merging and supported LSP features.

## Options and current limits

The server options correspond to the VS Code `qbxLua` settings, but
`initializationOptions` is a **flat object**. Neovim calls it `init_opts`;
Helix calls it `language-server.<name>.config`:

```json
{
  "library": ["/absolute/path/to/server/resources"],
  "diagnostics": {
    "enable": true,
    "workspace": true,
    "rules": { "unused-local": "warning" }
  },
  "inlayHints": { "enable": true },
  "semanticTokens": { "enable": true }
}
```

Do not send dotted keys such as `qbxLua.library`, or a `qbxLua` wrapper, in
initialization options. A `workspace/didChangeConfiguration` notification may
use either the flat settings object or `{ "qbxLua": { ... } }`. Restart the
server after changing library folders or workspace roots; roots are selected
during initialization. Formatting and lint configuration also use `qbxlint.toml`.

Completion, diagnostics, navigation, rename and formatting use ordinary LSP
methods, subject to each client's supported features. The VS Code status bar,
snippet browser, commands and CfxLua TextMate grammar belong to its adapter.
Connecting another client does not install that grammar; its Lua syntax parser
may still flag CfxLua syntax even when the server accepts it.

Clients that do not send watched-file changes can miss edits made outside the
editor. Restart the server to refresh the workspace, or integrate the custom
`qbx/reindex` request. The optional `qbx/status`, `qbx/fileInfo` and `qbx/snippets`
requests also need client UI code. These examples do not add that UI.
