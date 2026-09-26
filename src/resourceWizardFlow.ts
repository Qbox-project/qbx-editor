import type * as vscode from 'vscode';
import { createResourcePlan, type ResourcePlan, type ResourceTemplateId } from './resourceTemplates';
import { createResourceScaffold, validateResourceDestination, type ResourceDestination } from './resourceScaffold';

export type WizardDecision = 'create' | 'name' | 'template' | 'folder';
export interface ResourceCreationResult { folder: vscode.Uri; manifest: vscode.Uri }

export interface ResourceWizardUi {
    chooseParent(current?: vscode.Uri): Promise<vscode.Uri | undefined>;
    chooseName(current?: string): Promise<string | undefined>;
    chooseTemplate(current?: ResourceTemplateId): Promise<ResourceTemplateId | undefined>;
    preview(plan: ResourcePlan, destination: ResourceDestination): Promise<WizardDecision | undefined>;
    problem(message: string): Promise<'folder' | 'name' | undefined>;
    completed(result: ResourceCreationResult, plan: ResourcePlan): Promise<void>;
}

export interface ResourceWizardOperations {
    validate(parent: vscode.Uri, name: string): Promise<ResourceDestination>;
    create(parent: vscode.Uri, plan: ResourcePlan, options: { destination: ResourceDestination; signal?: AbortSignal }): Promise<ResourceCreationResult>;
}

/** Prompts only collect a plan; creation is reached exclusively through its matching preview. */
export async function runResourceWizardFlow(
    ui: ResourceWizardUi,
    options: { initialParent?: vscode.Uri; signal?: AbortSignal } = {},
    operations: ResourceWizardOperations = { validate: validateResourceDestination, create: createResourceScaffold },
): Promise<ResourceCreationResult | undefined> {
    let parent = options.initialParent;
    let name: string | undefined;
    let template: ResourceTemplateId | undefined;
    let step: Exclude<WizardDecision, 'create'> | 'preview' = parent ? 'name' : 'folder';
    const cancelled = () => options.signal?.aborted === true;
    while (!cancelled()) {
        if (step === 'folder') {
            parent = await ui.chooseParent(parent);
            if (!parent || cancelled()) { return undefined; }
            step = name && template ? 'preview' : 'name';
        }
        if (step === 'name') {
            name = await ui.chooseName(name);
            if (name === undefined || cancelled()) { return undefined; }
            step = template ? 'preview' : 'template';
        }
        if (step === 'template') {
            template = await ui.chooseTemplate(template);
            if (!template || cancelled()) { return undefined; }
            step = 'preview';
        }
        if (!parent || name === undefined || !template) { return undefined; }
        let plan: ResourcePlan;
        let destination: ResourceDestination;
        try {
            plan = createResourcePlan({ name, templateId: template });
            destination = await operations.validate(parent, plan.name);
        } catch (error) {
            if (cancelled()) { return undefined; }
            const decision = await ui.problem(error instanceof Error ? error.message : String(error));
            if (!decision || cancelled()) { return undefined; }
            step = decision;
            continue;
        }
        if (cancelled()) { return undefined; }
        const decision = await ui.preview(plan, destination);
        if (!decision || cancelled()) { return undefined; }
        if (decision !== 'create') { step = decision; continue; }
        let result: ResourceCreationResult;
        try {
            result = await operations.create(parent, plan, { destination, signal: options.signal });
        } catch (error) {
            if (cancelled()) { return undefined; }
            const recovery = await ui.problem(error instanceof Error ? error.message : String(error));
            if (!recovery || cancelled()) { return undefined; }
            step = recovery;
            continue;
        }
        // Creation succeeded. A reveal failure must never send the flow back into creating files.
        if (cancelled()) { return result; }
        try { await ui.completed(result, plan); }
        catch (error) {
            throw new Error(`Resource created at ${result.folder.fsPath}, but its editor could not open: ${error instanceof Error ? error.message : String(error)}`);
        }
        return result;
    }
    return undefined;
}
