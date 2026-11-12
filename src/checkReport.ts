import type { LocaleMatrix } from './localeMatrix';
import { boundedRows, type ReportRow, type ReportTone, type ReportView } from './reportTypes';
import { OVERSIZED_ASSET_BYTES, type CheckResult, type CheckSeverity } from './resourceChecks';

/** Makes a file, and a zero-based line in it, something a report row can open. */
export type LinkFor = (file: string, line?: number) => { id: string; label: string } | undefined;

const SEVERITY: Record<CheckSeverity, { label: string; tone: ReportTone }> = {
    error: { label: 'Error', tone: 'error' },
    warning: { label: 'Warning', tone: 'warning' },
    info: { label: 'Note', tone: 'muted' },
};

function megabytes(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KiB`;
}

/** The report of the data checks: problems first, then where the streaming memory goes. */
export function checkReportView(result: CheckResult, scope: string, link: LinkFor): ReportView {
    const count = (severity: CheckSeverity) => result.findings.filter((finding) => finding.severity === severity).length;
    const assets = result.facts.flatMap((resource) => resource.stream);
    const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
    const largest = [...assets].sort((a, b) => (b.physical ?? b.size) - (a.physical ?? a.size)).slice(0, 25);
    const byResource = result.facts.filter((resource) => resource.stream.length > 0)
        .map((resource) => ({ resource, bytes: resource.stream.reduce((sum, asset) => sum + asset.size, 0), physical: Math.max(0, ...resource.stream.map((asset) => asset.physical ?? 0)) }))
        .sort((a, b) => b.bytes - a.bytes);
    const escrowed = result.facts.filter((resource) => resource.escrowed);
    const problems: ReportRow[] = result.findings.map((finding) => ({
        cells: [{ text: SEVERITY[finding.severity].label, tone: SEVERITY[finding.severity].tone }, finding.resource, finding.category, finding.message],
        link: finding.file ? link(finding.file, finding.line) : undefined,
    }));
    return {
        title: 'Resource data checks',
        subtitle: scope,
        stats: [
            { label: 'Errors', value: count('error').toLocaleString(), tone: count('error') ? 'error' : 'ok' },
            { label: 'Warnings', value: count('warning').toLocaleString(), tone: count('warning') ? 'warning' : 'ok' },
            { label: 'Resources', value: result.facts.length.toLocaleString() },
            { label: 'Streamed files', value: assets.length.toLocaleString() },
            { label: 'Streamed size', value: megabytes(totalBytes) },
        ],
        sections: [
            { title: 'Problems', columns: ['Severity', 'Resource', 'Area', 'Problem'], ...boundedRows(problems),
                description: 'Vehicle and weapon metadata, data file declarations, streamed files and Asset Escrow.',
                empty: 'No problems found in what these checks cover.' },
            ...(largest.length > 0 ? [{ title: 'Largest streamed assets', columns: ['Asset', 'Resource', 'File size', 'Physical memory'],
                description: `The game warns about assets that need ${megabytes(OVERSIZED_ASSET_BYTES)} or more of physical memory.`,
                rows: largest.map((asset): ReportRow => ({
                    cells: [asset.name, asset.resource, megabytes(asset.size),
                        asset.physical === undefined ? { text: 'not a resource container', tone: 'muted' } : { text: megabytes(asset.physical), tone: asset.physical >= OVERSIZED_ASSET_BYTES ? 'warning' : undefined }],
                    link: link(asset.file),
                })) }] : []),
            ...(byResource.length > 1 ? [{ title: 'Streaming by resource', columns: ['Resource', 'Files', 'Total size', 'Largest physical memory'],
                ...boundedRows(byResource.map(({ resource, bytes, physical }): ReportRow => ({ cells: [resource.name, resource.stream.length.toLocaleString(), megabytes(bytes), physical ? megabytes(physical) : '' ] }))) }] : []),
            ...(escrowed.length > 0 ? [{ title: 'Asset Escrow', columns: ['Resource', 'Encrypted Lua files'],
                description: 'Encrypted files cannot be read, checked or edited; only what escrow_ignore left out can.',
                rows: escrowed.map((resource): ReportRow => ({ cells: [resource.name, resource.encryptedFiles.toLocaleString()] })) }] : []),
        ],
        notes: [
            'These checks read the files on disk, not a running server. They compare the metadata of a resource with what that resource streams and declares.',
            'Models, textures and handling that the game or another resource provides are not known here, so a warning about one of those can be ignored.',
            'Physical memory comes from the header of each streamed file, the figure the game reserves when it loads the file.',
        ],
    };
}

export interface ResourceLocales { name: string; matrix: LocaleMatrix }

/** The report of locale coverage: per language how complete it is, then every missing key. */
export function localeReportView(resources: readonly ResourceLocales[], scope: string, link: LinkFor): ReportView {
    const compared = resources.filter((resource) => resource.matrix.base);
    const coverage: ReportRow[] = [], missing: ReportRow[] = [], placeholders: ReportRow[] = [], unreadable: ReportRow[] = [];
    let gaps = 0;
    for (const { name, matrix } of resources) {
        const base = matrix.base;
        for (const file of matrix.files) {
            if (file.problem) {
                unreadable.push({ cells: [name, file.language, { text: file.problem, tone: 'error' }], link: link(file.file) });
                continue;
            }
            if (!base) { continue; }
            const lacking = file === base ? 0 : [...base.entries.keys()].filter((key) => !file.entries.has(key)).length;
            const extra = matrix.extra.get(file.language)?.length ?? 0;
            gaps += lacking;
            coverage.push({
                cells: [name, file === base ? `${file.language} (base)` : file.language, file.entries.size.toLocaleString(),
                    { text: lacking.toLocaleString(), tone: lacking ? 'warning' : 'ok' }, { text: extra.toLocaleString(), tone: extra ? 'muted' : undefined },
                    base.entries.size ? `${Math.round(100 * (base.entries.size - lacking) / base.entries.size)}%` : ''],
                link: link(file.file),
            });
        }
        for (const gap of matrix.missing) {
            missing.push({ cells: [name, gap.key, { text: gap.languages.join(', '), tone: 'warning' }, gap.text.slice(0, 160)], link: base ? link(base.file, gap.line) : undefined });
        }
        for (const gap of matrix.placeholders) {
            placeholders.push({ cells: [name, gap.key, { text: gap.languages.join(', '), tone: 'warning' }, gap.text.slice(0, 160)], link: base ? link(base.file, gap.line) : undefined });
        }
    }
    return {
        title: 'Locale matrix',
        subtitle: scope,
        stats: [
            { label: 'Resources with locales', value: compared.length.toLocaleString() },
            { label: 'Languages', value: new Set(compared.flatMap((resource) => resource.matrix.files.map((file) => file.language.toLowerCase()))).size.toLocaleString() },
            { label: 'Missing translations', value: gaps.toLocaleString(), tone: gaps ? 'warning' : 'ok' },
            { label: 'Placeholder differences', value: placeholders.length.toLocaleString(), tone: placeholders.length ? 'warning' : 'ok' },
        ],
        sections: [
            { title: 'Coverage', columns: ['Resource', 'Language', 'Keys', 'Missing', 'Not in base', 'Complete'], ...boundedRows(coverage),
                description: 'Each language compared with the base language of its resource: en where there is one, else the language with the most keys.',
                empty: 'No resource here has locale files in a locales folder.' },
            { title: 'Missing translations', columns: ['Resource', 'Key', 'Missing in', 'Base text'], ...boundedRows(missing), empty: 'Every key of the base languages is translated.' },
            ...(placeholders.length > 0 ? [{ title: 'Placeholder differences', columns: ['Resource', 'Key', 'Differs in', 'Base text'], ...boundedRows(placeholders),
                description: 'The %s, %d and %{name} placeholders of these translations are not those of the base text, so formatting them can fail or drop a value.' }] : []),
            ...(unreadable.length > 0 ? [{ title: 'Files that could not be read', columns: ['Resource', 'Language', 'Problem'], rows: unreadable }] : []),
        ],
        notes: [
            'Reads .json and .lua files directly in the locales (or locale) folder of each resource. Lua files count as far as they assign or return tables of string literals.',
        ],
    };
}
