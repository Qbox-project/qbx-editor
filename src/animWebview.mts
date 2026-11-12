/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { AnimPose } from './animPose.js';
import { AnimStage, type StageTime } from './animStage.mjs';
import type { AnimAction, AnimClipRow, AnimMessage, AnimPlayback, AnimView } from './animTypes.js';
import { luaPlayAnim, luaString } from './mapLua.js';
import { button, element, facts, fromHost, matches, node, pager, record, tokens } from './viewerDom.mjs';

declare function acquireVsCodeApi(): { postMessage(message: AnimAction): void; getState(): unknown; setState(value: unknown): void };
const vscode = acquireVsCodeApi();
const saved = vscode.getState(), prior = record(saved) ? saved : {};
const state = { query: typeof prior.query === 'string' ? prior.query.slice(0, 256) : '', path: typeof prior.path === 'string' ? prior.path.slice(0, 4096) : '',
    clip: typeof prior.clip === 'string' ? prior.clip.slice(0, 512) : '' };
let view: AnimView | undefined, selected: AnimClipRow | undefined, playback: AnimPlayback | undefined, request = 0, notes: string[] = [];
const canvas = element<HTMLCanvasElement>('figure'), scrub = element<HTMLInputElement>('scrub'), playButton = element<HTMLButtonElement>('play');
function save(): void { vscode.setState({ ...state }); }
function status(message: string): void { element('status').textContent = message; }
function copy(text: string, label: string): void { vscode.postMessage({ type: 'copy', text, label }); }
function seconds(value: number): string { return `${value.toFixed(value < 10 ? 2 : 1)} s`; }
function hex(hash: number): string { return `0x${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`; }
function filtered(): AnimClipRow[] { const query = tokens(state.query); return view?.clips.filter((clip) => matches(`${clip.name} ${hex(clip.hash)} ${clip.path}`, query)) ?? []; }
function stageMessage(message: string): void { element('figure-message').textContent = message; element('figure-message').hidden = !message; }
function snippet(title: string, code: string, label: string): HTMLElement[] { const block = node('pre', code, 'snippet'), row = node('div', undefined, 'copy-row'); row.append(button(`Copy ${title}`, () => copy(code, label))); return [block, row]; }

