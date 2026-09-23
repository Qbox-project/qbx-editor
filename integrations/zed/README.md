# CfxLua for Zed

Adds the **CfxLua** language to Zed for FiveM and RedM resources and runs the
[qbx-lua-ls](https://github.com/Qbox-project/qbx-lua-ls) language server for it.
It does not need Zed's Lua extension or LuaLS.

Setup, settings and limits are described in the
[editor setup guide](../../docs/editors.md#zed).

## Third-party files

The Tree-sitter queries in `languages/` are adapted from
[zed-extensions/lua](https://github.com/zed-extensions/lua) and are licensed under
the Apache License 2.0; see [`languages/LICENSE-APACHE`](languages/LICENSE-APACHE).
The CfxLua queries drop the LuaJIT FFI injection, inject LuaCATS doc comments into
the `LuaCATS` language, and add `overrides.scm` and backtick autoclosing.
The rest of this extension is licensed under the GNU GPL v3; see [`LICENSE`](LICENSE).
