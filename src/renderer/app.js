/* ============ TELEMOSTushka renderer ============ */
const $ = (s) => document.querySelector(s);

// Манифест по умолчанию — вшит в сборку, чтобы у всех, кто скачал приложение,
// сразу работали общие комнаты и проверка обновлений без ручной настройки.
// Пользователь может переопределить свой ссылкой в ⚙ настройках.
const DEFAULT_MANIFEST = 'https://raw.githubusercontent.com/cornetto1488/vetroduy/main/vetroduy.json';

let cfg = { rooms: [], sharedUrl: '' };
let sharedRooms = [];      // комнаты из общего списка по ссылке
let activeId = null;       // 'home' | room id | null
const views = new Map();   // id -> <webview> (одновременно живёт максимум одна)
const counts = new Map();  // id -> число участников или null
const prevCounts = new Map();
let editingRoomId = null;  // null = создание новой
let audioCtx = null;

const HOME_URL = 'https://telemost.yandex.ru/';

/* ---------- webview-комнаты (один войс за раз, как в Discord) ---------- */
function ensureView(id, url) {
  if (views.has(id)) return views.get(id);
  const wv = document.createElement('webview');
  wv.setAttribute('allowpopups', '');
  wv.src = url;
  wv.dataset.ready = '';
  wv.addEventListener('dom-ready', () => {
    wv.dataset.ready = '1';
    applyReskin(wv);
    startJoinLoop(id, wv);
  });
  wv.addEventListener('did-navigate', () => applyReskin(wv));
  $('#views').appendChild(wv);
  views.set(id, wv);
  return wv;
}

function findRoom(id) {
  if (id === 'home') return { id: 'home', name: 'Телемост', url: HOME_URL };
  return cfg.rooms.find((r) => r.id === id) || sharedRooms.find((r) => r.id === id) || null;
}

function activate(id) {
  const room = findRoom(id);
  if (!room) return;
  activeId = id;

  // переход в другой канал = отключение от предыдущего
  for (const key of [...views.keys()]) {
    if (key !== id) destroyView(key);
  }

  $('#welcome').classList.add('hidden');
  ensureView(id, room.url);
  views.forEach((wv, key) => wv.classList.toggle('active', key === id));
  renderRooms();
}

function destroyView(id) {
  const wv = views.get(id);
  if (wv) { wv.remove(); views.delete(id); }
  counts.delete(id);
  prevCounts.delete(id);
}

/* ---------- счётчик участников ----------
   Публичного API у Телемоста нет — читаем число с кнопки «Участники N»
   (в новом интерфейсе текст слеплен: «Участники1»). Берём только строки,
   НАЧИНАЮЩИЕСЯ со слова «Участники», поэтому маркетинговое
   «до 40 участников» с главной страницы не ловится. */
const COUNT_SCRIPT = `(() => {
  try {
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const sources = [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent];
      for (const s of sources) {
        if (!s) continue;
        const m = s.trim().match(/^(?:участники|participants)\\D{0,3}(\\d+)/i);
        if (m) return parseInt(m[1], 10);
      }
    }
    return null;
  } catch { return null; }
})()`;

/* клик по кнопке микрофона внутри Телемоста (для Ctrl+Shift+M);
   предпочитаем большую кнопку нижней панели (size_lg) */
const MUTE_SCRIPT = `(() => {
  try {
    const cands = [...document.querySelectorAll('button, [role="button"]')].filter((el) => {
      const s = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
      return /микрофон|microphone/i.test(s);
    });
    if (!cands.length) return false;
    const lg = cands.find((el) => /size_lg/.test(String(el.className)));
    (lg || cands[0]).click();
    return true;
  } catch { return false; }
})()`;

/* ---------- автовход: прокликиваем все экраны Телемоста ----------
   «Продолжить в браузере» → имя из настроек → «Подключиться».
   Без сохранённого имени кликаем только «Продолжить в браузере». */
