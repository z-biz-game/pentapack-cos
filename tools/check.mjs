// The static gate: what is true about this repository as files, independent of whether any
// test passes. `npm test` runs this first, because a broken layer boundary or a stray
// dependency is not something a behaviour test should have to discover.
//
//   node tools/check.mjs
//
// Six claims, each printed with the evidence that made it:
//   1. zero dependencies, verified two ways: the manifest tables are empty *and* no module in
//      the shipped app layer imports a bare specifier at all, while tools/ may only use `node:`
//      builtins (a bare `import 'left-pad'` would be a dependency the manifest forgot to declare).
//   2. index.html's references close — a typo'd stylesheet is a white screen in CI and a green
//      suite.
//   3. js/core/* is the pure layer: no DOM token anywhere in it, and every module in it loads
//      under plain node (which is the same thing the game's own tests depend on).
//   4. the asset layer closes both ways: every image lives under assets/, is a readable PNG whose
//      bytes and IHDR match assets/gen/manifest.json (so the art on disk is the art the generator
//      writes) *and* has its pixels counted on their own, so a generator that stopped drawing is
//      caught without touching the manifest; every path the code names exists, and nothing exists
//      that no code names.
//   5. the shipped data file is machine-generated, and it enters the app through exactly one
//      door: js/core/library.js.
//   6. nothing in the shipped layer is a ghost: every exported name is called or read by some
//      piece of code other than its own declaration, so "exported and never used" fails the
//      build instead of shipping as a feature.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rows = [];
const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : String(detail) });

const read = (p) => readFileSync(join(root, p), 'utf8');
const walk = (dir) => {
  const out = [];
  for (const e of readdirSync(join(root, dir))) {
    const p = join(dir, e);
    if (statSync(join(root, p)).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
};

// The audited inventory is every file that ships or tests: `electron/` is in it because the
// desktop shell is a real entry point (README documents it as optional), and a file CI never
// reads is a file that can rot.
const allFiles = walk('js').concat(walk('css'), walk('tools'), walk('test'), walk('electron'), ['server.cjs', 'index.html']);

// Comments have to come out before any "does this file use X" scan, and this is not cosmetic:
// js/core/board.js and js/core/logic.js both *state the rule* in their header ("no DOM, no
// clock, no Math.random"), and a grep that reads that line reports the purest files in the repo
// as violations. Prose is scanned by the purity rules never; only code is.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');

// --- 1. zero dependencies --------------------------------------------------
// "Zero dependencies" means zero *third-party* modules, and the two halves of that are checked
// separately because they fail differently. Node builtins under the `node:` scheme are not
// dependencies — tools/ runs in node and needs `node:fs` — but they are fatal in js/, which has
// to load in a browser. So: no bare specifier at all in the shipped app layer, and the tools
// layer may only reach for `node:` builtins.
const pkg = JSON.parse(read('package.json'));
rec('package.json declares no dependencies', Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify(pkg.dependencies));
rec('package.json declares no devDependencies', Object.keys(pkg.devDependencies || {}).length === 0, JSON.stringify(pkg.devDependencies));

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const NODE_BUILTIN_OK = /^node:/;
const appBare = [];
const toolBare = [];
const missing = [];
const jsFiles = allFiles.filter((f) => /\.(m?js|cjs)$/.test(f));
// Edges of the real module graph, used by rules 5 and 6 below.
const graph = new Map();
for (const f of jsFiles) {
  const src = read(f);
  const isApp = f.startsWith(`js${sep}`);
  const edges = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      if (isApp) appBare.push(`${f}: ${spec}`);
      else if (!NODE_BUILTIN_OK.test(spec)) toolBare.push(`${f}: ${spec}`);
      continue;
    }
    const target = relative(root, resolve(join(root, dirname(f)), spec)).split(sep).join('/');
    if (!existsSync(join(root, target))) missing.push(`${f}: ${spec}`);
    else edges.push(target);
  }
  for (const m of src.matchAll(DYNAMIC_RE)) {
    const spec = m[1];
    if (isApp) appBare.push(`${f}: dynamic ${spec}`);
    else if (!NODE_BUILTIN_OK.test(spec)) toolBare.push(`${f}: dynamic ${spec}`);
  }
  graph.set(f, edges);
}
rec('js/ imports nothing but files in this repo (so the browser layer has no undeclared dependency)',
  appBare.length === 0, appBare.join(', '));
