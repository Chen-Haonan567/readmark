const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

if (!/Mac/.test(navigator.platform)) {
  $('k1').textContent = 'Alt+Shift+H';
  $('k2').textContent = 'Alt+Shift+N';
}

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(msg) {
  const tab = await activeTab();
  return api.tabs.sendMessage(tab.id, msg);
}

function showLayer(on) {
  $('layer').checked = on;
  $('layerSub').textContent = on ? '高亮、旁注和便签正在显示' : '已隐藏，网页恢复原样';
}

async function refresh() {
  const { settings } = await api.storage.local.get('settings');
  showLayer(settings?.layerVisible !== false);
  try {
    const s = await send({ type: 'getPageState' });
    $('hl').textContent = s.highlights;
    $('notes').textContent = s.notes;
    $('stickies').textContent = s.stickies;
    $('orphans').hidden = !s.orphans;
    if (s.orphans) $('orphans').textContent = `有 ${s.orphans} 条高亮在页面里找不到原文（网页可能改版了），可在设置页查看。`;
  } catch (_) {
    $('unavailable').hidden = false;
    $('stats').hidden = true;
    $('addSticky').disabled = true;
    $('clear').disabled = true;
  }
}

$('layer').addEventListener('change', async (e) => {
  showLayer(e.target.checked);
  const { settings } = await api.storage.local.get('settings');
  await api.storage.local.set({ settings: { ...(settings || {}), layerVisible: e.target.checked } });
});
$('addSticky').addEventListener('click', async () => { await send({ type: 'addSticky' }); window.close(); });
$('options').addEventListener('click', () => { api.runtime.openOptionsPage(); window.close(); });

// Safari 的弹窗里不能用 confirm()，改成「再点一次确认」
let clearArmed = null;
$('clear').addEventListener('click', async () => {
  const btn = $('clear');
  if (!clearArmed) {
    btn.textContent = '确认清空？';
    btn.classList.add('confirm');
    clearArmed = setTimeout(() => {
      clearArmed = null;
      btn.textContent = '清空本页';
      btn.classList.remove('confirm');
    }, 3000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  btn.textContent = '清空本页';
  btn.classList.remove('confirm');
  await send({ type: 'clearPage' });
  refresh();
});

refresh();
