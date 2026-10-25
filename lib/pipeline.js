#!/usr/bin/env node
/**
 * dsh-note-forge 引擎：不依赖 cordis，纯函数 + 子进程调用 PyMuPDF。
 * 单独可跑，便于测试：node lib/pipeline.js selftest
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export const PY_CANDIDATES = [
  process.env.NOTEFORGE_PYTHON,
  path.join(process.env.HOME ?? '~', '.dsh', 'ungrouped', '.venv-pdf', 'bin', 'python'),
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  'python3',
].filter(Boolean);

export function pickPython() {
  for (const p of PY_CANDIDATES) {
    if (p.includes('/') && !fs.existsSync(p)) continue;
    const r = spawnSync(p, ['-c', 'import pymupdf'], { encoding: 'utf8' });
    if (r.status === 0) return p;
  }
  throw new Error('找不到带 PyMuPDF 的 python；设 NOTEFORGE_PYTHON 指向解释器，或 pip install pymupdf');
}

const run = (args) => {
  const r = spawnSync(pickPython(), [path.join(ROOT, 'forge.py'), ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`forge.py 失败（${r.status}）：${(r.stderr || '').slice(-800)}`);
  return r.stdout;
};

/** 从 PDF 文件名猜教材名：《生理学》（第10版） 3 → 生理学（第10版） */
export function bookName(file) {
  return path.basename(file, path.extname(file))
    .replace(/[《》]/g, '')
    .replace(/\s+\d+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** PDF → 每页文本 */
export function dumpPages(pdf, pages) {
  const args = ['dump', '--pdf', pdf];
  if (pages) args.push('--pages', pages);
  return JSON.parse(run(args));
}

/** PDF → 按题注切图，落进 outDir */
export function extractFigures({ pdf, chapter, outDir, pages, dpi = 300 }) {
  const args = ['figures', '--pdf', pdf, '--chapter', String(chapter), '--out', outDir, '--dpi', String(dpi)];
  if (pages) args.push('--pages', pages);
  const lines = run(args).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const summary = lines.find(l => l.summary)?.summary ?? { count: 0, holes: [], out: outDir };
  return { figures: lines.filter(l => l.file), ...summary };
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** 6 → 六，12 → 十二（笔记文件名和 H1 用汉字，frontmatter 留数字） */
export function cnChapter(n) {
  const v = Number(String(n).replace(/[^0-9]/g, ''));
  if (!Number.isFinite(v) || v <= 0) return String(n);
  if (v < 10) return CN_DIGITS[v];
  if (v < 20) return '十' + (v % 10 ? CN_DIGITS[v % 10] : '');
  return CN_DIGITS[Math.floor(v / 10)] + '十' + (v % 10 ? CN_DIGITS[v % 10] : '');
}

/** 分段导出的章节 PDF 里，PDF 页序 ≠ 教材页码。
 *  首页开头常有教材页码（如「本章数字资源 165 第六章」），据此算偏移：
 *  教材页 = PDF 页 + offset。识别不出就返回 0（页码照抄 PDF 页序）。 */
export function detectPageOffset(pages) {
  const head = (pages[0]?.text ?? '').split('\n').slice(0, 4).join(' ');
  for (const m of head.matchAll(/(?<![\d.])(\d{2,3})(?![\d.])/g)) {
    const n = Number(m[1]);
    if (n >= 100 && n <= 500) return n - 1;
  }
  return 0;
}

const CN = '一二三四五六七八九十';
const secRe = new RegExp(`^\\s*第([${CN}\\d]+)节\\s*[|｜\\s]*(.*)$`);
const dotLeader = /(?:[.．·…]\s*){3,}\d*\s*$/;  // 目录里的点线可能是『. . . .』

/** 目录页：同一页里冒出多条「第X节」，或标题带点线页码 */
function isTocPage(text) {
  const hits = text.split('\n').filter((l) => secRe.test(l.trim()));
  return hits.length >= 2 || hits.some((l) => dotLeader.test(l.trim()));
}

/** 从页文本里切出「第X节」的边界：返回 [{section, title, pages:[...], text}] */
export function splitSections(pages, offset = 0) {
  const sections = [];
  let cur = null;
  for (const p of pages) {
    if (isTocPage(p.text)) continue; // 跳过目录页，否则会把目录当成 23 个小节
    for (const line of p.text.split('\n')) {
      const m = line.trim().match(secRe);
      if (m) {
        const title = m[2].replace(dotLeader, '').trim().replace(/\s+/g, '');
        if (title.length > 1) {
          cur = { section: m[1], title, pages: [], text: [] };
          sections.push(cur);
        }
      }
      if (cur) {
        cur.text.push(line);
        if (!cur.pages.includes(p.page)) cur.pages.push(p.page);
      }
    }
  }
  return sections
    .map(s => ({
      ...s,
      rawPages: s.pages,
      pages: offset ? s.pages.map(p => p + offset) : s.pages,
      text: s.text.join('\n'),
    }))
    .filter(s => s.text.trim().length > 200);
}

/** 笔记骨架：与第五章四篇笔记同构（frontmatter → 定位 → 考什么 → mermaid → 考点占位 → 速记卡 → 出处） */
export function scaffold({ chapter, section, title, pages, source, figures = [], date }) {
  const cn = cnChapter(chapter);
  const figList = figures.map(f => `  - ${f.file}`).join('\n');
  const figEmbeds = figures
    .slice(0, 2)
    .map(f => `![[${f.file}|440]]\n*${f.caption}*`)
    .join('\n\n');
  return `---
chapter: ${chapter}
section: "${section}"
title: ${title}
source: ${source}
pages: ${pages[0]}-${pages[pages.length - 1]}
created: ${date}
tags:
  - 生理学
  - 考点笔记
  - 第${cn}章
figures:
${figList || '  - （待补）'}
---

# 第${cn}章 第${section}节 ${title}

> [!abstract] 这份笔记的定位
> 走**教材原文线**：按教材小节的顺序，把能出题的点稠密地拆开，图用教材原图。
> 按题号组织的旧笔记走**题目线**，两者互补，不用互相替代。

> [!info] 这一节在考什么
> （待补：三句话说清本节为什么会考、考什么角度、最容易混在哪。）

\`\`\`mermaid
mindmap
  root((${title}))
    一级
      二级
    一级
      二级
\`\`\`

${figEmbeds ? `## 教材原图\n\n${figEmbeds}\n\n` : ''}## 一、（待补小标题）

#### 考点：（待补）

**一句话**：。（待补）

**机制**：。（待补）

| 项目 | 数值/结论 |
| --- | --- |
| （待补） | （待补） |

> [!warning] 易错
> （待补）

> [!note] 补充
> （待补）

> [!quote] 出处
> 《${source}》第 ${pages[0]}–${pages[pages.length - 1]} 页。
`;
}

/** 整章骨架：一份 PDF = 一篇笔记，节只作为索引条目，不再一节一个文件 */
export function scaffoldChapter({ chapter, title = '', source, sections, figures = [], date, pages }) {
  const cn = cnChapter(chapter);
  const head = `第${cn}章${title ? ' ' + title : ''}`;
  const lo = pages[0];
  const hi = pages[pages.length - 1];

  const indexRows = sections
    .map((s) => {
      const mine = figures.filter((f) => f.page >= s.rawPages[0] && f.page <= s.rawPages.at(-1));
      return `| [[#第${s.section}节 ${s.title}\\|第${s.section}节]] | ${s.title} | ${s.pages[0]}–${s.pages.at(-1)} | ${mine.length} | 0 |`;
    })
    .join('\n');

  const body = sections
    .map((s) => {
      const mine = figures.filter((f) => f.page >= s.rawPages[0] && f.page <= s.rawPages.at(-1));
      const embeds = mine.slice(0, 3).map((f) => `![[${f.file}|440]]\n*${f.caption}*`).join('\n\n');
      return `## 第${s.section}节 ${s.title}

> [!quote] 教材出处
> 《${source}》第 ${s.pages[0]}–${s.pages.at(-1)} 页。

${embeds ? embeds + '\n\n' : ''}#### 考点：（待补）

**一句话**：。（待补）

**机制**：。（待补）

| 项目 | 数值/结论 |
| --- | --- |
| （待补） | （待补） |

> [!warning] 易错
> （待补）

> [!note] 补充
> （待补）
`;
    })
    .join('\n');

  const figList = figures.map((f) => `  - ${f.file}`).join('\n');
  const mindmapBranches = sections.map((s) => `    ${s.title}`).join('\n');

  return `---
chapter: ${chapter}
title: ${title || '（待补）'}
source: ${source}
pages: ${lo}-${hi}
sections: ${sections.length}
created: ${date}
tags:
  - 生理学
  - 考点笔记
  - 第${cn}章
figures:
${figList || '  - （待补）'}
---

# ${head}

> [!abstract] 这份笔记的定位
> 一章一篇：整份 PDF 一次性生成，**节只作索引**，不再一节一个文件。
> 走教材原文线，按节顺序把能出题的点稠密拆开，图用教材原图。

> [!info] 这一章在考什么
> （待补：三句话说清本章为什么会考、考什么角度、最容易混在哪。）

\`\`\`mermaid
mindmap
  root((${title || head}))
    本章索引
${mindmapBranches}
    速记卡
\`\`\`

## 本章索引

| 节 | 标题 | 教材页 | 图 | 考点 |
| --- | --- | --- | --- | --- |
${indexRows}

${body}
## 速记卡

| 一句话 | 数字/结论 |
| --- | --- |
| （待补） | （待补） |

> [!quote] 全章出处
> 《${source}》第 ${lo}–${hi} 页。
`;
}

/** 附件索引：从 dir 往上找含「附件」的目录，收集其中所有图片文件名（Obsidian 是 vault 内按名解析的） */
function figureNames(dir) {
  const names = new Set();
  let cur = dir;
  for (let i = 0; i < 4; i++) {
    const att = path.join(cur, '附件');
    if (fs.existsSync(att)) {
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else names.add(e.name);
        }
      };
      walk(att);
      break;
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return names;
}

/** 体检：考点数、断图、frontmatter 必填 */
export function report(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !/总览|合并版|模板|README|索引/i.test(f));
  const pool = figureNames(dir);
  const rows = [];
  for (const f of files) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    const fm = txt.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const lines = txt.split('\n');
    const points = [];
    lines.forEach((line, i) => {
      const m = line.match(/^#{4,5}\s*考点\s*[:：]?\s*(.*)$/);
      if (!m) return;
      let title = m[1].trim();
      if (!title) {
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          if (lines[j].trim()) { title = lines[j].trim(); break; }
        }
      }
      points.push(title);
    });
    const todo = (txt.match(/（待补/g) ?? []).length;
    const links = [...txt.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(m => m[1].trim());
    const missing = links.filter(l => !pool.has(path.basename(l)));
    rows.push({
      file: f,
      points: points.length,
      todo,
      figures: links.length,
      missing,
      frontmatter: [
        ...['chapter', 'source', 'pages'].filter(k => !new RegExp(`^${k}:`, 'm').test(fm)),
        ...(/(^|\n)sections?:/m.test(fm) ? [] : ['section/sections']),
      ],
    });
  }
  return rows;
}

/** 标题结构 → markmap 树：跳过 frontmatter、图片、callout、表格、代码块 */
export function outlineTree(notePath, rootName) {
  const src = fs.readFileSync(notePath, 'utf8');
  const lines = src.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const clean = (s) =>
    s
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\*([^*]*)\*/g, '$1')
      .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim();
  const root = { name: rootName, children: [] };
  const stack = [{ level: 1, node: root }];
  let inFence = false;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = raw.match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const level = m[1].length;
    const name = clean(m[2].replace(/^考点\s*[:：]?\s*/, '考点 · '));
    if (!name) continue;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].node : root;
    const node = { name, children: [] };
    parent.children.push(node);
    stack.push({ level, node });
  }
  return root;
}

