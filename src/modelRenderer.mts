/// <reference lib="dom" />
import type { ModelMeshRange, ModelVec3 } from './modelTypes.js';

export type Shading = 'textured' | 'solid' | 'materials' | 'normals';
export interface RenderOptions { shading: Shading; wireframe: boolean; grid: boolean; box: boolean }
interface SceneMesh { material: number; indexCount: number; fill: WebGLVertexArrayObject; lines?: WebGLVertexArrayObject; vertices: WebGLBuffer; elements: WebGLBuffer[]; indices: Uint16Array; flat: boolean; textured: boolean; coloured: boolean; range: ModelMeshRange }

const VERTEX = `#version 300 es
in vec3 aPosition; in vec3 aNormal; in vec2 aUv; in vec4 aColour;
uniform mat4 uViewProjection;
out vec3 vWorld; out vec3 vNormal; out vec2 vUv; out vec4 vColour;
void main() { vWorld = aPosition; vNormal = aNormal; vUv = aUv; vColour = aColour; gl_Position = uViewProjection * vec4(aPosition, 1.0); }`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec3 vWorld; in vec3 vNormal; in vec2 vUv; in vec4 vColour;
uniform sampler2D uTexture; uniform vec4 uColour; uniform vec3 uEye; uniform vec3 uLight;
uniform int uMode; uniform bool uTextured; uniform bool uFlat; uniform float uAlphaTest;
out vec4 outColour;
void main() {
    if (uMode == 3) { outColour = uColour; return; }
    vec3 normal = uFlat ? normalize(cross(dFdx(vWorld), dFdy(vWorld))) : normalize(vNormal);
    if (dot(normal, uEye - vWorld) < 0.0) { normal = -normal; }
    if (uMode == 2) { outColour = vec4(normal * 0.5 + 0.5, 1.0); return; }
    vec4 base = uColour;
    if (uMode == 1 && uTextured) { base = texture(uTexture, vUv); if (base.a < uAlphaTest) { discard; } }
    float diffuse = max(dot(normal, uLight), 0.0), fill = max(dot(normal, -uLight), 0.0) * 0.22;
    outColour = vec4(base.rgb * (0.36 + 0.64 * diffuse + fill), 1.0);
}`;
const CUTOUT = /cutout|decal|alpha|glass|fence|trees|grass|hair|screendoor/;

function perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
    const f = 1 / Math.tan(fov / 2), range = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * range, -1, 0, 0, 2 * far * near * range, 0]);
}
function lookAt(eye: ModelVec3, target: ModelVec3, up: ModelVec3): Float32Array {
    const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]), x = normalize(cross(up, z)), y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}
function multiply(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let column = 0; column < 4; column++) { for (let row = 0; row < 4; row++) { let sum = 0; for (let k = 0; k < 4; k++) { sum += a[k * 4 + row] * b[column * 4 + k]; } out[column * 4 + row] = sum; } }
    return out;
}
function cross(a: ModelVec3, b: ModelVec3): ModelVec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a: ModelVec3, b: ModelVec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function normalize(value: ModelVec3): ModelVec3 { const length = Math.hypot(...value) || 1; return [value[0] / length, value[1] / length, value[2] / length]; }
export function materialColour(index: number): [number, number, number] {
    const hue = (index * 137.508) % 360, c = 0.5, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = 0.34;
    const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
    return [r + m, g + m, b + m];
}

export class ModelRenderer {
    private readonly gl: WebGL2RenderingContext;
    private readonly program: WebGLProgram;
    private readonly uniforms: Record<string, WebGLUniformLocation | null> = {};
    private meshes: SceneMesh[] = [];
    private readonly textures = new Map<string, WebGLTexture>();
    private materials: { diffuse?: string; cutout: boolean }[] = [];
    private readonly lines: { vao: WebGLVertexArrayObject; buffer: WebGLBuffer; count: number; colour: [number, number, number, number] }[] = [];
    private min: ModelVec3 = [-1, -1, -1];
    private max: ModelVec3 = [1, 1, 1];
    private target: ModelVec3 = [0, 0, 0];
    private distance = 5;
    private azimuth = -1.9;
    private elevation = 0.38;
    private pending = 0;
    options: RenderOptions = { shading: 'textured', wireframe: false, grid: true, box: false };

    constructor(private readonly canvas: HTMLCanvasElement) {
        const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
        if (!gl) { throw new Error('WebGL 2 is not available in this editor window, so the 3D preview cannot be drawn.'); }
        this.gl = gl;
        const compile = (type: number, source: string): WebGLShader => {
            const shader = gl.createShader(type)!;
            gl.shaderSource(shader, source); gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { throw new Error(`The preview shader did not compile: ${gl.getShaderInfoLog(shader) ?? ''}`); }
            return shader;
        };
        const program = gl.createProgram()!;
        gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
        ['aPosition', 'aNormal', 'aUv', 'aColour'].forEach((name, index) => gl.bindAttribLocation(program, index, name));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { throw new Error(`The preview shader did not link: ${gl.getProgramInfoLog(program) ?? ''}`); }
        this.program = program;
        for (const name of ['uViewProjection', 'uTexture', 'uColour', 'uEye', 'uLight', 'uMode', 'uTextured', 'uFlat', 'uAlphaTest']) { this.uniforms[name] = gl.getUniformLocation(program, name); }
        gl.enable(gl.DEPTH_TEST);
    }
    get triangles(): number { return this.meshes.reduce((sum, mesh) => sum + mesh.indexCount / 3, 0); }
    private clearMeshes(): void {
        const gl = this.gl;
        for (const mesh of this.meshes) { gl.deleteVertexArray(mesh.fill); if (mesh.lines) { gl.deleteVertexArray(mesh.lines); } gl.deleteBuffer(mesh.vertices); mesh.elements.forEach((buffer) => gl.deleteBuffer(buffer)); }
        for (const line of this.lines) { gl.deleteVertexArray(line.vao); gl.deleteBuffer(line.buffer); }
        this.meshes = []; this.lines.length = 0;
    }
    clearTextures(): void { for (const texture of this.textures.values()) { this.gl.deleteTexture(texture); } this.textures.clear(); }
    private bind(vertices: WebGLBuffer, range: ModelMeshRange, base: number, indices: WebGLBuffer): WebGLVertexArrayObject {
        const gl = this.gl, vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
        const attribute = (index: number, size: number, type: number, normalized: boolean, offset: number, fallback: number[]): void => {
            if (offset < 0) { gl.disableVertexAttribArray(index); gl.vertexAttrib4f(index, fallback[0], fallback[1], fallback[2], fallback[3]); return; }
            gl.enableVertexAttribArray(index); gl.vertexAttribPointer(index, size, type, normalized, 0, offset - base);
        };
        attribute(0, 3, gl.FLOAT, false, range.positions, [0, 0, 0, 1]); attribute(1, 3, gl.FLOAT, false, range.normals, [0, 0, 1, 0]);
        attribute(2, 2, gl.FLOAT, false, range.uvs, [0, 0, 0, 0]); attribute(3, 4, gl.UNSIGNED_BYTE, true, range.colours, [1, 1, 1, 1]);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices); gl.bindVertexArray(null);
        return vao;
    }
    /** Uploads the meshes of one detail level; offsets in `ranges` address `buffer`. */
    setMesh(buffer: Uint8Array, ranges: readonly ModelMeshRange[], min: ModelVec3, max: ModelVec3, materials: readonly { shader: string; diffuse?: string }[]): void {
        const gl = this.gl;
        this.clearMeshes();
        this.materials = materials.map((material) => ({ diffuse: material.diffuse?.toLowerCase(), cutout: CUTOUT.test(material.shader) }));
        for (const range of ranges) {
            const end = range.indices + range.indexCount * 2;
            if (range.positions < 0 || end > buffer.length || range.indices < range.positions) { continue; }
            const vertices = gl.createBuffer()!, elements = gl.createBuffer()!;
            gl.bindBuffer(gl.ARRAY_BUFFER, vertices); gl.bufferData(gl.ARRAY_BUFFER, buffer.subarray(range.positions, range.indices), gl.STATIC_DRAW);
            const indices = new Uint16Array(buffer.buffer.slice(buffer.byteOffset + range.indices, buffer.byteOffset + end));
            const fill = this.bind(vertices, range, range.positions, elements);
            gl.bindVertexArray(fill); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW); gl.bindVertexArray(null);
            this.meshes.push({ material: range.material, indexCount: range.indexCount, fill, vertices, elements: [elements], indices, flat: range.normals < 0, textured: range.uvs >= 0, coloured: range.colours >= 0, range });
        }
        this.min = min; this.max = max;
        this.buildGuides();
    }
    private addLines(points: number[], colour: [number, number, number, number]): void {
        const gl = this.gl, vao = gl.createVertexArray()!, buffer = gl.createBuffer()!;
        gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0); gl.bindVertexArray(null);
        this.lines.push({ vao, buffer, count: points.length / 3, colour });
    }
    private buildGuides(): void {
        const { min, max } = this, size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 0.01);
        const step = 10 ** Math.floor(Math.log10(size / 2)), cx = Math.round((min[0] + max[0]) / 2 / step) * step, cy = Math.round((min[1] + max[1]) / 2 / step) * step;
        const half = Math.ceil(size * 0.75 / step) * step, grid: number[] = [];
        for (let offset = -half; offset <= half + step / 2; offset += step) { grid.push(cx + offset, cy - half, min[2], cx + offset, cy + half, min[2], cx - half, cy + offset, min[2], cx + half, cy + offset, min[2]); }
        const box: number[] = [];
        for (const [a, b] of [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) {
            for (const corner of [a, b]) { box.push(corner & 1 ? max[0] : min[0], corner & 2 ? max[1] : min[1], corner & 4 ? max[2] : min[2]); }
        }
        // The origin is the model's pivot; a collision file in world coordinates has none nearby, so its axes sit at the floor centre.
        const near = Math.hypot(...[0, 1, 2].map((axis) => Math.max(min[axis], Math.min(0, max[axis])))) < size * 2;
        const origin: ModelVec3 = near ? [0, 0, 0] : [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]], length = size * 0.35;
        this.addLines(grid, [0.5, 0.5, 0.5, 0.35]); this.addLines(box, [0.95, 0.75, 0.2, 1]);
        this.addLines([...origin, origin[0] + length, origin[1], origin[2]], [0.9, 0.3, 0.3, 1]); this.addLines([...origin, origin[0], origin[1] + length, origin[2]], [0.35, 0.8, 0.35, 1]);
        this.addLines([...origin, origin[0], origin[1], origin[2] + length], [0.35, 0.55, 0.95, 1]);
    }
    setTexture(name: string, width: number, height: number, rgba: Uint8Array): void {
        const gl = this.gl, texture = gl.createTexture()!, key = name.toLowerCase(), previous = this.textures.get(key);
        if (previous) { gl.deleteTexture(previous); }
        gl.bindTexture(gl.TEXTURE_2D, texture); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.textures.set(key, texture); this.invalidate();
    }
    resetView(): void {
        const radius = Math.max(Math.hypot(...this.max.map((value, axis) => value - this.min[axis])) / 2, 0.01);
        this.target = [0, 1, 2].map((axis) => (this.min[axis] + this.max[axis]) / 2) as ModelVec3;
        this.distance = radius / Math.sin(Math.PI / 8) * 1.08; this.azimuth = -1.9; this.elevation = 0.38;
        this.invalidate();
    }
    orbit(dx: number, dy: number): void {
        this.azimuth -= dx * 0.008; this.elevation = Math.max(-1.55, Math.min(1.55, this.elevation + dy * 0.008)); this.invalidate();
    }
    pan(dx: number, dy: number): void {
        const eye = this.eye(), forward = normalize([this.target[0] - eye[0], this.target[1] - eye[1], this.target[2] - eye[2]]), right = normalize(cross(forward, [0, 0, 1])), up = cross(right, forward);
        const scale = this.distance * 2 * Math.tan(Math.PI / 8) / Math.max(this.canvas.clientHeight, 1);
        this.target = [0, 1, 2].map((axis) => this.target[axis] - right[axis] * dx * scale + up[axis] * dy * scale) as ModelVec3;
        this.invalidate();
    }
    zoom(factor: number): void { this.distance = Math.max(1e-3, Math.min(1e6, this.distance * factor)); this.invalidate(); }
    private eye(): ModelVec3 {
        const horizontal = Math.cos(this.elevation) * this.distance;
        return [this.target[0] + horizontal * Math.cos(this.azimuth), this.target[1] + horizontal * Math.sin(this.azimuth), this.target[2] + Math.sin(this.elevation) * this.distance];
    }
    invalidate(): void {
        if (!this.pending) { this.pending = requestAnimationFrame(() => { this.pending = 0; this.draw(); }); }
    }
    draw(): void {
        const gl = this.gl, canvas = this.canvas, ratio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(canvas.clientWidth * ratio)), height = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        const background = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [31, 31, 31];
        gl.viewport(0, 0, width, height); gl.clearColor(background[0] / 255, background[1] / 255, background[2] / 255, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const eye = this.eye(), matrix = multiply(perspective(Math.PI / 4, width / height, this.distance / 200, this.distance * 200), lookAt(eye, this.target, [0, 0, 1]));
        const light = normalize([eye[0] - this.target[0] + 0.4 * this.distance, eye[1] - this.target[1] + 0.2 * this.distance, eye[2] - this.target[2] + 0.9 * this.distance]);
        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.uniforms.uViewProjection, false, matrix); gl.uniform3fv(this.uniforms.uEye, eye); gl.uniform3fv(this.uniforms.uLight, light); gl.uniform1i(this.uniforms.uTexture, 0);
        const { shading } = this.options;
        gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
        for (const mesh of this.meshes) {
            const material = this.materials[mesh.material], texture = shading === 'textured' && mesh.textured && material?.diffuse ? this.textures.get(material.diffuse) : undefined;
            const colour = shading === 'materials' || (shading === 'textured' && !mesh.textured) ? materialColour(mesh.material) : [0.72, 0.72, 0.75];
            gl.uniform1i(this.uniforms.uMode, shading === 'normals' ? 2 : texture ? 1 : 0); gl.uniform1i(this.uniforms.uTextured, texture ? 1 : 0); gl.uniform1i(this.uniforms.uFlat, mesh.flat ? 1 : 0);
            gl.uniform1f(this.uniforms.uAlphaTest, material?.cutout ? 0.35 : 0); gl.uniform4f(this.uniforms.uColour, colour[0], colour[1], colour[2], 1);
            if (texture) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture); }
            gl.bindVertexArray(mesh.fill); gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);
        }
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.uniform1i(this.uniforms.uMode, 3);
        if (this.options.wireframe) {
            gl.uniform4f(this.uniforms.uColour, 0.05, 0.05, 0.05, 1);
            for (const mesh of this.meshes) {
                if (!mesh.lines) {
                    const edges = new Uint16Array(mesh.indexCount * 2), elements = gl.createBuffer()!;
                    for (let index = 0; index + 2 < mesh.indexCount; index += 3) {
                        const [a, b, c] = [mesh.indices[index], mesh.indices[index + 1], mesh.indices[index + 2]];
                        edges.set([a, b, b, c, c, a], index * 2);
                    }
                    mesh.lines = this.bind(mesh.vertices, mesh.range, mesh.range.positions, elements); mesh.elements.push(elements);
                    gl.bindVertexArray(mesh.lines); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edges, gl.STATIC_DRAW);
                }
                gl.bindVertexArray(mesh.lines); gl.drawElements(gl.LINES, mesh.indexCount * 2, gl.UNSIGNED_SHORT, 0);
            }
        }
        this.lines.forEach((line, index) => {
            if ((index === 0 && !this.options.grid) || (index === 1 && !this.options.box)) { return; }
            if (line.colour[3] < 1) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); }
            gl.uniform4f(this.uniforms.uColour, ...line.colour); gl.bindVertexArray(line.vao); gl.drawArrays(gl.LINES, 0, line.count); gl.disable(gl.BLEND);
        });
        gl.bindVertexArray(null);
    }
}
