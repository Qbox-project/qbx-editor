import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getAnimHtml } from './animHtml';
import { buildPedPose } from './animPose';
import type { AnimAction, AnimMessage, AnimView } from './animTypes';
import { copyFromWebview, message as errorText, readBounded, record, watchFile } from './assetFiles';
import { MAX_ASSET_BYTES } from './assetFormats';
import { decodeClip, parseClips, type ClipFile } from './clipFormat';

export const ANIM_VIEW_TYPE = 'qbxLua.animViewer';
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

export class AnimEditor implements vscode.Disposable {
    private generation = 0;
    private disposed = false;
    private ready = false;
    private snapshot: AnimMessage = { type: 'loading' };
    private file: ClipFile | undefined;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly loaded = new vscode.EventEmitter<AnimView>();
    private readonly played = new vscode.EventEmitter<{ clip: number; frames: number }>();
    readonly onDidLoad = this.loaded.event;
    /** Fires when the webview has drawn the first pose of a clip. */
    readonly onDidPlay = this.played.event;
    view: AnimView | undefined;

    constructor(extensionUri: vscode.Uri, readonly uri: vscode.Uri, private readonly panel: vscode.WebviewPanel) {
        panel.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
        panel.webview.html = getAnimHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'animWebview.js')).toString(), randomBytes(16).toString('hex'));
        this.subscriptions.push(watchFile(uri, () => void this.load()), this.loaded, this.played,
            panel.webview.onDidReceiveMessage((value: unknown) => { void this.handle(value).catch((error) => this.post({ type: 'status', message: errorText(error) })); }),
            panel.onDidDispose(() => this.dispose()));
    }
    private post(value: AnimMessage): void {
        if (value.type === 'loading' || value.type === 'state' || value.type === 'error') { this.snapshot = value; }
        if (!this.disposed && this.ready) { void this.panel.webview.postMessage(value); }
    }
    async load(): Promise<void> {
        const generation = ++this.generation;
        this.post({ type: 'loading' });
        try {
            const file = await parseClips(await readBounded(this.uri, MAX_ASSET_BYTES));
            if (this.disposed || generation !== this.generation) { return; }
            const title = path.posix.basename(this.uri.path);
            this.file = file;
            this.view = { snapshotId: randomBytes(16).toString('hex'), title, path: this.uri.scheme === 'file' ? this.uri.fsPath : this.uri.toString(true), dictionary: title.replace(/\.ycd$/i, '').toLowerCase(),
                animations: file.animations, notes: file.notes, clips: file.clips.map((clip, id) => ({ id, name: clip.name, hash: clip.hash, kind: clip.kind, duration: clip.duration, rate: clip.rate, frames: clip.frames, fps: clip.fps, bones: clip.bones, path: clip.path })) };
            this.post({ type: 'state', data: this.view });
        } catch (error) {
            if (!this.disposed && generation === this.generation) { this.view = undefined; this.file = undefined; this.post({ type: 'error', message: errorText(error) }); }
        }
    }
    private animation(id: number, requestId: number): void {
        const clip = this.file?.clips[id];
        if (!this.file || !clip) { return; }
        try {
            const decoded = decodeClip(this.file, clip);
            if (!decoded) { this.post({ type: 'noAnimation', requestId, clip: id, message: clip.kind === 'list' ? 'This clip plays a list of animations, which the preview does not combine.' : 'This clip has no animation to preview.' }); return; }
            const pose = buildPedPose(decoded.data);
            if (!pose) {
                const bones = new Set(decoded.data.tracks.map((track) => track.bone)).size;
                this.post({ type: 'noAnimation', requestId, clip: id, message: decoded.data.frames
                    ? `This clip animates ${bones} bone${bones === 1 ? '' : 's'} that are not the standard ped skeleton, so there is no figure to draw. Its ${decoded.data.frames} frames decode correctly.`
                    : 'This clip has no frames to preview.' });
                return;
            }
            const notes: string[] = [];
            if (pose.assumed) { notes.push(`${pose.assumed} bone${pose.assumed === 1 ? ' uses its' : 's use their'} standard bind offset because the clip stores no position for ${pose.assumed === 1 ? 'it' : 'them'}.`); }
            if (pose.otherBones) { notes.push(`${pose.otherBones} other animated bone${pose.otherBones === 1 ? ' is' : 's are'} not drawn (face, helper and prop bones).`); }
            this.post({ type: 'animation', requestId, data: { clip: id, frames: pose.frames, duration: pose.duration, start: Math.max(0, Math.min(decoded.start, pose.duration)), end: Math.max(0, Math.min(decoded.end, pose.duration)),
                rate: clip.rate, names: pose.names, parents: pose.parents, positions: new Uint8Array(pose.positions.buffer), rotations: new Uint8Array(pose.rotations.buffer), notes } });
        } catch (error) { this.post({ type: 'noAnimation', requestId, clip: id, message: errorText(error) }); }
    }
    private async handle(value: unknown): Promise<void> {
        if (this.disposed || !record(value) || typeof value.type !== 'string') { return; }
        const action = value as AnimAction;
        if (action.type === 'ready') { this.ready = true; this.post(this.snapshot); }
        else if (action.type === 'loaded') { if (this.view && action.snapshotId === this.view.snapshotId) { this.loaded.fire(this.view); } }
        else if (action.type === 'played') { if (this.view && action.snapshotId === this.view.snapshotId && count(action.clip) && count(action.frames)) { this.played.fire({ clip: action.clip, frames: action.frames }); } }
        else if (action.type === 'reload') { await this.load(); }
        else if (action.type === 'animation') { if (count(action.clip) && count(action.requestId)) { this.animation(action.clip, action.requestId); } }
        else if (action.type === 'copy') { const status = await copyFromWebview(action.text, action.label); if (status) { this.post({ type: 'status', message: status }); } }
    }
    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true; ++this.generation; this.file = undefined;
        this.subscriptions.forEach((subscription) => subscription.dispose());
    }
}
