# Open the folder that holds your resources

Open your server's `resources` folder, or a single resource. Every folder with an
`fxmanifest.lua` is indexed, so completion, hover and go-to-definition work across
resources such as `ox_lib` and `qbx_core`.

- Opening one resource? Dependencies beside it are found on their own. Add other
  locations with the `qbxLua.library` setting.
- Using another Lua extension? Disable it for this workspace so you do not get
  every suggestion and warning twice.
