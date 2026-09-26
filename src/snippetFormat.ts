import { applyEdits, modify, parseTree, printParseErrorCode, type Edit, type Node, type ParseError } from 'jsonc-parser';

export const MAX_SNIPPET_FILE_BYTES = 1024 * 1024;
export const MAX_SNIPPET_BODY_BYTES = 128 * 1024;
export const MAX_SNIPPETS_PER_FILE = 1000;

export interface ParsedSnippet {
    name: string;
    prefix: string[];
    description: string;
    body: string;
}

export interface ParsedSnippetFile {
    snippets: ParsedSnippet[];
    issues: string[];
}

export function snippetNameError(name: string): string | undefined {
    return !name.trim() || [...name].length > 128 || /[\x00-\x1f\x7f]/.test(name)
        ? 'Snippet names must contain 1–128 characters and no control characters.' : undefined;
}

export function snippetBodyError(body: string): string | undefined {
    return Buffer.byteLength(body, 'utf8') > MAX_SNIPPET_BODY_BYTES ? 'A snippet body must not exceed 128 KiB.' : undefined;
}

function properties(node: Node): Map<string, Node> | undefined {
    if (node.type !== 'object') { return undefined; }
    const result = new Map<string, Node>();
    for (const property of node.children ?? []) {
        const [key, value] = property.children ?? [];
        if (!key || !value || result.has(key.value as string)) { return undefined; }
        result.set(key.value as string, value);
    }
    return result;
}

function stringOrLines(node: Node | undefined): string | undefined {
    if (node?.type === 'string') { return node.value as string; }
    if (node?.type === 'array' && node.children?.every((child) => child.type === 'string')) {
        return node.children.map((child) => child.value as string).join('\n');
    }
    return undefined;
}

/** Parse JSONC without losing duplicate object keys or trusting prototype-shaped snippet names. */
export function parseSnippetFile(text: string): ParsedSnippetFile {
    if (Buffer.byteLength(text, 'utf8') > MAX_SNIPPET_FILE_BYTES) {
        return { snippets: [], issues: ['The snippet file exceeds the 1 MiB limit.'] };
    }
    const errors: ParseError[] = [];
    const bomLength = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const tree = parseTree(text.slice(bomLength), errors, { allowTrailingComma: true });
    if (errors.length > 0 || !tree) {
        const issue = errors.slice(0, 3).map((error) => {
            const offset = error.offset + bomLength;
            const before = text.slice(0, offset);
            const line = before.split('\n').length;
            const column = offset - before.lastIndexOf('\n');
            return `${printParseErrorCode(error.error)} at line ${line}, column ${column}`;
        }).join('; ');
        return { snippets: [], issues: [`Invalid snippet JSONC${issue ? `: ${issue}` : '. Expected an object.'}`] };
    }
    if (tree.type !== 'object') {
        return { snippets: [], issues: ['The snippet file must be an object mapping snippet names to definitions.'] };
    }
    const entries = tree.children ?? [];
    if (entries.length > MAX_SNIPPETS_PER_FILE) {
        return { snippets: [], issues: ['The snippet file exceeds the 1000 snippet limit.'] };
    }
    const counts = new Map<string, number>();
    for (const entry of entries) {
        const name = entry.children?.[0].value as string;
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const snippets: ParsedSnippet[] = [];
    const issues: string[] = [];
    const reportedDuplicates = new Set<string>();
    for (const entry of entries) {
        const [key, value] = entry.children ?? [];
        const name = key.value as string;
        if (counts.get(name)! > 1) {
            if (!reportedDuplicates.has(name)) { issues.push(`Duplicate snippet name ${JSON.stringify(name)}. Give each snippet a unique name.`); }
            reportedDuplicates.add(name);
            continue;
        }
        const invalidName = snippetNameError(name);
        if (invalidName) { issues.push(`${JSON.stringify(name)}: ${invalidName}`); continue; }
        const fields = properties(value);
        if (!fields) { issues.push(`${JSON.stringify(name)}: the definition must be an object with no duplicate properties.`); continue; }
        if ([...fields.keys()].some((field) => !['prefix', 'description', 'body'].includes(field))) {
            issues.push(`${JSON.stringify(name)}: supported properties are prefix, description and body.`);
            continue;
        }
        const body = stringOrLines(fields.get('body'));
        if (body === undefined) { issues.push(`${JSON.stringify(name)}: body must be a string or an array of strings.`); continue; }
        const invalidBody = snippetBodyError(body);
        if (invalidBody) { issues.push(`${JSON.stringify(name)}: ${invalidBody}`); continue; }
        const description = fields.get('description');
        if (description && (description.type !== 'string' || [...description.value as string].length > 2048)) {
            issues.push(`${JSON.stringify(name)}: description must be a string of at most 2048 characters.`);
            continue;
        }
        const prefix = fields.get('prefix');
        let prefixes: string[] = [];
        if (prefix?.type === 'string') { prefixes = [prefix.value as string]; }
        else if (prefix?.type === 'array' && prefix.children?.every((child) => child.type === 'string')) {
            prefixes = prefix.children.map((child) => child.value as string);
        } else if (prefix) {
            issues.push(`${JSON.stringify(name)}: prefix must be a string or an array of strings.`);
            continue;
        }
        if (prefixes.length > 20 || prefixes.some((item) => [...item].length > 128 || /[\x00-\x1f\x7f]/.test(item))) {
            issues.push(`${JSON.stringify(name)}: use at most 20 prefixes, each at most 128 characters without control characters.`);
            continue;
        }
        snippets.push({ name, prefix: prefixes, description: description?.value as string ?? '', body });
    }
    return { snippets, issues };
}

/** Produce minimal edits; malformed files and duplicate labels always require the user's own edit. */
export function addSnippetToText(text: string, name: string, body: string, description?: string): { text: string; edits: Edit[] } {
    const invalidName = snippetNameError(name);
    if (invalidName) { throw new Error(invalidName); }
    const invalidBody = snippetBodyError(body);
    if (invalidBody) { throw new Error(invalidBody); }
    if (description !== undefined && [...description].length > 2048) { throw new Error('Snippet descriptions must not exceed 2048 characters.'); }
    const parsed = parseSnippetFile(text);
    if (parsed.issues.length) { throw new Error(`Fix the snippet file before adding another snippet: ${parsed.issues[0]}`); }
    if (parsed.snippets.some((snippet) => snippet.name === name)) { throw new Error(`A snippet named ${JSON.stringify(name)} already exists. Choose another name.`); }
    if (parsed.snippets.length >= MAX_SNIPPETS_PER_FILE) { throw new Error('The snippet file already contains 1000 snippets.'); }
    const indentation = /^([ \t]+)"/m.exec(text)?.[1] ?? '    ';
    const bomLength = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const edits = modify(text.slice(bomLength), [name], {
        prefix: name, ...(description === undefined ? {} : { description }), body: body.split(/\r?\n/),
    }, { formattingOptions: { insertSpaces: !indentation.includes('\t'), tabSize: Math.min(8, indentation.length), eol: text.includes('\r\n') ? '\r\n' : '\n' } })
        .map((edit) => ({ ...edit, offset: edit.offset + bomLength }));
    const updated = applyEdits(text, edits);
    const result = parseSnippetFile(updated);
    if (result.issues.length) { throw new Error(`The new snippet could not be added: ${result.issues[0]}`); }
    return { text: updated, edits };
}
