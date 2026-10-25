#!/usr/bin/env node
/**
 * note-forge 前端：本地零依赖 Web UI。
 *   node ui/server.mjs [--port 7788]
 * 只监听 127.0.0.1，数据全部是本机的 vault 与 PDF。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  dumpPages, detectPageOffset, splitSections, extractFigures, scaffoldChapter,
  cnChapter, report, mindmap, bookName,
} from '../lib/pipeline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME ?? os.homedir();
const argPort = (() => {
  const i = process.argv.indexOf('--port');
  return i > 0 ? Number(process.argv[i + 1]) : Number(process.env.NOTEFORGE_PORT ?? 7788);
})();

const VAULT = process.env.NOTEFORGE_VAULT
  ?? path.join(HOME, 'Desktop', 'physiologyshit');
const LIBRARY = process.env.NOTEFORGE_LIBRARY ?? '插件整合笔记';

const expand = (p) => (p ? p.replace(/^~(?=$|\/)/, HOME) : p);
const abs = (p) => path.resolve(expand(p));

// ---------- 状态扫描 ----------
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const secOrder = (file) => {
  const m = file.match(/第([一二三四五六七八九十]+)节/);
  return m ? (CN[m[1]] ?? 99) : 0;
};

function listBooks() {
  const root = path.join(VAULT, LIBRARY);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const bookDir = path.join(root, d.name);
      const chapters = fs.readdirSync(bookDir, { withFileTypes: true })
        .filter((c) => c.isDirectory() && /^第.+章/.test(c.name))
        .map((c) => {
          const dir = path.join(bookDir, c.name);
          const rows = report(dir).map((r) => {
            const notePath = path.join(dir, r.file);
            const mapPath = notePath.replace(/\.md$/, ' · 导图.html');
            return {
              file: r.file,
              points: r.points,
              todo: r.todo,
              figures: r.figures,
              missing: r.missing,
              frontmatter: r.frontmatter,
              map: fs.existsSync(mapPath) ? path.basename(mapPath) : null,
            };
          });
          rows.sort((a, b) => secOrder(a.file) - secOrder(b.file) || a.file.localeCompare(b.file, 'zh'));
          return { name: c.name, dir, notes: rows };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      return { name: d.name, dir: bookDir, chapters };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function listPdfs() {
  const dirs = [path.join(HOME, 'Downloads'), path.join(HOME, 'Desktop'), path.join(HOME, 'Documents')];
  const out = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/\.pdf$/i.test(f)) {
        const full = path.join(dir, f);
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        out.push({ path: full, name: f, size });
      }
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

// ---------- 生成 ----------
function prepare({ pdf, chapter, title, pages, sections, source, pageOffset, dpi, dryRun, noteDir: noteDirArg }) {
  const pdfPath = abs(pdf);
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF 不存在：${pdfPath}`);
  const ch = String(chapter).replace(/^第|章$/g, '');
  const ttl = (title ?? '').trim();
  const src = source?.trim() || bookName(pdfPath);
  const bookRoot = path.join(VAULT, LIBRARY, src);
  const noteDir = noteDirArg ? abs(noteDirArg) : path.join(bookRoot, `第${cnChapter(ch)}章`);
  const figDir = path.join(bookRoot, '附件', '生理图');

  const dump = dumpPages(pdfPath, pages);
  const offset = pageOffset ?? detectPageOffset(dump);
  const secs = splitSections(dump, offset);
  if (!secs.length) throw new Error('没识别到「第X节」标题：检查页码范围，或这份 PDF 没有文本层');
  const wanted = sections?.length ? secs.filter((s) => sections.includes(s.section)) : secs;
  if (!wanted.length) throw new Error(`指定的节不在 ${secs.map((s) => s.section).join('/')} 里`);

  const plan = wanted.map((s) => ({
    section: s.section,
    title: s.title,
    pages: `${s.pages[0]}-${s.pages.at(-1)}`,
    chars: s.text.length,
  }));
  const fileName = `第${cnChapter(ch)}章${ttl ? ' ' + ttl : ''}.md`;

  if (dryRun) return { plan, noteDir, figDir, note: path.join(noteDir, fileName), figures: null, written: [] };

  fs.mkdirSync(noteDir, { recursive: true });
  fs.mkdirSync(figDir, { recursive: true });
  const figs = extractFigures({ pdf: pdfPath, chapter: ch, outDir: figDir, pages, dpi: dpi ?? 300 });

  const rawDir = path.join(noteDir, '_原文');
  fs.mkdirSync(rawDir, { recursive: true });
  for (const s of wanted) {
    fs.writeFileSync(path.join(rawDir, `第${s.section}节 ${s.title}.txt`), s.text, 'utf8');
  }

  const md = scaffoldChapter({
    chapter: ch,
    title: ttl,
    source: src,
    sections: wanted,
    figures: figs.figures ?? [],
    date: new Date().toISOString().slice(0, 10),
    pages: [wanted[0].pages[0], wanted.at(-1).pages.at(-1)],
  });
  const file = path.join(noteDir, fileName);
  fs.writeFileSync(file, md, 'utf8');

  return {
    plan,
    noteDir,
    figDir,
    note: file,
    written: [{ file: fileName, figures: figs.figures?.length ?? 0, chars: wanted.reduce((a, s) => a + s.text.length, 0) }],
    figures: { count: figs.count, holes: figs.holes ?? [] },
  };
}

function mindmapFor(notePath) {
  const note = abs(notePath);
  if (!fs.existsSync(note)) throw new Error(`笔记不存在：${note}`);
  const out = note.replace(/\.md$/, ' · 导图.html');
  mindmap(note, out);
  return { file: out, name: path.basename(out) };
}

// ---------- HTTP ----------
const json = (res, code, data) => {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveFile(res, file) {
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('请求体不是合法 JSON'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveFile(res, path.join(HERE, 'index.html'));
    }
    if (req.method === 'GET' && url.pathname === '/app.js') return serveFile(res, path.join(HERE, 'app.js'));
    if (req.method === 'GET' && url.pathname === '/style.css') return serveFile(res, path.join(HERE, 'style.css'));

    // 直接把 vault 里的导图 HTML 喂给浏览器
    if (req.method === 'GET' && url.pathname === '/map') {
      const target = abs(url.searchParams.get('file') ?? '');
      if (!target.startsWith(VAULT)) { res.writeHead(403); res.end('forbidden'); return; }
      return serveFile(res, target);
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, {
        vault: VAULT,
        library: LIBRARY,
        books: listBooks(),
        pdfs: listPdfs(),
        home: HOME,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/prepare') {
      const body = await readBody(req);
      return json(res, 200, prepare(body));
    }

    if (req.method === 'POST' && url.pathname === '/api/report') {
      const body = await readBody(req);
      const dir = abs(body.dir ?? '');
      if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`);
      const rows = report(dir).map((r) => ({
        file: r.file, points: r.points, todo: r.todo, figures: r.figures,
        missing: r.missing ?? [], frontmatter: r.frontmatter ?? [],
      }));
      return json(res, 200, { dir, rows });
    }

    if (req.method === 'POST' && url.pathname === '/api/mindmap') {
      const body = await readBody(req);
      return json(res, 200, mindmapFor(body.note));
    }

    if (req.method === 'POST' && url.pathname === '/api/open') {
      const body = await readBody(req);
      const target = abs(body.path ?? '');
      if (target.startsWith(VAULT) && fs.existsSync(target)) {
        const { spawn } = await import('node:child_process');
        spawn('open', [target], { stdio: 'ignore', detached: true }).unref();
        return json(res, 200, { ok: true });
      }
      return json(res, 400, { error: '路径不在 vault 内或不存在' });
    }

    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    json(res, 500, { error: err?.message ?? String(err) });
  }
});

server.listen(argPort, '127.0.0.1', () => {
  const addr = server.address();
  console.log(`note-forge UI → http://127.0.0.1:${addr.port}`);
  console.log(`vault: ${VAULT}`);
});