const stage = new AnimStage(canvas, (time: StageTime) => {
    const active = playback !== undefined, span = playback ? playback.end - playback.start : 0;
    playButton.textContent = time.playing ? 'Pause' : 'Play'; playButton.disabled = !active || span <= 0;
    scrub.disabled = !active || span <= 0; element<HTMLButtonElement>('copy-phase').disabled = !active;
    if (document.activeElement !== scrub) { scrub.value = String(Math.round(time.phase * 1000)); }
    element('time').textContent = active ? `${seconds(Math.max(0, time.time - playback!.start))} / ${seconds(span)} · frame ${Math.round(time.frame) + 1} of ${playback!.frames} · phase ${time.phase.toFixed(2)}` : '';
});
function renderDetail(): void {
    const clip = selected, detail = element('detail');
    if (!clip || !view) { detail.replaceChildren(node('p', 'Select a clip to preview it and copy the code that plays it.', 'muted')); return; }
    const rows = [{ name: 'Dictionary', value: view.dictionary }, { name: 'Clip', value: clip.name }, { name: 'Length', value: `${seconds(clip.duration)}${clip.rate !== 1 ? ` at rate ${clip.rate.toFixed(3)}` : ''}` }];
    if (clip.kind === 'animation') { rows.push({ name: 'Frames', value: `${clip.frames}${clip.fps ? ` at ${clip.fps.toFixed(0)} per second` : ''}` }, { name: 'Tracks', value: String(clip.bones) }); }
    else { rows.push({ name: 'Kind', value: clip.kind === 'list' ? 'list of animations' : 'unrecognised clip type' }); }
    if (clip.path && clip.path !== clip.name) { rows.push({ name: 'Stored as', value: clip.path }); }
    const names = node('div', undefined, 'copy-row'), list = node('ul', undefined, 'viewer-notes');
    names.append(button('Copy clip name', () => copy(clip.name, 'clip name')), button('Copy both', () => copy(`${luaString(view!.dictionary)}, ${luaString(clip.name)}`, 'dictionary and clip name')));
    list.append(...notes.map((note) => node('li', note)));
    detail.replaceChildren(node('h2', clip.name, 'detail-name'), node('p', hex(clip.hash), 'detail-sub'), facts(rows, 'facts compact'), names, list,
        node('h2', 'Play with ox_lib', 'section-label'), ...snippet('ox_lib call', luaPlayAnim(view.dictionary, clip.name, 'ox'), 'ox_lib call'),
        node('h2', 'Play with natives', 'section-label'), ...snippet('natives', luaPlayAnim(view.dictionary, clip.name, 'natives'), 'native calls'));
}
function select(clip: AnimClipRow | undefined): void {
    selected = clip; playback = undefined; notes = []; state.clip = clip?.name ?? ''; save();
    stage.setClip(undefined); renderDetail(); clips.render(filtered());
    if (!clip) { stageMessage(''); return; }
    stageMessage('Decoding animation…');
    vscode.postMessage({ type: 'animation', clip: clip.id, requestId: ++request });
}
const clips = pager<AnimClipRow>({ body: 'rows', previous: 'previous', next: 'next', range: 'range' }, 100, 'clips', (clip) => {
    const line = node('tr');
    line.append(node('td', clip.name), node('td', seconds(clip.duration), 'num'), node('td', clip.kind === 'animation' ? String(clip.frames) : '', 'num'), node('td', clip.fps ? clip.fps.toFixed(0) : '', 'num'));
    return line;
}, (clip) => clip === selected, (clip) => select(clip));
function floats(bytes: Uint8Array): Float32Array { return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }
window.addEventListener('message', (event: MessageEvent<AnimMessage>) => {
    if (!fromHost(event)) { return; }
    const message = event.data;
    if (message?.type === 'loading') { element('loading').hidden = false; element('error').hidden = true; status('Reading animation dictionary…'); }
    else if (message?.type === 'state') {
        view = message.data;
        if (state.path !== view.path) { state.query = ''; state.clip = ''; }
        state.path = view.path; save();
        element('loading').hidden = true; element('error').hidden = true; element('clips').hidden = false;
        element('title').textContent = view.dictionary; element('path').textContent = view.path; element<HTMLInputElement>('search').value = state.query;
        element('summary').textContent = [`${view.clips.length.toLocaleString()} clip${view.clips.length === 1 ? '' : 's'} over ${view.animations.toLocaleString()} animation${view.animations === 1 ? '' : 's'}.`,
            'Scripts play a clip by this dictionary name and the clip name.', ...view.notes].join(' ');
        clips.reset(); select(view.clips.find((clip) => clip.name === state.clip) ?? view.clips[0]);
        status('Animation dictionary loaded. The view refreshes when the file changes on disk.');
        vscode.postMessage({ type: 'loaded', snapshotId: view.snapshotId });
    } else if (message?.type === 'error') {
        view = undefined; element('loading').hidden = true; element('clips').hidden = true; element('error').hidden = false; element('error').textContent = message.message;
        status('This file could not be read as an animation dictionary.');
    } else if (message?.type === 'status') { status(message.message); }
    else if (message?.type === 'animation' && message.requestId === request && view) {
        const data = message.data, pose: AnimPose = { frames: data.frames, duration: data.duration, names: data.names, parents: data.parents, positions: floats(data.positions), rotations: floats(data.rotations), animated: 0, assumed: 0, otherBones: 0 };
        if (pose.positions.length !== data.frames * data.names.length * 3 || pose.rotations.length !== data.frames * data.names.length * 4 || data.parents.length !== data.names.length) { stageMessage('The animation data did not arrive intact.'); return; }
        playback = data; notes = data.notes; stageMessage(''); renderDetail();
        stage.speed = Number(element<HTMLSelectElement>('speed').value) || 1; stage.loop = element<HTMLInputElement>('loop').checked;
        stage.setClip({ pose, start: data.start, end: data.end, rate: data.rate });
        status(data.end > data.start ? 'Playing. Space pauses; the arrow keys step one frame.' : 'This clip is a single pose.');
        vscode.postMessage({ type: 'played', snapshotId: view.snapshotId, clip: data.clip, frames: data.frames });
    } else if (message?.type === 'noAnimation' && message.requestId === request) { stageMessage(message.message); status(message.message); }
});
let drag: { x: number; y: number } | undefined;
canvas.addEventListener('pointerdown', (event) => { drag = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); });
canvas.addEventListener('pointermove', (event) => { if (drag) { stage.orbit(event.clientX - drag.x, event.clientY - drag.y); drag = { x: event.clientX, y: event.clientY }; } });
canvas.addEventListener('pointerup', () => { drag = undefined; }); canvas.addEventListener('pointercancel', () => { drag = undefined; });
canvas.addEventListener('wheel', (event) => { event.preventDefault(); stage.zoom(event.deltaY < 0 ? 1 / 1.15 : 1.15); }, { passive: false });
canvas.addEventListener('keydown', (event) => {
    if (event.key === ' ') { stage.toggle(); } else if (event.key === 'ArrowLeft') { stage.step(-1); } else if (event.key === 'ArrowRight') { stage.step(1); } else { return; }
    event.preventDefault();
});
new ResizeObserver(() => stage.invalidate()).observe(canvas);
new MutationObserver(() => stage.invalidate()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
playButton.addEventListener('click', () => stage.toggle());
scrub.addEventListener('input', () => { stage.pause(); stage.seek(Number(scrub.value) / 1000); });
element('speed').addEventListener('change', () => { stage.speed = Number(element<HTMLSelectElement>('speed').value) || 1; });
element('loop').addEventListener('change', () => { stage.loop = element<HTMLInputElement>('loop').checked; });
element('reset').addEventListener('click', () => stage.resetView());
element('copy-phase').addEventListener('click', () => copy(stage.state.phase.toFixed(3), 'phase'));
element('search').addEventListener('input', () => { state.query = element<HTMLInputElement>('search').value.slice(0, 256); save(); clips.reset(); clips.render(filtered()); });
element('copy-dictionary').addEventListener('click', () => { if (view) { copy(view.dictionary, 'dictionary name'); } });
element('reload').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
vscode.postMessage({ type: 'ready' });
