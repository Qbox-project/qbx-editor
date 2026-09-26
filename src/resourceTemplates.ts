export type ResourceTemplateId = 'lua' | 'ox_lib' | 'qbox';

export interface ResourceTemplate {
    readonly id: ResourceTemplateId;
    readonly label: string;
    readonly description: string;
    readonly dependencies: readonly string[];
}

export interface ResourcePlan {
    readonly name: string;
    readonly templateId: ResourceTemplateId;
    readonly templateLabel: string;
    readonly dependencies: readonly string[];
    readonly files: readonly { readonly path: string; readonly content: string }[];
}

export const RESOURCE_TEMPLATES: readonly ResourceTemplate[] = [
    { id: 'lua', label: 'Plain Lua', description: 'Client, server and shared Lua files with no framework dependency.', dependencies: [] },
    { id: 'ox_lib', label: 'Lua + ox_lib', description: 'Lua starter with the ox_lib initializer and lib helpers.', dependencies: ['ox_lib'] },
    { id: 'qbox', label: 'Qbox', description: 'Lua starter with ox_lib and the Qbox qbx helper module.', dependencies: ['ox_lib', 'qbx_core'] },
];

/** A portable folder name which also works as one exact resource console argument. */
export function resourceNameError(name: string): string | undefined {
    if (typeof name !== 'string' || name.length < 1 || name.length > 64 || /[^A-Za-z0-9_-]/.test(name)) {
        return 'Use 1–64 ASCII letters, numbers, underscores or hyphens for the resource name.';
    }
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
        return 'This resource name is reserved by Windows. Choose another name.';
    }
    return undefined;
}

/** Pure, deterministic starter contents. See docs/resource-templates.md for provenance. */
export function createResourcePlan(options: { name: string; templateId: ResourceTemplateId }): ResourcePlan {
    const invalidName = resourceNameError(options.name);
    if (invalidName) { throw new Error(invalidName); }
    const template = RESOURCE_TEMPLATES.find((candidate) => candidate.id === options.templateId);
    if (!template) { throw new Error('Choose a supported resource template.'); }

    const sharedScripts = [
        ...(template.id !== 'lua' ? ['@ox_lib/init.lua'] : []),
        ...(template.id === 'qbox' ? ['@qbx_core/modules/lib.lua'] : []),
        'shared/config.lua',
    ];
    const manifest = [
        "fx_version 'cerulean'",
        "game 'gta5'",
        '',
        `name '${options.name}'`,
        "version '0.1.0'",
        '',
        'shared_scripts {',
        ...sharedScripts.map((script) => `    '${script}',`),
        '}',
        '',
        "client_script 'client/main.lua'",
        "server_script 'server/main.lua'",
        ...(template.dependencies.length ? [
            '',
            'dependencies {',
            ...template.dependencies.map((dependency) => `    '${dependency}',`),
            '}',
        ] : []),
        '',
    ].join('\n');
    const helpers = template.id === 'qbox'
        ? '-- lib and qbx helpers are available here. Use exports.qbx_core for core exports.\n'
        : template.id === 'ox_lib' ? '-- lib helpers are available here.\n' : '';
    return {
        name: options.name,
        templateId: template.id,
        templateLabel: template.label,
        dependencies: [...template.dependencies],
        files: [
            { path: 'fxmanifest.lua', content: manifest },
            { path: 'shared/config.lua', content: '-- Settings loaded separately on both client and server.\n-- This file is sent to clients; keep server secrets in server-only code.\nConfig = {}\n' },
            { path: 'client/main.lua', content: '-- Add client-side code here. Config is loaded from shared/config.lua.\n' + helpers },
            { path: 'server/main.lua', content: '-- Add server-side code here. Config is loaded from shared/config.lua.\n' + helpers },
        ],
    };
}

function markdownText(text: string): string { return text.replace(/[\\`*_{}\[\]<>()#+.!|~-]/g, '\\$&'); }

function codeBlock(content: string, language: string): string {
    const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    return `${fence}${language}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`;
}

/** Markdown preview with destination and exact file contents contained in inert code fences. */
export function renderResourcePreview(plan: ResourcePlan, destination: string): string {
    const tree = `${plan.name}/\n${plan.files.map((file) => `    ${file.path}`).join('\n')}`;
    return [
        '# Create FiveM Resource',
        '',
        `Template: ${markdownText(plan.templateLabel)}`,
        '',
        'Creates four files in a new local resource folder.',
        '',
        '## Destination',
        '',
        codeBlock(destination, 'text'),
        '',
        '## Dependencies',
        '',
        ...(plan.dependencies.length ? ['These resources must already be installed on your server.', '', codeBlock(plan.dependencies.join('\n'), 'text')] : ['None.']),
        '',
        '## Files',
        '',
        codeBlock(tree, 'text'),
        ...plan.files.flatMap((file) => ['', `## ${markdownText(file.path)}`, '', codeBlock(file.content, 'lua')]),
        '',
    ].join('\n');
}
