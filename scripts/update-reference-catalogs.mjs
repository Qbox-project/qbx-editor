// Regenerates data/reference-catalogs.json, the offline catalogs of blips, markers and model names
// in the FiveM reference tab, from the game references of citizenfx/fivem-docs.
// usage: node scripts/update-reference-catalogs.mjs [--latest | --revision <commit>]
// Without an argument the pages are read at the revision the data file records, which reproduces it.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'data', 'reference-catalogs.json');
const REPOSITORY = 'citizenfx/fivem-docs';
const FOLDER = 'content/docs/game-references';
const PAGES = {
    blip: { file: 'blips.md', url: 'https://docs.fivem.net/docs/game-references/blips/' },
    marker: { file: 'markers.md', url: 'https://docs.fivem.net/docs/game-references/markers/' },
    ped: { file: 'ped-models.md', url: 'https://docs.fivem.net/docs/game-references/ped-models/' },
    weapon: { file: 'weapon-models.md', url: 'https://docs.fivem.net/docs/game-references/weapon-models/' },
    vehicle: { file: 'vehicle-references/vehicle-models.md', url: 'https://docs.fivem.net/docs/game-references/vehicle-references/vehicle-models/' },
};

async function text(url) {
    const response = await fetch(url, { headers: { 'User-Agent': 'reference-catalog-generator' } });
    if (!response.ok) { throw new Error(`${url}: HTTP ${response.status}`); }
    return response.text();
}

async function revision() {
    const argument = process.argv.indexOf('--revision');
    if (argument >= 0) { return process.argv[argument + 1]; }
    if (process.argv.includes('--latest')) { return JSON.parse(await text(`https://api.github.com/repos/${REPOSITORY}/commits/master`)).sha; }
    return JSON.parse(await readFile(output, 'utf8')).source.revision;
}

function clean(value) {
    return value.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

function unique(rows, what, least) {
    const seen = new Set();
    for (const row of rows) {
        const key = String(row[0]).toLowerCase();
        if (seen.has(key)) { throw new Error(`${what}: ${row[0]} is listed twice`); }
        seen.add(key);
        if (row.some((cell) => typeof cell === 'string' && /[<>\u0000-\u001f]/.test(cell))) { throw new Error(`${what}: unexpected markup in ${JSON.stringify(row)}`); }
    }
    if (rows.length < least) { throw new Error(`${what}: only ${rows.length} entries, expected at least ${least}`); }
    return rows;
}

/** Rows under the heading before them: `heading` finds a heading, `fields` the values of an entry in order. */
function grouped(source, heading, fields) {
    const rows = [];
    let group = '', current = [];
    for (const line of source.split('\n')) {
        const title = heading.exec(line);
        if (title) { group = clean(title[1]); continue; }
        const next = fields[current.length].exec(line);
        if (!next) { continue; }
        current.push(clean(next[1]));
        if (current.length === fields.length) {
            rows.push([...current, group]);
            current = [];
        }
    }
    return rows;
}

const commit = await revision();
if (!/^[0-9a-f]{40}$/.test(commit ?? '')) { throw new Error('Pass --latest or --revision <40 hexadecimal digits> for the first run.'); }
const pages = Object.fromEntries(await Promise.all(Object.entries(PAGES).map(async ([kind, page]) =>
    [kind, await text(`https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${FOLDER}/${page.file}`)])));
const committedAt = JSON.parse(await text(`https://api.github.com/repos/${REPOSITORY}/commits/${commit}`)).commit.committer.date;

const blips = [...pages.blip.matchAll(/<div class="blip"><div><div><img [^>]*><\/div><\/div><span><strong>(\d+)<\/strong><br>([^<]+)<\/span><\/div>/g)]
    .map((match) => [Number(match[1]), clean(match[2])]);
const blipColors = [...pages.blip.matchAll(/<div class="blip bcolor"><div class="blip_color" style="background-color: (#[0-9a-fA-F]{3,8})" ?><\/div><span><strong>(\d+)<\/strong><br>([^<]*)<\/span><\/div>/g)]
    .map((match) => [Number(match[2]), clean(match[3]), match[1].toLowerCase()]);
const markers = [...pages.marker.matchAll(/<div class="marker"><span><img [^>]*><br><strong>(\d+)<\/strong><br>([^<]+)<\/span><\/div>/g)]
    .map((match) => [Number(match[1]), clean(match[2])]);
const peds = grouped(pages.ped, /^##\s+(.+)$/, [/<div class="model"><span><img [^>]*><br><strong>([^<]+)<\/strong>/]);
const weapons = grouped(pages.weapon, /<h2>(.+?)<\/h2>/, [
    /<span><strong>Name:<\/strong>\s*(.*?)<\/span>/, /<span class='hash-key'><strong>Hash:<\/strong>\s*(.*?)<\/span>/,
    /<span><strong>Model Hash Key:<\/strong>\s*(.*?)<\/span>/, /<span><strong>DLC:<\/strong>\s*(.*?)<\/span>/,
]).map(([label, name, model, dlc, group]) => [name, label, group, model, dlc]);
const vehicles = grouped(pages.vehicle, /^##\s+(.+)$/, [
    /<span><strong>Display Name:<\/strong>\s*(.*?)<\/span>/, /<span><strong>Hash:<\/strong>\s*(.*?)<\/span>/, /<span><strong>Model Name:<\/strong>\s*(.*?)<\/span>/,
]).map(([label, , name, group]) => [name, label, group]);

const data = {
    format: 1,
    source: { repository: REPOSITORY, revision: commit, committedAt, pages: Object.fromEntries(Object.entries(PAGES).map(([kind, page]) => [kind, page.url])) },
    blip: unique(blips, 'blips', 900),
    blipColor: unique(blipColors, 'blip colours', 80),
    marker: unique(markers, 'markers', 40),
    ped: unique(peds, 'ped models', 700),
    weapon: unique(weapons, 'weapons', 100),
    vehicle: unique(vehicles, 'vehicle models', 700),
};
const rows = (list) => `[\n${list.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]`;
const body = ['blip', 'blipColor', 'marker', 'ped', 'weapon', 'vehicle'].map((kind) => `  ${JSON.stringify(kind)}: ${rows(data[kind])}`).join(',\n');
await writeFile(output, `{\n  "format": 1,\n  "source": ${JSON.stringify(data.source, null, 2).replace(/\n/g, '\n  ')},\n${body}\n}\n`);
console.log(`${output}: ${['blip', 'blipColor', 'marker', 'ped', 'weapon', 'vehicle'].map((kind) => `${data[kind].length} ${kind}`).join(', ')} at ${commit.slice(0, 12)}`);