function autoJoinScript(name) {
  return `(() => {
    try {
      const btns = [...document.querySelectorAll('button, [role="button"]')];
      const byText = (rx) => btns.find((b) => rx.test(b.textContent || ''));
      const byLabel = (rx) => btns.find((b) => rx.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')));
      if (byLabel(/выйти из встречи/i)) return 'joined';
      const cont = byText(/продолжить в браузере/i);
      if (cont) { cont.click(); return 'continue'; }
      const want = ${JSON.stringify(name)};
      if (!want) return 'wait';
      const join = byText(/подключиться/i);
      if (!join) return 'wait';
      const input = document.querySelector('input[class*="Textinput"]');
      if (input && input.value !== want) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, want);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      join.click();
      return 'joining';
    } catch { return 'err'; }
  })()`;
}

/* ---------- рескин Телемоста под стиль приложения ---------- */
const RESKIN_CSS = `
  [class*="GlobalBar"], [class*="Logo360"], [class*="ServiceWrap"],
  [class*="PSHeader"], [class*="promozavr"], [class*="buttonInstallApp"],
  [class*="footerButton"], [class*="AccordionItem"], a[href*="360.yandex"],
  [class*="Tariff"], [class*="tariff"] { display: none !important; }
  [class*="globalBarLayout"] { padding-left: 0 !important; margin-left: 0 !important; }
  html, #root { background: transparent !important; }
  body {
    background: radial-gradient(1100px 700px at 75% -10%, #1c2050 0%, #0d1024 60%) fixed !important;
  }
  .Orb-Button_view_brand {
    background: linear-gradient(135deg, #7c8cff, #b17cff) !important;
    border-color: transparent !important;
  }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18); border-radius: 4px; }
`;

function applyReskin(wv) {
  try { wv.insertCSS(RESKIN_CSS); } catch {}
}

function startJoinLoop(id, wv) {
  if (wv.dataset.joining) return;
  wv.dataset.joining = '1';
  let tries = 0;
  const t = setInterval(async () => {
    if (!views.has(id) || views.get(id) !== wv) { clearInterval(t); return; }
    if (++tries > 60) { clearInterval(t); return; }
    try {
      const st = await wv.executeJavaScript(autoJoinScript(cfg.userName || ''), false);
      if (st === 'joined') clearInterval(t);
    } catch {}
  }, 1500);
}

/* кто сейчас говорит: Телемост вешает класс rootStroke (зелёная обводка)
   на плитку говорящего участника */
const SPEAKER_SCRIPT = `(() => {
  try {
    const names = new Set();
    const sel = '[class*="rootStroke"], [class*="peaking"], [class*="talking"]';
    for (const el of document.querySelectorAll(sel)) {
      const nameEl = el.querySelector('[class*="TextName"], [class*="Name_"]');
      const t = (nameEl ? nameEl.textContent : '').trim();
      if (t && t.length < 40) names.add(t.slice(0, 24));
    }
    return [...names].slice(0, 3);
  } catch { return []; }
})()`;

let speakingNames = [];
let speakingHold = 0;

function updateSpeaking() {
  document.querySelectorAll('#room-list .room').forEach((btn) => {
    const nameEl = btn.querySelector('.room-name');
    let line = nameEl.querySelector('.speaking-line');
    if (btn.dataset.id !== activeId || !speakingNames.length) {
      if (line) line.remove();
      return;
    }
    if (!line) {
      line = document.createElement('span');
      line.className = 'speaking-line';
      nameEl.appendChild(line);
    }
    line.textContent = '🔊 ' + speakingNames.join(', ');
  });
}

async function pollCounts() {
  for (const [id, wv] of views) {
    if (!wv.dataset.ready) continue;
    try {
      const n = await wv.executeJavaScript(COUNT_SCRIPT, false);
      const val = Number.isInteger(n) ? n : null;
      const prev = counts.get(id);
      counts.set(id, val);

      // уведомление: в комнате стало больше людей
      if (Number.isInteger(prev) && Number.isInteger(val) && val > prev) {
        onSomeoneJoined(id, val);
      }

      if (id === activeId) {
        const sp = await wv.executeJavaScript(SPEAKER_SCRIPT, false);
        // обводка говорящего пульсирует — держим имя ещё пару опросов
        if (Array.isArray(sp) && sp.length) {
          speakingNames = sp;
          speakingHold = 2;
        } else if (--speakingHold <= 0) {
          speakingNames = [];
        }
      }
    } catch {
      counts.set(id, null);
    }
  }
  updateBadges();
  updateSpeaking();
}
setInterval(pollCounts, 2500);

