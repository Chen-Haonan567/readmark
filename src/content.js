// ReadMark 内容脚本：划词翻译弹窗、高亮、旁注、便签、笔记层开关
(() => {
  if (window.__readmarkLoaded) return;
  window.__readmarkLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;

  const COLORS = {
    yellow: { name: '黄', solid: '#facc15', paper: '#fef6c3' },
    green: { name: '绿', solid: '#4ade80', paper: '#dcf7e3' },
    blue: { name: '蓝', solid: '#60a5fa', paper: '#dcebff' },
    pink: { name: '粉', solid: '#f472b6', paper: '#fde2ef' },
    orange: { name: '橙', solid: '#fb923c', paper: '#ffe7d1' }
  };
  const CONTEXT_LEN = 40;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'IFRAME', 'CANVAS', 'SVG', 'TEMPLATE', 'WN-NOTE', 'READMARK-ROOT']);

  let settings = { provider: 'microsoft', targetLang: 'zh-CN', autoTranslate: true, showPhonetic: true, layerVisible: true, defaultColor: 'yellow', dblclickNote: true };
  let page = { url: '', title: '', items: [], stickies: [] };
  let storageKey = '';
  const ownRevs = new Set();   // 本标签页自己写入的版本号，用来区分「别处修改」
  let lastContextPoint = null;

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const normalizeUrl = (href) => { const u = new URL(href); u.hash = ''; return u.toString(); };

  // ======================= 存储 =======================
  async function loadAll() {
    storageKey = 'page:' + normalizeUrl(location.href);
    const data = await api.storage.local.get(['settings', storageKey]);
    settings = { ...settings, ...(data.settings || {}) };
    page = data[storageKey] || { url: normalizeUrl(location.href), title: document.title, items: [], stickies: [] };
    page.items ||= [];
    page.stickies ||= [];
    applyLayerVisibility();
  }

  async function savePage() {
    page.title = document.title || page.title;
    page.url = normalizeUrl(location.href);
    page.updated = Date.now();
    if (!page.items.length && !page.stickies.length) {
      await api.storage.local.remove(storageKey);
    } else {
      page.rev = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      ownRevs.add(page.rev);
      if (ownRevs.size > 200) ownRevs.delete(ownRevs.values().next().value);
      await api.storage.local.set({ [storageKey]: page });
    }
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = { ...settings, ...(changes.settings.newValue || {}) };
      applyLayerVisibility();
    }
    // 其他标签页或管理页修改了本页数据 → 重新渲染
    if (changes[storageKey]) {
      const v = changes[storageKey].newValue;
      const mine = v ? ownRevs.has(v.rev) : (!page.items.length && !page.stickies.length);
      if (!mine) {
        page = v || { url: page.url, title: page.title, items: [], stickies: [] };
        page.items ||= [];
        page.stickies ||= [];
        rerenderAll();
      }
    }
  });

  function applyLayerVisibility() {
    document.documentElement.classList.toggle('wn-hidden', !settings.layerVisible);
    if (ui) ui.stickyLayer.style.display = settings.layerVisible ? '' : 'none';
    if (!settings.layerVisible && panel.mode === 'existing') hidePanel();
  }

  async function setLayerVisible(v) {
    settings.layerVisible = v;
    applyLayerVisibility();
    const { settings: s } = await api.storage.local.get('settings');
    await api.storage.local.set({ settings: { ...(s || {}), layerVisible: v } });
  }

  // ======================= 文本索引与定位 =======================
  // 把页面所有可见文字拼成一个字符串，并记录每个文本节点的起始位置。
  // 高亮包裹前后文字内容不变，所以偏移量在多次包裹之间保持有效。
  function buildIndex() {
    const entries = [];
    let text = '';
    const root = document.body || document.documentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          return SKIP_TAGS.has(n.nodeName.toUpperCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      entries.push({ node: n, start: text.length });
      text += n.data;
    }
    return { entries, text };
  }

  function rangeToOffsets(index, range) {
    let start = -1;
    let end = -1;
    for (const e of index.entries) {
      if (!range.intersectsNode(e.node)) {
        if (start >= 0) break;
        continue;
      }
      if (start < 0) start = e.start + (e.node === range.startContainer ? range.startOffset : 0);
      end = e.start + (e.node === range.endContainer ? range.endOffset : e.node.data.length);
    }
    if (start < 0 || end <= start) return null;
    return { start, end };
  }

  function makeQuote(index, { start, end }) {
    return {
      exact: index.text.slice(start, end),
      prefix: index.text.slice(Math.max(0, start - CONTEXT_LEN), start),
      suffix: index.text.slice(end, end + CONTEXT_LEN)
    };
  }

  function commonSuffixLen(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  }
  function commonPrefixLen(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  // 根据保存的文字 + 前后文，在页面中找到最匹配的位置
  function findQuote(index, quote) {
    const { text } = index;
    let best = null;
    let bestScore = -1;
    let pos = text.indexOf(quote.exact);
    let guard = 0;
    while (pos !== -1 && guard++ < 2000) {
      const before = text.slice(Math.max(0, pos - CONTEXT_LEN), pos);
      const after = text.slice(pos + quote.exact.length, pos + quote.exact.length + CONTEXT_LEN);
      const score = commonSuffixLen(before, quote.prefix || '') + commonPrefixLen(after, quote.suffix || '');
      if (score > bestScore) {
        bestScore = score;
        best = { start: pos, end: pos + quote.exact.length };
        if (score >= (quote.prefix || '').length + (quote.suffix || '').length) break;
      }
      pos = text.indexOf(quote.exact, pos + 1);
    }
    return best;
  }

  function entryAt(index, offset) {
    // 二分查找包含 offset 的文本节点
    let lo = 0;
    let hi = index.entries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (index.entries[mid].start <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function wrapOffsets(index, { start, end }, item) {
    const marks = [];
    let i = entryAt(index, start);
    for (; i < index.entries.length; i++) {
      const e = index.entries[i];
      if (e.start >= end) break;
      let node = e.node;
      const len = node.data.length;
      const ls = Math.max(0, start - e.start);
      const le = Math.min(len, end - e.start);
      if (ls >= le) continue;
      if (!node.data.slice(ls, le).trim()) continue;   // 跳过纯空白（如表格单元之间）
      if (le < len) node.splitText(le);
      if (ls > 0) node = node.splitText(ls);
      const mark = document.createElement('wn-mark');
      mark.dataset.id = item.id;
      mark.dataset.color = item.color;
      node.parentNode.insertBefore(mark, node);
      mark.appendChild(node);
      marks.push(mark);
    }
    if (marks.length) {
      marks[0].classList.add('wn-first');
      marks[marks.length - 1].classList.add('wn-last');
      renderNote(item, marks[marks.length - 1]);
    }
    return marks;
  }

  function marksOf(id) {
    return Array.from(document.querySelectorAll(`wn-mark[data-id="${CSS.escape(id)}"]`));
  }

  function unwrapItem(id) {
    for (const m of marksOf(id)) {
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    }
    document.querySelectorAll(`wn-note[data-id="${CSS.escape(id)}"]`).forEach((n) => n.remove());
  }

  function renderNote(item, lastMark) {
    document.querySelectorAll(`wn-note[data-id="${CSS.escape(item.id)}"]`).forEach((n) => n.remove());
    if (!item.note) return;
    lastMark = lastMark || marksOf(item.id).pop();
    if (!lastMark) return;
    const el = document.createElement('wn-note');
    el.dataset.id = item.id;
    el.dataset.color = item.color;
    el.textContent = item.note;
    el.title = item.note;
    lastMark.after(el);
  }

  // 一次性定位全部高亮：从后往前包裹，遇到重叠时重建索引
  function anchorItems(items) {
    if (!items.length) return;
    let index = buildIndex();
    const located = [];
    for (const item of items) {
      if (marksOf(item.id).length) continue;
      const pos = findQuote(index, item.quote);
      item.orphan = !pos;
      if (pos) located.push({ item, pos });
    }
    located.sort((a, b) => b.pos.start - a.pos.start);
    let lastStart = Infinity;
    for (const { item, pos } of located) {
      if (pos.end > lastStart) index = buildIndex();
      wrapOffsets(index, pos, item);
      lastStart = pos.start;
    }
  }

  function rerenderAll() {
    document.querySelectorAll('wn-mark').forEach((m) => unwrapItem(m.dataset.id));
    document.querySelectorAll('wn-note').forEach((n) => n.remove());
    anchorItems(page.items);
    renderStickies();
    if (panel.item && !page.items.find((i) => i.id === panel.item.id)) hidePanel();
  }

  // 动态加载的页面（单页应用、懒加载）：内容变化后重试定位未找到的高亮
  let retryTimer = null;
  const observer = new MutationObserver((muts) => {
    if (!page.items.some((i) => i.orphan)) return;
    if (muts.every((m) => isOwnNode(m.target))) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => anchorItems(page.items.filter((i) => i.orphan)), 800);
  });
  const isOwnNode = (n) => n && n.nodeType === 1 && (n.closest?.('wn-mark, wn-note, readmark-root'));

  // ======================= 界面（Shadow DOM，避免与网页样式互相影响） =======================
  let ui = null;
  const panel = { mode: null, range: null, text: '', item: null, translation: null, reqId: 0 };

  const ICONS = {
    speaker: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5 10 17l9-10"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    palette: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>',
    minus: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
    translate: '<svg viewBox="0 0 24 24"><path d="M4 5h9M8.5 3v2M6 5c.8 3.5 3 6 6 7.5M11 5c-.8 3.5-3.2 6.5-7 8"/><path d="m12 21 4.5-10L21 21M13.5 18h6"/></svg>'
  };

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ui {
      --bg: rgba(255,255,255,.96); --fg: #18181b; --sub: #52525b; --muted: #a1a1aa; --line: rgba(0,0,0,.07);
      --hover: rgba(0,0,0,.05); --accent: #2563eb; --chip: rgba(0,0,0,.045); --shadow: 0 12px 40px -8px rgba(0,0,0,.22), 0 2px 6px rgba(0,0,0,.06);
      --danger: #dc2626; --field: #fff;
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased; color: var(--fg);
    }
    @media (prefers-color-scheme: dark) {
      .ui { --bg: rgba(32,32,36,.96); --fg: #f4f4f5; --sub: #d4d4d8; --muted: #71717a; --line: rgba(255,255,255,.08);
        --hover: rgba(255,255,255,.07); --accent: #60a5fa; --chip: rgba(255,255,255,.07); --danger: #f87171; --field: rgba(255,255,255,.04);
        --shadow: 0 12px 40px -8px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.06); }
    }
    svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; display: block; }
    button { font: inherit; color: inherit; }

    .panel {
      position: absolute; z-index: 2147483647; width: 340px; max-width: calc(100vw - 16px);
      background: var(--bg); border-radius: 14px; box-shadow: var(--shadow);
      -webkit-backdrop-filter: saturate(180%) blur(16px); backdrop-filter: saturate(180%) blur(16px);
      overflow: hidden; animation: pop .14s ease-out;
    }
    .panel[hidden] { display: none; }
    @keyframes pop { from { opacity: 0; transform: translateY(4px) scale(.98); } to { opacity: 1; transform: none; } }

    .head { display: flex; align-items: flex-start; gap: 8px; padding: 14px 14px 0 16px; }
    .src { flex: 1; min-width: 0; color: var(--sub); font-size: 13px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
    .panel.word .src { color: var(--fg); font-size: 20px; font-weight: 650; letter-spacing: -.01em; line-height: 1.3; -webkit-line-clamp: 1; }
    .tools { display: flex; gap: 2px; margin: -4px -6px 0 0; }
    .ib { width: 28px; height: 28px; display: grid; place-items: center; border: 0; background: transparent; color: var(--muted); border-radius: 8px; cursor: pointer; transition: background .12s, color .12s; }
    .ib:hover { background: var(--hover); color: var(--fg); }
    .ib.danger:hover { color: var(--danger); }
    .ib.ok { color: #16a34a; }

    .say { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 16px 0; }
    .say:empty { display: none; }
    .pr { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border: 0; border-radius: 999px; background: var(--chip); color: var(--sub); font-size: 12px; cursor: pointer; transition: background .12s; }
    .pr:hover { background: var(--hover); color: var(--fg); }
    .pr svg { width: 13px; height: 13px; }
    .pr b { font-weight: 600; color: var(--muted); }
    .pr.playing { color: var(--accent); }
    .pr.playing svg { animation: pulse .8s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .35; } }
    .ipa { font-family: "Lucida Grande", "Segoe UI", "Arial Unicode MS", sans-serif; }

    .body { padding: 10px 16px 14px; max-height: 260px; overflow: auto; }
    .tr { font-size: 15px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
    .dict { margin-top: 8px; display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 13px; color: var(--sub); }
    .pos { color: var(--muted); font-size: 12px; font-style: italic; padding-top: 1px; }
    .err { color: var(--danger); font-size: 12px; word-break: break-word; }
    .hint { color: var(--muted); font-size: 12px; }
    .linkbtn { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; font-size: 13px; display: inline-flex; gap: 4px; align-items: center; }
    .sk { height: 12px; border-radius: 6px; background: linear-gradient(90deg, var(--chip) 25%, var(--hover) 50%, var(--chip) 75%); background-size: 200% 100%; animation: sh 1.1s linear infinite; margin: 6px 0; }
    @keyframes sh { from { background-position: 200% 0; } to { background-position: -200% 0; } }

    .bar { display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 16px; border-top: 1px solid var(--line); }
    .dot { width: 16px; height: 16px; border-radius: 50%; border: 0; padding: 0; cursor: pointer; position: relative; transition: transform .12s; }
    .dot:hover { transform: scale(1.18); }
    .dot.on::after { content: ""; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var(--fg); opacity: .55; }
    .spacer { flex: 1; }
    .src-tag { font-size: 11px; color: var(--muted); margin-right: 2px; }

    .noteBox { padding: 0 12px 12px; }
    .noteBox[hidden] { display: none; }
    textarea { width: 100%; min-height: 72px; resize: vertical; border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; font: inherit; font-size: 13px; color: var(--fg); background: var(--field); outline: none; transition: border-color .12s, box-shadow .12s; }
    textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
    .row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; align-items: center; }
    .row .hint { flex: 1; }
    .btn { border: 0; border-radius: 8px; padding: 5px 12px; cursor: pointer; font-size: 12px; background: var(--chip); color: var(--fg); }
    .btn:hover { background: var(--hover); }
    .btn.primary { background: var(--accent); color: #fff; }
    .btn.primary:hover { filter: brightness(1.08); }

    .sticky {
      position: absolute; z-index: 2147483646; width: 230px; min-height: 130px; border-radius: 12px;
      box-shadow: 0 10px 30px -8px rgba(0,0,0,.25), 0 1px 3px rgba(0,0,0,.08); display: flex; flex-direction: column; color: #27272a;
    }
    .sticky.min { min-height: 0; }
    .sticky.min textarea { display: none; }
    .sticky .sh { display: flex; align-items: center; gap: 0; padding: 4px 4px 0 10px; cursor: grab; user-select: none; -webkit-user-select: none; }
    .sticky .sh:active { cursor: grabbing; }
    .sticky .sh .t { flex: 1; font-size: 11px; color: rgba(0,0,0,.45); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .sticky .ib { width: 24px; height: 24px; color: rgba(0,0,0,.45); }
    .sticky .ib:hover { background: rgba(0,0,0,.07); color: rgba(0,0,0,.8); }
    .sticky .ib svg { width: 14px; height: 14px; }
    .sticky textarea { flex: 1; border: 0; background: transparent; min-height: 100px; color: #27272a; box-shadow: none; padding: 4px 12px 12px; }
  `;

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }
  const iconBtn = (icon, title, onclick, cls = '') => el('button', { class: 'ib ' + cls, title, 'aria-label': title, html: ICONS[icon], onclick });

  function ensureUI() {
    if (ui) return ui;
    const host = document.createElement('readmark-root');
    host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.append(el('style', {}, UI_CSS));
    const root = el('div', { class: 'ui' });

    const stickyLayer = el('div', { class: 'stickies' });
    const p = el('div', { class: 'panel', hidden: true, role: 'dialog' });
    const src = el('div', { class: 'src' });
    const copyBtn = iconBtn('copy', '复制译文', copyTranslation);
    const say = el('div', { class: 'say' });
    const body = el('div', { class: 'body' });
    const dots = Object.entries(COLORS).map(([key, c]) =>
      el('button', { class: 'dot', title: c.name + '色高亮', 'data-color': key, style: `background:${c.solid}`, onclick: () => onColor(key) }));
    const provider = el('span', { class: 'src-tag' });
    const noteBtn = iconBtn('note', '写笔记', openNoteEditor);
    const delBtn = iconBtn('trash', '删除高亮', onDelete, 'danger');
    const bar = el('div', { class: 'bar' }, ...dots, el('span', { class: 'spacer' }), provider, noteBtn, delBtn);
    const ta = el('textarea', { placeholder: '写点笔记…' });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(); }
      if (e.key === 'Escape') { e.stopPropagation(); hidePanel(); }
    });
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const noteBox = el('div', { class: 'noteBox', hidden: true }, ta,
      el('div', { class: 'row' }, el('span', { class: 'hint' }, (isMac ? '⌘' : 'Ctrl') + ' + Enter 保存'),
        el('button', { class: 'btn', onclick: () => { noteBox.hidden = true; } }, '取消'),
        el('button', { class: 'btn primary', onclick: saveNote }, '保存')));
    p.append(el('div', { class: 'head' }, src, el('div', { class: 'tools' }, copyBtn, iconBtn('close', '关闭 (Esc)', hidePanel))),
      say, body, bar, noteBox);
    root.append(stickyLayer, p);
    shadow.append(root);
    // 面板内的事件不要冒泡到网页（避免网页自身的快捷键、选择逻辑干扰）
    for (const t of ['mousedown', 'mouseup', 'keydown', 'keyup', 'keypress', 'click']) {
      p.addEventListener(t, (e) => e.stopPropagation());
      stickyLayer.addEventListener(t, (e) => e.stopPropagation());
    }
    document.documentElement.appendChild(host);
    ui = { host, shadow, panel: p, src, say, copyBtn, body, dots, provider, noteBtn, delBtn, noteBox, ta, stickyLayer };
    applyLayerVisibility();
    return ui;
  }

  function positionPanel(rect) {
    const p = ui.panel;
    p.hidden = false;
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    let left = rect.left + window.scrollX;
    left = Math.min(left, window.scrollX + document.documentElement.clientWidth - w - 8);
    left = Math.max(window.scrollX + 8, left);
    let top = rect.bottom + window.scrollY + 10;
    if (rect.bottom + h + 20 > window.innerHeight && rect.top - h - 10 > 0) {
      top = rect.top + window.scrollY - h - 10;
    }
    p.style.left = left + 'px';
    p.style.top = top + 'px';
  }

  const isWord = (s) => /^[A-Za-z][A-Za-z'’-]{0,40}$/.test(s);
  const hasCJK = (s) => /[぀-ヿ㐀-鿿가-힯]/.test(s);

  function showPanel({ mode, rect, text, range = null, item = null, openNote = false, autoNote = false }) {
    ensureUI();
    Object.assign(panel, { mode, range, text, item, autoNote, translation: item?.translation || null });
    ui.panel.classList.toggle('word', isWord(text));
    ui.src.textContent = text;
    ui.src.title = text;
    ui.dots.forEach((d) => d.classList.toggle('on', !!item && d.dataset.color === item.color));
    ui.delBtn.style.display = item ? '' : 'none';
    ui.noteBox.hidden = true;
    ui.provider.textContent = '';
    renderSay(item?.phonetic || '');
    ui.body.textContent = '';
    if (panel.translation) {
      renderTranslation(panel.translation);
    } else if ((settings.autoTranslate || autoNote) && text.length <= 1000) {
      runTranslate();
    } else {
      ui.body.append(el('button', { class: 'linkbtn', html: ICONS.translate, onclick: () => runTranslate() }, '翻译'));
    }
    positionPanel(rect);
    if (openNote) openNoteEditor();
  }

  function hidePanel() {
    if (ui) ui.panel.hidden = true;
    panel.mode = null;
    panel.item = null;
    panel.range = null;
    panel.reqId++;
  }

  // 发音按钮：英文显示「美 / 英」两种，其他语言一个朗读按钮
  function renderSay(phonetic) {
    ui.say.textContent = '';
    const text = panel.text;
    if (text.length > 600) return;
    const mk = (label, accent) => {
      const b = el('button', { class: 'pr', title: '朗读', onclick: () => pronounce(text, accent, b) });
      if (label) b.append(el('b', {}, label));
      if (accent !== 'uk' && phonetic) b.append(el('span', { class: 'ipa' }, phonetic));
      b.insertAdjacentHTML('beforeend', ICONS.speaker);
      return b;
    };
    if (!hasCJK(text) && /[A-Za-z]/.test(text)) {
      ui.say.append(mk('美', 'us'), mk('英', 'uk'));
    } else {
      ui.say.append(mk('', 'auto'));
    }
  }

  async function runTranslate() {
    const reqId = ++panel.reqId;
    const text = panel.text;
    panel.phonetic = null;
    ui.body.textContent = '';
    ui.body.append(el('div', { class: 'sk', style: 'width:72%' }), el('div', { class: 'sk', style: 'width:46%' }));
    let res;
    try {
      if (isWord(text) && settings.showPhonetic) loadPhonetic(text, reqId);
      res = await api.runtime.sendMessage({ type: 'translate', text });
    } catch (e) {
      res = { ok: false, error: '扩展已更新，请刷新本页 (' + (e.message || e) + ')' };
    }
    if (reqId !== panel.reqId) return;
    if (!res?.ok) {
      ui.body.textContent = '';
      ui.body.append(el('div', { class: 'err' }, res?.error || '翻译失败'),
        el('button', { class: 'linkbtn', style: 'margin-top:6px', onclick: () => runTranslate() }, '重试'));
      return;
    }
    const t = { text: res.result.text, dict: res.result.dict || [], phonetic: res.result.phonetic || '',
      audio: res.result.audio || '', provider: res.result.provider };
    if (panel.phonetic) Object.assign(t, panel.phonetic);
    panel.translation = t;
    renderTranslation(t);
    if (panel.autoNote) return addMeaningNote();
    // 已高亮但还没保存译文的条目，顺便存起来，方便以后复习
    if (panel.item && !panel.item.translation) {
      panel.item.translation = t;
      panel.item.phonetic = t.phonetic;
      savePage();
    }
  }

  // 音标和发音录音单独加载，先到先显示，不拖慢译文
  async function loadPhonetic(text, reqId) {
    panel.phonetic = null;
    let ph = null;
    try { ph = await api.runtime.sendMessage({ type: 'phonetic', text }); } catch (_) {}
    if (reqId !== panel.reqId || !ph?.phonetic) return;
    panel.phonetic = { phonetic: ph.phonetic, audio: ph.audio || '' };
    renderSay(ph.phonetic);
    if (panel.translation) {
      Object.assign(panel.translation, panel.phonetic);
      if (panel.item) { panel.item.phonetic = ph.phonetic; savePage(); }
    }
  }

  function renderTranslation(t) {
    ui.body.textContent = '';
    renderSay(t.phonetic || '');
    const word = isWord(panel.text);
    const dict = (t.dict || []).filter((g) => g.terms?.length);
    // 单词有词典释义时，直接列出全部词义，不再重复单个直译
    if (!dict.length || !word) ui.body.append(el('div', { class: 'tr' }, t.text));
    if (dict.length) {
      const d = el('div', { class: 'dict', style: word ? 'margin-top:0' : '' });
      for (const g of dict) d.append(el('span', { class: 'pos' }, shortPos(g.pos)), el('span', {}, g.terms.join('；')));
      ui.body.append(d);
    }
    ui.provider.textContent = t.provider || '';
  }

  const POS = { noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.', pronoun: 'pron.', preposition: 'prep.',
    conjunction: 'conj.', interjection: 'int.', adj: 'adj.', adv: 'adv.', prep: 'prep.', conj: 'conj.', pron: 'pron.', det: 'det.', modal: 'modal' };
  const shortPos = (p) => POS[(p || '').toLowerCase()] || (p ? p.toLowerCase() + '.' : '');

  function copyTranslation() {
    const t = panel.translation;
    if (!t?.text) return;
    const dict = (t.dict || []).map((g) => `${shortPos(g.pos)} ${g.terms.join('；')}`).join('\n');
    navigator.clipboard?.writeText(dict && isWord(panel.text) ? dict : t.text).then(() => {
      ui.copyBtn.innerHTML = ICONS.check;
      ui.copyBtn.classList.add('ok');
      setTimeout(() => { ui.copyBtn.innerHTML = ICONS.copy; ui.copyBtn.classList.remove('ok'); }, 1200);
    }).catch(() => {});
  }

  // ======================= 发音 =======================
  // 优先用有道词典的真人/高质量发音（国内可直连，支持美音/英音，也能读短句），
  // 失败时（网络或网页安全策略拦截）退回 Free Dictionary 的录音，再退回系统语音（会指定英文嗓音）。
  let audioEl = null;
  let playingBtn = null;

  function setPlaying(btn) {
    playingBtn?.classList.remove('playing');
    playingBtn = btn;
    btn?.classList.add('playing');
  }

  function playUrl(url) {
    return new Promise((resolve, reject) => {
      audioEl?.pause();
      const a = new Audio();
      audioEl = a;
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
      a.addEventListener('playing', () => { clearTimeout(timer); resolve(a); }, { once: true });
      a.addEventListener('error', () => { clearTimeout(timer); reject(new Error('audio error')); }, { once: true });
      a.addEventListener('ended', () => setPlaying(null), { once: true });
      a.src = url;
      a.play().catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  async function pronounce(text, accent, btn) {
    setPlaying(btn);
    speechSynthesis?.cancel();
    const english = accent === 'us' || accent === 'uk';
    if (english && text.length <= 300) {
      const urls = [`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=${accent === 'uk' ? 1 : 2}`];
      if (panel.translation?.audio && isWord(text)) urls.push(panel.translation.audio);
      for (const url of urls) {
        try { await playUrl(url); return; } catch (_) { /* 换下一个 */ }
      }
    }
    ttsSpeak(text, accent === 'uk' ? 'en-GB' : accent === 'us' ? 'en-US' : guessLang(text));
  }

  function guessLang(text) {
    if (/[぀-ヿ]/.test(text)) return 'ja-JP';
    if (/[가-힯]/.test(text)) return 'ko-KR';
    if (/[㐀-鿿]/.test(text)) return 'zh-CN';
    return 'en-US';
  }

  function pickVoice(lang) {
    const voices = speechSynthesis.getVoices();
    const norm = (l) => (l || '').replace('_', '-').toLowerCase();
    let pool = voices.filter((v) => norm(v.lang) === lang.toLowerCase());
    if (!pool.length) pool = voices.filter((v) => norm(v.lang).startsWith(lang.slice(0, 2).toLowerCase()));
    const score = (v) => (/natural|neural|premium|enhanced/i.test(v.name) ? 4 : 0)
      + (/samantha|aria|jenny|guy|daniel|serena|google/i.test(v.name) ? 2 : 0)
      + (v.localService ? 1 : 0);
    return pool.sort((a, b) => score(b) - score(a))[0] || null;
  }

  function ttsSpeak(text, lang) {
    if (!window.speechSynthesis) { setPlaying(null); return; }
    const go = () => {
      const u = new SpeechSynthesisUtterance(text.slice(0, 1000));
      u.lang = lang;
      const v = pickVoice(lang);
      if (v) u.voice = v;
      u.rate = 0.95;
      u.onend = u.onerror = () => setPlaying(null);
      speechSynthesis.speak(u);
    };
    // 语音列表是异步加载的；cancel 之后立即 speak 在 Chrome 里偶尔会被吞掉，稍等一下
    if (!speechSynthesis.getVoices().length) {
      speechSynthesis.addEventListener('voiceschanged', () => setTimeout(go, 30), { once: true });
      setTimeout(() => { if (!speechSynthesis.speaking) go(); }, 600);
    } else {
      setTimeout(go, 60);
    }
  }

  // ======================= 操作 =======================
  // 双击单词：自动高亮，并把词义写成旁注
  function meaningNote(t) {
    const dict = (t.dict || []).filter((g) => g.terms?.length);
    if (!dict.length) return t.text || '';
    return dict.slice(0, 3).map((g) => `${shortPos(g.pos)} ${g.terms.slice(0, 3).join('，')}`.trim()).join('  ');
  }

  function addMeaningNote() {
    panel.autoNote = false;
    if (panel.mode !== 'new' || !panel.range || !panel.translation) return;
    const rect = panel.range.getBoundingClientRect();
    const item = createHighlight(panel.range, settings.defaultColor || 'yellow');
    if (!item) return;
    item.note = meaningNote(panel.translation);
    renderNote(item);
    savePage();
    showPanel({ mode: 'existing', rect, text: item.quote.exact, item });
  }

  function createHighlight(range, color) {
    const index = buildIndex();
    const offs = rangeToOffsets(index, range);
    if (!offs) return null;
    const quote = makeQuote(index, offs);
    if (!quote.exact.trim()) return null;
    const item = {
      id: uid(), type: 'highlight', color, quote, note: '',
      translation: panel.translation || null, phonetic: panel.translation?.phonetic || '',
      created: Date.now()
    };
    if (!settings.layerVisible) setLayerVisible(true);
    wrapOffsets(index, offs, item);
    page.items.push(item);
    savePage();
    window.getSelection()?.removeAllRanges();
    return item;
  }

  function onColor(color) {
    if (panel.mode === 'new' && panel.range) {
      const rect = panel.range.getBoundingClientRect();
      const item = createHighlight(panel.range, color);
      if (item) showPanel({ mode: 'existing', rect, text: item.quote.exact, item });
    } else if (panel.item) {
      panel.item.color = color;
      marksOf(panel.item.id).forEach((m) => { m.dataset.color = color; });
      document.querySelectorAll(`wn-note[data-id="${CSS.escape(panel.item.id)}"]`).forEach((n) => { n.dataset.color = color; });
      ui.dots.forEach((d) => d.classList.toggle('on', d.dataset.color === color));
      savePage();
    }
  }

  function openNoteEditor() {
    if (panel.mode === 'new' && panel.range) {
      const rect = panel.range.getBoundingClientRect();
      const item = createHighlight(panel.range, settings.defaultColor || 'yellow');
      if (!item) return;
      showPanel({ mode: 'existing', rect, text: item.quote.exact, item, openNote: true });
      return;
    }
    if (!panel.item) return;
    ui.noteBox.hidden = false;
    ui.ta.value = panel.item.note || '';
    setTimeout(() => ui.ta.focus(), 0);
  }

  function saveNote() {
    if (!panel.item) return;
    panel.item.note = ui.ta.value.trim();
    panel.item.updated = Date.now();
    renderNote(panel.item);
    savePage();
    ui.noteBox.hidden = true;
  }

  function onDelete() {
    if (!panel.item) return;
    unwrapItem(panel.item.id);
    page.items = page.items.filter((i) => i.id !== panel.item.id);
    savePage();
    hidePanel();
  }

  function highlightCurrentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0).cloneRange();
    const rect = range.getBoundingClientRect();
    const item = createHighlight(range, settings.defaultColor || 'yellow');
    if (item) showPanel({ mode: 'existing', rect, text: item.quote.exact, item });
  }

  // ======================= 便签 =======================
  function renderStickies() {
    ensureUI();
    ui.stickyLayer.textContent = '';
    for (const s of page.stickies) ui.stickyLayer.append(stickyEl(s));
  }

  function stickyEl(s) {
    const c = COLORS[s.color] || COLORS.yellow;
    const ta = el('textarea', { placeholder: '便签…' });
    ta.value = s.text || '';
    let t = null;
    ta.addEventListener('input', () => {
      s.text = ta.value;
      s.updated = Date.now();
      clearTimeout(t);
      t = setTimeout(savePage, 400);
    });
    const title = el('span', { class: 't' }, new Date(s.created).toLocaleDateString());
    const box = el('div', { class: 'sticky' + (s.min ? ' min' : ''), style: `left:${s.x}px;top:${s.y}px;background:${c.paper}` });
    const colorBtn = iconBtn('palette', '换颜色', () => {
      const keys = Object.keys(COLORS);
      s.color = keys[(keys.indexOf(s.color) + 1) % keys.length];
      box.style.background = COLORS[s.color].paper;
      savePage();
    });
    const minBtn = iconBtn('minus', '折叠/展开', () => {
      s.min = !s.min;
      box.classList.toggle('min', s.min);
      savePage();
    });
    const delBtn = iconBtn('close', '删除便签', () => {
      if (s.text && !confirm('删除这张便签？')) return;
      page.stickies = page.stickies.filter((x) => x.id !== s.id);
      box.remove();
      savePage();
    });
    const head = el('div', { class: 'sh' }, title, colorBtn, minBtn, delBtn);
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const sx = e.pageX - s.x;
      const sy = e.pageY - s.y;
      head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        s.x = Math.max(0, ev.pageX - sx);
        s.y = Math.max(0, ev.pageY - sy);
        box.style.left = s.x + 'px';
        box.style.top = s.y + 'px';
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        savePage();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
    box.append(head, ta);
    return box;
  }

  function addSticky(atContextMenu) {
    ensureUI();
    if (!settings.layerVisible) setLayerVisible(true);
    let x;
    let y;
    if (atContextMenu && lastContextPoint) {
      ({ x, y } = lastContextPoint);
    } else {
      x = window.scrollX + document.documentElement.clientWidth - 250;
      y = window.scrollY + 80 + (page.stickies.length % 5) * 24;
    }
    const s = { id: uid(), x: Math.max(0, x), y: Math.max(0, y), text: '', color: 'yellow', created: Date.now() };
    page.stickies.push(s);
    const node = stickyEl(s);
    ui.stickyLayer.append(node);
    node.querySelector('textarea').focus();
    savePage();
  }

  // ======================= 事件 =======================
  const inOwnUI = (e) => ui && e.composedPath().includes(ui.host);
  const isEditable = (n) => {
    const e = n?.nodeType === 1 ? n : n?.parentElement;
    return !!e?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');
  };

  document.addEventListener('mousedown', (e) => {
    if (inOwnUI(e)) return;
    if (ui && !ui.panel.hidden) hidePanel();
  }, true);

  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || inOwnUI(e)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const text = sel.toString().trim();
      if (!text || text.length > 5000) return;
      const range = sel.getRangeAt(0);
      if (isEditable(range.commonAncestorContainer)) return;
      const rects = range.getClientRects();
      const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      const dbl = e.detail === 2 && isWord(text);
      if (dbl) {
        // 双击的是已经高亮过的词：直接打开它，不重复添加
        const node = range.commonAncestorContainer;
        const mark = (node.nodeType === 1 ? node : node.parentElement)?.closest('wn-mark');
        const existing = mark && page.items.find((i) => i.id === mark.dataset.id);
        if (existing && settings.layerVisible) {
          sel.removeAllRanges();
          showPanel({ mode: 'existing', rect, text: existing.quote.exact, item: existing });
          return;
        }
      }
      showPanel({ mode: 'new', rect, text, range: range.cloneRange(), autoNote: dbl && settings.dblclickNote !== false });
    }, 10);
  });

  // 点击已有高亮或旁注 → 打开它的面板
  document.addEventListener('click', (e) => {
    if (!settings.layerVisible || inOwnUI(e)) return;
    const target = e.target.closest?.('wn-mark, wn-note');
    if (!target) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;   // 正在选择文字时不打开
    const item = page.items.find((i) => i.id === target.dataset.id);
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    const marks = marksOf(item.id);
    const rect = (target.tagName === 'WN-NOTE' ? target : (marks[marks.length - 1] || target)).getBoundingClientRect();
    showPanel({ mode: 'existing', rect, text: item.quote.exact, item, openNote: target.tagName === 'WN-NOTE' });
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui && !ui.panel.hidden) hidePanel();
  });

  document.addEventListener('contextmenu', (e) => {
    lastContextPoint = { x: e.pageX, y: e.pageY };
  }, true);

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'getPageState':
        sendResponse({
          url: page.url || normalizeUrl(location.href),
          highlights: page.items.length,
          notes: page.items.filter((i) => i.note).length,
          orphans: page.items.filter((i) => i.orphan).length,
          stickies: page.stickies.length,
          layerVisible: settings.layerVisible
        });
        return false;
      case 'addSticky':
        addSticky(!!msg.atContextMenu);
        break;
      case 'highlightSelection':
        highlightCurrentSelection();
        break;
      case 'clearPage':
        page.items.forEach((i) => unwrapItem(i.id));
        page.items = [];
        page.stickies = [];
        renderStickies();
        hidePanel();
        savePage();
        break;
    }
    sendResponse({ ok: true });
    return false;
  });

  // 单页应用切换网址时，重新加载该网址的笔记
  let lastHref = normalizeUrl(location.href);
  setInterval(async () => {
    const now = normalizeUrl(location.href);
    if (now === lastHref) return;
    lastHref = now;
    hidePanel();
    document.querySelectorAll('wn-mark').forEach((m) => unwrapItem(m.dataset.id));
    await loadAll();
    rerenderAll();
  }, 1000);

  // ======================= 启动 =======================
  (async () => {
    await loadAll();
    ensureUI();
    anchorItems(page.items);
    renderStickies();
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
  })();
})();
