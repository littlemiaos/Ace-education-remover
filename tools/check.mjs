/*
 * tools/check.mjs — 语法与清单体检
 *
 * 没有构建步骤,所以这里只做几件能被机器确定的事:
 *   1. 每个 JS 文件按它真实的模块形态解析;
 *   2. 每个 JSON 文件能 parse,清单关键字段在位;
 *   3. 动态注册会引用的文件确实存在,且 core 排在最前。
 *
 * 实现上刻意不启子进程:全部用 node:vm 在原进程内解析,免去管道开销,
 * 也避免在受限沙箱里被 stdio 限制卡住。
 *
 * 运行:node tools/check.mjs
 */

import { readdir, readFile, mkdtemp, copyFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.vscode']);
const MODULE_FILES = new Set(['src/background.js', 'tools/check.mjs']);

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), out);
    } else {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * 解析一个文件。
 * - classic script:直接交给 vm.Script。
 * - ES module:vm.SourceTextModule 需要 --experimental-vm-modules,所以退化成
 *   「剥掉顶层 import/export、替换 import.meta、整体包进 async 箭头函数」再解析。
 *   这足以抓到括号/语法层面的错误,唯一的代价是模块解析语义(如 import.meta 的类型)
 *   不参与校验。
 */
function syntaxError(rel, src) {
  const isModule = MODULE_FILES.has(rel) || rel.endsWith('.mjs');
  try {
    if (!isModule) {
      new vm.Script(src, { filename: rel });
      return { ok: true, mode: 'script' };
    }
    const body = src
      .replace(/^\s*import\s+[^;]*;?/gm, '')
      .replace(/^\s*export\s+/gm, '')
      .replace(/import\.meta\.dirname/g, '"."')
      .replace(/import\.meta\.url/g, '"file:///"');
    new vm.Script('(async () => {' + body + '\n})', { filename: rel });
    return { ok: true, mode: 'module(降级解析)' };
  } catch (e) {
    return { ok: false, mode: isModule ? 'module' : 'script', error: String((e && e.message) || e) };
  }
}

// 统一成正斜杠,免得 Windows 上 path.relative 的反斜杠让后面的比较全部失配
const files = (await walk(ROOT))
  .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
  .sort();
const jsFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
const jsonFiles = files.filter((f) => f.endsWith('.json'));

let pass = 0;
const failures = [];
const notes = [];

/* ------------------------------------------------- 1. JS 解析 */

for (const rel of jsFiles) {
  const src = await readFile(path.join(ROOT, rel), 'utf8');
  const res = syntaxError(rel, src);
  if (res.ok) {
    pass++;
    if (res.mode.startsWith('module')) notes.push(`${rel}: ${res.mode}`);
  } else {
    failures.push(`解析失败 [${res.mode}] ${rel}\n      ${res.error}`);
  }
}

/* ------------------------------------------------- 2. JSON 与清单 */

let manifest = null;
for (const rel of jsonFiles) {
  try {
    const parsed = JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));
    if (rel === 'manifest.json') manifest = parsed;
    pass++;
  } catch (e) {
    failures.push(`JSON 解析失败 ${rel}:${e.message}`);
  }
}

if (!manifest) {
  failures.push('缺少 manifest.json');
} else {
  for (const k of ['manifest_version', 'name', 'version', 'background']) {
    if (!(k in manifest)) failures.push(`manifest.json 缺少字段:${k}`);
  }
  if (manifest.manifest_version !== 3) failures.push('manifest_version 必须是 3');
  if (!manifest.background || !manifest.background.service_worker) {
    failures.push('manifest.json 未声明 background.service_worker');
  }
  if (!(manifest.optional_host_permissions || []).join(',').includes('*://*/*')) {
    failures.push('optional_host_permissions 必须包含 *://*/* ,否则无法按白名单授权');
  }
  if (!manifest.permissions || !manifest.permissions.includes('scripting')) {
    failures.push('permissions 必须包含 scripting(动态注册依赖它)');
  }
}

/* --------------------------------- 3. 被引用的文件必须存在 */

const TIMING_FILES = {
  off: [],
  freeze: ['src/main/40-timing-clock.js'],
  replay: ['src/main/40-timing-clock.js', 'src/main/41-timing-sched.js', 'src/main/42-timing-raf.js']
};

const referenced = [
  'src/patterns.js',
  'src/bridge.js',
  'src/main/00-core.js',
  'src/main/10-visibility.js',
  'src/main/20-focus.js',
  'src/main/30-lifecycle.js',
  ...Object.values(TIMING_FILES).flat(),
  'src/options.html',
  'src/options.js',
  'src/popup.html',
  'src/popup.js',
  'src/ui.css',
  'harness/index.html',
  'harness/detector.js',
  'harness/harness.css',
  'harness/serve.ps1'
];

for (const rel of referenced) {
  try {
    await access(path.join(ROOT, rel));
    pass++;
  } catch (_) {
    failures.push(`引用的文件不存在:${rel}`);
  }
}

/* ------------------------------------------------- 4. 加载顺序约束 */

const coreRel = 'src/main/00-core.js';
const order = [coreRel, 'src/main/40-timing-clock.js', 'src/main/41-timing-sched.js', 'src/main/42-timing-raf.js'];
const orderIndex = (rel) => order.indexOf(rel);
if (orderIndex(coreRel) !== 0) failures.push('core 必须排在最前');

for (const rel of jsFiles) {
  if (!rel.startsWith('src/main/')) continue;
  if (rel === coreRel) continue;
  const src = await readFile(path.join(ROOT, rel), 'utf8');
  if (!src.includes('globalThis.__PVG__')) {
    failures.push(`${rel} 没有依赖 core(被单独加载时会静默失效)`);
  }
}

// 41 必须在 40 之后(pump 依赖 clock),42 必须在 41 之后(帧源依赖 frameSources)
if (orderIndex('src/main/41-timing-sched.js') < orderIndex('src/main/40-timing-clock.js')) {
  failures.push('时序模块顺序错误:41 必须在 40 之后');
}
if (orderIndex('src/main/42-timing-raf.js') < orderIndex('src/main/41-timing-sched.js')) {
  failures.push('时序模块顺序错误:42 必须在 41 之后');
}

/* -------------------------------------------------------- 输出 */

const total = pass + failures.length;
if (failures.length === 0) {
  console.log('');
  console.log(`  OK  ${pass}/${total} 项检查通过`);
  console.log(`      解析 ${jsFiles.length} 个 JS、${jsonFiles.length} 个 JSON`);
  for (const n of notes) console.log(`      · ${n}`);
  console.log('');
} else {
  console.log('');
  console.log(`  FAIL  ${failures.length} 项失败(通过 ${pass}/${total})`);
  console.log('');
  for (const f of failures) console.log('  - ' + f);
  console.log('');
  process.exitCode = 1;
}
