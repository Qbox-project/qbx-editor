import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { RESOURCE_TEMPLATES, renderResourcePreview, resourceNameError, type ResourcePlan, type ResourceTemplateId } from './resourceTemplates';
import type { ResourceDestination } from './resourceScaffold';
import { runResourceWizardFlow, type ResourceWizardUi, type WizardDecision } from './resourceWizardFlow';

/** Loaded by the create command, with no filesystem watchers or UI at extension startup. */
export class ResourceWizard implements vscode.Disposable {
    private busy = false;
    private disposed = false;
    private operation: AbortController | undefined;
    private readonly previews = new Map<string, string>();
    private readonly provider: vscode.Disposable;

    constructor() {
        this.provider = vscode.workspace.registerTextDocumentContentProvider('qbx-resource-preview', {
            provideTextDocumentContent: (uri) => this.previews.get(uri.toString()) ?? 'This resource preview has closed.',
        });
    }

    async show(argument?: unknown): Promise<void> {
        if (this.disposed) { return; }
        if (this.busy) {
            void vscode.window.showInformationMessage('Finish or cancel the current resource wizard first.');
            return;
        }
        if (argument !== undefined && !(argument instanceof vscode.Uri)) {
            void vscode.window.showErrorMessage('Choose a destination folder in Explorer or run FiveM: Create Resource from the Command Palette.');
            return;
        }
        this.busy = true;
        const operation = new AbortController();
        this.operation = operation;
        const ui: ResourceWizardUi = {
            chooseParent: (current) => this.chooseParent(current),
            chooseName: (current) => Promise.resolve(vscode.window.showInputBox({
                title: 'Create FiveM resource · Name', value: current ?? 'my_resource',
                prompt: 'Name the new resource folder (letters, numbers, underscores or hyphens; up to 64 characters).',
                validateInput: resourceNameError, ignoreFocusOut: true,
            })),
            chooseTemplate: (current) => this.chooseTemplate(current),
            preview: (plan, destination) => this.preview(plan, destination),
            problem: async (message) => {
                const choice = await vscode.window.showErrorMessage(message, 'Change folder', 'Change name');
                return choice === 'Change folder' ? 'folder' : choice === 'Change name' ? 'name' : undefined;
            },
            completed: async (result, plan) => {
                await vscode.window.showTextDocument(result.manifest, { preview: false });
                if (operation.signal.aborted) { return; }
                const required = plan.dependencies.length ? ` Required resources: ${plan.dependencies.join(', ')}.` : '';
                void vscode.window.showInformationMessage(`Created ${plan.name} with ${plan.files.length} files.${required}`, 'Reveal folder').then(async (choice) => {
                    if (choice === 'Reveal folder') {
                        try { await vscode.commands.executeCommand('revealInExplorer', result.folder); }
                        catch { void vscode.window.showWarningMessage(`Resource created at ${result.folder.fsPath}. Open the folder in Explorer to view it.`); }
                    }
                });
            },
        };
        try {
            await runResourceWizardFlow(ui, { initialParent: argument, signal: operation.signal });
        } catch (error) {
            if (!operation.signal.aborted) {
                void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
            }
        } finally {
            try { await this.closePreviews(); }
            catch {
                if (!this.disposed) { void vscode.window.showWarningMessage('The resource preview could not be closed. You can close that tab manually.'); }
            } finally {
                if (this.operation === operation) { this.operation = undefined; }
                this.busy = false;
            }
        }
    }

    dispose(): void {
        this.disposed = true;
        this.operation?.abort();
        this.provider.dispose();
        void this.closePreviews().catch(() => undefined);
    }

    private async chooseParent(current?: vscode.Uri): Promise<vscode.Uri | undefined> {
        const active = vscode.window.activeTextEditor?.document.uri;
        const folder = active && vscode.workspace.getWorkspaceFolder(active);
        const defaultUri = current ?? folder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        const picked = await vscode.window.showOpenDialog({
            title: 'Choose the parent folder for the new FiveM resource',
            openLabel: 'Use this folder', defaultUri,
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        });
        return picked?.[0];
    }

    private async chooseTemplate(current?: ResourceTemplateId): Promise<ResourceTemplateId | undefined> {
        const picked = await vscode.window.showQuickPick(RESOURCE_TEMPLATES.map((template) => ({
            label: template.label, description: template.id === current ? 'Current selection' : undefined,
            detail: template.description, id: template.id,
        })), {
            title: 'Create FiveM resource · Starter', placeHolder: 'Choose a Lua starter', matchOnDetail: true, ignoreFocusOut: true,
        });
        return picked?.id;
    }

    private async preview(plan: ResourcePlan, destination: ResourceDestination): Promise<WizardDecision | undefined> {
        await this.closePreviews();
        if (this.disposed || this.operation?.signal.aborted) { return undefined; }
        const uri = vscode.Uri.from({ scheme: 'qbx-resource-preview', path: `/${plan.name} preview.md`, query: randomUUID() });
        this.previews.set(uri.toString(), renderResourcePreview(plan, destination.folder.fsPath));
        const document = await vscode.workspace.openTextDocument(uri);
        if (this.disposed || this.operation?.signal.aborted) { return undefined; }
        await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        if (this.disposed || this.operation?.signal.aborted) { return undefined; }
        const choices: (vscode.QuickPickItem & { decision?: WizardDecision })[] = [
            { label: '$(new-folder) Create resource', description: `${plan.name} · ${plan.templateLabel}`, detail: `Create the ${plan.files.length} files shown in the preview.`, decision: 'create' },
            { label: '$(edit) Change resource name', decision: 'name' },
            { label: '$(list-selection) Change starter', decision: 'template' },
            { label: '$(folder-opened) Change destination folder', decision: 'folder' },
            { label: 'Cancel' },
        ];
        return (await vscode.window.showQuickPick(choices, {
            title: 'Create FiveM resource · Review',
            placeHolder: 'Review the read-only editor preview, then choose Create resource.', ignoreFocusOut: true,
        }))?.decision;
    }

    private async closePreviews(): Promise<void> {
        const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) =>
            tab.input instanceof vscode.TabInputText && this.previews.has(tab.input.uri.toString()));
        try { if (tabs.length) { await vscode.window.tabGroups.close(tabs, true); } }
        finally { this.previews.clear(); }
    }
}