function onSomeoneJoined(id, n) {
  const room = findRoom(id);
  const name = room ? room.name : 'комнате';
  playPop();
  if (!document.hasFocus()) {
    try {
      new Notification('ВЕТРОДУЙ', { body: `В «${name}» кто-то зашёл — теперь ${n} 👤`, silent: true });
    } catch {}
  }
}

function playPop() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(540, t);
    o.frequency.exponentialRampToValueAtTime(820, t + 0.12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.45);
  } catch {}
}

function badgeFor(id) {
  const n = counts.get(id);
  if (Number.isInteger(n)) return { text: '👤 ' + n, live: true };
  if (views.has(id)) return { text: '', live: true };
  return null;
}

function updateBadges() {
  document.querySelectorAll('#room-list .room').forEach((btn) => {
    const id = btn.dataset.id;
    const holder = btn.querySelector('.room-status');
    if (!holder) return;
    const b = badgeFor(id);
    if (!b) { holder.innerHTML = ''; return; }
    if (b.text) {
      holder.innerHTML = '<span class="count-badge">' + b.text + '</span>';
    } else {
      holder.innerHTML = '<span class="live-dot" title="Подключено"></span>';
    }
  });
}

/* ---------- список комнат ---------- */
function makeRoomButton(room, shared) {
  const btn = document.createElement('button');
  btn.className = 'room' + (room.id === activeId ? ' active' : '');
  btn.dataset.id = room.id;

  const ico = document.createElement('span');
  ico.className = 'room-ico';
  ico.textContent = shared ? '☁' : '#';

  const name = document.createElement('span');
  name.className = 'room-name';
  name.textContent = room.name;

  const status = document.createElement('span');
  status.className = 'room-status';

  btn.append(ico, name, status);

  const actions = document.createElement('span');
  actions.className = 'room-actions';
  actions.innerHTML = shared
    ? '<button class="ra-btn" data-act="copy" title="Копировать ссылку">⧉</button>'
    : '<button class="ra-btn" data-act="copy" title="Копировать ссылку">⧉</button>' +
      '<button class="ra-btn" data-act="edit" title="Изменить">✎</button>' +
      '<button class="ra-btn del" data-act="del" title="Удалить">✕</button>';
  btn.appendChild(actions);

  btn.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'copy') { navigator.clipboard.writeText(room.url); return; }
    if (act === 'edit') { openRoomModal(room); return; }
    if (act === 'del') { deleteRoom(room.id); return; }
    activate(room.id);
  });

  return btn;
}

function renderRooms() {
  const list = $('#room-list');
  list.querySelectorAll('.room:not(.home-room), .sb-sub').forEach((el) => el.remove());
  const home = list.querySelector('.home-room');
  home.classList.toggle('active', activeId === 'home');

  for (const room of cfg.rooms) list.appendChild(makeRoomButton(room, false));

  if (sharedRooms.length) {
    const sub = document.createElement('div');
    sub.className = 'sb-sub';
    sub.textContent = 'Общие';
    list.appendChild(sub);
    for (const room of sharedRooms) list.appendChild(makeRoomButton(room, true));
  }

  updateBadges();
  pushTrayRooms();
}

function pushTrayRooms() {
  const all = [
    { id: 'home', name: '⌂ Телемост', active: activeId === 'home' },
    ...cfg.rooms.map((r) => ({ id: r.id, name: '# ' + r.name, active: r.id === activeId })),
    ...sharedRooms.map((r) => ({ id: r.id, name: '☁ ' + r.name, active: r.id === activeId }))
  ];
  window.api.updateTrayRooms(all);
}

async function saveRooms() {
  cfg = await window.api.setConfig({ rooms: cfg.rooms });
}

function deleteRoom(id) {
  cfg.rooms = cfg.rooms.filter((r) => r.id !== id);
  destroyView(id);
  if (botRoomId === id) stopBot(false);
  if (activeId === id) {
    activeId = null;
    $('#welcome').classList.remove('hidden');
  }
  saveRooms();
  renderRooms();
}

/* ---------- общий список комнат по ссылке ---------- */
function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'sh_' + (h >>> 0).toString(36);
}

let updateInfo = null;

function isNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function checkUpdate(manifest) {
  try {
    if (!manifest.version) return;
    const current = await window.api.appVersion();
    if (!isNewer(manifest.version, current)) return;
    const dl = manifest.download || {};
    const isWin = navigator.platform.toLowerCase().includes('win');
    const url = (isWin ? (dl.windows || dl.win) : (dl.linux)) || dl.windows || dl.win || '';
    updateInfo = { version: manifest.version, url, page: manifest.page || '' };
    const btn = $('#update-btn');
    btn.textContent = '⬇ Скачать обновление ' + manifest.version;
    btn.classList.remove('hidden');
  } catch {}
}

async function refreshShared() {
  const manifestUrl = cfg.sharedUrl || DEFAULT_MANIFEST;
  const res = await window.api.fetchShared(manifestUrl);
  if (!res.ok) return; // тихо оставляем старый список
  let list = [];
  if (Array.isArray(res.data)) {
    list = res.data;
  } else if (res.data && typeof res.data === 'object') {
    list = Array.isArray(res.data.rooms) ? res.data.rooms : [];
    checkUpdate(res.data);
  }
  const fresh = [];
  for (const item of list) {
    const url = normalizeTelemostUrl(item && item.url);
    const name = item && typeof item.name === 'string' ? item.name.trim().slice(0, 40) : '';
    if (url && name) fresh.push({ id: hashId(url + name), name, url });
  }
  const changed = JSON.stringify(fresh) !== JSON.stringify(sharedRooms);
  sharedRooms = fresh;
  if (changed) renderRooms();
}
setInterval(refreshShared, 60000);

/* ---------- музыкальный бот ----------
   Скрытый webview с отдельной сессией заходит в комнату как участник
   «🎵 Музыка»; его «микрофон» — это аудиопоток (см. bot-inject.js). */
let botView = null;
let botRoomId = null;
let botJoined = false;
let botTimer = null;
let pendingTrack = null;
let botVolume = 0.5;
let musicProxyPort = 0;

const BOT_NAME = '🎵 Музыка';

// исходник патча микрофона (bot-inject.js) — инжектируем в мир страницы
const PATCH_SRC = window.api.botPatchSource();

const BOT_STEP_SCRIPT = `(() => {
  try {
    if (!window.__bot) return 'nopatch'; // без патча не лезем дальше — иначе в канал уйдёт настоящий микрофон
    const btns = [...document.querySelectorAll('button, [role="button"]')];
    const byText = (rx) => btns.find((b) => rx.test(b.textContent || ''));
    const byLabel = (rx) => btns.find((b) => rx.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')));
    if (byLabel(/выйти из встречи/i)) return 'joined';
    const cont = byText(/продолжить в браузере/i);
    if (cont) { cont.click(); return 'continue'; }
    const join = byText(/подключиться/i);
    if (!join) return 'wait';
    const camOff = byLabel(/выключить камеру/i);
    if (camOff) camOff.click();
    const micOn = byLabel(/^\\s*включить микрофон/i);
    if (micOn) micOn.click();
    const input = document.querySelector('input[class*="Textinput"]');
    if (input && input.value !== ${JSON.stringify(BOT_NAME)}) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(BOT_NAME)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    join.click();
    return 'joining';
  } catch { return 'err'; }
})()`;

function setMusicState(text, on) {
  const el = $('#music-state');
  el.textContent = text;
  el.classList.toggle('on', !!on);
}

function startBot(roomId) {
  const room = findRoom(roomId);
  if (!room) return;
  stopBot(true);
  botRoomId = roomId;
  botJoined = false;
  botView = document.createElement('webview');
  botView.className = 'bot-view';
  // preload и webPreferences боту настраивает main-процесс (will-attach-webview)
  botView.setAttribute('partition', 'persist:musicbot');
  botView.src = room.url;
  botView.dataset.ready = '';
  botView.addEventListener('dom-ready', () => {
    botView.dataset.ready = '1';
    // глушим локальный выход бота: иначе он проигрывает весь канал
    // (включая твой же голос) второй раз — получается эхо
    try { botView.setAudioMuted(true); } catch {}
  });
  $('#views').appendChild(botView);
  botTimer = setInterval(botStep, 1600);
  setMusicState('бот заходит в канал…', false);
}

