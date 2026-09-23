# Changelog

## Unreleased

- Add a CfxLua dev extension for Zed in `integrations/zed`: a CfxLua language for `.lua` files that downloads and runs qbx-lua-ls without LuaLS.
- Publish all five platform packages to Open VSX after a GitHub release.

## 1.0.2

- Keep event and callback autocomplete filtering through `:` and replace the full name when accepting a suggestion.
- Bundle qbx-lua-ls 1.0.2.
- Publish all five platform packages to VS Code Marketplace after a GitHub release.
- Add the Qbox icon, Marketplace presentation and CfxLua/FiveM discovery metadata.
- Rewrite the README around resource development and Marketplace installation;
  move source-build instructions to the contributor guide and clarify RedM coverage.

## 1.0.1

- Bundle qbx-lua-ls 1.0.1.

## 1.0.0

- Added Neovim and Helix configuration examples and an editor setup guide.
- Added platform-specific VSIX assets to tagged GitHub releases.
- Updated the bundled language server with static string-key renames,
  guarded event-side checks and a full workspace rescan.
- Updated shared analysis code to avoid invalid hash quick fixes and bound expression depth.
- Updated the Intel macOS release job to a supported runner.

## 0.2.0

- Added document formatting and registered the extension as the default Lua formatter.
- Added workspace diagnostics, event/export checks, security checks and locale rules.
- Added field and method references and rename, locale/convar/state bag completion,
  and the `onCache` snippet.
- Added the active file's client/server/shared side to the status bar.

## 0.1.0

- Initial extension with the bundled `qbx-lua-ls` server, CfxLua and LuaCATS
  highlighting, settings, a status bar item and commands.
