-- Neovim 0.11+: copy to lua/qbx.lua in your Neovim configuration and require('qbx').
-- Install qbx-lua-ls on PATH, or replace cmd[1] with its absolute executable path.
vim.lsp.config('qbx', {
    cmd = { 'qbx-lua-ls' }, -- stdio is the default; no arguments are needed.
    filetypes = { 'lua' },
    root_dir = function(bufnr, on_dir)
        local root = vim.fs.root(bufnr, { 'fxmanifest.lua', '__resource.lua' })
        if root then
            on_dir(root)
        end
    end,
    -- Initialization options are flat; do not wrap these in qbxLua.
    init_opts = {
        library = {}, -- Add absolute folders, e.g. { 'C:/server/resources' }.
        diagnostics = { enable = true, workspace = true },
        inlayHints = { enable = true },
        semanticTokens = { enable = true },
    },
})
vim.lsp.enable('qbx')
