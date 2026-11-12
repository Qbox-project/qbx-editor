import * as path from 'node:path';
import * as vscode from 'vscode';
import { checkReportView, localeReportView, type LinkFor } from './checkReport';
import { localeMatrix, readLocales } from './localeMatrix';
import { ReportPanel, type ReportContent, type ReportLink } from './reportBrowser';
import { checkResources, type CheckFinding, type CheckTarget } from './resourceChecks';
import type { Resource, ResourceIndex } from './resources';

const SEVERITIES: Record<CheckFinding['severity'], vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
};
const TEXT_FILE = /\.(?:lua|meta|xml|json)$/i;

/**
 * The checks of resource data that need no language server: vehicle and weapon metadata, data file
 * declarations, streamed files, Asset Escrow, and locale coverage. Each shows a report tab; the
 * data checks also list their findings in the Problems panel.
 */
export class DataChecks implements vscode.Disposable {
    private readonly diagnostics = vscode.languages.createDiagnosticCollection('fivem-data');
    private readonly checks: ReportPanel;
    private readonly locales: ReportPanel;
    private checkScope: Resource | undefined;
    private localeScope: Resource | undefined;
    private readonly subscriptions: vscode.Disposable[] = [];
    private rerun: ReturnType<typeof setTimeout> | undefined;

    constructor(extensionUri: vscode.Uri, private readonly index: ResourceIndex) {
        this.checks = new ReportPanel(extensionUri, 'qbxLua.dataChecks', 'Resource data checks', (status, isCurrent) => this.buildChecks(status, isCurrent));
        this.locales = new ReportPanel(extensionUri, 'qbxLua.localeMatrix', 'Locale matrix', (status, isCurrent) => this.buildLocales(status, isCurrent));
        this.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
            // An open report follows the files it reads.
            const name = path.basename(document.fileName).toLowerCase();
            const data = /\.meta$/.test(name) || name === 'fxmanifest.lua' || name === '__resource.lua';
            const locale = /[\\/]locales?[\\/][^\\/]+\.(?:json|lua)$/i.test(document.fileName);
            if ((data && this.checks.visible) || (locale && this.locales.visible)) {
                clearTimeout(this.rerun);
                this.rerun = setTimeout(() => {
                    if (data && this.checks.visible) { void this.checks.refresh(); }
                    if (locale && this.locales.visible) { void this.locales.refresh(); }
                }, 500);
            }
        }));
    }

    /** Checks the resource `value` names or lies in, or every resource of the workspace without one. */
    async showChecks(value?: unknown): Promise<void> {
        this.checkScope = await this.scope(value);
        await this.checks.show();
    }

    async showLocales(value?: unknown): Promise<void> {
        this.localeScope = await this.scope(value);
        await this.locales.show();
    }

    restoreChecks(panel: vscode.WebviewPanel): Promise<void> { return this.checks.restore(panel); }
    restoreLocales(panel: vscode.WebviewPanel): Promise<void> { return this.locales.restore(panel); }

    private async scope(value: unknown): Promise<Resource | undefined> {
        await this.index.ready;
        return value instanceof vscode.Uri ? this.index.owner(value) : undefined;
    }

    private targets(scope: Resource | undefined): { resources: Resource[]; label: string } {
        const current = scope && this.index.entries.find((entry) => entry.folder.toString() === scope.folder.toString());
        const resources = current ? [current] : [...this.index.entries];
        return { resources, label: current ? `${current.name} · ${current.folder.fsPath}` : `${resources.length.toLocaleString()} ${resources.length === 1 ? 'resource' : 'resources'} in this workspace` };
    }

    private linker(links: Map<string, ReportLink>, resources: readonly Resource[]): LinkFor {
        return (file, line) => {
            const id = `link:${links.size}`;
            links.set(id, { uri: vscode.Uri.file(file), line });
            const owner = resources.find((resource) => file.toLowerCase().startsWith(`${resource.folder.fsPath.toLowerCase()}${path.sep}`));
            const relative = owner ? path.relative(owner.folder.fsPath, file).split(path.sep).join('/') : path.basename(file);
            return { id, label: line === undefined ? relative : `${relative}:${line + 1}` };
        };
    }

    private async buildChecks(status: (text: string) => void, isCurrent: () => boolean): Promise<ReportContent> {
        await this.index.ready;
        const { resources, label } = this.targets(this.checkScope);
        if (resources.length === 0) { throw new Error('No FiveM resources were found in this workspace.'); }
        const targets: CheckTarget[] = resources.map((resource) => ({ name: resource.name, root: resource.folder.fsPath, manifest: resource.manifest.fsPath }));
        const result = await checkResources(targets, isCurrent, (done) => status(`Checked ${done.toLocaleString()} of ${targets.length.toLocaleString()} resources…`));
        const links = new Map<string, ReportLink>();
        const view = checkReportView(result, label, this.linker(links, resources));
        if (isCurrent()) { this.publish(result.findings); }
        return { view, links };
    }

    /** Lists the findings about text files in the Problems panel, replacing those of the run before. */
    private publish(findings: readonly CheckFinding[]): void {
        const byFile = new Map<string, vscode.Diagnostic[]>();
        for (const finding of findings) {
            if (!finding.file || !TEXT_FILE.test(finding.file)) { continue; }
            const line = finding.line ?? 0;
            const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER), finding.message, SEVERITIES[finding.severity]);
            diagnostic.source = 'fivem-data';
            diagnostic.code = finding.category;
            byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), diagnostic]);
        }
        this.diagnostics.clear();
        for (const [file, diagnostics] of byFile) { this.diagnostics.set(vscode.Uri.file(file), diagnostics); }
    }

    private async buildLocales(status: (text: string) => void, isCurrent: () => boolean): Promise<ReportContent> {
        await this.index.ready;
        const { resources, label } = this.targets(this.localeScope);
        if (resources.length === 0) { throw new Error('No FiveM resources were found in this workspace.'); }
        const compared: { name: string; matrix: ReturnType<typeof localeMatrix> }[] = [];
        for (let at = 0; at < resources.length && isCurrent(); at += 8) {
            const batch = await Promise.all(resources.slice(at, at + 8).map(async (resource) => ({ name: resource.name, files: await readLocales(resource.folder.fsPath) })));
            compared.push(...batch.filter((entry) => entry.files.length > 0).map((entry) => ({ name: entry.name, matrix: localeMatrix(entry.files) })));
            status(`Read ${Math.min(at + 8, resources.length).toLocaleString()} of ${resources.length.toLocaleString()} resources…`);
        }
        const links = new Map<string, ReportLink>();
        return { view: localeReportView(compared, label, this.linker(links, resources)), links };
    }

    dispose(): void {
        clearTimeout(this.rerun);
        this.subscriptions.forEach((subscription) => subscription.dispose());
        this.checks.dispose();
        this.locales.dispose();
        this.diagnostics.dispose();
    }
}
