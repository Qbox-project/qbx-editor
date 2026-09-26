# NUI preview

Use **FiveM: Open NUI Preview** to inspect a resource's browser UI beside its Lua
code. You can also right-click the resource folder in Explorer and choose
**FiveM → Open NUI Preview**. The command requires a trusted workspace because it
runs the resource's UI scripts.

## Prepare the frontend

Build your frontend locally and point the manifest at its HTML output:

```lua
ui_page 'web/dist/index.html'
```

Use a relative asset base, such as `./`, in your frontend build configuration.
Keep the page's scripts, styles, fonts, images and other local assets in its
directory or subdirectories. For the example above, the preview serves
`web/dist/`; it does not serve the rest of the resource.

Save manifest changes before opening or reloading. The extension does not start
your frontend build or development server. After rebuilding, choose **Reload
preview**. **Choose resource…** opens another resource in the same tab.

## Send a message and mock a callback

Put the JSON your UI's `message` listener expects in **Message**, then choose
**Send message**. For example, a page might use:

```json
{ "action": "setVisible", "visible": true }
```

The payload format belongs to your page; adapt the example to its listener.

In **Mock responses**, map callback names to JSON response values:

```json
{
  "getInventory": { "items": [], "slots": 40 },
  "close": { "ok": true }
}
```

Choose **Apply mocks** to activate the object. Calls made with `fetch` or
`XMLHttpRequest` to this resource's NUI callback URLs receive the configured
values. `GetParentResourceName()` returns the selected resource's name. A callback
without a mock receives an error object, and the activity entry says **No mock
configured**. Lua handlers are never executed by the preview.

If the page requests data during initialization, apply its mocks and choose
**Reload preview**. The last applied mocks are restored for that resource; message
payloads are sent only when you choose **Send message**.

Both JSON fields are limited to 64 KiB. A mock object can contain up to 100 callback
names, each 1–256 printable characters long.

## Reuse inputs and inspect callbacks

Enter a **Preset name** and choose **Save** to store both JSON fields. Presets are
scoped to the exact resource in the current workspace and live in VS Code's
extension workspace state. Saving the same name replaces that preset. Selecting
a saved preset fills the fields; choose **Send message** and **Apply mocks** when
ready. **Delete** removes the selected preset explicitly.

Unsaved drafts stay separate for each resource. They are not shared project
files, and switching resources does not send a message.

**Callback activity** keeps the latest 30 entries with bounded request and
response previews. Expand an entry and choose **Open Lua handler** to inspect a
matching indexed callback. When several handlers share a name, their source
paths identify each choice. The **Lua callbacks** filter also finds handlers
directly by name or source file.

## When a preview cannot load

Check the resource notes beneath the preview. The `ui_page` must be a local,
relative HTML file with built assets available on the extension host filesystem.
Remote pages, CDN dependencies, game textures and assets from other resources are
unsupported. Use a relative build base for JavaScript module imports as well as
images and styles.

An existing page Content Security Policy can block UI assets or the injected
preview bridge. If the tab reports **Preview bridge did not start**, check that
policy and the local asset paths, rebuild if needed, then reload. The preview
provides browser rendering and mocked callbacks; it has no FiveM game runtime,
Lua execution or connection to a running server.
