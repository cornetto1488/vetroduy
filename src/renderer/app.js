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
let voiceEffect = 'normal'; // текущий эффект войс-ченджера

const HOME_URL = 'https://telemost.yandex.ru/';

/* ---------- webview-комнаты (один войс за раз, как в Discord) ---------- */
const VOICE_SRC = window.api.voicePatchSource();

function ensureView(id, url) {
  if (views.has(id)) return views.get(id);
  const wv = document.createElement('webview');
  wv.setAttribute('allowpopups', '');
  wv.src = url;
  wv.dataset.ready = '';
  wv.addEventListener('dom-ready', async () => {
    wv.dataset.ready = '1';
    applyReskin(wv);
    if (id !== 'home') {
      // войс-ченджер: патчим getUserMedia ДО того, как Телемост захватит микрофон
      try {
        await wv.executeJavaScript(VOICE_SRC, false);
        if (voiceEffect !== 'normal') await wv.executeJavaScript(`window.__voice && window.__voice.set(${JSON.stringify(voiceEffect)})`, false);
      } catch {}
    }
    startJoinLoop(id, wv);
  });
  if (id !== 'home') showCurtain(id, (findRoom(id) || {}).name || 'комнате');
  wv.addEventListener('did-navigate', () => applyReskin(wv));
  $('#views').appendChild(wv);
  views.set(id, wv);
  return wv;
}

/* «На главную» по клику на лого/название. Звонок при этом НЕ рвём —
   вьюха комнаты просто прячется и продолжает жить в фоне. */
