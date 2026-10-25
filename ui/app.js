const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let STATE = null;
let selected = null;

function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function log(lines, clear = true) {
  const el = $('log');
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
  el.textContent = clear ? text : `${el.textContent}\n${text}`;
  el.scrollTop = el.scrollHeight;
  switchTab('log');
}

function switchTab(name) {
  document.body.dataset.tab = name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
}

async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderState(s) {
  STATE = s;
  $('vaultPath').textContent = s.vault;
  $('pdfs').innerHTML = s.pdfs.map((p) => `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join('');

  let total = 0;
  const tree = $('tree');
  if (!s.books.length) {
    tree.innerHTML = `<p class="hint">还没有笔记。选中左边的 PDF，填章号，点「预演」看看会生成哪几节。</p>`;
  } else {
    tree.innerHTML = s.books.map((b) => `
      <details class="book" ${b.chapters.length ? 'open' : ''}>
        <summary>${esc(b.name)}</summary>
        ${b.chapters.map((c) => {
          total += c.notes.length;
          const pts = c.notes.reduce((a, n) => a + n.points, 0);
          const todo = c.notes.reduce((a, n) => a + n.todo, 0);
          return `
          <details class="chapter" open>
            <summary>${esc(c.name)}<span class="badge">${c.notes.length} 篇 · 考点 ${pts}${todo ? ` · 待补 ${todo}` : ''}</span></summary>
            ${c.notes.map((n) => {
              const cls = n.missing.length || n.todo ? 'warn' : 'ok';
              return `
              <div class="note" data-file="${esc(c.dir + '/' + n.file)}" data-dir="${esc(c.dir)}">
                <span class="name">${esc(n.file.replace(/\.md$/, ''))}</span>
                <span class="badge ${cls}">考点 ${n.points}</span>
                <span class="badge">图 ${n.figures}</span>
                ${n.map ? '<span class="badge ok">导图</span>' : ''}
              </div>`;
            }).join('')}
          </details>`;
        }).join('')}
      </details>`).join('');
  }
  $('count').textContent = `${total} 篇`;

  tree.querySelectorAll('.note').forEach((el) => {
    el.addEventListener('click', () => {
      tree.querySelectorAll('.note.active').forEach((x) => x.classList.remove('active'));
      el.classList.add('active');
      selected = { file: el.dataset.file, dir: el.dataset.dir };
      $('reportDir').value = el.dataset.dir;
      log(`选中：${el.dataset.file}\n目录：${el.dataset.dir}\n\n点「导图」标签可预览，或点下面的按钮生成/打开。`);
      const note = findNote(el.dataset.file);
      if (note?.map) {
        const mapPath = el.dataset.file.replace(/\.md$/, ' · 导图.html');
        openMap(mapPath);
      }
    });
  });
}

function findNote(file) {
  for (const b of STATE?.books ?? []) for (const c of b.chapters) {
    const n = c.notes.find((x) => `${c.dir}/${x.file}` === file);
    if (n) return n;
  }
  return null;
}

function openMap(mapPath) {
  $('frame').src = `/map?file=${encodeURIComponent(mapPath)}`;
  switchTab('map');
}

function collect() {
  const sections = $('sections').value.trim();
  const offset = $('pageOffset').value.trim();
  return {
    pdf: $('pdf').value.trim(),
    chapter: $('chapter').value.trim(),
    title: $('title').value.trim() || undefined,
    pages: $('pages').value.trim() || undefined,
    sections: sections ? sections.split(/[,，、\s]+/).filter(Boolean) : undefined,
    source: $('source').value.trim() || undefined,
    dpi: Number($('dpi').value) || 300,
    pageOffset: offset ? Number(offset) : undefined,
  };
}

async function runPrepare(dryRun) {
  const body = collect();
  if (!body.pdf) return toast('先填教材 PDF 路径');
  if (!body.chapter) return toast('先填章号');
  $('gen').disabled = $('dry').disabled = true;
  try {
    log(dryRun ? '预演中…' : '生成中：切图 + 拆节 + 写骨架…');
    const r = await api('/api/prepare', { ...body, dryRun });
    const lines = [];
    lines.push(`${dryRun ? '预演' : '已生成'}：1 篇章节笔记（索引 ${r.plan.length} 节）`);
    if (r.note) lines.push(`笔记 ${r.note}`);
    lines.push(`插图目录 ${r.figDir}`);
    if (r.figures) {
      lines.push(`切图 ${r.figures.count} 张` + (r.figures.holes?.length ? `；⚠️ 漏检 ${r.figures.holes.join(', ')}` : ''));
    }
    lines.push('');
    for (const p of r.plan) lines.push(`第${p.section}节 ${p.title}  p${p.pages}  原文 ${p.chars} 字`);
    if (!dryRun) lines.push('', '下一步：按「本章索引」逐节把「（待补）」写成考点正文，对着 _原文/ 核对，再跑体检。');
    log(lines.join('\n'));
    if (!dryRun) { await refresh(); }
    toast(dryRun ? '预演完成' : '生成完成');
  } catch (e) {
    log(`出错：${e.message}`);
    toast('出错了，看日志');
  } finally {
    $('gen').disabled = $('dry').disabled = false;
  }
}

async function runReport() {
  const dir = $('reportDir').value.trim();
  if (!dir) return toast('先选一篇笔记或填目录');
  try {
    const r = await api('/api/report', { dir });
    const sum = (k) => r.rows.reduce((a, x) => a + x[k], 0);
    log([
      `体检 ${dir}`,
      `${r.rows.length} 篇 / 考点 ${sum('points')} / 待补 ${sum('todo')} / 断图 ${sum('missing')}`,
      '',
      ...r.rows.map((x) => `${x.file}\t考点 ${x.points}\t待补 ${x.todo}\t图 ${x.figures}`
        + (x.missing.length ? `\t断图 ${x.missing.join(',')}` : '')
        + (x.frontmatter.length ? `\t缺字段 ${x.frontmatter.join(',')}` : '')),
      '',
      r.rows.some((x) => x.missing.length || x.todo || x.frontmatter.length) ? '有需要收尾的条目。' : '结构完整。',
    ].join('\n'));
    await refresh();
    toast('体检完成');
  } catch (e) {
    log(`出错：${e.message}`);
  }
}

async function makeMap() {
  if (!selected) return toast('先在中间选一篇笔记');
  try {
    log(`生成导图：${selected.file}`);
    const r = await api('/api/mindmap', { note: selected.file });
    log(`导图已生成：${r.file}`);
    openMap(r.file);
    await refresh();
    toast('导图已生成');
  } catch (e) {
    log(`出错：${e.message}`);
  }
}

async function refresh() {
  try {
    renderState(await api('/api/state'));
  } catch (e) {
    log(`读取状态失败：${e.message}`);
  }
}

$('dry').addEventListener('click', () => runPrepare(true));
$('gen').addEventListener('click', () => runPrepare(false));
$('refresh').addEventListener('click', refresh);
$('report').addEventListener('click', runReport);
$('mkmap').addEventListener('click', makeMap);
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tab === 'map' && selected && !$('frame').src) makeMap();
  else switchTab(b.dataset.tab);
}));

// 选中笔记后，双击笔记行 = 生成导图
$('tree').addEventListener('dblclick', (e) => {
  if (e.target.closest('.note')) makeMap();
});

log('note-forge 前端就绪。\n左侧选 PDF 建章节骨架，中间看已有笔记，右侧看日志与导图预览。\n');
refresh();
