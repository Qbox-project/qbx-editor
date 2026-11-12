# Restart resources without leaving the editor

**Configure Resource Connection** stores the address and RCON password of your
development server for this workspace. The password is kept in VS Code's secret
storage, never in settings.

After that, **Ctrl+Alt+R** (**Ctrl+Cmd+R** on macOS) restarts the resource of the
file you are editing. **Start**, **Stop**, **Restart** and **Ensure** are also on
every resource in the FiveM sidebar, on resource folders in the Explorer and in
the **FiveM** menu of the editor.

Your server needs `rcon_password` set in `server.cfg`. Use this with a local or
development server only.
