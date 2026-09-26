export interface LogSource {
    start: number;
    end: number;
    resource: string;
    path: string;
    /** One-based Lua source line. */
    line: number;
}

/** Plain text only: strip terminal escape sequences, Cfx colors, and non-printing controls. */
export function cleanLogText(text: string): string {
    // Linear scan avoids pathological escape sequences and handles CSI, OSC and ST strings.
    const out: string[] = [];
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code === 0x1b || code === 0x9b || code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
            const next = text[index + 1];
            if (code === 0x9b || (code === 0x1b && next === '[')) {
                index += code === 0x1b ? 2 : 1;
                while (index < text.length && !(text.charCodeAt(index) >= 0x40 && text.charCodeAt(index) <= 0x7e)) { index++; }
            } else if (code !== 0x1b || next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
                index += code === 0x1b ? 2 : 1;
                while (index < text.length && text.charCodeAt(index) !== 7 && text.charCodeAt(index) !== 0x9c
                    && !(text.charCodeAt(index) === 0x1b && text[index + 1] === '\\')) { index++; }
                if (text.charCodeAt(index) === 0x1b) { index++; }
            } else if (next !== undefined) { index++; }
            continue;
        }
        if (text[index] === '^' && /[0-9]/.test(text[index + 1] ?? '')) { index++; continue; }
        if ((code < 0x20 && code !== 9 && code !== 10) || (code >= 0x7f && code <= 0x9f)
            || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) { continue; }
        out.push(text[index]);
    }
    return out.join('');
}

/**
 * Cfx emits SCRIPT ERROR followed by Lua @resource/path.lua:line sources and stack frames.
 * https://github.com/citizenfx/fivem/blob/master/data/shared/citizen/scripting/lua/scheduler.lua
 * https://github.com/citizenfx/fivem/blob/master/code/components/citizen-scripting-core/src/ScriptHost.cpp
 * Offsets refer to the supplied plain text; callers clean text before parsing. Resolution and
 * traversal checks belong to the workspace source resolver, never to log-provided paths.
 */
export function parseLogSources(text: string): LogSource[] {
    const source = text.slice(0, 32768);
    const pattern = /@([^\s/:@()[\]"'<>]{1,128})\/([^\s:@()[\]"'<>]{1,2048}\.lua):([0-9]{1,10})(?=[:\s),\]]|$)/gi;
    const matches: LogSource[] = [];
    for (const match of source.matchAll(pattern)) {
        const line = Number(match[3]);
        if (!Number.isSafeInteger(line) || line < 1 || line > 0x7fffffff) { continue; }
        matches.push({ start: match.index, end: match.index + match[0].length, resource: match[1], path: match[2], line });
        if (matches.length === 32) { break; }
    }
    return matches;
}
