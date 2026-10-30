// ReadMark 后台：翻译请求（避免网页 CORS 限制）、右键菜单、快捷键
const api = globalThis.browser ?? globalThis.chrome;

const DEFAULT_SETTINGS = {
  provider: 'microsoft',   // microsoft | google | mymemory
  targetLang: 'zh-CN',
  autoTranslate: true,
  showPhonetic: true,
  layerVisible: true,
  defaultColor: 'yellow',
  dblclickNote: true
};

async function getSettings() {
  const { settings } = await api.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  } finally {
    clearTimeout(t);
  }
}

const isSingleWord = (s) => /^[A-Za-z][A-Za-z'’-]{0,40}$/.test(s);

// ---------- Microsoft（Edge 浏览器内置翻译使用的免费接口，国内可直连） ----------
let msToken = null;
let msTokenExp = 0;
// 后台脚本闲置一会儿就会被浏览器休眠，内存里的令牌会丢；存到 storage 里，避免每次都多一次请求
const tokenStore = api.storage.session || api.storage.local;
async function msAuth() {
  if (msToken && Date.now() < msTokenExp) return msToken;
  try {
    const { msAuth: saved } = await tokenStore.get('msAuth');
    if (saved?.token && Date.now() < saved.exp) {
      msToken = saved.token;
      msTokenExp = saved.exp;
      return msToken;
    }
  } catch (_) {}
  const r = await fetchWithTimeout('https://edge.microsoft.com/translate/auth', {}, 5000);
  msToken = await r.text();
  msTokenExp = Date.now() + 8 * 60 * 1000;
  try { await tokenStore.set({ msAuth: { token: msToken, exp: msTokenExp } }); } catch (_) {}
  return msToken;
}
const MS_LANG = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' };
async function microsoft(text, to) {
  const token = await msAuth();
  const tl = MS_LANG[to] || to;
  const base = 'https://api-edge.cognitive.microsofttranslator.com';
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  const body = JSON.stringify([{ Text: text }]);
  // 单词：翻译和词典查询同时发出，不再一个接一个
  const dictP = isSingleWord(text)
    ? fetchWithTimeout(`${base}/dictionary/lookup?api-version=3.0&from=en&to=${tl}`, { method: 'POST', headers, body }, 4000)
      .then((r2) => r2.json())
      .then((j2) => {
        const groups = {};
        for (const t of j2[0]?.translations || []) (groups[t.posTag] ||= []).push(t.displayTarget);
        return Object.entries(groups).map(([pos, terms]) => ({ pos: pos.toLowerCase(), terms: terms.slice(0, 8) }));
      })
      .catch(() => [])
    : Promise.resolve([]);
  const r = await fetchWithTimeout(`${base}/translate?api-version=3.0&to=${tl}`, { method: 'POST', headers, body });
  const j = await r.json();
  return {
    provider: 'Microsoft',
    text: j[0].translations[0].text,
    detected: j[0].detectedLanguage?.language,
    dict: await dictP
  };
}

// ---------- Google（免 key 接口，国内可能需要代理） ----------
async function google(text, to) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&dt=bd&dj=1'
    + `&tl=${encodeURIComponent(to)}&q=${encodeURIComponent(text)}`;
  const j = await (await fetchWithTimeout(url)).json();
  return {
    provider: 'Google',
    text: (j.sentences || []).map((s) => s.trans || '').join(''),
    detected: j.src,
    dict: (j.dict || []).map((d) => ({ pos: d.pos, terms: (d.terms || []).slice(0, 6) }))
  };
}

// ---------- MyMemory（免费，每天有额度限制） ----------
async function mymemory(text, to) {
  const from = /[一-鿿]/.test(text) ? 'zh-CN' : 'en';
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}`
    + `&langpair=${from}|${encodeURIComponent(to)}`;
  const j = await (await fetchWithTimeout(url)).json();
  if (j.responseStatus && j.responseStatus !== 200) throw new Error(j.responseDetails || 'MyMemory error');
  return { provider: 'MyMemory', text: j.responseData.translatedText, dict: [] };
}

const PROVIDERS = { microsoft, google, mymemory };

// 有道词典简明释义（免 key、国内可直连），在翻译源没有给出词典释义时补上多个词义
async function youdaoDict(word) {
  try {
    const url = `https://dict.youdao.com/suggest?num=1&doctype=json&q=${encodeURIComponent(word)}`;
    const j = await (await fetchWithTimeout(url, {}, 3000)).json();
    const entry = j?.data?.entries?.[0];
    if (!entry || entry.entry.toLowerCase() !== word.toLowerCase() || !entry.explain) return [];
    const groups = [];
    const re = /([a-z]+\.)\s*([^]*?)(?=\s+[a-z]+\.\s|$)/g;
    let m;
    while ((m = re.exec(entry.explain))) {
      const terms = m[2].split(/[;；,，]\s*/).map((x) => x.trim()).filter(Boolean);
      if (terms.length) groups.push({ pos: m[1].replace('.', ''), terms: terms.slice(0, 6) });
    }
    if (!groups.length) groups.push({ pos: '', terms: entry.explain.split(/[;；]\s*/).filter(Boolean).slice(0, 6) });
    return groups;
  } catch (_) {
    return [];
  }
}

