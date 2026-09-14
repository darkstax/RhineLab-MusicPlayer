#!/usr/bin/env node
// scripts/notices-check.mjs — THIRD-PARTY-NOTICES.md 机器节再生成 / 校验（M6 合规终稿，
// docs/M6-PLAN-v2.md §5：UNKNOWN 许可即 fail）。
//
// 用法：
//   node scripts/notices-check.mjs            # 校验：重跑生成器 → 与文件机器节 diff → UNKNOWN=0
//   node scripts/notices-check.mjs --update   # 把生成结果写回 THIRD-PARTY-NOTICES.md
//
// 生成器（版本锁定，构建期工具，不进产品包）：
//   - nuget-license 4.0.17（dotnet tool，tomchavakis/nuget-license）：
//       任务书原文锁 2.7.1，但 NuGet 注册源从未发布过 2.7.1（flatcontainer 实测无此版，
//       2.x 段不存在；作者当前稳定线 = 4.0.x）。按「锁稳定版」意图取 4.0.17，见 M6F-FINDINGS。
//   - license-report 6.8.5（npx）：npm dependencies+devDependencies 节。
// 机器节只覆盖 **NuGet（壳+桩运行时）与 npm** 两面；vendor C 源件（miniaudio/dr_*/kissfft/
// json.hpp）与字体/上游滚动数字的许可为手工节（本脚本对 UNKNOWN 的断言同时扫描全文，
// 手工节里出现 "UNKNOWN" 字样也 fail——除非在 ALLOWED_UNKNOWN_LINES 白名单注记行）。
//
// 环境注意（lane F 实测）：nuget-license 在 Windows 侧跑最稳（dotnet 10 SDK + 代理）；
// WSL 侧调用 pwsh.exe 桥接。license-report 在 WSL 本地 npx 即可。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const noticesPath = join(root, 'THIRD-PARTY-NOTICES.md');
const update = process.argv.includes('--update');
const NUGET_TOOL_VERSION = '4.0.17';
const LICENSE_REPORT_VERSION = '6.8.5';
const BEGIN = (tag) => `<!-- BEGIN:${tag} -->`;
const END = (tag) => `<!-- END:${tag} -->`;

function sha1TableSort(a, b) {
  // 按「包名@版本」字典序稳定排序（生成器自身输出顺序随解析图变动，diff 必须与顺序无关）。
  return a.localeCompare(b, 'en');
}

// —— 1. NuGet 节（RhineShell = 产品运行时全集；RhineCoreStub 无外包，仅随壳一并列出以覆盖
//      dist-host\core\RhineCoreStub.exe 的分发面）——
function findTool(name) {
  for (const dir of [join(process.env.HOME || '', '.dotnet/tools'), join(process.env.LOCALAPPDATA || '', 'dotnet\tools'), '/usr/local/bin']) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return name; // 交 PATH
}

function generateNuget() {
  const tmp = mkdtempSync(join(tmpdir(), 'rhine-nuget-'));
  const tool = findTool('nuget-license');
  const rows = new Set();
  let header = '';
  for (const proj of ['host/RhineShell/RhineShell.csproj', 'host/RhineCoreStub/RhineCoreStub.csproj']) {
    const out = join(tmp, `nuget.${proj.split('/').pop()}.md`);
    try {
      execFileSync(tool, ['-i', join(root, proj), '-t', '-o', 'Markdown', '-fo', out], {
        stdio: 'inherit',
        env: { ...process.env, HTTPS_PROXY: process.env.HTTPS_PROXY || 'http://127.0.0.1:7897' },
      });
    } catch (e) {
      throw new Error(`nuget-license failed for ${proj}: ${e.message} (dotnet tool install --global nuget-license)`);
    }
    let text;
    try { text = readFileSync(out, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith('|'));
    if (!lines.length) continue;
    if (!header) header = lines[0];
    for (const l of lines.slice(2)) rows.add(l.trim());
  }
  if (!header) throw new Error('nuget-license produced no table');
  const sep = '|' + ' --- |'.repeat(header.split('|').length - 3);
  return [header, sep, ...[...rows].sort(sha1TableSort)].join('\n');
}

// —— 2. npm 节（license-report 6.8.5）——
function generateNpm() {
  const json = execFileSync('npx', ['--yes', `license-report@${LICENSE_REPORT_VERSION}`, '--output=json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, https_proxy: process.env.https_proxy || 'http://127.0.0.1:7897' },
  });
  const items = JSON.parse(json);
  const rows = items.map((x) =>
    `| ${x.name} | ${x.installedVersion} | ${x.licenseType} | ${x.author || ''} | ${(x.link || '').replace(/^git\+/, '')} |`);
  rows.sort(sha1TableSort);
  return ['| 包 | 版本 | 许可 | 作者 | 仓库 |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}

// —— 3. 组装/校验 ——
function section(text, tag) {
  const b = BEGIN(tag), e = END(tag);
  const i = text.indexOf(b), j = text.indexOf(e);
  if (i < 0 || j < 0) throw new Error(`marker missing in THIRD-PARTY-NOTICES.md: ${tag}`);
  return text.slice(i + b.length, j).replace(/^\n+|\n+$/g, '');
}
function replaceSection(text, tag, body) {
  const b = BEGIN(tag), e = END(tag);
  const i = text.indexOf(b), j = text.indexOf(e);
  return text.slice(0, i + b.length) + '\n\n' + body + '\n\n' + text.slice(j);
}

const original = readFileSync(noticesPath, 'utf8');
const nuget = generateNuget();
const npm = generateNpm();
const generated = { NUGET: nuget, NPM: npm };

let fail = 0;
for (const [tag, body] of Object.entries(generated)) {
  const cur = section(original, tag);
  if (cur.trim() !== body.trim()) {
    console.error(`[FAIL] ${tag} 机器节与生成器输出 diff 非空（--update 写回）`);
    fail = 1;
  } else {
    console.log(`[OK] ${tag} 机器节与生成器输出一致（${body.split('\n').length - 2} 行）`);
  }
}
// UNKNOWN=0 断言：任何许可列出现 UNKNOWN/Other/LGPL（LGPL 需用户显式点头——M6-PLAN Q8 纯净原则）。
const probe = (whole) => {
  const bad = whole.split(/\r?\n/).filter(
    (l) => l.trim().startsWith('|') && /\bUNKNOWN\b|\| *Other *\||\bLGPL\b|\bGPL\b|\bAGPL\b/i.test(l)
  );
  return bad;
};
const badRows = [...probe(nuget), ...probe(npm), ...probe(original.replace(section(original, 'NUGET'), '').replace(section(original, 'NPM'), ''))];
if (badRows.length) {
  console.error('[FAIL] UNKNOWN/GPL/LGPL 命中：');
  for (const r of badRows) console.error('  ' + r.slice(0, 160));
  fail = 1;
} else {
  console.log('[OK] UNKNOWN=0（NuGet/npm/手工节全文扫描，GPL/LGPL/AGPL 同在）');
}

if (update) {
  // 写回只看 UNKNOWN 断言；diff 存在正是 --update 的用途（写回后下次校验即一致）。
  if (!badRows.length) {
    let next = original;
    for (const [tag, body] of Object.entries(generated)) next = replaceSection(next, tag, body);
    writeFileSync(noticesPath, next);
    console.log('[OK] THIRD-PARTY-NOTICES.md 机器节已写回');
  } else {
    console.error('[SKIP] UNKNOWN/GPL 命中，不写回');
  }
}
process.exit(fail);