rec('tools/ only reaches for node: builtins, never for a package', toolBare.length === 0, toolBare.join(', '));
rec('every relative import resolves to a file that exists', missing.length === 0, missing.join(', '));

// --- 2. index.html closes -------------------------------------------------
const html = read('index.html');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('data:') && !u.startsWith('http'));
const broken = refs.filter((r) => !existsSync(join(root, r)));
rec('index.html references only files that exist', broken.length === 0, broken.join(', ') || refs.join(', '));
// The head used to satisfy "has an icon" with `href="data:,"`, which is a real answer to a
// question nobody should be asking: an empty icon means the tab shows a grey hole. Now the links
// point at generated PNGs, and the checks below are only as strong as rules 4's byte inspection.
rec('the head declares a title, real PNG icons, an apple-touch-icon, a manifest and an og card',
  /<title>五连块匣/.test(html)
  && /rel="icon"[^>]*href="assets\/icons\/icon-32\.png"/.test(html)
  && /rel="apple-touch-icon" href="assets\/icons\/apple-touch-icon\.png"/.test(html)
  && /rel="manifest" href="manifest\.webmanifest"/.test(html)
  && /property="og:image" content="assets\/og-cover\.png"/.test(html),
  String(html.match(/<link[^>]+>/g)));
// Three layers can disagree about one colour: the meta the browser paints chrome with, the
// manifest the installer paints its splash with, and the stylesheet that paints the page. This
// reads the value out of the CSS variable rather than comparing it to a literal typed here.
const bgVar = (read('css/game.css').match(/--bg:\s*(#[0-9a-fA-F]{6})/) || [])[1];
const metaTheme = (html.match(/name="theme-color" content="(#[0-9a-fA-F]{6})"/) || [])[1];
rec('theme-color is the colour the page is actually painted with',
  !!bgVar && !!metaTheme && metaTheme.toLowerCase() === bgVar.toLowerCase(), `meta=${metaTheme} css --bg=${bgVar}`);
rec('the page is a module page (no bundler, no build step)', /<script type="module" src="js\/main.js">/.test(html), '');

// --- 3. the pure layer ----------------------------------------------------
// `window` is allowed in exactly one core file, because the save layer has to *find out* that
// it does not exist and keep working; `document` and friends are never allowed there. Both
// scans run on comment-stripped source, so a header that recites the rule cannot violate it,
// and so a *local variable* called `window` still gets caught (js/core/make.js used to shadow
// the global with `const window = opts.depth || band.depth`).
const DOM_RE = /\b(document|requestAnimationFrame|getElementById|querySelector|canvas|innerHTML|addEventListener)\b/;
const coreFiles = walk('js/core');
const codeOf = (f) => stripComments(read(f));
const dirty = coreFiles.filter((f) => DOM_RE.test(codeOf(f)));
rec('js/core/* contains no DOM token at all', dirty.length === 0, dirty.join(', '));
const windowUsers = coreFiles.filter((f) => /\bwindow\b/.test(codeOf(f)));
rec('only the storage layer mentions window, and only behind try/catch',
  windowUsers.length === 1 && windowUsers[0].endsWith('storage.js') && /try \{/.test(codeOf(windowUsers[0])),
  windowUsers.join(', '));
const randoms = coreFiles.filter((f) => /Math\.random|Date\.now|new Date|performance\.now/.test(codeOf(f)));
rec('js/core/* has no clock and no Math.random (determinism is testable because of it)', randoms.length === 0, randoms.join(', '));

let loaded = 0;
const loadFails = [];
for (const f of coreFiles) {
  try {
    await import(pathToFileURL(join(root, f)).href);
    loaded++;
  } catch (err) {
    loadFails.push(`${f}: ${err.message}`);
  }
}
rec('every js/core module loads under bare node', loadFails.length === 0 && loaded === coreFiles.length, loadFails.join(' | ') || `${loaded}/${coreFiles.length}`);

// --- 4. the asset layer ---------------------------------------------------
// This rule used to read "there are no image assets and no code asks for one", argued from the
// fact that the pieces are drawn from geometry. That half still holds — js/view.js paints every
// pentomino from js/core/pieces.js and loads no sprite for a piece — but the page now carries a
// real visual identity (nine icons, an og card, a felt texture, two particle sprites), so a gate
// that only forbids files would simply be false. It was rewritten to check the opposite: that
// each shipped image is a *readable* PNG, that its bytes are the ones its own generator wrote,
// and that nothing is referenced without existing or existing without being referenced.
//
// The PNG signature check is what makes "no SVG in disguise" need no separate regex: the 8 bytes
// 89 50 4E 47 0D 0A 1A 0A cannot begin an SVG, so a text file renamed .png fails right here.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_RE = /\.(png|jpe?g|gif|webp|ico|svg)$/i;
const assetFiles = walk('assets').filter((f) => IMAGE_RE.test(f));
const rootFiles = readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
const stray = allFiles.filter((f) => IMAGE_RE.test(f)).concat(rootFiles.filter((f) => IMAGE_RE.test(f)));
rec('every image asset lives under assets/', stray.length === 0, stray.join(', '));

const dims = new Map();
const unreadable = [];
for (const f of assetFiles) {
  const buf = readFileSync(join(root, f));
  if (!buf.subarray(0, 8).equals(PNG_SIG)) {
    unreadable.push(`${f}: signature ${buf.subarray(0, 8).toString('hex')}`);
    continue;
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (!w || !h) unreadable.push(`${f}: IHDR ${w}x${h}`);
  // A filename that promises a size is a promise this rule can hold: icon-192.png must *be* 192.
  const named = f.match(/(\d+)\.png$/);
  if (named && Number(named[1]) !== w) unreadable.push(`${f}: IHDR ${w}x${h} contradicts the name`);
  if (buf.length < 400) unreadable.push(`${f}: ${buf.length} bytes is a placeholder, not art`);
  dims.set(f, { w, h, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length });
}
rec('every shipped image is a readable PNG whose IHDR matches its own filename',
  unreadable.length === 0 && assetFiles.length > 0, unreadable.join(' | ') || `${assetFiles.length} files`);

// Byte hashes prove the bytes are what the generator wrote; they do not prove the generator drew
// anything. Repoint it at a flat fill, re-run it, and every rule above stays green while the game
// ships a blank texture. So the pixels get counted on their own, with no reference to
// assets/gen/manifest.json: inflate + undo the row filters + tally distinct samples.
const { inflateSync } = await import('node:zlib');
function pixelPalette(file) {
  const buf = readFileSync(join(root, file));
  let pos = 8;
  let w = 0; let h = 0; let ctype = 6; const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); ctype = body[9]; }
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype] || 4;
  const stride = w * ch;
  const raw = inflateSync(Buffer.concat(idat));
  const prev = Buffer.alloc(stride);
  const colours = new Set();
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    const bpp = ch; // 8-bit channels, so one pixel is one filter unit
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 255;
      else if (filter === 2) line[i] = (line[i] + b) & 255;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
        line[i] = (line[i] + pr) & 255;
      }
    }
    // Sample, don't tally: 1200x630 has 756k pixels and a flat image shows up in the first row.
    for (let x = 0; x < w; x += 3) {
      let key = 0;
      for (let c = 0; c < Math.min(ch, 3); c++) key = key * 256 + line[x * ch + c];
      colours.add(key);
    }
    line.copy(prev);
  }
  return colours.size;
}
const thin = [];
const palettes = [];
for (const f of assetFiles) {
  let n = 0;
  try { n = pixelPalette(f); } catch (err) { thin.push(`${f}: pixels undecodable (${err.message})`); continue; }
  palettes.push(`${f.split('/').pop()}=${n}`);
  // 8 is not an aesthetic floor, it is a gap that no real asset sits near: the sparsest one here
  // is the felt weave at 23 sampled colours (the 16px favicon measures 53), while a flat fill
  // measures exactly 1.
  if (n < 8) thin.push(`${f}: only ${n} distinct colours — a placeholder, not art`);
}
rec('every shipped image has real pixel content (>=8 distinct colours, measured)',
  thin.length === 0, thin.join(' | ') || palettes.join(' '));

