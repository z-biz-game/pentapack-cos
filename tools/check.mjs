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
//   4. no image assets: the pieces are drawn from geometry, so a .png sneaking in means the
//      claim "procedurally rendered" is false.
//   5. the shipped data file is machine-generated, and it enters the app through exactly one
//      door: js/core/library.js.
//   6. nothing in the shipped layer is a ghost: every exported name is called or read by some
//      piece of code other than its own declaration, so "exported and never used" fails the
//      build instead of shipping as a feature.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
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
rec('the page carries a title and a favicon-less icon', /<title>五连块匣/.test(html) && /rel="icon" href="data:,">/.test(html), '');
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

// --- 4. no image assets ---------------------------------------------------
// The asset inventory covers every shipped path including css/, which the first version of this
// rule skipped: a `background: url(x.png)` in the stylesheet would have passed it. The reference
// scan excludes this file, whose own source necessarily contains the patterns it looks for.
const images = allFiles.filter((f) => /\.(png|jpe?g|svg|gif|webp|ico)$/i.test(f));
const refScan = allFiles.filter((f) => f !== 'tools/check.mjs');
const imgRefs = refScan.filter((f) => /<img|url\(.*\.(png|jpg|jpeg|svg|gif|webp)|new Image\(/i.test(read(f)));
rec('there are no image assets and no code asks for one', images.length === 0 && imgRefs.length === 0, images.concat(imgRefs).join(', '));

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