async function botStep() {
  if (!botView || !botView.dataset.ready) return;
  try {
    // сначала ставим патч микрофона (идемпотентен), потом кликаем
    await botView.executeJavaScript(PATCH_SRC, false);
    const st = await botView.executeJavaScript(BOT_STEP_SCRIPT, false);
    if (st === 'joined' && !botJoined) {
      botJoined = true;
      clearInterval(botTimer);
      botTimer = null;
      try { await botView.executeJavaScript(`window.__bot && window.__bot.volume(${botVolume})`, false); } catch {}
      if (pendingTrack) playPending();
      else setMusicState('бот в канале', true);
    }
  } catch {}
}

async function playPending() {
  if (!botView || !botJoined || !pendingTrack) return;
  let r = 'nobot';
  try {
    r = await botView.executeJavaScript(`window.__bot ? window.__bot.play(${JSON.stringify(pendingTrack.url)}) : 'nobot'`, false);
  } catch {}
  if (String(r).startsWith('playing')) {
    isPaused = false;
    $('#music-pause').textContent = '⏸';
    setMusicState('▶ ' + pendingTrack.name, true);
    $('#music-controls').classList.remove('hidden');
  } else {
    setMusicState('пропускаю: ' + pendingTrack.name, false);
    setTimeout(playNext, 1500);
  }
}

function stopBot(silent) {
  if (botTimer) { clearInterval(botTimer); botTimer = null; }
  if (botView) { botView.remove(); botView = null; }
  botJoined = false;
  botRoomId = null;
  if (!silent) {
    pendingTrack = null;
    queue = [];
    isPaused = false;
    renderQueue();
    setMusicState('выключен', false);
    $('#music-controls').classList.add('hidden');
  }
}

/* ---------- очередь треков ---------- */
let queue = [];
let isPaused = false;
let loadingTrack = false;

function renderQueue() {
  const box = $('#music-queue');
  box.innerHTML = '';
  if (!queue.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  queue.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'mq-item';
    const label = document.createElement('span');
    label.textContent = (i + 1) + '. ' + item.name;
    const del = document.createElement('button');
    del.className = 'mq-del';
    del.textContent = '✕';
    del.title = 'Убрать из очереди';
    del.addEventListener('click', () => { queue.splice(i, 1); renderQueue(); });
    row.append(label, del);
    box.appendChild(row);
  });
}

function enqueue(item) {
  if (!activeId) { setMusicState('сначала зайди в комнату', false); return; }
  const busy = !!pendingTrack || loadingTrack;
  queue.push(item);
  renderQueue();
  if (!busy) playNext();
  else setMusicState('в очередь: ' + item.name, true);
}

async function playNext() {
  if (!queue.length) {
    pendingTrack = null;
    isPaused = false;
    loadingTrack = false;
    if (botView && botJoined) {
      try { await botView.executeJavaScript('window.__bot && window.__bot.stop()', false); } catch {}
    }
    setMusicState(botJoined ? 'очередь пуста' : 'выключен', false);
    renderQueue();
    return;
  }
  const item = queue.shift();
  renderQueue();
  loadingTrack = true;
  setMusicState('загружаю: ' + item.name, false);

  let url = item.url;
  if (item.kind === 'yt') {
    const r = await window.api.ytUrl(item.id);
    if (!r.ok) {
      loadingTrack = false;
      setMusicState('не удалось: ' + item.name, false);
      setTimeout(playNext, 1200);
      return;
    }
    url = r.url;
  }

  if (!musicProxyPort) musicProxyPort = await window.api.musicProxyPort();
  pendingTrack = {
    name: item.name,
    url: `http://127.0.0.1:${musicProxyPort}/stream?url=${encodeURIComponent(url)}`
  };
  loadingTrack = false;
  if (!botView || botRoomId !== activeId) startBot(activeId);
  if (botJoined) playPending();
  else setMusicState('бот заходит в канал…', false);
}

// автопереход к следующему треку, когда текущий закончился
setInterval(async () => {
  if (!botView || !botJoined || !pendingTrack || isPaused) return;
  try {
    const st = await botView.executeJavaScript('window.__bot ? window.__bot.state() : null', false);
    if (st && st.ended) playNext();
  } catch {}
}, 2500);