// The generator writes this manifest next to the art, so a hand-edited or truncated PNG drifting
// away from `python3 assets/gen/gen_art.py` is a red build rather than a silent one.
const artManifest = JSON.parse(read('assets/gen/manifest.json'));
const drift = [];
for (const f of assetFiles) {
  const key = f.slice('assets/'.length).split(sep).join('/');
  const exp = (artManifest.files || {})[key];
  if (!exp) { drift.push(`${key}: not in assets/gen/manifest.json`); continue; }
  const got = dims.get(f);
  if (!got) continue;
  if (got.sha256 !== exp.sha256) drift.push(`${key}: sha256 ${got.sha256.slice(0, 12)} != ${String(exp.sha256).slice(0, 12)}`);
  else if (got.w !== exp.w || got.h !== exp.h) drift.push(`${key}: ${got.w}x${got.h} != manifest ${exp.w}x${exp.h}`);
}
const unlisted = [...(artManifest.files ? Object.keys(artManifest.files) : [])].filter((k) => !assetFiles.some((f) => f.slice('assets/'.length).split(sep).join('/') === k));
rec('the committed bytes are the generator output, per assets/gen/manifest.json',
  drift.length === 0 && unlisted.length === 0, drift.concat(unlisted.map((u) => `${u}: listed but absent`)).join(' | '));

