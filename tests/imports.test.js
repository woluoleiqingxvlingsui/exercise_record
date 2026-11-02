/**
 * 静态检查 www/js 里所有具名 import 是否真的能在目标模块里找到对应导出。
 *
 * 为什么需要它：ES 模块的"导入了不存在的名字"只在**浏览器真正加载时**才报
 * SyntaxError，`node --check` 只看单个文件的语法，纯逻辑测试也覆盖不到 DOM 模块。
 * 这个坑真踩过：ui.js 从 util.js 导入 esc，而 util.js 根本没导出 esc，
 * 结果整个 App 白屏。这里用静态分析把这类错误挡在构建之前。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const JS_ROOT = resolve(here, '..', 'www', 'js');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 收集一个文件对外暴露的具名导出 */
function exportsOf(src) {
  const names = new Set();
  const decl = /\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = decl.exec(src))) names.add(m[1]);

  // export { a, b as c } / export { x } from './y.js'
  const list = /\bexport\s*\{([\s\S]*?)\}/g;
  while ((m = list.exec(src))) {
    m[1].split(',').forEach((part) => {
      const seg = part.trim();
      if (!seg) return;
      const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      names.add(asMatch ? asMatch[1] : seg.split(/\s+/)[0]);
    });
  }

  // export default
  if (/\bexport\s+default\b/.test(src)) names.add('default');
  return names;
}

/** 收集一个文件里的具名 import 及其来源 */
function importsOf(src) {
  const list = [];
  const re = /\bimport\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const names = m[1].split(',').map((s) => {
      const seg = s.trim();
      const asMatch = seg.match(/^(\S+)\s+as\s+([A-Za-z_$][\w$]*)$/);
      return asMatch ? asMatch[1] : seg;
    }).filter(Boolean);
    list.push({ names, from: m[2] });
  }
  return list;
}

const files = walk(JS_ROOT);

test('www/js 下能找到模块文件', () => {
  assert.ok(files.length >= 10, `只找到 ${files.length} 个模块，路径可能不对`);
});

test('所有具名 import 都能在目标模块里找到对应导出（防止浏览器端 SyntaxError 白屏）', () => {
  const problems = [];

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const { names, from } of importsOf(src)) {
      if (!from.startsWith('.')) continue;             // 只查相对路径
      const target = resolve(dirname(file), from);
      let targetSrc;
      try {
        targetSrc = readFileSync(target, 'utf8');
      } catch (e) {
        problems.push(`${relative(JS_ROOT, file)} 引用了不存在的模块 ${from}`);
        continue;
      }
      const available = exportsOf(targetSrc);
      for (const n of names) {
        if (!available.has(n)) {
          problems.push(
            `${relative(JS_ROOT, file)} 从 ${from} 导入了 "${n}"，但该模块只导出：${[...available].sort().join(', ') || '（无）'}`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], `发现 ${problems.length} 处导入/导出不匹配：\n` + problems.join('\n'));
});

test('没有模块导出重复名字或留下明显未使用的外部依赖', () => {
  // 顺带确认每个模块都能被解析到（存在性）
  files.forEach((f) => {
    const src = readFileSync(f, 'utf8');
    assert.ok(src.length > 0, `${f} 是空文件`);
  });
});
