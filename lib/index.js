/**
 * dsh-note-forge —— 教材笔记生成器
 *
 * host 半边：四个工具 + 一个 skill。
 *   noteforge_prepare  有图版 PDF + 章号 → 切图入库 / 按节拆文本 / 生成笔记骨架
 *   noteforge_report   体检一个笔记目录：考点数、待补数、断图、frontmatter 缺失
 *   noteforge_mindmap  按笔记结构生成零依赖交互导图
 *   noteforge_ui       启动 / 停止本地前端（ui/ 目录，零依赖 Web UI）
 *
 * 前端是插件自带的本地 Web 应用（node ui/server.mjs），不是 client bundle：
 * 不需要重建 web 产物，任何浏览器打开 127.0.0.1 就能用。
 */
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpPages, extractFigures, splitSections, scaffoldChapter, report, mindmap, cnChapter, detectPageOffset, bookName } from './pipeline.js';

export const name = 'dsh-note-forge';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const expand = (p) => (p ? p.replace(/^~(?=$|\/)/, process.env.HOME ?? '~') : p);
const abs = (p) => (path.isAbsolute(expand(p)) ? path.resolve(expand(p)) : path.resolve(expand(p)));

const text = (v) => [{ type: 'text', text: String(v) }];
const OUTPUT = { schema: { type: 'string', description: '给人看的一行摘要，同时回填给模型。' }, render: (_a, v) => text(v) };

/* ------------------------------- skill ------------------------------- */

const SKILL_FILE = path.join(HERE, '..', 'SKILL.md');
const SKILL_NAME = 'note-forge';