// What asks for what: index.html, the stylesheet, the service worker's precache list, the PWA
// manifest and the two layers that build Image objects all name asset paths as string literals.
const refHunt = ['index.html', 'css/game.css', 'sw.js', 'manifest.webmanifest', ...allFiles.filter((f) => f.startsWith(`js${sep}`))];
const asked = new Map();
for (const f of refHunt) {
  for (const m of read(f).matchAll(/['"(]((?:\.\.\/)*assets\/[A-Za-z0-9._/-]+\.[a-z]{2,4})['")]/g)) {
    const key = m[1].split('/').filter((s) => s && s !== '..').join('/');
    if (!asked.has(key)) asked.set(key, f);
  }
}
const absent = [...asked.keys()].filter((k) => !existsSync(join(root, k)));
rec('every asset path the code names exists on disk', absent.length === 0, absent.map((k) => `${k} (${asked.get(k)})`).join(', '));
const orphan = assetFiles
  .map((f) => f.slice('assets/'.length).split(sep).join('/'))
  .filter((k) => !k.startsWith('gen/') && !asked.has(`assets/${k}`));
rec('no asset ships that nothing asks for', orphan.length === 0, orphan.join(', '));

// The install manifest is the one a browser parses, so it gets checked field by field against the
// files rather than against the prose that describes them.
const pwa = JSON.parse(read('manifest.webmanifest'));
const pwaBad = [];
if (!/standalone/.test(pwa.display || '')) pwaBad.push(`display=${pwa.display}`);
if (String(pwa.theme_color).toLowerCase() !== String(bgVar).toLowerCase()) pwaBad.push(`manifest theme_color=${pwa.theme_color} css --bg=${bgVar}`);
for (const k of ['name', 'short_name', 'description', 'start_url', 'theme_color', 'background_color']) {
  if (!pwa[k]) pwaBad.push(`${k} missing`);
}
for (const ic of pwa.icons || []) {
  const rel = String(ic.src).replace(/^\.\//, '');
  const info = dims.get(rel);
  if (!info) pwaBad.push(`${ic.src}: absent or unreadable`);
  else if (ic.sizes !== `${info.w}x${info.h}`) pwaBad.push(`${ic.src}: sizes=${ic.sizes}, IHDR=${info.w}x${info.h}`);
  else if (ic.type !== 'image/png') pwaBad.push(`${ic.src}: type=${ic.type}`);
}
rec('manifest.webmanifest declares a real installable app, with icons that match their bytes',
  pwaBad.length === 0 && (pwa.icons || []).length >= 2 && (pwa.icons || []).some((i) => i.purpose === 'maskable'),
  pwaBad.join(' | ') || `${(pwa.icons || []).length} icons`);

// --- 5. the generated data file ------------------------------------------
const data = read('js/data/lots.js');
rec('js/data/lots.js declares itself generated', /GENERATED by tools\/bake\.mjs/.test(data.slice(0, 200)), data.split('\n')[0]);
// The claim is about the *module graph*, so the graph is what gets read. The first version
// grepped every file's text for the string "data/lots.js" and reported 5 references — three of
// them were comments reciting this same rule, one was this checker's own regex literal. That
// number could never have been driven to 1 by fixing wiring, only by deleting the prose.
const dataImporters = [...graph.entries()]
  .filter(([from, edges]) => edges.some((e) => e.startsWith('js/data/')))
  .map(([from]) => from)
  .sort();
rec('js/data/* is imported by js/core/library.js and by nothing else',
  dataImporters.length === 1 && dataImporters[0] === 'js/core/library.js', dataImporters.join(', '));

// --- 6. no ghost exports --------------------------------------------------
// CONTRACT.md 5: "不做只有文件没有接线的幽灵功能。导出的函数若无人调用，删掉。"
//
// The claim is about *calls*, so the scan is: take every file's code with comments stripped and
// with each export statement's own header cut out, then ask whether the name survives anywhere.
// Both halves matter. Comments stay in the "not a call" pile because this repository documents
// its own wiring — a sentence saying "game.js:playerPlacements feeds grade()" is not a call, and
// the first version of this rule let every dead export off on exactly that excuse. And a use
// *inside the declaring file* counts, because a private helper that the module itself calls is
// not a ghost feature; `export` on it means "the tests may pin it too". What cannot survive is a
// name that appears once in the whole tree: on its own declaration line.
//
// What this catches in practice is the failure mode this repo actually had: duplicate aliases of a
// fact already exported elsewhere (CELLS_PER_PIECE vs CELLS, PIECE_NAMES vs NAMES, MAKE_CELLS
// again) and accessors no path through the app ever reaches. Aliases are worse than dead code,
// because two names for one fact can disagree.
const DECL_RE = /^export\s+(?:const|let|var|async function|function|class)\s+([A-Za-z0-9_$]+)/gm;
const GROUP_RE = /^export\s*\{([^}]*)\}(?:\s*from\s*['"][^'"]*['"])?/gm;
const IMPORT_STMT_RE = /(?:^|\n)[ \t]*import[\s\S]*?(?:from[ \t]*)?['"][^'"]+['"][ \t]*;?/g;
const declared = [];
const hollow = new Map(); // file -> code, with comments, import lists and export headers removed
for (const f of jsFiles) {
  let src = codeOf(f).replace(IMPORT_STMT_RE, (m) => '\n' + ' '.repeat(m.length - 1));
  src = src.replace(GROUP_RE, (m) => ' '.repeat(m.length));
  for (const m of src.matchAll(DECL_RE)) declared.push([m[1], f]);
  src = src.replace(DECL_RE, (m) => ' '.repeat(m.length));
  hollow.set(f, src);
}
const ghosts = [];
for (const [name, file] of declared) {
  const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
  let where = null;
  for (const f of jsFiles) {
    if (re.test(hollow.get(f))) { where = f; break; }
  }
  if (!where) ghosts.push(`${file} ${name}`);
}
rec('nothing in the tree is exported and never used', ghosts.length === 0, ghosts.join(', '));

// --- report (the shape tools/verify.sh aggregates on) ---------------------
let failed = 0;
for (const r of rows) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? '  ok  ' : '  FAIL'} ${r.test}${r.pass ? '' : '\n         ' + (r.detail || '')}`);
}
console.log(`rows: ${rows.length} fail: ${failed}`);
process.exit(failed ? 1 : 0);
