# Changelog

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