function skillProvider() {
  const read = () => {
    const raw = fs.readFileSync(SKILL_FILE, 'utf8');
    const end = raw.indexOf('\n---\n', 4);
    if (!raw.startsWith('---\n') || end < 0) throw new Error('note-forge SKILL.md frontmatter 不合法');
    const description = /^\s*description\s*:\s*(.+?)\s*$/mu.exec(raw.slice(4, end))?.[1]?.replace(/^['"]|['"]$/gu, '');
    if (!description) throw new Error('note-forge SKILL.md 缺少 description');
    return { raw, end, description };
  };
  const meta = () => {
    const { description } = read();
    return {
      name: SKILL_NAME,
      description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled',
      provider: 'dsh-note-forge',
      path: SKILL_FILE,
      resourceBase: { kind: 'directory', path: path.dirname(SKILL_FILE) },
      rank: 600,
      locator: SKILL_FILE,
    };
  };
  return {
    name: 'dsh-note-forge',
    list: async () => [meta()],
    get: async () => {
      const { raw, end } = read();
      return { ...meta(), content: raw.slice(end + 5) };
    },
  };
}

/* ------------------------------- tools ------------------------------- */

function prepareTool(config) {
  const vault = path.resolve(expand(process.env.NOTEFORGE_VAULT ?? config?.vaultPath ?? path.join(process.env.HOME ?? '~', 'Desktop', 'physiologyshit')));
  return {
    name: 'noteforge_prepare',
    description: '整份教材 PDF 一次性生成一篇章节笔记：切全部插图、按「第X节」建本章索引、每节留考点占位。节不再单独成篇。',
    parameters: {
      type: 'object',
      properties: {
        pdf: { type: 'string', description: '教材 PDF 绝对路径（必须是有图版，纯文字版切不出图）' },
        chapter: { type: 'string', description: '章号，如 "6"' },
        title: { type: 'string', description: '章名，如 "消化和吸收"；缺省留空，之后手填' },
        pages: { type: 'string', description: 'PDF 页范围，如 "1-30"；缺省全书' },
        noteDir: { type: 'string', description: '笔记目录，绝对或相对 vault' },
        source: { type: 'string', description: '教材名（写进 frontmatter），默认 PDF 文件名' },
        sections: { type: 'array', items: { type: 'string' }, description: '只收这几节进索引，如 ["一","二"]；缺省全部' },
        pageOffset: { type: 'number', description: '教材页 = PDF 页 + offset。缺省自动从首页页码推测' },
        dpi: { type: 'number', description: '切图 dpi，默认 300' },
        dryRun: { type: 'boolean', description: '只报会生成什么，不落盘' },
      },
      required: ['pdf', 'chapter'],
    },
    output: OUTPUT,
    async execute(args) {
      const pdf = abs(args.pdf);
      if (!fs.existsSync(pdf)) throw new Error(`PDF 不存在: ${pdf}`);
      const chapter = String(args.chapter).replace(/^第|章$/g, '');
      const title = (args.title ?? '').trim();
      const source = args.source ?? bookName(pdf);
      const bookRoot = path.join(vault, config?.libraryRoot ?? '插件整合笔记', source);
      const noteDir = args.noteDir
        ? (path.isAbsolute(expand(args.noteDir)) ? abs(args.noteDir) : path.join(vault, args.noteDir))
        : path.join(bookRoot, `第${cnChapter(chapter)}章`);
      const figDir = path.join(bookRoot, '附件', '生理图');

      const dump = dumpPages(pdf, args.pages);
      const offset = args.pageOffset ?? detectPageOffset(dump);
      const secs = splitSections(dump, offset);
      if (!secs.length) throw new Error('没识别到「第X节」标题：检查 pages 范围，或这份 PDF 没有文本层');
      const wanted = args.sections?.length ? secs.filter((s) => args.sections.includes(s.section)) : secs;
      if (!wanted.length) throw new Error(`sections ${JSON.stringify(args.sections)} 不在 ${secs.map((s) => s.section).join('/')} 里`);

      const plan = wanted.map((s) => `第${s.section}节 ${s.title}  p${s.pages[0]}-${s.pages.at(-1)}  ${s.text.length} 字`);

      if (args.dryRun) {
        return [
          `${wanted.length} 节 → 1 篇整章笔记`,
          `笔记：${path.join(noteDir, `第${cnChapter(chapter)}章${title ? ' ' + title : ''}.md`)}`,
          `插图：${figDir}`,
          ...plan.map((p) => '  ' + p),
        ].join('\n');
      }

      fs.mkdirSync(noteDir, { recursive: true });
      fs.mkdirSync(figDir, { recursive: true });
      const figs = extractFigures({ pdf, chapter, outDir: figDir, pages: args.pages, dpi: args.dpi ?? 300 });

      const rawDir = path.join(noteDir, '_原文');
      fs.mkdirSync(rawDir, { recursive: true });
      for (const s of wanted) {
        fs.writeFileSync(path.join(rawDir, `第${s.section}节 ${s.title}.txt`), s.text, 'utf8');
      }

      const md = scaffoldChapter({
        chapter,
        title,
        source,
        sections: wanted,
        figures: figs.figures ?? [],
        date: new Date().toISOString().slice(0, 10),
        pages: [wanted[0].pages[0], wanted.at(-1).pages.at(-1)],
      });
      const file = path.join(noteDir, `第${cnChapter(chapter)}章${title ? ' ' + title : ''}.md`);
      fs.writeFileSync(file, md, 'utf8');

      return [
        `切图 ${figs.count} 张 → ${figDir}`,
        figs.holes?.length ? `⚠️ 漏检图号（题注与正文粘连，需手工 clip 补切）：${figs.holes.join(', ')}` : '',
        `1 篇整章笔记：${path.basename(file)}`,
        `索引 ${wanted.length} 节：`,
        ...plan.map((p) => '  ' + p),
        `原文留档：${rawDir}`,
        '下一步：按索引逐节把「（待补）」写成考点正文，对着 _原文 核对，再跑 noteforge_report。',
      ].filter(Boolean).join('\n');
    },
  };
}

function reportTool(config) {
  const vault = path.resolve(expand(process.env.NOTEFORGE_VAULT ?? config?.vaultPath ?? path.join(process.env.HOME ?? '~', 'Desktop', 'physiologyshit')));
  return {
    name: 'noteforge_report',
    description: '体检一个笔记目录：每篇的考点数、待补占位数、图片引用是否断链、frontmatter 必填项。',
    parameters: {
      type: 'object',
      properties: { dir: { type: 'string', description: '笔记目录，绝对路径或相对 vault' } },
      required: ['dir'],
    },
    output: OUTPUT,
    async execute(args) {
      const dir = path.isAbsolute(expand(args.dir)) ? abs(args.dir) : path.join(vault, args.dir);
      if (!fs.existsSync(dir)) throw new Error(`目录不存在: ${dir}`);
      const rows = report(dir);
      if (!rows.length) return `${dir} 下没有 .md`;
      const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
      const bad = rows.filter((r) => r.missing.length || r.frontmatter.length || r.todo > 0);
      return [
        `${rows.length} 篇 / 考点 ${sum('points')} / 待补 ${sum('todo')} / 断图 ${sum('missing')}`,
        ...rows.map(
          (r) =>
            `  ${r.file}\t考点 ${r.points}\t待补 ${r.todo}\t图 ${r.figures}` +
            (r.missing.length ? `\t断图 ${r.missing.join(',')}` : '') +
            (r.frontmatter.length ? `\t缺字段 ${r.frontmatter.join(',')}` : ''),
        ),
        bad.length ? `需要收尾：${bad.length} 篇` : '结构完整。',
      ].join('\n');
    },
  };
}

function mindmapTool(config) {
  const vault = path.resolve(expand(process.env.NOTEFORGE_VAULT ?? config?.vaultPath ?? path.join(process.env.HOME ?? '~', 'Desktop', 'physiologyshit')));
  return {
    name: 'noteforge_mindmap',
    description: '把一篇笔记的标题结构渲染成 markmap 交互式思维导图（独立 HTML，可折叠缩放，比 mermaid 好看）。',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '笔记路径，绝对或相对 vault' },
        out: { type: 'string', description: '输出 HTML，默认与笔记同目录 <名字> · 导图.html' },
      },
      required: ['note'],
    },
    output: OUTPUT,
    async execute(args) {
      const note = path.isAbsolute(expand(args.note)) ? abs(args.note) : path.join(vault, args.note);
      if (!fs.existsSync(note)) throw new Error(`笔记不存在: ${note}`);
      const out = args.out
        ? (path.isAbsolute(expand(args.out)) ? abs(args.out) : path.join(vault, args.out))
        : path.join(path.dirname(note), `${path.basename(note, '.md')} · 导图.html`);
      const file = mindmap(note, out);
      return `导图：${file}（单文件离线，直接双击用浏览器打开）`;
    },
  };
}