/** 生成完全离线、零依赖的可折叠思维导图 HTML（SVG 连线 + HTML 节点，DOM 实测宽度） */
export function mindmap(notePath, outPath) {
  const title = path.basename(notePath, '.md');
  let tree = outlineTree(notePath, title.replace(/^第[一二三四五六七八九十]+章\s*/, ''));
  const base = path.basename(notePath, '.md');
  if (tree.children && tree.children.length === 1 && tree.children[0].name === base) tree = tree.children[0];
  const data = JSON.stringify(tree).replace(/</g, '\\u003c');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 导图</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#fbfbfd;color:#1c1c1e;
  font:14px/1.5 -apple-system,"PingFang SC","Helvetica Neue",sans-serif}
#bar{position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:8px;
  padding:0 14px;background:rgba(251,251,253,.93);border-bottom:1px solid #e8e8ed;z-index:9;
  font-size:12px;color:#8a8a8e;user-select:none;backdrop-filter:saturate(180%) blur(12px)}
#bar b{color:#1c1c1e;font-size:13px;font-weight:600;margin-right:4px}
#bar button{border:1px solid #d8d8dd;background:#fff;color:#3a3a3c;border-radius:7px;
  padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit}
#bar button:hover{background:#f2f2f7}
#hint{margin-left:auto}
#stage{position:fixed;inset:44px 0 0 0;overflow:hidden;cursor:grab}
#stage.drag{cursor:grabbing}
#canvas{position:absolute;left:0;top:0;transform-origin:0 0}
#links{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.node{position:absolute;box-sizing:border-box;padding:5px 9px;border-radius:8px;white-space:pre;
  overflow:hidden;text-overflow:ellipsis;font-size:13px;line-height:1.35;
  border:1px solid;background:#fff;transition:box-shadow .12s}
