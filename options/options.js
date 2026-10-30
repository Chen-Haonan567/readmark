const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const COLORS = { yellow: '#facc15', green: '#4ade80', blue: '#60a5fa', pink: '#f472b6', orange: '#fb923c' };
const DEFAULTS = { provider: 'microsoft', targetLang: 'zh-CN', autoTranslate: true, showPhonetic: true, layerVisible: true, defaultColor: 'yellow', dblclickNote: true };

function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

// ---------- 设置 ----------
async function loadSettings() {
  const { settings } = await api.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  for (const k of ['provider', 'targetLang', 'defaultColor']) $(k).value = s[k];
  for (const k of ['autoTranslate', 'showPhonetic', 'layerVisible', 'dblclickNote']) $(k).checked = !!s[k];
}
async function saveSettings() {
  const { settings } = await api.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  for (const k of ['provider', 'targetLang', 'defaultColor']) s[k] = $(k).value;
  for (const k of ['autoTranslate', 'showPhonetic', 'layerVisible', 'dblclickNote']) s[k] = $(k).checked;
  await api.storage.local.set({ settings: s });
  $('saved').hidden = false;
  setTimeout(() => { $('saved').hidden = true; }, 1200);
}
for (const k of ['provider', 'targetLang', 'defaultColor', 'autoTranslate', 'showPhonetic', 'layerVisible', 'dblclickNote']) {
  $(k).addEventListener('change', saveSettings);
}

// ---------- 笔记列表 ----------
async function allPages() {
  const all = await api.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith('page:'))
    .map(([key, p]) => ({ key, ...p }))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

async function render() {
  const q = $('search').value.trim().toLowerCase();
  const pages = await allPages();
  const box = $('pages');
  box.textContent = '';
  let nItems = 0;
  let nSticky = 0;
  for (const p of pages) {
    const match = (s) => !q || (s || '').toLowerCase().includes(q);
    const pageMatch = match(p.title) || match(p.url);
    const items = (p.items || []).filter((i) => pageMatch || match(i.quote?.exact) || match(i.note) || match(i.translation?.text));
    const stickies = (p.stickies || []).filter((s) => pageMatch || match(s.text));
    if (!items.length && !stickies.length) continue;
    nItems += items.length;
    nSticky += stickies.length;

    const sec = h('div', { class: 'page' },
      h('div', { class: 'page-head' },
        h('a', { href: p.url, target: '_blank' }, p.title || p.url),
        h('span', { class: 'muted' }, `${items.length} 条高亮 · ${stickies.length} 张便签`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'danger', onclick: async () => {
          if (!confirm('删除这个网页的全部笔记？')) return;
          await api.storage.local.remove(p.key);
          render();
        } }, '删除本页')));

    for (const i of items) {
      sec.append(h('div', { class: 'item' },
        h('span', { class: 'swatch', style: `background:${COLORS[i.color] || COLORS.yellow}` }),
        h('div', {},
          h('div', { class: 'q' }, i.quote?.exact || '', i.phonetic ? h('span', { class: 'muted' }, '  ' + i.phonetic) : null),
          i.translation?.text ? h('div', { class: 'tr' }, i.translation.text) : null,
          i.note ? h('div', { class: 'note' }, '📝 ' + i.note) : null,
          i.orphan ? h('div', { class: 'orphan' }, '上次打开时在网页中没找到这段原文') : null),
        h('button', { onclick: async () => {
          const fresh = (await api.storage.local.get(p.key))[p.key];
          if (!fresh) return;
          fresh.items = (fresh.items || []).filter((x) => x.id !== i.id);
          if (!fresh.items.length && !(fresh.stickies || []).length) await api.storage.local.remove(p.key);
          else await api.storage.local.set({ [p.key]: fresh });
          render();
        } }, '删除')));
    }
    for (const s of stickies) {
      sec.append(h('div', { class: 'item' },
        h('span', { class: 'swatch', style: `background:${COLORS[s.color] || COLORS.yellow}` }),
        h('div', {}, h('div', { class: 'note' }, '🗒 ' + (s.text || '（空便签）'))),
        h('span', {})));
    }
    box.append(sec);
  }
  if (!box.children.length) box.append(h('div', { class: 'empty' }, q ? '没有匹配的笔记' : '还没有笔记。打开任意网页，选中文字试试吧！'));
  $('summary').textContent = `${nItems} 条高亮 · ${nSticky} 张便签`;
}
$('search').addEventListener('input', render);

// ---------- 导入导出 ----------
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const today = () => new Date().toISOString().slice(0, 10);

$('exportJson').addEventListener('click', async () => {
  const all = await api.storage.local.get(null);
  download(`readmark-backup-${today()}.json`, JSON.stringify({ app: 'ReadMark', version: 1, data: all }, null, 2), 'application/json');
});
$('importJson').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    const data = json.data || json;
    const pages = Object.fromEntries(Object.entries(data).filter(([k]) => k.startsWith('page:')));
    if (!confirm(`导入 ${Object.keys(pages).length} 个网页的笔记？同一网页的已有笔记会被备份中的内容覆盖。`)) return;
    await api.storage.local.set(pages);
    render();
  } catch (err) {
    alert('导入失败：' + err.message);
  }
  e.target.value = '';
});
$('exportCsv').addEventListener('click', async () => {
  const pages = await allPages();
  const esc = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  const rows = [['原文', '音标', '译文', '笔记', '颜色', '网页标题', '网址', '时间']];
  for (const p of pages) {
    for (const i of p.items || []) {
      rows.push([i.quote?.exact, i.phonetic, i.translation?.text, i.note, i.color, p.title, p.url,
        new Date(i.created || 0).toLocaleString()]);
    }
  }
  download(`readmark-vocab-${today()}.csv`, '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n'), 'text/csv');
});

api.storage.onChanged.addListener(() => render());
loadSettings();
render();