async function musicGo() {
  const q = $('#music-input').value.trim();
  if (!q) return;
  if (!activeId) { setMusicState('сначала зайди в комнату', false); return; }
  const box = $('#music-results');
  box.innerHTML = '';
  box.classList.add('hidden');

  if (/^https?:\/\//i.test(q)) {
    enqueue({ kind: 'url', name: 'свой поток', url: q });
    return;
  }

  setMusicState('ищу…', false);
  const [yt, radio] = await Promise.all([window.api.ytSearch(q), window.api.musicSearch(q)]);

  const addSection = (label) => {
    const s = document.createElement('div');
    s.className = 'mr-section';
    s.textContent = label;
    box.appendChild(s);
  };
  const addItem = (text, small, item) => {
    const b = document.createElement('button');
    b.className = 'mr-item';
    b.textContent = text + ' ';
    if (small) {
      const sm = document.createElement('small');
      sm.textContent = small;
      b.appendChild(sm);
    }
    b.addEventListener('click', () => enqueue(item));
    box.appendChild(b);
  };

  let any = false;
  if (yt.ok && yt.items && yt.items.length) {
    any = true;
    addSection('Треки');
    for (const t of yt.items) {
      addItem(t.title, (t.channel ? t.channel + ' · ' : '') + t.dur, { kind: 'yt', id: t.id, name: t.title });
    }
  }
  if (radio.ok && radio.items && radio.items.length) {
    any = true;
    addSection('Радио');
    for (const st of radio.items) {
      addItem(st.name, (st.country || '') + (st.bitrate ? ' · ' + st.bitrate + ' kbps' : ''), { kind: 'radio', name: st.name, url: st.url });
    }
  }
  if (!any) { setMusicState('ничего не нашёл', false); return; }
  box.classList.remove('hidden');
  setMusicState('клик — в очередь', false);
}