.node.has-kids{cursor:pointer}
.node.has-kids:hover{box-shadow:0 2px 10px rgba(0,0,0,.13)}
.node .tg{display:inline-block;width:12px;color:#8a8a8e;font-size:10px}
.d0{font-weight:700}
.d1{font-weight:600}
#tip{position:fixed;left:0;right:0;bottom:6px;text-align:center;font-size:11px;color:#b0b0b6;pointer-events:none}
</style></head><body>
<div id="bar"><b>${title}</b>
  <button onclick="MM.expandAll()">全部展开</button>
  <button onclick="MM.collapseLevel(2)">收起到 2 级</button>
  <button onclick="MM.fit()">适应窗口</button>
  <span id="hint">滚轮缩放 · 拖动平移 · 点节点折叠</span>
</div>
<div id="stage"><div id="canvas"><svg id="links"></svg></div></div>
<div id="tip">按标题结构生成 · 共 __NODES__ 个节点</div>
<script>
var DATA = ${data};
var MM = (function(){
  var ROW = 34, MINW = 66, MAXW = 460, GAPX = 54, PAD = 44;
  var COLORS = ['#2f6fed','#1b9c85','#c2661f','#8b5cf6','#c2377f','#4b5563'];
  var stage = document.getElementById('stage');
  var canvas = document.getElementById('canvas');
  var svg = document.getElementById('links');
  var scale = 1, tx = PAD, ty = PAD, all = [];

  function walk(n, d) {
    n.depth = d; n.kids = n.children || []; n.fold = false; all.push(n);
    n.kids.forEach(function (k) { walk(k, d + 1); });
  }

  function make(n) {
    var el = document.createElement('div');
    el.className = 'node d' + Math.min(n.depth, 2);
    var c = COLORS[Math.min(n.depth, COLORS.length - 1)];
    el.style.borderColor = c + '55';
    el.style.background = n.depth === 0 ? c : n.depth === 1 ? '#eef3fe' : '#fff';
    el.style.color = n.depth === 0 ? '#fff' : '#1c1c1e';
    el.title = n.name;
    el.innerHTML = '<span class="tg"></span><span class="tx"></span>';
    el.onclick = function (e) {
      if (!n.kids.length) return;
      e.stopPropagation();
      n.fold = !n.fold;
      paint();
    };
    n.el = el;
  }

  // 先把节点挂到 canvas 上，用 offsetWidth 量真实文字宽度（不受缩放影响）
  function measureAll(visible) {
    visible.forEach(function (n) {
      n.el.querySelector('.tx').textContent = n.name;
      n.el.querySelector('.tg').textContent = n.kids.length ? (n.fold ? '▸ ' : '▾ ') : '';
      n.el.style.width = 'auto';
      n.w = Math.max(MINW, Math.min(MAXW, Math.ceil(n.el.offsetWidth * 1.05) + 4));
      n.h = Math.max(26, n.el.offsetHeight);
    });
  }

  function layout() {
    var widths = [], leafY = 0;
    function place(n) {
      var kids = n.fold ? [] : n.kids;
      var ys = kids.map(place);
      n.y = kids.length ? (ys[0] + ys[ys.length - 1]) / 2 : leafY;
      if (!kids.length) leafY += ROW;
      widths[n.depth] = Math.max(widths[n.depth] || 0, n.w);
      return n.y;
    }
    place(DATA);
    var xs = [], acc = PAD;
    for (var d = 0; d < widths.length; d++) { xs[d] = acc; acc += widths[d] + GAPX; }
    (function setX(n) { n.x = xs[n.depth]; (n.fold ? [] : n.kids).forEach(setX); })(DATA);
  }

  function visibleNodes() {
    var out = [];
    (function rec(n) { out.push(n); if (!n.fold) n.kids.forEach(rec); })(DATA);
    return out;
  }

  function paint() {
    all.forEach(function (n) { if (!n.el) { make(n); canvas.appendChild(n.el); } });
    var vis = visibleNodes();
    var seen = new Set(vis);
    all.forEach(function (n) {
      n.el.style.display = seen.has(n) ? 'block' : 'none';
    });
    measureAll(vis);
    layout();
    svg.innerHTML = '';
    all.forEach(function (n) {
      n.el.style.width = n.w + 'px';
      n.el.style.height = n.h + 'px';
      n.el.style.left = n.x + 'px';
      n.el.style.top = (n.y - n.h / 2) + 'px';
    });
    var maxX = 0, maxY = 0;
    vis.forEach(function (n) {  // 画布只按可见节点算，折叠的子节点不撑大画布
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h / 2);
    });
    all.forEach(function (n) {
      if (n.fold) return;
      n.kids.forEach(function (k) {
        var d = 'M' + (n.x + n.w) + ',' + n.y +
                ' C' + (n.x + n.w + GAPX / 2) + ',' + n.y +
                ' ' + (k.x - GAPX / 2) + ',' + k.y +
                ' ' + k.x + ',' + k.y;
        var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', d);
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', COLORS[Math.min(k.depth, COLORS.length - 1)] + '66');
        p.setAttribute('stroke-width', '1.6');
        svg.appendChild(p);
      });
    });
    var W = maxX + PAD, H = maxY + PAD;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.style.width = W + 'px';
    svg.style.height = H + 'px';
    apply();
  }

  function apply() {
    canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
  }

  function fit() {
    var w = parseFloat(canvas.style.width) || 800;
    var h = parseFloat(canvas.style.height) || 600;
    var vw = stage.clientWidth, vh = stage.clientHeight;
    scale = Math.max(0.5, Math.min(1, Math.min((vw - 28) / w, (vh - 28) / h)));
    tx = Math.max(10, (vw - w * scale) / 2);
    ty = Math.max(10, (vh - h * scale) / 2);
    apply();
  }

  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;
    var k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    var ns = Math.min(3, Math.max(0.2, scale * k));
    tx = mx - (mx - tx) * (ns / scale);
    ty = my - (my - ty) * (ns / scale);
    scale = ns;
    apply();
  }, { passive: false });

  var dragging = false, lx = 0, ly = 0;
  stage.addEventListener('mousedown', function (e) {
    if (e.target.closest('.node')) return;
    dragging = true; lx = e.clientX; ly = e.clientY; stage.classList.add('drag');
  });
  window.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply();
  });
  window.addEventListener('mouseup', function () { dragging = false; stage.classList.remove('drag'); });
  window.addEventListener('resize', fit);

  walk(DATA, 0);
  paint();

  return {
    expandAll: function () { all.forEach(function (n) { n.fold = false; }); paint(); fit(); },
    collapseLevel: function (lv) {
      all.forEach(function (n) { n.fold = n.depth >= lv - 1 && n.kids.length > 0; });
      paint(); fit();
    },
    fit: fit
  };
})();
MM.collapseLevel(2);
</script>
</body></html>`.replace('__NODES__', String(countNodes(tree))), 'utf8');
  return outPath;
}

function countNodes(n) {
  return 1 + (n.children || []).reduce((a, k) => a + countNodes(k), 0);
}

if (process.argv[2] === 'selftest') {
  const note = path.join(ROOT, 'lib', '__selftest.md');
  fs.writeFileSync(note, scaffold({
    chapter: 6, section: '一', title: '消化与吸收', pages: [1, 2], source: '生理学（第10版）',
    figures: [{ file: '图6-1 x.png', caption: '图6-1 x' }], date: '2026-10-25',
  }), 'utf8');
  console.log(fs.readFileSync(note, 'utf8').slice(0, 700));
  console.log('\n--- report ---');
  console.log(report(path.join(ROOT, 'lib')));
  fs.unlinkSync(note);
}