// 英文单词音标 + 发音（Free Dictionary API）
async function phonetic(word) {
  try {
    const j = await (await fetchWithTimeout(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`, {}, 5000)).json();
    const e = j[0] || {};
    const p = (e.phonetics || []).find((x) => x.text && x.audio) || (e.phonetics || []).find((x) => x.text) || {};
    return { phonetic: e.phonetic || p.text || '', audio: p.audio || '' };
  } catch (_) {
    return null;
  }
}

const cache = new Map();

// 依次尝试翻译源：先用选定的，失败时自动换下一个
async function runProviders(text, s) {
  const order = [s.provider, ...Object.keys(PROVIDERS).filter((p) => p !== s.provider)];
  const errors = [];
  for (const name of order) {
    try {
      const res = await PROVIDERS[name](text, s.targetLang);
      if (!res.text) throw new Error('empty result');
      return res;
    } catch (e) {
      errors.push(`${name}: ${e.message || e}`);
    }
  }
  throw new Error('所有翻译源都失败了 · ' + errors.join(' | '));
}

const fromYoudao = (dict) => ({ provider: '有道词典', text: dict[0].terms[0], dict });

// 单词：有道词典（全部词义）和翻译源同时查，谁先拿到完整词义就先用谁
async function translateWord(text, s) {
  const ydP = s.targetLang.startsWith('zh') ? youdaoDict(text) : Promise.resolve([]);
  const prP = runProviders(text, s);
  prP.catch(() => {});
  const first = await Promise.race([ydP, prP.then(() => null, () => null)]);
  if (first?.length) return fromYoudao(first);
  let res;
  try {
    res = await prP;
  } catch (e) {
    const d = await ydP;
    if (d.length) return fromYoudao(d);
    throw e;
  }
  if (!res.dict?.length) {
    const d = await ydP;
    if (d.length) res = { ...res, dict: d };
  }
  return res;
}

async function translate(text) {
  const s = await getSettings();
  const key = `${s.provider}|${s.targetLang}|${text}`;
  if (cache.has(key)) return cache.get(key);
  const res = isSingleWord(text) ? await translateWord(text, s) : await runProviders(text, s);
  if (cache.size > 500) cache.clear();
  cache.set(key, res);
  return res;
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'translate') {
    translate(msg.text)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  // 音标单独查询，不拖慢翻译结果的显示
  if (msg?.type === 'phonetic') {
    phonetic(msg.text).then((r) => sendResponse(r)).catch(() => sendResponse(null));
    return true;
  }
  if (msg?.type === 'openOptions') {
    api.runtime.openOptionsPage();
  }
  return false;
});

// ---------- 右键菜单 & 快捷键 ----------
async function toggleLayer() {
  const s = await getSettings();
  s.layerVisible = !s.layerVisible;
  await api.storage.local.set({ settings: s });
}

function sendToTab(tabId, msg) {
  if (tabId == null) return;
  try {
    const p = api.tabs.sendMessage(tabId, msg);
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}
}

// Safari 的 browser.* 只支持 Promise 写法，所以这里不用回调
async function setupMenus() {
  try {
    await api.contextMenus.removeAll();
    api.contextMenus.create({ id: 'rm-sticky', title: '在这里添加便签', contexts: ['page', 'selection', 'image', 'link'] });
    api.contextMenus.create({ id: 'rm-highlight', title: '高亮选中文字', contexts: ['selection'] });
    api.contextMenus.create({ id: 'rm-toggle', title: '显示 / 隐藏笔记层', contexts: ['page', 'selection'] });
  } catch (_) { /* 菜单不可用时忽略 */ }
}
api.runtime.onInstalled.addListener(setupMenus);
api.runtime.onStartup?.addListener(setupMenus);

api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'rm-toggle') toggleLayer();
  if (info.menuItemId === 'rm-sticky') sendToTab(tab?.id, { type: 'addSticky', atContextMenu: true });
  if (info.menuItemId === 'rm-highlight') sendToTab(tab?.id, { type: 'highlightSelection' });
});

api.commands?.onCommand.addListener(async (command) => {
  if (command === 'toggle-layer') return toggleLayer();
  if (command === 'add-sticky') {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    sendToTab(tab?.id, { type: 'addSticky' });
  }
});