const UI_STATE = path.join(os.tmpdir(), 'note-forge-ui.json');
const UI_ENTRY = path.join(HERE, '..', 'ui', 'server.mjs');

function uiTool(config) {
  const vault = path.resolve(expand(process.env.NOTEFORGE_VAULT ?? config?.vaultPath ?? path.join(process.env.HOME ?? '~', 'Desktop', 'physiologyshit')));
  const readState = () => {
    try { return JSON.parse(fs.readFileSync(UI_STATE, 'utf8')); } catch { return null; }
  };
  const alive = (pid) => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  return {
    name: 'noteforge_ui',
    description: '启动/停止 note-forge 的本地前端（笔记工坊 Web UI）：建章节骨架、跑体检、生成与预览导图。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'], description: '默认 start' },
        port: { type: 'number', description: '端口，默认 7788' },
      },
    },
    output: OUTPUT,
    async execute(args) {
      const action = args.action ?? 'start';
      const cur = readState();

      if (action === 'status') {
        if (cur && alive(cur.pid)) return `前端在跑：http://127.0.0.1:${cur.port}（pid ${cur.pid}）`;
        return '前端没在跑。用 action:"start" 启动。';
      }

      if (action === 'stop') {
        if (cur && alive(cur.pid)) {
          try { process.kill(cur.pid); } catch { /* ignore */ }
          try { fs.unlinkSync(UI_STATE); } catch { /* ignore */ }
          return `已停止（pid ${cur.pid}）`;
        }
        return '本来就没在跑。';
      }

      if (cur && alive(cur.pid)) return `已经在跑：http://127.0.0.1:${cur.port}（pid ${cur.pid}）`;
      if (!fs.existsSync(UI_ENTRY)) throw new Error(`前端入口缺失：${UI_ENTRY}`);

      const port = args.port ?? 7788;
      const child = spawn(process.execPath, [UI_ENTRY, '--port', String(port)], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, NOTEFORGE_VAULT: vault },
      });
      child.unref();
      fs.writeFileSync(UI_STATE, JSON.stringify({ pid: child.pid, port, vault }), 'utf8');
      return `前端已启动：http://127.0.0.1:${port}\nvault: ${vault}\n（用 action:"stop" 关闭）`;
    },
  };
}

export function apply(ctx, config) {
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(function* () {
      yield toolsCtx.tools.register(prepareTool(config));
      yield toolsCtx.tools.register(reportTool(config));
      yield toolsCtx.tools.register(mindmapTool(config));
      yield toolsCtx.tools.register(uiTool(config));
    }, 'dsh-note-forge: tools');
  });
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.skills.registerProvider(() => skillProvider());
  });
}
