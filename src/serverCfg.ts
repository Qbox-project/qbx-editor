/**
 * Reading and checking FXServer configuration files (`server.cfg` and the files it runs with
 * `exec`). Each line is a console command; nothing here runs one.
 */

export interface CfgToken { text: string; start: number; end: number }
/** One command of a line; `tokens[0]` is its name. `;` puts several commands on one line. */
export interface CfgCommand { line: number; tokens: CfgToken[] }
export interface CfgEntry { summary: string; usage?: string; values?: readonly string[]; kind: 'command' | 'variable' }
export interface CfgResource { name: string; categories: readonly string[]; dependencies: readonly string[] }
export interface CfgProblem { line: number; start: number; end: number; severity: 'warning' | 'info'; message: string }

const ON_OFF = ['true', 'false'] as const;
export const RESOURCE_COMMANDS = ['ensure', 'start', 'stop', 'restart'];
export const SET_COMMANDS = ['set', 'sets', 'setr', 'seta'];

/** The commands and variables of FXServer that configuration files use most. Resources add their own. */
export const CFG_ENTRIES: Readonly<Record<string, CfgEntry>> = {
    ensure: { kind: 'command', usage: 'ensure <resource | [category]>', summary: 'Starts a resource, or restarts it when it already runs. A name in brackets starts every resource of that category folder.' },
    start: { kind: 'command', usage: 'start <resource | [category]>', summary: 'Starts a resource that is not running.' },
    stop: { kind: 'command', usage: 'stop <resource>', summary: 'Stops a running resource.' },
    restart: { kind: 'command', usage: 'restart <resource>', summary: 'Stops and starts a running resource.' },
    refresh: { kind: 'command', usage: 'refresh', summary: 'Scans the resource folders again, so resources added since the server started can be started.' },
    exec: { kind: 'command', usage: 'exec <file.cfg>', summary: 'Runs the commands of another configuration file, relative to the server data folder.' },
    set: { kind: 'command', usage: 'set <variable> <value>', summary: 'Sets a server variable. Scripts read it with GetConvar.' },
    sets: { kind: 'command', usage: 'sets <variable> <value>', summary: 'Sets a server variable that is also shown in the server list, such as tags, locale or banner_detail.' },
    setr: { kind: 'command', usage: 'setr <variable> <value>', summary: 'Sets a replicated variable: clients receive it too, so client scripts can read it with GetConvar.' },
    seta: { kind: 'command', usage: 'seta <variable> <value>', summary: 'Sets an archived variable.' },
    add_ace: { kind: 'command', usage: 'add_ace <principal> <object> <allow | deny>', summary: 'Grants or denies a principal access to an object, such as command.restart or a name a resource checks with IsPlayerAceAllowed.' },
    remove_ace: { kind: 'command', usage: 'remove_ace <principal> <object> <allow | deny>', summary: 'Removes an access entry added with add_ace.' },
    add_principal: { kind: 'command', usage: 'add_principal <child> <parent>', summary: 'Makes a principal inherit from another, such as identifier.license:… from group.admin.' },
    remove_principal: { kind: 'command', usage: 'remove_principal <child> <parent>', summary: 'Removes an inheritance added with add_principal.' },
    endpoint_add_tcp: { kind: 'command', usage: 'endpoint_add_tcp "0.0.0.0:30120"', summary: 'The TCP address and port the server listens on.' },
    endpoint_add_udp: { kind: 'command', usage: 'endpoint_add_udp "0.0.0.0:30120"', summary: 'The UDP address and port the server listens on. RCON uses this port.' },
    load_server_icon: { kind: 'command', usage: 'load_server_icon <file.png>', summary: 'The icon of the server in the server list: a 96×96 PNG file.' },
    sv_hostname: { kind: 'variable', usage: 'sv_hostname "name"', summary: 'The name of the server in the server list.' },
    sv_projectName: { kind: 'variable', usage: 'sets sv_projectName "name"', summary: 'The project name shown in the server list.' },
    sv_projectDesc: { kind: 'variable', usage: 'sets sv_projectDesc "description"', summary: 'The short project description shown in the server list.' },
    sv_maxclients: { kind: 'variable', usage: 'sv_maxclients <count>', summary: 'The number of player slots.' },
    sv_licenseKey: { kind: 'variable', usage: 'sv_licenseKey <key>', summary: 'The server license key from the Cfx.re portal. Keep it out of files you share.' },
    sv_enforceGameBuild: { kind: 'variable', usage: 'sv_enforceGameBuild <build>', summary: 'The game build clients must run, which decides the DLC content that is available.',
        values: ['1604', '2060', '2189', '2372', '2545', '2612', '2699', '2802', '2944', '3095', '3258', '3407'] },
    sv_scriptHookAllowed: { kind: 'variable', usage: 'sv_scriptHookAllowed <0 | 1>', summary: 'Whether clients may load Script Hook plugins. Leave it at 0 on public servers.', values: ['0', '1'] },
    sv_endpointPrivacy: { kind: 'variable', usage: 'sv_endpointPrivacy <true | false>', summary: 'Hides player IP addresses from the endpoints that list players.', values: ON_OFF },
    sv_lan: { kind: 'variable', usage: 'sv_lan <true | false>', summary: 'Runs the server without listing or license authentication, for a local network.', values: ON_OFF },
    sv_master1: { kind: 'variable', usage: 'sv_master1 ""', summary: 'The server list to announce to. An empty value keeps the server out of the public list.' },
    sv_listingIPOverride: { kind: 'variable', usage: 'set sv_listingIPOverride "address"', summary: 'The address the server list shows instead of the one it detects.' },
    sv_pureLevel: { kind: 'variable', usage: 'sv_pureLevel <0 | 1 | 2>', summary: 'How strictly modified client game files are refused.', values: ['0', '1', '2'] },
    sv_authMaxVariance: { kind: 'variable', usage: 'sv_authMaxVariance <1-5>', summary: 'How much a returning player may differ from their last session before being refused.', values: ['1', '2', '3', '4', '5'] },
    sv_authMinTrust: { kind: 'variable', usage: 'sv_authMinTrust <1-5>', summary: 'The least account trust a player needs to join.', values: ['1', '2', '3', '4', '5'] },
    sv_tebexSecret: { kind: 'variable', usage: 'sv_tebexSecret <secret>', summary: 'The secret of the Tebex store linked to this server. Keep it out of files you share.' },
    sv_entityLockdown: { kind: 'variable', usage: 'sv_entityLockdown <strict | relaxed | inactive>', summary: 'Whether clients may create entities: strict allows only script-created server entities.', values: ['strict', 'relaxed', 'inactive'] },
    sv_filterRequestControl: { kind: 'variable', usage: 'sv_filterRequestControl <0-4>', summary: 'How far clients may take control of entities they do not own.', values: ['0', '1', '2', '3', '4'] },
    sv_enableNetworkedSounds: { kind: 'variable', usage: 'sv_enableNetworkedSounds <true | false>', summary: 'Whether clients may play sounds for other players through network events.', values: ON_OFF },
    sv_enableNetworkedPhoneExplosions: { kind: 'variable', usage: 'sv_enableNetworkedPhoneExplosions <true | false>', summary: 'Whether clients may trigger phone explosions for other players.', values: ON_OFF },
    sv_enableNetworkedScriptEntityStates: { kind: 'variable', usage: 'sv_enableNetworkedScriptEntityStates <true | false>', summary: 'Whether clients may change script entity states over the network.', values: ON_OFF },
    sv_stateBagStrictMode: { kind: 'variable', usage: 'sv_stateBagStrictMode <true | false>', summary: 'Stops clients from writing state bags of entities they do not own.', values: ON_OFF },
    onesync: { kind: 'variable', usage: 'set onesync <on | legacy | off>', summary: 'Server-side entity synchronisation, needed for more than 48 players and for server-side entity natives.', values: ['on', 'legacy', 'off'] },
    rcon_password: { kind: 'variable', usage: 'rcon_password <password>', summary: 'Enables remote console commands with this password. Qbox Lua uses it to start, stop and restart resources. Keep it out of files you share.' },
    steam_webApiKey: { kind: 'variable', usage: 'set steam_webApiKey <key>', summary: 'The Steam Web API key that lets the server read Steam identifiers. Keep it out of files you share.' },
    mysql_connection_string: { kind: 'variable', usage: 'set mysql_connection_string "mysql://user:password@host/database"', summary: 'The database connection oxmysql uses. Keep it out of files you share.' },
    tags: { kind: 'variable', usage: 'sets tags "roleplay, qbox"', summary: 'Comma-separated tags the server list filters by.' },
    locale: { kind: 'variable', usage: 'sets locale "en-US"', summary: 'The language of the server, as a locale such as en-US or de-DE, for the server list.' },
    banner_detail: { kind: 'variable', usage: 'sets banner_detail "https://…"', summary: 'The image shown on the server page of the server list.' },
    banner_connecting: { kind: 'variable', usage: 'sets banner_connecting "https://…"', summary: 'The image shown while a player connects.' },
};

