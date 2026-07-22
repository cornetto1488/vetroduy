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

// комната, в которой сейчас реально идёт звонок (единственный живой webview кроме home)
function callRoomId() {
  return [...views.keys()].find((k) => k !== 'home') || null;
}

function activate(id) {
  const room = findRoom(id);
  if (!room) return;
  activeId = id;

  if (id === 'home') {
    // «Телемост» — утилита (создать встречу, скопировать ссылку).
    // Звонок в текущей комнате НЕ рвём — он продолжается в фоне.
    ensureView('home', HOME_URL);
  } else {
    // это голосовая комната: один звонок за раз — рвём другие комнаты (но не home)
    for (const key of [...views.keys()]) {
      if (key !== id && key !== 'home') destroyView(key);
    }
    ensureView(id, room.url);
  }

  $('#welcome').classList.add('hidden');
  views.forEach((wv, key) => wv.classList.toggle('active', key === id));
  renderRooms();
  presenceHeartbeat(); // отметиться в комнате звонка
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
    if (btn.dataset.id !== callRoomId() || !speakingNames.length) {
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

      if (id === callRoomId()) {
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
  applyDucking();
}
setInterval(pollCounts, 2500);

/* ---------- дакинг: музыка тише, когда говорит человек ---------- */
let duckingEnabled = false;
let lastDuckVol = null;

async function applyDucking() {
  if (!botView || !botJoined || !pendingTrack || isPaused) { lastDuckVol = null; return; }
  const humanSpeaking = speakingNames.some((n) => n !== BOT_NAME);
  const target = (duckingEnabled && humanSpeaking) ? +(botVolume * 0.2).toFixed(3) : botVolume;
  if (lastDuckVol === target) return;
  lastDuckVol = target;
  try { await botView.executeJavaScript(`window.__bot && window.__bot.volume(${target})`, false); } catch {}
}

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
  // presence из бэкенда — «кто где сидит» для комнат, куда мы не заходили
  const room = findRoom(id);
  if (room) {
    const info = presenceInfo[urlKey(room.url)];
    if (info && info.count) return { text: '👥 ' + info.count, live: false, title: info.names.join(', ') };
  }
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
      const cls = b.live ? 'count-badge' : 'count-badge presence';
      holder.innerHTML = '<span class="' + cls + '"' + (b.title ? ' title="' + b.title.replace(/"/g, '') + '"' : '') + '>' + b.text + '</span>';
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

  const watched = Array.isArray(cfg.pings) && cfg.pings.includes(room.id);
  const bell = `<button class="ra-btn${watched ? ' on' : ''}" data-act="ping" title="Пинговать, когда кто-то зайдёт">${watched ? '🔔' : '🔕'}</button>`;

  const actions = document.createElement('span');
  actions.className = 'room-actions';
  actions.innerHTML = shared
    ? bell + '<button class="ra-btn" data-act="copy" title="Копировать ссылку">⧉</button>'
    : bell + '<button class="ra-btn" data-act="copy" title="Копировать ссылку">⧉</button>' +
      '<button class="ra-btn" data-act="edit" title="Изменить">✎</button>' +
      '<button class="ra-btn del" data-act="del" title="Удалить">✕</button>';
  btn.appendChild(actions);

  btn.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'ping') { togglePing(room.id); return; }
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
    // адрес общего бэкенда (Firebase RTDB) — для чата/presence/пингов
    const b = typeof res.data.backend === 'string' ? res.data.backend.trim() : '';
    if (b && b !== backendUrl) {
      backendUrl = b;
      $('#chat-btn').classList.remove('hidden');
      presenceHeartbeat();
      presenceRead();
    }
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

// ЛОКАЛЬНОЕ добавление в очередь (используется хостом и в режиме без бэкенда)
function enqueueLocal(item) {
  const busy = !!pendingTrack || loadingTrack;
  queue.push(item);
  renderQueue();
  if (!busy) playNext();
  else setMusicState('в очередь: ' + item.name, true);
  smPublish();
}

// Общий вход: решает, стать ли хостом, добавить в общую очередь или играть локально
async function enqueue(item) {
  const cr = callRoomId();
  if (!cr) { setMusicState('сначала зайди в комнату', false); return; }
  const key = smSessionKey();

  if (key && !smIsHost) {
    const hres = await db('GET', `music/${key}/host`);
    const host = hres.ok ? hres.data : null;
    if (hostFresh(host) && host.dev !== deviceId) {
      // бот уже есть у другого — добавляем в ОБЩУЮ очередь, своего не поднимаем
      await db('POST', `music/${key}/adds`, {
        id: item.id || '', kind: item.kind || '', name: item.name, url: item.url || '', by: myName, ts: Date.now()
      });
      setMusicState('добавлено (бот у ' + (host.name || 'друга') + ')', true);
      smEnsureFollow(key);
      return;
    }
    // бота нет — становимся хостом
    await smBecomeHost(key);
  }
  enqueueLocal(item);
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
  const cr = callRoomId();
  if (!botView || botRoomId !== cr) startBot(cr);
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

/* ============================================================
   ОБЩИЙ музыкальный бот: 1 бот на комнату, синхронное управление.
   Хост реально крутит бота (локальная логика выше), а Firebase —
   канал синхронизации: /host (claim), /adds (чужие треки),
   /ctrl (интенты управления), /view (что показывать остальным).
   ============================================================ */
let smKey = null;        // ключ комнаты общего сеанса
let smIsHost = false;    // мы ли ведём бота
let smHbTimer = null;    // heartbeat хоста
let smTimer = null;      // цикл синхронизации
let smLastSkip = 0;
let smLastStop = 0;
let smAppliedVol = null;

function smSessionKey() {
  const cr = callRoomId();
  if (!backendReady() || !cr) return null;
  const room = findRoom(cr);
  return room ? urlKey(room.url) : null;
}
function hostFresh(h) { return !!(h && h.ts && Date.now() - h.ts < 25000); }
function smFollower() { return !!(smKey && !smIsHost); }

async function smBecomeHost(key) {
  smKey = key;
  smIsHost = true;
  smLastSkip = 0; smLastStop = 0;
  await db('PUT', `music/${key}/host`, { dev: deviceId, name: myName, ts: Date.now() });
  if (smHbTimer) clearInterval(smHbTimer);
  smHbTimer = setInterval(() => {
    if (smIsHost && smKey) db('PUT', `music/${smKey}/host`, { dev: deviceId, name: myName, ts: Date.now() });
  }, 8000);
  smStartLoop();
}

function smEnsureFollow(key) {
  smKey = key;
  smIsHost = false;
  smStartLoop();
}

function smStartLoop() {
  if (smTimer) clearInterval(smTimer);
  smTimer = setInterval(smTick, 2500);
  smTick();
}

async function smTick() {
  const cur = smSessionKey();
  // сменили комнату звонка или вышли — снимаем сеанс
  if (!cur || cur !== smKey) {
    if (smIsHost && smKey) { // освобождаем claim, чтобы max-1 не блокировал
      try { await db('DELETE', `music/${smKey}/host`); await db('DELETE', `music/${smKey}/view`); } catch {}
    }
    smTeardown();
    return;
  }
  const res = await db('GET', `music/${smKey}`);
  const m = res.ok ? (res.data || {}) : {};
  if (smIsHost) await smHostTick(smKey, m);
  else smFollowTick(m);
}

async function smHostTick(key, m) {
  const ctrl = m.ctrl || {};
  // кто-то выгнал бота
  if ((ctrl.stopSeq || 0) > smLastStop) { smLastStop = ctrl.stopSeq; await smKickAsHost(); return; }
  // забираем чужие треки в локальную очередь
  if (m.adds) {
    for (const id of Object.keys(m.adds).sort()) {
      const a = m.adds[id];
      await db('DELETE', `music/${key}/adds/${id}`);
      enqueueLocal({ id: a.id, kind: a.kind, name: a.name, url: a.url });
    }
  }
  // громкость
  if (typeof ctrl.volume === 'number' && Math.abs(ctrl.volume / 100 - botVolume) > 0.001) {
    botVolume = ctrl.volume / 100;
    $('#music-volume').value = ctrl.volume;
    lastDuckVol = null;
    if (botView && botJoined) { try { await botView.executeJavaScript(`window.__bot && window.__bot.volume(${botVolume})`, false); } catch {} }
  }
  // пауза
  if (ctrl.paused !== undefined && !!ctrl.paused !== isPaused) { await setPausedLocal(!!ctrl.paused); }
  // скип
  if ((ctrl.skipSeq || 0) > smLastSkip) { smLastSkip = ctrl.skipSeq; playNext(); }
  smPublish();
}

function smFollowTick(m) {
  if (!hostFresh(m.host)) {
    // хост ушёл — по решению: музыка останавливается
    setMusicState('бота нет', false);
    $('#music-controls').classList.add('hidden');
    renderQueueNames([]);
    return;
  }
  const v = m.view || {};
  setMusicState(v.now ? '▶ ' + v.now : 'бот в канале', true);
  $('#music-controls').classList.remove('hidden');
  $('#music-pause').textContent = v.paused ? '▶' : '⏸';
  if (typeof v.volume === 'number') $('#music-volume').value = v.volume;
  renderQueueNames(v.queue || [], v.hostName);
}

async function smPublish() {
  if (!smIsHost || !smKey) return;
  await db('PUT', `music/${smKey}/view`, {
    hostName: myName,
    now: pendingTrack ? pendingTrack.name : null,
    paused: isPaused,
    volume: Math.round(botVolume * 100),
    queue: queue.slice(0, 20).map((q) => q.name),
    ts: Date.now()
  });
}

async function setPausedLocal(pause) {
  if (!botView || !botJoined || !pendingTrack) return;
  try {
    if (pause) { await botView.executeJavaScript('window.__bot && window.__bot.pause()', false); isPaused = true; }
    else {
      const r = await botView.executeJavaScript('window.__bot ? window.__bot.resume() : "x"', false);
      if (String(r).startsWith('playing')) isPaused = false; else playPending();
    }
    $('#music-pause').textContent = isPaused ? '▶' : '⏸';
  } catch {}
}

// хост завершает сеанс (сам вышел / выгнали)
async function smKickAsHost() {
  const key = smKey;
  smTeardown();
  if (key) { try { await db('DELETE', `music/${key}`); } catch {} }
  stopBot(false);
}

function smTeardown() {
  smIsHost = false;
  smKey = null;
  if (smHbTimer) { clearInterval(smHbTimer); smHbTimer = null; }
  if (smTimer) { clearInterval(smTimer); smTimer = null; }
}

// очередь только для отображения (у не-хоста)
function renderQueueNames(names, hostName) {
  const box = $('#music-queue');
  box.innerHTML = '';
  if (!names.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  names.forEach((n, i) => {
    const row = document.createElement('div');
    row.className = 'mq-item';
    const label = document.createElement('span');
    label.textContent = (i + 1) + '. ' + n;
    row.appendChild(label);
    box.appendChild(row);
  });
}

// авто-обнаружение чужого бота в комнате звонка → пассивно показываем сеанс
setInterval(async () => {
  if (!backendReady() || smKey) return;
  const cr = callRoomId();
  if (!cr) return;
  const room = findRoom(cr);
  if (!room) return;
  const key = urlKey(room.url);
  const hres = await db('GET', `music/${key}/host`);
  if (hostFresh(hres.ok ? hres.data : null)) smEnsureFollow(key);
}, 4000);

async function musicGo() {
  const q = $('#music-input').value.trim();
  if (!q) return;
  if (!callRoomId()) { setMusicState('сначала зайди в комнату', false); return; }
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
    const title = document.createElement('span');
    title.className = 'mr-title';
    title.textContent = text;
    b.appendChild(title);
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

/* ============================================================
   Бэкенд: чат, presence («кто где сидит»), пинги.
   Работает через Firebase RTDB REST (адрес берётся из манифеста,
   поле "backend"). Без адреса функции просто спят.
   ============================================================ */
let backendUrl = '';
let deviceId = '';
let myName = 'Гость';
let presenceInfo = {};   // urlKey -> { count, names[] }
let prevPresence = {};   // urlKey -> count (для пинга 0→>0)

function db(method, path, body, query) {
  if (!backendUrl) return Promise.resolve({ ok: false, error: 'нет бэкенда' });
  return window.api.dbReq({ base: backendUrl, method, path, body, query });
}

function urlKey(url) {
  // стабильный ключ встречи по её ссылке — одинаковый у всех участников
  try {
    const m = String(url).match(/telemost\.yandex\.[a-z]+\/j\/(\d+)/i);
    if (m) return 'm' + m[1];
  } catch {}
  return hashId(String(url));
}

function backendReady() { return !!backendUrl; }

/* ---------- presence: пишем, что мы в комнате, и читаем остальных ---------- */
let lastPresenceKey = null;

async function presenceHeartbeat() {
  if (!backendReady()) return;
  const rid = callRoomId(); // presence по комнате звонка, а не по видимой вкладке
  const room = rid ? findRoom(rid) : null;
  const key = room ? urlKey(room.url) : null;

  // ушли из старой комнаты — убираем себя оттуда
  if (lastPresenceKey && lastPresenceKey !== key) {
    db('DELETE', `presence/${lastPresenceKey}/${deviceId}`);
    lastPresenceKey = null;
  }
  if (!key) return;
  lastPresenceKey = key;
  db('PUT', `presence/${key}/${deviceId}`, { name: myName, ts: Date.now() });
}

async function presenceRead() {
  if (!backendReady()) return;
  const res = await db('GET', 'presence');
  if (!res.ok) return;
  const now = Date.now();
  const info = {};
  const data = res.data || {};
  for (const key of Object.keys(data)) {
    const members = data[key] || {};
    const names = [];
    for (const dev of Object.keys(members)) {
      const m = members[dev];
      if (m && typeof m.ts === 'number' && now - m.ts < 50000) names.push(m.name || 'кто-то');
    }
    if (names.length) info[key] = { count: names.length, names };
  }
  presenceInfo = info;
  checkPings();
  updateBadges();
}

function checkPings() {
  const watched = Array.isArray(cfg.pings) ? cfg.pings : [];
  for (const room of [...cfg.rooms, ...sharedRooms]) {
    if (!watched.includes(room.id)) continue;
    const key = urlKey(room.url);
    const now = (presenceInfo[key] && presenceInfo[key].count) || 0;
    const before = prevPresence[key] || 0;
    if (before === 0 && now > 0 && room.id !== callRoomId()) {
      playPop();
      try { new Notification('ВЕТРОДУЙ', { body: `🔔 В «${room.name}» кто-то появился (${now})`, silent: true }); } catch {}
    }
  }
  // запоминаем текущее состояние по всем ключам
  const snap = {};
  for (const room of [...cfg.rooms, ...sharedRooms]) {
    const key = urlKey(room.url);
    snap[key] = (presenceInfo[key] && presenceInfo[key].count) || 0;
  }
  prevPresence = snap;
}

function togglePing(roomId) {
  const watched = Array.isArray(cfg.pings) ? cfg.pings.slice() : [];
  const i = watched.indexOf(roomId);
  if (i >= 0) watched.splice(i, 1); else watched.push(roomId);
  cfg.pings = watched;
  window.api.setConfig({ pings: watched });
  renderRooms();
}

/* ---------- чат-шаутбокс ---------- */
let chatOpen = false;
let chatTimer = null;
let lastChatKeys = new Set();

async function chatPoll() {
  if (!backendReady() || !chatOpen) return;
  const res = await db('GET', 'chat', undefined, 'orderBy="$key"&limitToLast=60');
  if (!res.ok || !res.data) { renderChat([]); return; }
  const msgs = Object.keys(res.data).sort().map((k) => ({ k, ...res.data[k] }));
  renderChat(msgs);
}

function renderChat(msgs) {
  const box = $('#chat-messages');
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = '';
  for (const m of msgs) {
    const row = document.createElement('div');
    row.className = 'chat-msg' + (m.dev === deviceId ? ' mine' : '');
    const who = document.createElement('span');
    who.className = 'chat-who';
    who.textContent = m.name || 'кто-то';
    const txt = document.createElement('span');
    txt.className = 'chat-text';
    txt.textContent = m.text || '';
    row.append(who, txt);
    box.appendChild(row);
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function chatSend() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (!backendReady()) { alert('Чат не настроен: в манифесте нет поля "backend" (см. README).'); return; }
  input.value = '';
  await db('POST', 'chat', { name: myName, dev: deviceId, text: text.slice(0, 500), ts: Date.now() });
  chatPoll();
}

function openChat() {
  chatOpen = true;
  $('#modal-chat').classList.remove('hidden');
  $('#chat-input').focus();
  chatPoll();
  if (chatTimer) clearInterval(chatTimer);
  chatTimer = setInterval(chatPoll, 3500);
}

function closeChat() {
  chatOpen = false;
  $('#modal-chat').classList.add('hidden');
  if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
}

setInterval(presenceHeartbeat, 20000);
setInterval(presenceRead, 12000);

/* ---------- инициализация ---------- */
async function init() {
  cfg = await window.api.getConfig();
  if (!Array.isArray(cfg.rooms)) cfg.rooms = [];
  if (typeof cfg.sharedUrl !== 'string') cfg.sharedUrl = '';
  duckingEnabled = !!cfg.ducking;
  $('#music-duck').classList.toggle('active', duckingEnabled);

  // идентификатор устройства и имя для чата/presence
  if (!cfg.deviceId) { cfg.deviceId = crypto.randomUUID(); window.api.setConfig({ deviceId: cfg.deviceId }); }
  deviceId = cfg.deviceId;
  myName = cfg.userName || 'Гость';

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
    const cr = callRoomId();
    const wv = cr ? views.get(cr) : null;
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
    myName = cfg.userName || 'Гость';
    $('#modal-settings').classList.add('hidden');
    sharedRooms = [];
    refreshShared();
  });

  // общий чат
  $('#chat-btn').addEventListener('click', openChat);
  $('#chat-close').addEventListener('click', closeChat);
  $('#chat-send').addEventListener('click', chatSend);
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') chatSend(); });

  // музыкальный бот
  $('#music-play').addEventListener('click', musicGo);
  $('#music-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') musicGo(); });
  $('#music-pause').addEventListener('click', async () => {
    if (smFollower()) {
      const wantPause = $('#music-pause').textContent === '⏸';
      await db('PATCH', `music/${smKey}/ctrl`, { paused: wantPause });
      $('#music-pause').textContent = wantPause ? '▶' : '⏸';
      return;
    }
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
      smPublish();
    } catch {}
  });
  $('#music-next').addEventListener('click', async () => {
    if (smFollower()) { await db('PATCH', `music/${smKey}/ctrl`, { skipSeq: { '.sv': { increment: 1 } } }); return; }
    playNext();
  });
  $('#music-duck').addEventListener('click', () => {
    duckingEnabled = !duckingEnabled;
    $('#music-duck').classList.toggle('active', duckingEnabled);
    window.api.setConfig({ ducking: duckingEnabled });
    lastDuckVol = null; // пересчитать громкость немедленно
    applyDucking();
  });
  $('#music-stop').addEventListener('click', async () => {
    if (smFollower()) { await db('PATCH', `music/${smKey}/ctrl`, { stopSeq: { '.sv': { increment: 1 } } }); return; }
    if (smIsHost) { await smKickAsHost(); return; }
    stopBot(false);
  });
  $('#music-volume').addEventListener('input', async (e) => {
    const vol = e.target.value / 100;
    if (smFollower()) { await db('PATCH', `music/${smKey}/ctrl`, { volume: Math.round(vol * 100) }); return; }
    botVolume = vol;
    lastDuckVol = null; // слайдер важнее — сбрасываем дакинг-кэш
    if (botView && botJoined) {
      // если сейчас идёт приглушение — не перебиваем его полным звуком
      const humanSpeaking = speakingNames.some((n) => n !== BOT_NAME);
      const v = (duckingEnabled && humanSpeaking) ? +(botVolume * 0.2).toFixed(3) : botVolume;
      lastDuckVol = v;
      try { await botView.executeJavaScript(`window.__bot && window.__bot.volume(${v})`, false); } catch {}
    }
    smPublish();
  });

  // закрытие модалок по клику на фон / Escape
  document.querySelectorAll('.modal-back').forEach((back) => {
    back.addEventListener('mousedown', (e) => { if (e.target === back) { back.classList.add('hidden'); if (back.id === 'modal-chat') closeChat(); } });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeChat(); document.querySelectorAll('.modal-back').forEach((b) => b.classList.add('hidden')); }
  });
}

init();