function goHome() {
  activeId = null;
  views.forEach((wv) => wv.classList.remove('active'));
  $('#welcome').classList.remove('hidden');
  $('#watch-overlay').classList.add('hidden');
  updateCurtain();
  renderRooms();
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
  if (id !== 'home') djAutoStart();
  updateCurtain();
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
  /* точные классы яндекс-бара; НЕ [class*="GlobalBar"] — иначе прячется
     весь контент страниц с классом withGlobalBar_... */
  [class*="GlobalBarRoot"], [class*="globalBar_"], [class*="GlobalBarContainer"],
  [class*="GlobalBarTop"], [class*="GlobalBarControl"], [class*="Logo360"], [class*="ServiceWrap"],
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

/* ---------- занавес: пока прокликиваем Телемост, показываем лого ---------- */
let curtainFor = null;

function updateCurtain() {
  $('#join-curtain').classList.toggle('hidden', !(curtainFor && curtainFor === activeId));
}
function showCurtain(id, name) {
  curtainFor = id;
  $('#jc-text').textContent = 'подключаемся к «' + name + '»…';
  updateCurtain();
}
function hideCurtain(id) {
  if (id && curtainFor !== id) return;
  curtainFor = null;
  updateCurtain();
}

function startJoinLoop(id, wv) {
  if (wv.dataset.joining) return;
  wv.dataset.joining = '1';
  let tries = 0;
  // страховка: занавес не должен висеть вечно, если Телемост изменится
  const failsafe = setTimeout(() => hideCurtain(id), 30000);
  const t = setInterval(async () => {
    if (!views.has(id) || views.get(id) !== wv) { clearInterval(t); clearTimeout(failsafe); hideCurtain(id); return; }
    if (++tries > 60) { clearInterval(t); clearTimeout(failsafe); hideCurtain(id); return; }
    try {
      const st = await wv.executeJavaScript(autoJoinScript(cfg.userName || ''), false);
      if (st === 'joined') { clearInterval(t); clearTimeout(failsafe); hideCurtain(id); }
      // без сохранённого имени человек вводит его сам — экран прятать нельзя
      else if (!cfg.userName && st === 'wait') { clearTimeout(failsafe); hideCurtain(id); }
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
  pushOverlay();
}
setInterval(pollCounts, 2500);

/* ---------- оверлей поверх игры ---------- */
let overlayOn = false;
function pushOverlay() {
  if (!overlayOn) return;
  window.api.overlayData({
    speakers: speakingNames,
    now: (typeof pendingTrack !== 'undefined' && pendingTrack && !isPaused) ? pendingTrack.name : null,
    inCall: !!callRoomId()
  });
}
async function toggleOverlay() {
  overlayOn = await window.api.overlayToggle();
  $('#overlay-btn').classList.toggle('on', overlayOn);
  if (overlayOn) pushOverlay();
}

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
      $('#watch-btn').classList.remove('hidden');
      $('#quiz-btn').classList.remove('hidden');
      presenceHeartbeat();
      presenceRead();
      loadStats(); // топ войса на главной
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
  if (musicBlocked()) { setMusicState('🔒 хост запретил добавлять треки', false); return; }
  const key = smSessionKey();

  if (key && !smIsHost) {
    const hres = await db('GET', `music/${key}/host`);
    const host = hres.ok ? hres.data : null;
    if (hostFresh(host) && host.dev !== deviceId) {
      if (item.kind === 'local') {
        // файл лежит на ТВОЁМ диске — чужой хост его не достанет
        setMusicState('файл с диска может включить только хост бота', false);
        return;
      }
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
  if (item.kind === 'sc') {
    const r = await window.api.songUrl(item.url);
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
    // локальный файл уже раздаётся нашим прокси с Range — не заворачиваем в /stream
    url: item.kind === 'local' ? url : `http://127.0.0.1:${musicProxyPort}/stream?url=${encodeURIComponent(url)}`
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
let smPerms = null;      // права, прочитанные follower'ом: {lockAll, blocked:{dev}}
let hostPerms = { lockAll: false, blocked: {} }; // права, которые задаёт хост

// заблокировано ли нам (follower'у) управление музыкой
function musicBlocked() {
  if (!smFollower() || !smPerms) return false;
  return !!(smPerms.lockAll || (smPerms.blocked && smPerms.blocked[deviceId]));
}

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
  hostPerms = { lockAll: false, blocked: {} };
  await db('PUT', `music/${key}/host`, { dev: deviceId, name: myName, ts: Date.now() });
  await db('PUT', `music/${key}/perms`, hostPerms);
  $('#music-perms').classList.remove('hidden'); // хосту доступна кнопка прав
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
  $('#music-perms').classList.add('hidden'); // кнопка прав только у хоста
  smPerms = m.perms || null;
  if (!hostFresh(m.host)) {
    // хост ушёл — по решению: музыка останавливается
    setMusicState('бота нет', false);
    $('#music-controls').classList.add('hidden');
    renderQueueNames([]);
    return;
  }
  const v = m.view || {};
  const blocked = musicBlocked();
  setMusicState(blocked ? '🔒 хост ограничил управление' : (v.now ? '▶ ' + v.now : 'бот в канале'), !blocked);
  $('#music-controls').classList.remove('hidden');
  $('#music-pause').textContent = v.paused ? '▶' : '⏸';
  if (typeof v.volume === 'number') $('#music-volume').value = v.volume;
  renderQueueNames(v.queue || [], v.hostName);
  applyMusicLock(blocked);
}

// блокируем/разблокируем элементы управления музыкой у follower'а
function applyMusicLock(blocked) {
  const els = ['#music-input', '#music-play', '#music-pause', '#music-next', '#music-stop', '#music-volume'];
  els.forEach((s) => { const el = $(s); if (el) el.disabled = !!blocked; });
  $('#music-panel').classList.toggle('locked', !!blocked);
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
  smPerms = null;
  if (smHbTimer) { clearInterval(smHbTimer); smHbTimer = null; }
  if (smTimer) { clearInterval(smTimer); smTimer = null; }
  $('#music-perms').classList.add('hidden');
  applyMusicLock(false); // снять блокировку
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

// ---------- права хоста: кто может управлять музыкой ----------
async function writeHostPerms() {
  if (!smIsHost || !smKey) return;
  await db('PUT', `music/${smKey}/perms`, hostPerms);
}

function renderPermList() {
  $('#perm-lockall').checked = !!hostPerms.lockAll;
  const box = $('#perm-list');
  box.innerHTML = '';
  const members = presenceMembers[smKey] || {};
  const others = Object.keys(members).filter((d) => d !== deviceId && members[d] !== BOT_NAME);
  if (!others.length) {
    box.innerHTML = '<p class="hint">Пока в комнате больше никого нет.</p>';
    return;
  }
  for (const dev of others) {
    const row = document.createElement('label');
    row.className = 'perm-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!(hostPerms.blocked && hostPerms.blocked[dev]);
    cb.addEventListener('change', () => {
      hostPerms.blocked = hostPerms.blocked || {};
      if (cb.checked) hostPerms.blocked[dev] = true; else delete hostPerms.blocked[dev];
      writeHostPerms();
    });
    const span = document.createElement('span');
    span.textContent = members[dev];
    row.append(cb, span);
    box.appendChild(row);
  }
}

async function openPerms() {
  if (!smIsHost) return;
  await presenceRead(); // освежить список участников
  renderPermList();
  $('#modal-perms').classList.remove('hidden');
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

  // 1) SoundCloud-треки — показываем сразу
  const songs = await window.api.songSearch(q);
  if (songs.ok && songs.items && songs.items.length) {
    addSection('Треки');
    for (const t of songs.items) {
      addItem(t.title, (t.channel ? t.channel + ' · ' : '') + t.dur, { kind: 'sc', url: t.url, name: t.title });
    }
    box.classList.remove('hidden');
    setMusicState('клик — в очередь', false);
  } else {
    setMusicState('ищу радио…', false);
  }

  // 2) Радио — догружаем в фоне с таймаутом (чтобы не блокировало треки)
  const radioTimeout = new Promise((res) => setTimeout(() => res({ ok: false }), 6000));
  const radio = await Promise.race([window.api.musicSearch(q), radioTimeout]);
  const hasSongs = box.querySelector('.mr-item');
  if (radio.ok && radio.items && radio.items.length) {
    addSection('Радио');
    for (const st of radio.items) {
      addItem(st.name, (st.country || '') + (st.bitrate ? ' · ' + st.bitrate + ' kbps' : ''), { kind: 'radio', name: st.name, url: st.url });
    }
    box.classList.remove('hidden');
    setMusicState('клик — в очередь', false);
  } else if (!hasSongs) {
    setMusicState('ничего не нашёл', false);
  }
}

/* ---------- воздухан: сам находит трек и сразу ставит ---------- */
const DJ_MOODS = {
  'весёл|весел|позитив|качов|кач|туса|туc|праздник': ['party hits', 'фонк качалка', 'русский хип хоп 2024', 'зарубежные хиты'],
  'груст|печал|медлен|лирик|душев': ['грустный рэп', 'sad russian', 'лирика рэп', 'ambient sad'],
  'чил|расслаб|спокой|учеб|фон': ['lofi hip hop', 'chillhop', 'чил бит', 'phonk chill'],
  'фонк|phonk|агресс|качат|спорт|качал': ['phonk', 'aggressive phonk', 'drift phonk', 'russian phonk'],
  'реп|рэп|русск': ['русский рэп', 'Кровосток', 'ATL', 'Скриптонит', 'Boulevard Depo']
};
const DJ_RANDOM = ['Кровосток', 'Miyagi', 'phonk', 'русский рэп 2024', 'lofi hip hop', 'Скриптонит', 'ATL', 'Boulevard Depo', 'зарубежные хиты', 'фонк качалка', '三', 'Big Baby Tape'];

function djQueryFor(text) {
  const t = (text || '').trim().toLowerCase();
  if (!t || /^(что-?нибудь|что-?то|рандом|любое|давай|на своё|на свое|сам реши|удиви)/.test(t)) {
    // без конкретики — по настроению или совсем рандом
    for (const rx in DJ_MOODS) {
      if (new RegExp(rx).test(t)) { const arr = DJ_MOODS[rx]; return arr[Math.floor(Math.random() * arr.length)]; }
    }
    return DJ_RANDOM[Math.floor(Math.random() * DJ_RANDOM.length)];
  }
  return text.trim(); // конкретный запрос — ищем как есть
}

/* Английская модель слышит фразу целиком («воздухан включи…» она разберёт
   как мусор), а нужен только хвост — само название. Берём столько последних
   слов, сколько их в русском запросе. */
function djEnHint(query) {
  if (!djLastEn.text || Date.now() - djLastEn.ts > 5000) return '';
  const w = djLastEn.text.trim().split(/\s+/).filter(Boolean);
  const n = String(query || '').trim().split(/\s+/).filter(Boolean).length;
  if (!w.length || !n) return '';
  return w.slice(-Math.min(n, w.length)).join(' ');
}

async function djPlay(query) {
  if (musicBlocked()) { setMusicState('🔒 хост ограничил управление', false); return; }
  const q = djQueryFor(query);
  const hint = djEnHint(q);
  $('#music-results').classList.add('hidden');
  setMusicState('🎧 ищу: ' + q, false);
  const res = await window.api.songSearch(q, hint);
  if (!res.ok || !res.items || !res.items.length) { setMusicState('🎧 не нашёл «' + q + '»', false); return; }
  const t = res.items[0];
  setMusicState('🎧 ставлю: ' + t.title, true);
  enqueue({ kind: 'sc', url: t.url, name: t.title });
  // воздухан объявляет трек голосом, как радиоведущий
  setTimeout(() => botSay('Ставлю: ' + t.title.replace(/[_|]+/g, ' ').slice(0, 90)), 900);
}

/* ============================================================
   Угадай мелодию: бот играет отрывок трека всем в комнате, игроки
   выкрикивают исполнителя, воздухан слышит ответы и засчитывает.
   Хост ведёт игру (играет и судит), остальные только кричат.
   ============================================================ */
// q — что искать на SoundCloud, ans — как это звучит по-русски (для засчёта на слух)
const QUIZ_POOL = [
  { q: 'Кровосток', name: 'Кровосток', ans: ['кровосток'] },
  { q: 'MORGENSHTERN', name: 'MORGENSHTERN', ans: ['моргенштерн', 'моргенштен', 'моргенштейн'] },
  { q: 'Oxxxymiron', name: 'Оксимирон', ans: ['оксимирон', 'оксюморон'] },
  { q: 'Miyagi', name: 'Miyagi', ans: ['мияги', 'мияджи'] },
  { q: 'Баста', name: 'Баста', ans: ['баста'] },
  { q: 'Skriptonit', name: 'Скриптонит', ans: ['скриптонит'] },
  { q: 'Big Baby Tape', name: 'Big Baby Tape', ans: ['биг бейби тейп', 'бейби тейп'] },
  { q: 'Элджей', name: 'Элджей', ans: ['элджей', 'элджэй'] },
  { q: 'Скриптонит', name: 'Скриптонит', ans: ['скриптонит'] },
  { q: 'ATL', name: 'ATL', ans: ['атл', 'а тэ эл'] },
  { q: 'Linkin Park', name: 'Linkin Park', ans: ['линкин парк', 'линкенпарк', 'линкин'] },
  { q: 'Eminem', name: 'Eminem', ans: ['эминем'] },
  { q: 'Billie Eilish', name: 'Billie Eilish', ans: ['билли айлиш', 'билли элиш'] },
  { q: 'The Weeknd', name: 'The Weeknd', ans: ['уикенд', 'викенд', 'зе уикенд'] },
  { q: 'Imagine Dragons', name: 'Imagine Dragons', ans: ['имеджин драгонс', 'имэджин драгонс', 'драгонс'] },
  { q: 'Coldplay', name: 'Coldplay', ans: ['колдплей', 'колд плей'] },
  { q: 'Queen', name: 'Queen', ans: ['куин', 'квин'] },
  { q: 'Rammstein', name: 'Rammstein', ans: ['рамштайн', 'раммштайн'] },
  { q: 'System of a Down', name: 'System of a Down', ans: ['систем оф э даун', 'систем автодаун', 'систем'] },
  { q: 'Gorillaz', name: 'Gorillaz', ans: ['гориллаз', 'горилаз'] }
];
const QUIZ_ROUNDS = 7, QUIZ_GUESS_MS = 30000, QUIZ_REVEAL_MS = 5000;

// маленький Левенштейн для нестрогого засчёта ответа на слух
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function simTxt(a, b) { const n = Math.max(a.length, b.length); return n ? 1 - lev(a, b) / n : 0; }

function quizMatch(guess, answers) {
  const g = (guess || '').toLowerCase().replace(/[^а-яёa-z\s]/g, ' ').trim();
  if (!g) return false;
  const words = g.split(/\s+/);
  for (const a of answers) {
    if (g.includes(a)) return true;
    if (simTxt(g, a) > 0.82) return true;
    // одиночное слово-ответ ловим по отдельным словам фразы
    if (!a.includes(' ')) { for (const w of words) if (w.length > 3 && simTxt(w, a) > 0.8) return true; }
  }
  return false;
}

let quizOn = false, quizIsHost = false, quizKey = null, quizTimer = null;
let quizAnswer = null, quizDeck = [], quizRound = 0, quizPhase = 'lobby';
let quizScores = {}, quizPhaseUntil = 0, quizRoundStart = 0, quizSeenGuess = {};

function quizRoomKey() { const cr = callRoomId(); return cr ? urlKey(findRoom(cr).url) : null; }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; }

async function quizPublish(extra) {
  if (!quizIsHost || !quizKey) return;
  await db('PUT', `quiz/${quizKey}/state`, Object.assign({
    host: { dev: deviceId, name: myName, ts: Date.now() },
    phase: quizPhase, round: quizRound, total: QUIZ_ROUNDS,
    scores: quizScores, until: quizPhaseUntil
  }, extra || {}));
}

// играем отрывок напрямую через бота, НЕ трогая общую очередь музыки,
// иначе название трека засветилось бы в панели у всех
async function quizPlaySnippet(query) {
  const res = await window.api.songSearch(query);
  if (!res.ok || !res.items || !res.items.length) return false;
  const track = res.items[Math.floor(Math.random() * Math.min(3, res.items.length))];
  const u = await window.api.songUrl(track.url);
  if (!u.ok) return false;
  if (!musicProxyPort) musicProxyPort = await window.api.musicProxyPort();
  const stream = `http://127.0.0.1:${musicProxyPort}/stream?url=${encodeURIComponent(u.url)}`;
  try { await botView.executeJavaScript(`window.__bot && window.__bot.play(${JSON.stringify(stream)})`, false); return true; } catch { return false; }
}

async function quizStopSnippet() {
  try { await botView.executeJavaScript('window.__bot && window.__bot.stop()', false); } catch {}
}

async function ensureBotForQuiz() {
  const cr = callRoomId();
  if (!cr) return false;
  if (!botView || botRoomId !== cr) { startBot(cr); }
  for (let i = 0; i < 30 && !botJoined; i++) await new Promise((r) => setTimeout(r, 500));
  return botJoined;
}

async function quizStartGame() {
  if (!await ensureBotForQuiz()) { quizToast('нужен музыкальный бот в канале'); return; }
  if (!djOn) djStart();                    // всем нужен слух, чтобы кричать ответы
  quizIsHost = true;
  quizDeck = shuffle(QUIZ_POOL);
  quizRound = 0; quizScores = {}; quizSeenGuess = {};
  await quizNextRound();
}

async function quizNextRound() {
  quizRound++;
  if (quizRound > QUIZ_ROUNDS) { await quizEndGame(); return; }
  quizAnswer = quizDeck[(quizRound - 1) % quizDeck.length];
  quizPhase = 'playing';
  quizRoundStart = Date.now();
  quizPhaseUntil = Date.now() + QUIZ_GUESS_MS;
  await quizPublish({ revealed: null, winner: null });
  botSay('Раунд ' + quizRound + '. Что за исполнитель?');
  const ok = await quizPlaySnippet(quizAnswer.q);
  if (!ok) { quizToast('не смог поставить трек, пропускаю'); setTimeout(quizNextRound, 800); }
}

async function quizAward(dev, name) {
  quizScores[dev] = quizScores[dev] || { name, pts: 0 };
  quizScores[dev].name = name;
  quizScores[dev].pts++;
  quizPhase = 'reveal';
  quizPhaseUntil = Date.now() + QUIZ_REVEAL_MS;
  await quizStopSnippet();
  await quizPublish({ revealed: quizAnswer.name, winner: name });
  botSay('Верно, ' + name + '. Это ' + quizAnswer.name + '.');
}

async function quizTimeoutRound() {
  quizPhase = 'reveal';
  quizPhaseUntil = Date.now() + QUIZ_REVEAL_MS;
  await quizStopSnippet();
  await quizPublish({ revealed: quizAnswer.name, winner: null });
  botSay('Никто не угадал. Это ' + quizAnswer.name + '.');
}

async function quizEndGame() {
  quizPhase = 'over';
  quizPhaseUntil = 0;
  await quizStopSnippet();
  await quizPublish({ revealed: null, winner: null });
  const top = Object.values(quizScores).sort((a, b) => b.pts - a.pts)[0];
  botSay(top ? ('Игра окончена. Победил ' + top.name + ' с ' + top.pts + ' очками.') : 'Игра окончена.');
}

// ответы игроков (что услышал их воздухан) во время раунда — в Firebase
function quizReportGuess(text) {
  if (!quizOn || quizPhase !== 'playing' || !quizKey) return;
  db('PATCH', `quiz/${quizKey}/guesses/${deviceId}`, { text, name: myName, ts: Date.now() });
}

async function quizHostTick() {
  const now = Date.now();
  if (quizPhase === 'playing') {
    const res = await db('GET', `quiz/${quizKey}/guesses`);
    const guesses = (res.ok && res.data) ? res.data : {};
    // самый ранний верный ответ забирает очко
    let best = null;
    for (const dev in guesses) {
      const g = guesses[dev];
      if (!g || !g.ts || g.ts < quizRoundStart) continue;
      if ((quizSeenGuess[dev] || 0) >= g.ts) continue;
      quizSeenGuess[dev] = g.ts;
      if (quizMatch(g.text, quizAnswer.ans) && (!best || g.ts < best.ts)) best = { dev, name: g.name || 'игрок', ts: g.ts };
    }
    if (best) { await quizAward(best.dev, best.name); return; }
    if (now > quizPhaseUntil) { await quizTimeoutRound(); return; }
  } else if (quizPhase === 'reveal') {
    if (now > quizPhaseUntil) { await quizNextRound(); }
  }
}

function quizToast(t) { const b = $('#quiz-body'); if (b && quizPhase === 'lobby') return; setMusicState('🎯 ' + t, false); }

function quizRender(state) {
  const body = $('#quiz-body');
  if (!body) return;
  const st = quizIsHost
    ? { phase: quizPhase, round: quizRound, total: QUIZ_ROUNDS, scores: quizScores, until: quizPhaseUntil, revealed: quizPhase === 'reveal' ? (quizAnswer && quizAnswer.name) : null }
    : (state || {});
  const scores = st.scores || {};
  const rows = Object.values(scores).sort((a, b) => b.pts - a.pts);
  const scoreHtml = rows.length
    ? '<div class="quiz-scores">' + rows.map((s, i) => `<div class="quiz-score-row${i === 0 ? ' lead' : ''}"><span>${i === 0 ? '👑 ' : ''}${escapeHtml(s.name)}</span><span class="qs-pts">${s.pts}</span></div>`).join('') + '</div>'
    : '';

  if (!st.phase || st.phase === 'lobby') {
    body.innerHTML = `<div class="quiz-sub">Бот включит отрывок — кричи исполнителя вслух, воздухан засчитает. ${QUIZ_ROUNDS} раундов.</div>` +
      `<div class="quiz-actions"><button id="quiz-start" class="btn primary">▶ Начать игру</button><button id="quiz-exit" class="btn ghost">Закрыть</button></div>`;
    $('#quiz-start').addEventListener('click', quizStartGame);
    $('#quiz-exit').addEventListener('click', closeQuiz);
    return;
  }
  if (st.phase === 'playing') {
    const left = Math.max(0, Math.ceil((st.until - Date.now()) / 1000));
    body.innerHTML = `<div class="quiz-sub">Раунд ${st.round} из ${st.total}</div>` +
      `<div class="quiz-big">🔊 ${left}с</div><div class="quiz-sub">Кричи имя исполнителя!</div>` +
      scoreHtml + `<div class="quiz-actions">${quizIsHost ? '<button id="quiz-skip" class="btn ghost">Пропустить</button>' : ''}<button id="quiz-exit" class="btn ghost">Выйти</button></div>`;
  } else if (st.phase === 'reveal') {
    body.innerHTML = `<div class="quiz-sub">Раунд ${st.round} из ${st.total}</div>` +
      `<div class="quiz-reveal">${escapeHtml(st.revealed || '?')}</div>` +
      `<div class="quiz-sub">${st.winner ? '✅ угадал ' + escapeHtml(st.winner) : '❌ никто не угадал'}</div>` +
      scoreHtml + `<div class="quiz-actions"><button id="quiz-exit" class="btn ghost">Выйти</button></div>`;
  } else if (st.phase === 'over') {
    const win = rows[0];
    body.innerHTML = `<div class="quiz-big">🏆</div><div class="quiz-reveal">${win ? escapeHtml(win.name) : 'ничья'}</div>` +
      `<div class="quiz-sub">победитель</div>` + scoreHtml +
      `<div class="quiz-actions">${quizIsHost ? '<button id="quiz-again" class="btn primary">Ещё раз</button>' : ''}<button id="quiz-exit" class="btn ghost">Закрыть</button></div>`;
    if (quizIsHost) $('#quiz-again').addEventListener('click', quizStartGame);
  }
  const ex = $('#quiz-exit'); if (ex) ex.addEventListener('click', closeQuiz);
  const sk = $('#quiz-skip'); if (sk) sk.addEventListener('click', () => { if (quizIsHost) quizTimeoutRound(); });
}

async function quizTick() {
  if (!quizOn) return;
  const key = quizRoomKey();
  if (!key) { quizRender({ phase: 'lobby' }); return; }
  quizKey = key;
  if (quizIsHost) { await quizHostTick(); quizRender(); return; }
  const res = await db('GET', `quiz/${key}/state`);
  const data = (res.ok && res.data) ? res.data : null;
  const st = (data && data.host && hostFresh(data.host)) ? data : null;
  quizRender(st || { phase: 'lobby' });
}

function openQuiz() {
  if (!backendReady()) { alert('Игра работает через общий бэкенд (Firebase).'); return; }
  if (!callRoomId()) { alert('Сначала зайди в комнату со звонком.'); return; }
  quizOn = true;
  quizIsHost = false; quizPhase = 'lobby';
  $('#quiz-overlay').classList.remove('hidden');
  quizKey = quizRoomKey();
  quizTick();
  if (quizTimer) clearInterval(quizTimer);
  quizTimer = setInterval(quizTick, 800);
}

async function closeQuiz() {
  const wasHost = quizIsHost;
  quizOn = false; quizIsHost = false;
  $('#quiz-overlay').classList.add('hidden');
  if (quizTimer) { clearInterval(quizTimer); quizTimer = null; }
  if (wasHost && quizKey) { try { await quizStopSnippet(); await db('DELETE', `quiz/${quizKey}`); } catch {} }
  quizAnswer = null; quizPhase = 'lobby';
}
function toggleQuiz() { quizOn ? closeQuiz() : openQuiz(); }

/* ============================================================
   Караоке: тянем синхронный текст с lrclib и подсвечиваем строку
   по времени воспроизведения бота. Голос не вырезаем — поём поверх.
   ============================================================ */
let karaokeOn = false, karTimer = null, karLines = null, karTrackName = '', karFetching = false;

function parseLrc(lrc) {
  const out = [];
  for (const raw of String(lrc || '').split('\n')) {
    const m = raw.match(/^((?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/);
    if (!m) continue;
    const text = m[2].trim();
    const stamps = m[1].match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g) || [];
    for (const st of stamps) {
      const p = st.match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/);
      const t = (+p[1]) * 60 + (+p[2]) + (p[3] ? +('0.' + p[3]) : 0);
      out.push({ t, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// «MORGENSHTERN - Быстро (prod. X)» → { artist, track } для запроса текста
function splitTrack(name) {
  let s = String(name || '').replace(/\.(mp3|wav|flac|m4a|ogg|opus)$/i, '').trim();
  s = s.replace(/\s*[\(\[](?:official|prod|remix|feat|ft|audio|lyrics|clip|видео|премьера)[^)\]]*[\)\]]/gi, '').trim();
  const m = s.split(/\s[-–—]\s/);
  if (m.length >= 2) return { artist: m[0].trim(), track: m.slice(1).join(' - ').trim() };
  return { artist: '', track: s };
}

async function botTime() {
  if (!botView || !botJoined) return null;
  try {
    const st = await botView.executeJavaScript('window.__bot ? window.__bot.state() : null', false);
    return st && st.playing ? st.time : (st ? st.time : null);
  } catch { return null; }
}

function karSetStatus(t) { $('#kar-status').textContent = t; }

function renderKarLines(activeIdx) {
  const box = $('#kar-lyrics');
  box.innerHTML = '';
  if (!karLines || !karLines.length) return;
  karLines.forEach((l, i) => {
    if (!l.text) return;
    const d = document.createElement('div');
    d.className = 'kar-line' + (i === activeIdx ? ' active' : (i < activeIdx ? ' past' : ''));
    d.textContent = l.text;
    box.appendChild(d);
    if (i === activeIdx) d.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

async function loadKaraoke(name) {
  karTrackName = name;
  karLines = null;
  karFetching = true;
  renderKarLines(-1);
  const { artist, track } = splitTrack(name);
  karSetStatus('ищу текст…');
  const r = await window.api.karaokeLyrics(artist, track);
  karFetching = false;
  if (karTrackName !== name) return;   // трек успел смениться
  if (!r.ok) { karSetStatus('текста нет — но можно подпевать 🙂'); karLines = null; return; }
  karLines = parseLrc(r.lrc);
  karSetStatus(r.artist + ' — ' + r.track);
  renderKarLines(-1);
}

async function karTick() {
  if (!karaokeOn) return;
  const cur = (typeof pendingTrack !== 'undefined' && pendingTrack) ? pendingTrack.name : null;
  if (!cur) { karSetStatus('включи трек — покажу текст'); if (karLines) { karLines = null; renderKarLines(-1); } karTrackName = ''; return; }
  if (cur !== karTrackName && !karFetching) { await loadKaraoke(cur); return; }
  if (!karLines || !karLines.length) return;
  const t = await botTime();
  if (t == null) return;
  let idx = -1;
  for (let i = 0; i < karLines.length; i++) { if (karLines[i].t <= t + 0.15) idx = i; else break; }
  if (idx !== karTick._last) { karTick._last = idx; renderKarLines(idx); }
}

function openKaraoke() {
  karaokeOn = true;
  $('#karaoke-overlay').classList.remove('hidden');
  karTrackName = ''; karTick._last = -2;
  karTick();
  if (karTimer) clearInterval(karTimer);
  karTimer = setInterval(karTick, 350);
}
function closeKaraoke() {
  karaokeOn = false;
  $('#karaoke-overlay').classList.add('hidden');
  if (karTimer) { clearInterval(karTimer); karTimer = null; }
  karLines = null; karTrackName = '';
}
function toggleKaraoke() { karaokeOn ? closeKaraoke() : openKaraoke(); }

/* ---------- саундборд ----------
   Звук уходит отдельной дорожкой бота, поэтому играет поверх музыки
   и не сбивает текущий трек. Слышат все в комнате. */
async function botSfx(file, volume) {
  if (!botView || !botJoined) { setMusicState('сначала позови бота (включи музыку)', false); return false; }
  if (!musicProxyPort) musicProxyPort = await window.api.musicProxyPort();
  const id = await window.api.allowFile(file);
  if (!id) return false;
  const url = `http://127.0.0.1:${musicProxyPort}/local?id=${id}`;
  try {
    await botView.executeJavaScript(`window.__bot && window.__bot.sfx(${JSON.stringify(url)}, ${typeof volume === 'number' ? volume : 1})`, false);
    return true;
  } catch { return false; }
}

// воздухан говорит вслух прямо в звонок
async function botSay(text) {
  if (!botView || !botJoined) return;
  const r = await window.api.ttsSay(text);
  if (!r.ok) return;
  await botSfx(r.file, 1);
}

async function renderSfx() {
  const list = await window.api.sfxList();
  const grid = $('#sfx-grid');
  grid.innerHTML = '';
  if (!list.length) {
    const e = document.createElement('div');
    e.className = 'sfx-empty';
    e.textContent = 'пусто — добавь свой через + или скачай готовые:';
    const seed = document.createElement('button');
    seed.id = 'sfx-seed';
    seed.className = 'sfx-btn';
    seed.textContent = '⬇ стартовый набор мемов';
    seed.addEventListener('click', seedSfx);
    grid.append(e, seed);
    return;
  }
  list.forEach((s) => {
    const b = document.createElement('button');
    b.className = 'sfx-btn';
    b.textContent = s.name;
    b.title = s.name + ' — клик играет всем, правый клик удаляет';
    b.addEventListener('click', () => botSfx(s.file));
    b.addEventListener('contextmenu', async (ev) => {
      ev.preventDefault();
      if (!confirm('Удалить звук «' + s.name + '»?')) return;
      await window.api.sfxRemove(s.file);
      renderSfx();
    });
    grid.appendChild(b);
  });
}

/* Стартовый набор мемов. Файлы не вшиты в сборку (чужое аудио), а
   качаются поиском по SoundCloud — одной кнопкой при пустом саундборде. */
const SFX_PRESETS = [
  ['vine boom', 'vine boom sound effect'],
  ['bruh', 'bruh sound effect'],
  ['among us', 'among us role reveal sound effect'],
  ['fbi open up', 'fbi open up sound effect'],
  ['emotional damage', 'emotional damage sound effect'],
  ['metal pipe', 'metal pipe falling sound effect'],
  ['ой всё', 'ой всё звук мем'],
  ['сосиска', 'звук мем сосиска']
];

async function seedSfx() {
  const btn = $('#sfx-seed');
  if (btn) btn.disabled = true;
  let ok = 0;
  for (let i = 0; i < SFX_PRESETS.length; i++) {
    const [name, q] = SFX_PRESETS[i];
    setMusicState(`🔊 качаю мемы ${i + 1}/${SFX_PRESETS.length}…`, false);
    const r = await window.api.sfxAddSearch(q, name);
    if (r.ok) ok++;
    await renderSfx();
  }
  setMusicState('🔊 добавлено мемов: ' + ok, ok > 0);
  if (btn) btn.disabled = false;
  renderSfx();
}

async function addSfxByUrl() {
  const url = (prompt('Ссылка на звук (YouTube, SoundCloud, прямой mp3):') || '').trim();
  if (!url) return;
  const name = (prompt('Как назвать кнопку?') || '').trim();
  if (!name) return;
  setMusicState('🔊 качаю «' + name + '»…', false);
  const r = await window.api.sfxAddUrl(url, name);
  setMusicState(r.ok ? '🔊 добавлен: ' + name : '🔊 не вышло: ' + r.error, r.ok);
  renderSfx();
}

/* ---------- воздухан: слушает мик и понимает команды ---------- */
let djOn = false, djModel = null, djRec = null, djStream = null, djCtx = null, djNode = null, djBusy = false;
// вторая, английская модель: слушает тот же звук параллельно и даёт
// нормальное написание англоязычных имён вместо русской каши
let djModelEn = null, djRecEn = null, djLastEn = { text: '', ts: 0 };
// порог «тут говорят» и состояние текущей фразы
const DJ_GATE = 0.012;
let djSpeaking = false, djSilence = 0, djHeardSec = 0, djPrev = null;

function djSetVolume(delta) {
  const el = $('#music-volume');
  el.value = Math.max(0, Math.min(100, (+el.value || 50) + delta));
  el.dispatchEvent(new Event('input'));
  setMusicState('🎧 громкость ' + el.value, true);
}

/* Зовут его «воздухан», но в словаре Vosk такого слова нет — вживую он
   слышит «воздуха» или «воздух энн». Поэтому ловим все эти варианты
   (и «диджей» заодно оставляем). */
// [а-яё]*, а не \w* — \w в JS кириллицу не ловит, и «воздуха» резалось
// до «воздух», а лишняя «а» утекала в текст команды
const DJ_WAKE = /(?:^|\s)(?:возду[хш][а-яё]*|ди\s?дж[еэ]й|дижей)(?:\s+(?:энн?|ан|он|н))?[\s,]*/;
const DJ_VERB = /^(включи|включай|поставь|ставь|давай|найди|запусти|врубай|врубить|сыграй|дальше|следующ|скип|пропусти|переключи|другой|другую|пауза|паузу|останови|продолж|стоп|стой|выключи|хватит|уйди|заткнись|громче|погромче|тише|потише|сделай|что-?нибудь|что-?то|рандом)/;

function djHeard(text) {
  const t = (text || '').toLowerCase().trim();
  const m = t.match(DJ_WAKE);
  if (!m) return;
  const cmd = t.slice(m.index + m[0].length).trim();
  if (!cmd) return;
  // «свежий воздух сегодня» — это не команда: если обращение не в начале
  // фразы, требуем понятный глагол, иначе молчим
  if (m.index !== 0 && !DJ_VERB.test(cmd)) return;
  djLog('услышал: ' + cmd);

  if (/^(стоп|стой|выключи|хватит|уйди|заткнись|тихо)/.test(cmd)) { $('#music-stop').click(); setMusicState('🎧 окей, выключаю', false); return; }
  if (/^(дальше|следующ|скип|пропусти|переключи|другой|другую)/.test(cmd)) { $('#music-next').click(); setMusicState('🎧 переключаю', true); return; }
  if (/^(пауза|паузу|останови|продолж|дальше играй)/.test(cmd)) { $('#music-pause').click(); return; }
  if (/^(сделай\s+|давай\s+)?(по)?громче/.test(cmd)) { djSetVolume(+15); return; }
  if (/^(сделай\s+|давай\s+)?(по)?тише/.test(cmd)) { djSetVolume(-15); return; }

  const p = cmd.match(/^(?:включи|включай|поставь|ставь|давай|найди|запусти|врубай|врубить|сыграй)\s+(.+)$/);
  const q = p ? p[1] : cmd;
  if (djBusy) return;
  djBusy = true;
  djPlay(q).finally(() => { setTimeout(() => { djBusy = false; }, 1500); });
}

function djLog(s) { const el = $('#dj-heard'); if (el) el.textContent = s; }

async function djStart() {
  if (!callRoomId()) { setMusicState('сначала зайди в комнату', false); return; }
  if (typeof Vosk === 'undefined') { setMusicState('🎧 распознавание не загрузилось', false); return; }
  try {
    setMusicState('🎧 бужу воздухана…', false);
    const m = await window.api.djModel();      // ~44 МБ, качается один раз
    if (!m.ok) { setMusicState('🎧 не скачалась модель: ' + m.error, false); return; }
    if (!djModel) {
      setMusicState('🎧 включаю слух…', false);
      djModel = await Vosk.createModel(m.url);
    }
    djStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    // ВАЖНО: используем общий контекст на родной частоте устройства.
    // Отдельный AudioContext на 16 кГц роняет аудио-движок, когда рядом
    // играет звук из контекста с другой частотой (звук захода в комнату).
    // Vosk сам пересемплирует — ему достаточно передать реальную частоту.
    if (!audioCtx) audioCtx = new AudioContext();
    try { if (audioCtx.state === 'suspended') await audioCtx.resume(); } catch {}
    djCtx = audioCtx;
    djRec = new djModel.KaldiRecognizer(djCtx.sampleRate);
    djRec.on('result', (msg) => {
      try {
        const t = msg && msg.result && msg.result.text;
        if (!t) return;
        reportSwears(t);      // считаем мат во всей речи, не только в командах
        quizReportGuess(t);   // во время игры — это ответ на раунд
        djHeard(t);
      } catch {}
    });

    // английская модель — не критична: не скачалась, работаем на русской
    try {
      if (!djModelEn) {
        const me = await window.api.djModel('en');
        if (me.ok) djModelEn = await Vosk.createModel(me.url);
      }
      if (djModelEn) {
        djRecEn = new djModelEn.KaldiRecognizer(djCtx.sampleRate);
        djRecEn.on('result', (msg) => {
          const t = msg && msg.result && msg.result.text;
          if (t) djLastEn = { text: t, ts: Date.now() };
        });
      }
    } catch {}
    const src = djCtx.createMediaStreamSource(djStream);
    djNode = djCtx.createScriptProcessor(4096, 1, 1);
    // Кормим распознаватель ТОЛЬКО когда реально говорят. Если гнать в него
    // всё подряд, он на играющей рядом музыке никогда не «закрывает» фразу,
    // копит состояние и вместе с webview'ами доводит вкладку до нехватки
    // памяти — приложение падало именно из-за этого.
    djNode.onaudioprocess = (e) => {
      if (!djOn || !djRec) return;
      const buf = e.inputBuffer.getChannelData(0);
      const rate = djCtx.sampleRate;
      let sum = 0;
      for (let i = 0; i < buf.length; i += 4) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / (buf.length / 4));
      try {
        if (rms > DJ_GATE) {
          if (!djSpeaking) {                       // старт фразы: добавим чуть предыдущего
            djSpeaking = true; djHeardSec = 0;
            if (djPrev) djRec.acceptWaveformFloat(djPrev, rate);
          }
          djSilence = 0;
          djHeardSec += buf.length / rate;
          djRec.acceptWaveformFloat(buf, rate);
          if (djRecEn) djRecEn.acceptWaveformFloat(buf, rate);
        } else if (djSpeaking) {
          djSilence += buf.length / rate;
          djRec.acceptWaveformFloat(buf, rate);    // хвост фразы тоже нужен
          if (djRecEn) djRecEn.acceptWaveformFloat(buf, rate);
        }
        // пауза после речи либо слишком длинная фраза — закрываем и сбрасываем
        if (djSpeaking && (djSilence > 0.9 || djHeardSec > 12)) {
          djSpeaking = false; djSilence = 0; djHeardSec = 0;
          if (djRecEn) djRecEn.retrieveFinalResult();   // сначала английская —
          djRec.retrieveFinalResult();                  // чтобы подсказка была готова
        }
      } catch {}
      djPrev = buf.slice(0);
    };
    src.connect(djNode);
    const mute = djCtx.createGain(); mute.gain.value = 0;  // в тишину, чтобы не эхо в динамики
    djNode.connect(mute); mute.connect(djCtx.destination);
    djOn = true;
    $('#music-dj').classList.add('dj-on');
    $('#dj-hint').classList.remove('hidden');
    setMusicState('🎧 воздухан слушает', true);
  } catch (err) {
    setMusicState('🎧 не вышло: ' + (err.message || err), false);
    djStop(true);
  }
}

function djStop(quiet) {
  djOn = false;
  try { if (djNode) { djNode.onaudioprocess = null; djNode.disconnect(); } } catch {}
  try { if (djStream) djStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (djRec) djRec.remove(); } catch {}   // контекст общий — его не закрываем
  try { if (djRecEn) djRecEn.remove(); } catch {}
  djNode = djStream = djCtx = djRec = djRecEn = null;
  djLastEn = { text: '', ts: 0 };
  djSpeaking = false; djSilence = 0; djHeardSec = 0; djPrev = null;
  $('#music-dj').classList.remove('dj-on');
  $('#dj-hint').classList.add('hidden');
  djLog('');
  if (!quiet) setMusicState('🎧 воздухан ушёл', false);
}

/* Воздухан по умолчанию всегда слушает: включается сам при заходе в комнату.
   Кнопку оставляем — выбор запоминается, чтобы его можно было прогнать. */
function djToggle() {
  if (djOn) {
    djStop();
    cfg.djAuto = false;
    try { window.api.setConfig({ djAuto: false }); } catch {}
  } else {
    cfg.djAuto = true;
    try { window.api.setConfig({ djAuto: true }); } catch {}
    djStart();
  }
}

function djAutoStart() {
  if (djOn || cfg.djAuto === false) return;
  setTimeout(() => { if (!djOn && cfg.djAuto !== false && callRoomId()) djStart(); }, 2500);
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
let presenceMembers = {}; // urlKey -> { deviceId: name } (свежие участники)
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
  const membersByKey = {};
  const data = res.data || {};
  for (const key of Object.keys(data)) {
    const members = data[key] || {};
    const names = [];
    const fresh = {};
    for (const dev of Object.keys(members)) {
      const m = members[dev];
      if (m && typeof m.ts === 'number' && now - m.ts < 50000) { names.push(m.name || 'кто-то'); fresh[dev] = m.name || 'кто-то'; }
    }
    if (names.length) { info[key] = { count: names.length, names }; membersByKey[key] = fresh; }
  }
  presenceInfo = info;
  presenceMembers = membersByKey;
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

/* ---------- статистика войса (топ задротов) ---------- */
// раз в минуту, пока сидим в звонке, атомарно прибавляем себе 60 секунд
setInterval(() => {
  const rid = callRoomId();
  if (!rid || !backendReady()) return;
  const room = findRoom(rid);
  if (!room) return;
  const key = urlKey(room.url);
  db('PATCH', `stats/${deviceId}`, {
    name: myName,
    secs: { '.sv': { increment: 60 } },
    ['byRoom/' + key]: { '.sv': { increment: 60 } }
  });
}, 60000);

/* ---------- мат-о-метр ----------
   Корни матерных слов, но с обязательным началом слова и списком приставок:
   без этого «хлебать» и «потребует» улетали бы в статистику как мат. */
const SWEARS = [
  ['хуй',     /(^|[\s,.!?])[а-яё]{0,3}ху[йёеяю][а-яё]*/g],
  ['пизда',   /(^|[\s,.!?])[а-яё]{0,3}пизд[а-яё]*/g],
  ['блядь',   /(^|[\s,.!?])бл[яе][дт][а-яё]*/g],
  ['ебать',   /(^|[\s,.!?])(за|на|про|вы|у|от|под|при|до|пере|разъ)?[её]б[аеёиуы][а-яё]*/g],
  ['сука',    /(^|[\s,.!?])сук[аиоуе][а-яё]*/g],
  ['мудак',   /(^|[\s,.!?])муда[кчлр][а-яё]*/g],
  ['гандон',  /(^|[\s,.!?])[гк]андон[а-яё]*/g],
  ['долбоёб', /(^|[\s,.!?])долбо[её]б[а-яё]*/g],
  ['залупа',  /(^|[\s,.!?])залуп[а-яё]*/g],
  ['шлюха',   /(^|[\s,.!?])шлюх[а-яё]*/g]
];

function countSwears(text) {
  const t = ' ' + (text || '').toLowerCase() + ' ';
  const found = {};
  for (const [word, rx] of SWEARS) {
    rx.lastIndex = 0;
    const n = (t.match(rx) || []).length;
    if (n) found[word] = n;
  }
  return found;
}

function reportSwears(text) {
  if (!backendReady()) return;
  const found = countSwears(text);
  const words = Object.keys(found);
  if (!words.length) return;
  const patch = { name: myName, swearTotal: { '.sv': { increment: words.reduce((a, w) => a + found[w], 0) } } };
  for (const w of words) patch['swears/' + w] = { '.sv': { increment: found[w] } };
  db('PATCH', `stats/${deviceId}`, patch);
}

function renderSwearMeter(all) {
  const block = $('#swear-block');
  const totals = {};
  let topMan = null;
  for (const s of Object.values(all || {})) {
    if (!s || !s.swears) continue;
    for (const w in s.swears) totals[w] = (totals[w] || 0) + (s.swears[w] || 0);
    if (s.name && s.swearTotal > 0 && (!topMan || s.swearTotal > topMan.swearTotal)) topMan = s;
  }
  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!rows.length) { block.classList.add('hidden'); return; }
  const box = $('#swear-list');
  box.innerHTML = '';
  rows.forEach(([w, n], i) => {
    const row = document.createElement('div');
    row.className = 'stats-row';
    const place = document.createElement('span'); place.className = 'sr-place'; place.textContent = (i + 1) + '.';
    const nm = document.createElement('span'); nm.className = 'sr-name'; nm.textContent = w;
    const c = document.createElement('span'); c.className = 'sr-time sr-swear'; c.textContent = n;
    row.append(place, nm, c);
    box.appendChild(row);
  });
  if (topMan) {
    const row = document.createElement('div');
    row.className = 'stats-row sr-champ';
    row.textContent = '👑 главный матершинник — ' + topMan.name + ' (' + topMan.swearTotal + ')';
    box.appendChild(row);
  }
  block.classList.remove('hidden');
}

async function loadStats() {
  if (!backendReady()) return;
  const res = await db('GET', 'stats');
  const block = $('#stats-block');
  if (!res.ok || !res.data) { block.classList.add('hidden'); return; }
  renderSwearMeter(res.data);
  const rows = Object.values(res.data)
    .filter((s) => s && s.name && typeof s.secs === 'number' && s.secs > 0)
    .sort((a, b) => b.secs - a.secs)
    .slice(0, 8);
  if (!rows.length) { block.classList.add('hidden'); return; }
  const box = $('#stats-list');
  box.innerHTML = '';
  rows.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'stats-row';
    const place = document.createElement('span'); place.className = 'sr-place'; place.textContent = (i + 1) + '.';
    const nm = document.createElement('span'); nm.className = 'sr-name'; nm.textContent = s.name;
    const t = document.createElement('span'); t.className = 'sr-time';
    const h = s.secs / 3600;
    t.textContent = h >= 1 ? h.toFixed(1) + ' ч' : Math.round(s.secs / 60) + ' мин';
    row.append(place, nm, t);
    box.appendChild(row);
  });
  block.classList.remove('hidden');
}
// обновляем топ, пока видна главная
setInterval(() => { if (!$('#welcome').classList.contains('hidden')) loadStats(); }, 90000);

/* ============================================================
   Кинотеатр (watch party): смотрим видео синхронно.
   Ведущий грузит ссылку (RuTube / VK Видео / прямой mp4), его
   play/pause/тайминг публикуются в Firebase, у остальных то же
   видео подтягивается и синхронизируется. Источник-независимо —
   рулим тегом <video> на странице (поэтому не завязано на YouTube).
   ============================================================ */
let watchOpen = false, watchWv = null, watchKey = null, watchIsHost = false, watchTimer = null, watchUrl = null, watchHostSince = 0;

const WATCH_CTRL = `(() => {
  const v = document.querySelector('video');
  if (!v) return false;
  window.__wp = {
    get: () => ({ t: v.currentTime || 0, p: !v.paused, d: v.duration || 0 }),
    apply: (p, t) => {
      if (typeof t === 'number' && Math.abs((v.currentTime || 0) - t) > 1.8) { try { v.currentTime = t; } catch (e) {} }
      if (p && v.paused) v.play().catch(() => {});
      if (!p && !v.paused) v.pause();
    }
  };
  return true;
})()`;

function setWatchInfo(t) { $('#watch-info').textContent = t; }

function ensureWatchView(url) {
  if (!watchWv) {
    watchWv = document.createElement('webview');
    watchWv.setAttribute('allowpopups', '');
    watchWv.setAttribute('partition', 'persist:watch');
    watchWv.addEventListener('dom-ready', () => { watchWv.dataset.ready = '1'; });
    $('#watch-view').appendChild(watchWv);
  }
  if (watchUrl !== url) { watchUrl = url; watchWv.dataset.ready = ''; watchWv.src = url; }
}
function destroyWatchView() { if (watchWv) { watchWv.remove(); watchWv = null; } watchUrl = null; }

function openWatch() {
  if (!backendReady()) { alert('Кинотеатр работает через общий бэкенд (Firebase). Его нет — см. README.'); return; }
  watchOpen = true;
  $('#watch-overlay').classList.remove('hidden');
  const host = callRoomId() ? null : undefined;
  $('#watch-url').value = '';
  setWatchInfo(callRoomId() ? 'вставь ссылку и «Показать всем» — или жди ведущего' : 'сначала зайди в комнату');
  watchTick();
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = setInterval(watchTick, 1500);
}

function closeWatch() {
  watchOpen = false;
  $('#watch-overlay').classList.add('hidden');
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  if (watchIsHost && watchKey) { try { db('DELETE', `watch/${watchKey}`); } catch {} }
  destroyWatchView();
  watchIsHost = false; watchKey = null;
}

async function watchLoad() {
  const url = $('#watch-url').value.trim();
  if (!/^https?:\/\//i.test(url)) { setWatchInfo('нужна ссылка http(s)'); return; }
  const cr = callRoomId();
  if (!cr) { setWatchInfo('сначала зайди в комнату'); return; }
  watchKey = urlKey(findRoom(cr).url);
  watchIsHost = true;
  watchHostSince = Date.now();
  ensureWatchView(url);
  await db('PUT', `watch/${watchKey}`, { host: { dev: deviceId, name: myName, ts: watchHostSince }, url, playing: false, time: 0, ts: Date.now() });
  setWatchInfo('ты ведущий • грузим видео…');
}

async function watchTick() {
  if (!watchOpen) return;
  const cr = callRoomId();
  const key = cr ? urlKey(findRoom(cr).url) : null;
  if (!key) { setWatchInfo('нет активной комнаты'); return; }
  if (watchKey && watchKey !== key) {
    if (watchIsHost) { try { await db('DELETE', `watch/${watchKey}`); } catch {} }
    destroyWatchView(); watchIsHost = false;
  }
  watchKey = key;
  const res = await db('GET', `watch/${key}`);
  const w = res.ok ? res.data : null;

  if (watchIsHost) {
    // теряем хостство ТОЛЬКО если его явно перехватил другой (не при пустом ответе)
    if (w && w.host && w.host.dev !== deviceId && (w.host.ts || 0) > (watchHostSince || 0)) { watchIsHost = false; return; }
    let st = null;
    try { st = await watchWv.executeJavaScript('window.__wp ? window.__wp.get() : null', false); } catch {}
    if (!st) { try { await watchWv.executeJavaScript(WATCH_CTRL, false); } catch {} }
    if (st) {
      db('PATCH', `watch/${key}`, { playing: st.p, time: st.t, ts: Date.now(), host: { dev: deviceId, name: myName, ts: Date.now() } });
      setWatchInfo('ты ведущий • ' + (st.p ? '▶' : '⏸') + ' ' + Math.floor(st.t) + 'с');
    }
  } else {
    if (!w || !hostFresh(w.host) || !w.url) { setWatchInfo('ведущий ещё не включил видео'); return; }
    ensureWatchView(w.url);
    setWatchInfo('смотрим с ' + (w.host.name || 'ведущим') + ' • ' + (w.playing ? '▶' : '⏸'));
    if (watchWv.dataset.ready) {
      try {
        const ok = await watchWv.executeJavaScript(`window.__wp ? window.__wp.apply(${w.playing ? 'true' : 'false'}, ${(+w.time || 0)}) : false`, false);
        if (ok === false) await watchWv.executeJavaScript(WATCH_CTRL, false);
      } catch {}
    }
  }
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
  voiceEffect = cfg.voice || 'normal';
  $('#voice-select').value = voiceEffect;

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

  // оверлей поверх игры
  $('#overlay-btn').addEventListener('click', toggleOverlay);

  // караоке
  $('#karaoke-btn').addEventListener('click', toggleKaraoke);
  $('#kar-close').addEventListener('click', closeKaraoke);

  // угадай мелодию
  $('#quiz-btn').addEventListener('click', toggleQuiz);

  // саундборд
  $('#sfx-add').addEventListener('click', addSfxByUrl);
  renderSfx();

  // лого и название в шапке = на главную
  $('#home-logo').addEventListener('click', goHome);
  $('#home-title').addEventListener('click', goHome);

  // кинотеатр (watch party)
  $('#watch-btn').addEventListener('click', openWatch);
  $('#watch-close').addEventListener('click', closeWatch);
  $('#watch-load').addEventListener('click', watchLoad);
  $('#watch-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') watchLoad(); });

  // общий чат
  $('#chat-btn').addEventListener('click', openChat);
  $('#chat-close').addEventListener('click', closeChat);
  $('#chat-send').addEventListener('click', chatSend);
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') chatSend(); });

  // музыкальный бот
  $('#music-play').addEventListener('click', musicGo);
  $('#music-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') musicGo(); });
  $('#music-pause').addEventListener('click', async () => {
    if (musicBlocked()) return;
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
    if (musicBlocked()) return;
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
    if (musicBlocked()) return;
    if (smFollower()) { await db('PATCH', `music/${smKey}/ctrl`, { stopSeq: { '.sv': { increment: 1 } } }); return; }
    if (smIsHost) { await smKickAsHost(); return; }
    stopBot(false);
  });

  // воздухан: 🎧 зовёт/прогоняет, дальше он слушает мик
  $('#music-dj').addEventListener('click', djToggle);
  window.api.onDjProgress((pct) => { if (!djOn) setMusicState('🎧 качаю голосовой движок ' + pct + '%', false); });

  // войс-ченджер: применяем к текущему звонку сразу
  $('#voice-select').addEventListener('change', async (e) => {
    voiceEffect = e.target.value;
    window.api.setConfig({ voice: voiceEffect });
    const cr = callRoomId();
    const wv = cr ? views.get(cr) : null;
    if (wv && wv.dataset.ready) {
      try {
        const r = await wv.executeJavaScript(`window.__voice ? window.__voice.set(${JSON.stringify(voiceEffect)}) : 'nopatch'`, false);
        if (String(r).startsWith('ok')) setMusicState('🎤 голос: ' + e.target.selectedOptions[0].textContent, true);
      } catch {}
    }
  });

  // drag&drop аудиофайлов — играют у всех через бота
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    document.body.classList.remove('dropping');
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    for (const f of files) {
      if (!/\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(f.name)) continue;
      const p = window.api.getFilePath(f);
      if (!p) continue;
      if (e.shiftKey) {                       // с Shift — не в очередь, а в саундборд
        const r = await window.api.sfxAddFile(p, f.name.replace(/\.[^.]+$/, ''));
        setMusicState(r.ok ? '🔊 в саундборд: ' + f.name : '🔊 не вышло: ' + r.error, r.ok);
        renderSfx();
        continue;
      }
      const id = await window.api.allowFile(p);
      if (!id) continue;
      if (!musicProxyPort) musicProxyPort = await window.api.musicProxyPort();
      await enqueue({ kind: 'local', name: f.name.replace(/\.[^.]+$/, ''), url: `http://127.0.0.1:${musicProxyPort}/local?id=${id}` });
    }
  });

  // права хоста на музыку
  $('#music-perms').addEventListener('click', openPerms);
  $('#perm-close').addEventListener('click', () => $('#modal-perms').classList.add('hidden'));
  $('#perm-lockall').addEventListener('change', (e) => {
    hostPerms.lockAll = e.target.checked;
    writeHostPerms();
  });
  $('#music-volume').addEventListener('input', async (e) => {
    if (musicBlocked()) return;
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
