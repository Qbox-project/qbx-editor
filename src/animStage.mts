/// <reference lib="dom" />
import { poseWorld, type AnimPose } from './animPose.js';
import { themeColor } from './viewerDom.mjs';

export interface StageClip { pose: AnimPose; start: number; end: number; rate: number }
export interface StageTime { time: number; frame: number; phase: number; playing: boolean }
const GROUND = -1, FIELD = Math.PI / 5;

/** Draws a ped skeleton pose on a 2D canvas with an orbiting camera and plays it over the clip's time range. */
export class AnimStage {
    private clip: StageClip | undefined;
    private time = 0;
    private playing = false;
    private last = 0;
    private pending = 0;
    private azimuth = 1.05;
    private elevation = 0.2;
    private distance = 3.4;
    private world = new Float32Array(0);
    private orientations = new Float32Array(0);
    speed = 1;
    loop = true;

    constructor(private readonly canvas: HTMLCanvasElement, private readonly changed: (state: StageTime) => void) {}
    private get span(): number { return this.clip ? Math.max(0, this.clip.end - this.clip.start) : 0; }
    get state(): StageTime {
        const clip = this.clip, span = this.span;
        const frame = clip && clip.pose.duration > 0 ? this.time / clip.pose.duration * (clip.pose.frames - 1) : 0;
        return { time: this.time, frame: Math.max(0, Math.min(clip ? clip.pose.frames - 1 : 0, frame)), phase: clip && span > 0 ? (this.time - clip.start) / span : 0, playing: this.playing };
    }
    setClip(clip: StageClip | undefined): void {
        this.clip = clip; this.playing = false;
        this.time = clip?.start ?? 0;
        if (clip) { this.world = new Float32Array(clip.pose.names.length * 3); this.orientations = new Float32Array(clip.pose.names.length * 4); }
        if (clip && this.span > 0) { this.play(); } else { this.invalidate(); }
    }
    play(): void {
        if (!this.clip || this.span <= 0 || this.playing) { return; }
        if (this.time >= this.clip.end) { this.time = this.clip.start; }
        this.playing = true; this.last = performance.now(); this.invalidate();
    }
    pause(): void { this.playing = false; this.invalidate(); }
    toggle(): void { if (this.playing) { this.pause(); } else { this.play(); } }
    seek(phase: number): void {
        if (!this.clip) { return; }
        this.time = this.clip.start + Math.max(0, Math.min(1, phase)) * this.span; this.invalidate();
    }
    step(frames: number): void {
        const clip = this.clip;
        if (!clip || clip.pose.frames < 2 || clip.pose.duration <= 0) { return; }
        this.playing = false;
        const perFrame = clip.pose.duration / (clip.pose.frames - 1);
        this.time = Math.max(clip.start, Math.min(clip.end, (Math.round(this.time / perFrame) + frames) * perFrame)); this.invalidate();
    }
    resetView(): void { this.azimuth = 1.05; this.elevation = 0.2; this.distance = 3.4; this.invalidate(); }
    orbit(dx: number, dy: number): void { this.azimuth -= dx * 0.008; this.elevation = Math.max(-0.2, Math.min(1.5, this.elevation + dy * 0.008)); this.invalidate(); }
    zoom(factor: number): void { this.distance = Math.max(0.6, Math.min(30, this.distance * factor)); this.invalidate(); }
    invalidate(): void { if (!this.pending) { this.pending = requestAnimationFrame((now) => { this.pending = 0; this.tick(now); }); } }
    private tick(now: number): void {
        const clip = this.clip;
        if (clip && this.playing) {
            this.time += Math.min(0.1, (now - this.last) / 1000) * clip.rate * this.speed; this.last = now;
            if (this.time >= clip.end) {
                if (this.loop) { this.time = clip.start + (this.time - clip.start) % this.span; } else { this.time = clip.end; this.playing = false; }
            }
        }
        this.draw(); this.changed(this.state);
        if (this.playing) { this.invalidate(); }
    }
    private draw(): void {
        const canvas = this.canvas, context = canvas.getContext('2d'), ratio = window.devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
        if (!context || !width || !height) { return; }
        if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
        context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
        const target = [0, 0, -0.2], horizontal = Math.cos(this.elevation) * this.distance;
        const eye = [target[0] + horizontal * Math.cos(this.azimuth), target[1] + horizontal * Math.sin(this.azimuth), target[2] + Math.sin(this.elevation) * this.distance];
        const forward = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]].map((value) => value / this.distance);
        const rightLength = Math.hypot(forward[1], forward[0]) || 1, right = [forward[1] / rightLength, -forward[0] / rightLength, 0];
        const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
        const focal = height / 2 / Math.tan(FIELD / 2);
        const project = (x: number, y: number, z: number): [number, number, number] | undefined => {
            const dx = x - eye[0], dy = y - eye[1], dz = z - eye[2], depth = dx * forward[0] + dy * forward[1] + dz * forward[2];
            if (depth < 0.05) { return undefined; }
            return [width / 2 + focal * (dx * right[0] + dy * right[1] + dz * right[2]) / depth, height / 2 - focal * (dx * up[0] + dy * up[1] + dz * up[2]) / depth, depth];
        };
        const line = (a: [number, number, number] | undefined, b: [number, number, number] | undefined): void => { if (a && b) { context.beginPath(); context.moveTo(a[0], a[1]); context.lineTo(b[0], b[1]); context.stroke(); } };
        context.lineCap = 'round'; context.lineWidth = 1; context.strokeStyle = themeColor('--vscode-panel-border', '#444');
        for (let offset = -2; offset <= 2.001; offset += 0.5) { line(project(offset, -2, GROUND), project(offset, 2, GROUND)); line(project(-2, offset, GROUND), project(2, offset, GROUND)); }
        context.strokeStyle = themeColor('--vscode-charts-green', '#89d185'); context.lineWidth = 2;
        line(project(0, 0, GROUND), project(0, 0.6, GROUND)); line(project(0, 0.6, GROUND), project(-0.08, 0.48, GROUND)); line(project(0, 0.6, GROUND), project(0.08, 0.48, GROUND));
        const clip = this.clip;
        if (!clip) { return; }
        const pose = clip.pose, points = poseWorld(pose, this.state.frame, this.world, this.orientations);
        const screen = pose.names.map((_name, bone) => project(points[bone * 3], points[bone * 3 + 1], points[bone * 3 + 2]));
        const colours = { left: themeColor('--vscode-charts-blue', '#3794ff'), right: themeColor('--vscode-charts-orange', '#d18616'), centre: themeColor('--vscode-foreground', '#ccc') };
        const bones = pose.names.map((name, bone) => ({ name, bone, parent: pose.parents[bone] })).filter((entry) => entry.parent >= 0 && screen[entry.bone] && screen[entry.parent])
            .sort((a, b) => screen[b.bone]![2] - screen[a.bone]![2]);
        for (const { name, bone, parent } of bones) {
            const finger = name.includes('Finger'), scale = Math.max(0.4, Math.min(3, 3.4 / screen[bone]![2]));
            context.strokeStyle = name.includes('_L_') ? colours.left : name.includes('_R_') ? colours.right : colours.centre; context.lineWidth = (finger ? 1.4 : 4) * scale;
            line(screen[parent], screen[bone]);
        }
        const head = pose.names.indexOf('SKEL_Head');
        if (head >= 0) {
            const x = this.orientations[head * 4], y = this.orientations[head * 4 + 1], z = this.orientations[head * 4 + 2], w = this.orientations[head * 4 + 3];
            const centre = project(points[head * 3] + 0.1 * (1 - 2 * (y * y + z * z)), points[head * 3 + 1] + 0.2 * (x * y + w * z), points[head * 3 + 2] + 0.2 * (x * z - w * y));
            if (centre) { context.strokeStyle = colours.centre; context.lineWidth = 2.5; context.beginPath(); context.arc(centre[0], centre[1], focal * 0.1 / centre[2], 0, Math.PI * 2); context.stroke(); }
        }
    }
}