/* ---------- модалка комнаты ---------- */
function normalizeTelemostUrl(raw) {
  let u = (typeof raw === 'string' ? raw : '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    if (!/(^|\.)telemost\.yandex\.(ru|com)$/.test(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function openRoomModal(room) {
  editingRoomId = room ? room.id : null;
  $('#modal-room-title').textContent = room ? 'Изменить комнату' : 'Новая комната';
  $('#room-name-input').value = room ? room.name : '';
  $('#room-url-input').value = room ? room.url : '';
  $('#room-error').classList.add('hidden');
  $('#modal-room').classList.remove('hidden');
  $('#room-name-input').focus();
}

function saveRoomFromModal() {
  const name = $('#room-name-input').value.trim();
  const url = normalizeTelemostUrl($('#room-url-input').value);
  const err = $('#room-error');

  if (!name) { err.textContent = 'Дай комнате название.'; err.classList.remove('hidden'); return; }
  if (!url) {
    err.textContent = 'Нужна ссылка вида https://telemost.yandex.ru/j/…';
    err.classList.remove('hidden');
    return;
  }

  if (editingRoomId) {
    const room = cfg.rooms.find((r) => r.id === editingRoomId);
    if (room) {
      const urlChanged = room.url !== url;
      room.name = name;
      room.url = url;
      if (urlChanged) destroyView(room.id);
    }
  } else {
    const room = { id: crypto.randomUUID(), name, url };
    cfg.rooms.push(room);
    activate(room.id);
  }

  saveRooms();
  renderRooms();
  $('#modal-room').classList.add('hidden');
}

/* ---------- инициализация ---------- */
async function init() {
  cfg = await window.api.getConfig();
  if (!Array.isArray(cfg.rooms)) cfg.rooms = [];
  if (typeof cfg.sharedUrl !== 'string') cfg.sharedUrl = '';
  renderRooms();
  refreshShared();

  // окно
  $('#btn-min').addEventListener('click', () => window.api.win.minimize());
  $('#btn-max').addEventListener('click', () => window.api.win.maximize());
  $('#btn-close').addEventListener('click', () => window.api.win.close());
  $('#btn-mini').addEventListener('click', () => window.api.win.miniToggle());
  window.api.win.onMaximized((max) => {
    $('#btn-max').innerHTML = max ? '&#x2750;' : '&#x25A1;';
  });
  window.api.win.onMini((mini) => {
    document.body.classList.toggle('mini', mini);
    $('#btn-mini').title = mini ? 'Обычный режим' : 'Мини-режим поверх окон';
  });

  // трей и глобальный хоткей
  window.api.onRoomActivate((id) => activate(id));
  window.api.onMuteHotkey(async () => {
    const wv = activeId ? views.get(activeId) : null;
    if (wv && wv.dataset.ready) {
      try { await wv.executeJavaScript(MUTE_SCRIPT, false); } catch {}
    }
  });

  // комнаты
  $('#room-list').querySelector('.home-room').addEventListener('click', () => activate('home'));
  $('#btn-add-room').addEventListener('click', () => openRoomModal(null));
  $('#btn-room-save').addEventListener('click', saveRoomFromModal);
  $('#btn-room-cancel').addEventListener('click', () => $('#modal-room').classList.add('hidden'));
  $('#btn-paste').addEventListener('click', () => {
    $('#room-url-input').value = window.api.readClipboard();
  });
  $('#room-url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveRoomFromModal(); });
  $('#room-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#room-url-input').focus(); });

  // обновления — 1 кнопка: скачать установщик и запустить
  let updating = false;
  window.api.onUpdateProgress((pct) => {
    if (updating) $('#update-btn').textContent = '⬇ Скачиваю… ' + pct + '%';
  });
  $('#update-btn').addEventListener('click', async () => {
    if (!updateInfo) return;
    if (!updateInfo.url) { // нет прямой ссылки под эту ОС — открываем страницу релизов
      window.api.openExternal(updateInfo.page || cfg.sharedUrl || DEFAULT_MANIFEST);
      return;
    }
    if (updating) return;
    updating = true;
    $('#update-btn').textContent = '⬇ Скачиваю… 0%';
    const res = await window.api.downloadUpdate(updateInfo.url);
    if (!res.ok) {
      updating = false;
      $('#update-btn').textContent = '⚠ Ошибка, открыть в браузере';
      $('#update-btn').onclick = () => window.api.openExternal(updateInfo.url);
    } else {
      $('#update-btn').textContent = '✓ Устанавливаю…';
    }
  });

  // настройки (имя + общий список)
  $('#btn-settings').addEventListener('click', () => {
    $('#user-name-input').value = cfg.userName || '';
    $('#shared-url-input').value = cfg.sharedUrl || '';
    $('#modal-settings').classList.remove('hidden');
  });
  $('#btn-settings-cancel').addEventListener('click', () => $('#modal-settings').classList.add('hidden'));
  $('#btn-settings-save').addEventListener('click', async () => {
    cfg = await window.api.setConfig({
      userName: $('#user-name-input').value.trim(),
      sharedUrl: $('#shared-url-input').value.trim()
    });
    $('#modal-settings').classList.add('hidden');
    sharedRooms = [];
    refreshShared();
  });

  // музыкальный бот
  $('#music-play').addEventListener('click', musicGo);
  $('#music-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') musicGo(); });
  $('#music-pause').addEventListener('click', async () => {
    if (!botView || !botJoined || !pendingTrack) return;
    try {
      if (isPaused) {
        const r = await botView.executeJavaScript('window.__bot ? window.__bot.resume() : "nobot"', false);
        if (String(r).startsWith('playing')) {
          isPaused = false;
          $('#music-pause').textContent = '⏸';
          setMusicState('▶ ' + pendingTrack.name, true);
        } else {
          // живой поток мог протухнуть за время паузы — переоткрываем
          playPending();
        }
      } else {
        await botView.executeJavaScript('window.__bot && window.__bot.pause()', false);
        isPaused = true;
        $('#music-pause').textContent = '▶';
        setMusicState('⏸ пауза: ' + pendingTrack.name, false);
      }
    } catch {}
  });
  $('#music-next').addEventListener('click', () => playNext());
  $('#music-stop').addEventListener('click', () => stopBot(false));
  $('#music-volume').addEventListener('input', async (e) => {
    botVolume = e.target.value / 100;
    if (botView && botJoined) {
      try { await botView.executeJavaScript(`window.__bot && window.__bot.volume(${botVolume})`, false); } catch {}
    }
  });

  // закрытие модалок по клику на фон / Escape
  document.querySelectorAll('.modal-back').forEach((back) => {
    back.addEventListener('mousedown', (e) => { if (e.target === back) back.classList.add('hidden'); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-back').forEach((b) => b.classList.add('hidden'));
  });
}

init();