/** The commands of FXServer configuration text, with comments (`#` or `//`) and blank lines dropped. */
export function parseCfg(source: string): CfgCommand[] {
    const commands: CfgCommand[] = [];
    const lines = source.split('\n');
    for (let line = 0; line < lines.length && line < 20_000; line++) {
        const text = lines[line];
        let tokens: CfgToken[] = [], at = 0;
        const flush = (): void => {
            if (tokens.length > 0) { commands.push({ line, tokens }); }
            tokens = [];
        };
        while (at < text.length) {
            const char = text[at];
            if (char === ' ' || char === '\t' || char === '\r') { at++; continue; }
            if (char === '#' || (char === '/' && text[at + 1] === '/')) { break; }
            if (char === ';') { flush(); at++; continue; }
            const start = at;
            if (char === '"') {
                let value = '';
                at++;
                while (at < text.length && text[at] !== '"') {
                    if (text[at] === '\\' && at + 1 < text.length) { at++; }
                    value += text[at++];
                }
                at++;
                tokens.push({ text: value, start, end: Math.min(at, text.length) });
            } else {
                while (at < text.length && !/[\s;"]/.test(text[at])) { at++; }
                tokens.push({ text: text.slice(start, at), start, end: at });
            }
        }
        flush();
    }
    return commands;
}

/** Whether text looks like FXServer configuration rather than another kind of `.cfg` file. */
export function looksLikeServerCfg(source: string): boolean {
    const lines = source.slice(0, 65536).split('\n');
    return lines.filter((line) => /^\s*(?:ensure|start|exec|endpoint_add_(?:tcp|udp)|add_ace|add_principal|set[sra]?|sv_[A-Za-z0-9_]+|load_server_icon)\s+\S/.test(line)).length >= 2;
}

/**
 * Checks commands against the resources next to the configuration file and against the files it
 * runs. Without `resources` nothing is said about resource names: the file may belong to a server
 * whose resources are not in the workspace.
 */
export function checkCfg(commands: readonly CfgCommand[], context: { resources?: readonly CfgResource[]; fileExists?: (relative: string) => boolean }): CfgProblem[] {
    const problems: CfgProblem[] = [];
    const report = (command: CfgCommand, token: CfgToken, severity: CfgProblem['severity'], message: string): void => {
        problems.push({ line: command.line, start: token.start, end: token.end, severity, message });
    };
    const byName = new Map((context.resources ?? []).map((resource) => [resource.name.toLowerCase(), resource]));
    const categories = new Set((context.resources ?? []).flatMap((resource) => resource.categories.map((category) => category.toLowerCase())));
    const started = new Map<string, number>();
    const starts: { command: CfgCommand; token: CfgToken; resource: CfgResource }[] = [];
    for (const command of commands) {
        const [name, argument] = command.tokens;
        const kind = name.text.toLowerCase();
        if (kind === 'exec' && argument && context.fileExists && !/[$%]/.test(argument.text) && !context.fileExists(argument.text)) {
            report(command, argument, 'warning', `${argument.text} does not exist next to this file, so exec runs nothing.`);
        }
        if ((kind !== 'ensure' && kind !== 'start') || !argument) { continue; }
        const target = argument.text.toLowerCase();
        const category = /^\[(.+)\]$/.exec(target)?.[1];
        if (category !== undefined) {
            if (context.resources && !categories.has(`[${category}]`)) {
                report(command, argument, 'warning', `No resource folder is in a category named ${argument.text}.`);
            }
            for (const resource of context.resources ?? []) {
                if (resource.categories.some((candidate) => candidate.toLowerCase() === `[${category}]`) && !started.has(resource.name.toLowerCase())) {
                    started.set(resource.name.toLowerCase(), command.line);
                }
            }
            continue;
        }
        if (started.has(target) && kind === 'ensure') {
            report(command, argument, 'info', `${argument.text} is already started on line ${started.get(target)! + 1}; this line restarts it.`);
        }
        const resource = byName.get(target);
        if (context.resources && !resource) {
            report(command, argument, 'warning', `No resource named ${argument.text} is among the resources next to this file.`);
        }
        if (!started.has(target)) {
            started.set(target, command.line);
            if (resource) { starts.push({ command, token: argument, resource }); }
        }
    }
    for (const { command, token, resource } of starts) {
        for (const dependency of resource.dependencies) {
            const key = dependency.toLowerCase(), line = started.get(key);
            if (!byName.has(key)) {
                report(command, token, 'warning', `${resource.name} depends on ${dependency}, which is not among the resources next to this file, so it cannot start.`);
            } else if (line === undefined) {
                report(command, token, 'info', `${resource.name} depends on ${dependency}, which this file does not start. The server starts it on demand.`);
            } else if (line > command.line) {
                report(command, token, 'info', `${resource.name} depends on ${dependency}, which is started later, on line ${line + 1}. The server starts it early for ${resource.name}; list dependencies first to keep the order you read.`);
            }
        }
    }
    return problems.sort((a, b) => a.line - b.line || a.start - b.start);
}

/** The dependencies a manifest declares as resource names, without constraints such as `/server:5181`. */
export function resourceDependencies(values: readonly string[]): string[] {
    return [...new Set(values.filter((value) => value && !value.startsWith('/')))];
}

export type CfgPosition =
    | { kind: 'command'; prefix: string }
    | { kind: 'resource'; prefix: string }
    | { kind: 'file'; prefix: string }
    | { kind: 'variable'; prefix: string }
    | { kind: 'value'; name: string; prefix: string }
    | { kind: 'none' };

/** What can be completed at `character` of a line: the command, or an argument by the command before it. */
export function cfgPosition(lineText: string, character: number): CfgPosition {
    const before = lineText.slice(0, character);
    const segment = before.slice(before.lastIndexOf(';') + 1);
    if (/^\s*(?:#|\/\/)/.test(segment)) { return { kind: 'none' }; }
    const commands = parseCfg(segment);
    const tokens = commands[commands.length - 1]?.tokens ?? [];
    const open = /\S$/.test(segment);
    const prefix = open && tokens.length > 0 ? tokens[tokens.length - 1].text : '';
    const complete = open ? tokens.slice(0, -1) : tokens;
    if (complete.length === 0) { return { kind: 'command', prefix }; }
    const command = complete[0].text.toLowerCase();
    if (RESOURCE_COMMANDS.includes(command) && complete.length === 1) { return { kind: 'resource', prefix }; }
    if (command === 'exec' && complete.length === 1) { return { kind: 'file', prefix }; }
    if (SET_COMMANDS.includes(command)) {
        return complete.length === 1 ? { kind: 'variable', prefix } : complete.length === 2 ? { kind: 'value', name: complete[1].text, prefix } : { kind: 'none' };
    }
    return complete.length === 1 && CFG_ENTRIES[complete[0].text]?.values ? { kind: 'value', name: complete[0].text, prefix } : { kind: 'none' };
}
