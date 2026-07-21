const { app, BrowserWindow, ipcMain, session, shell, desktopCapturer, Tray, Menu, globalShortcut, net, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');

let win = null;
let tray = null;
let trayRooms = [];
let isQuitting = false;
let trayBalloonShown = false;

// ---------- одиночный экземпляр ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.setAppUserModelId('ru.vetroduy.app');

// ---------- конфиг (комнаты, общий список) ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');

function migrateOldConfig() {
  // раньше приложение звалось telemostushka/glassmost — подхватываем старый конфиг
  try {
    const p = configPath();
    if (fs.existsSync(p)) return;
    for (const oldName of ['telemostushka', 'glassmost']) {
      const old = path.join(app.getPath('appData'), oldName, 'config.json');
      if (fs.existsSync(old)) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.copyFileSync(old, p);
        return;
      }
    }
  } catch {}
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return { rooms: [], sharedUrl: '' };
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('config save failed', e);
  }
}

const iconPath = () => path.join(__dirname, '..', 'build', 'icon.ico');

// ---------- окно ----------
let prevBounds = null;
let miniMode = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    backgroundColor: '#0b0d1a',
    show: false,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
      spellcheck: false
    }
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));

  // закрытие = сворачивание в трей, звонок продолжается
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
    if (tray && !trayBalloonShown) {
      trayBalloonShown = true;
      try {
        tray.displayBalloon({
          title: 'ВЕТРОДУЙ работает в трее',
          content: 'Звонок не прерван. Открыть — клик по иконке, выйти — правый клик → Выйти.'
        });
      } catch {}
    }
  });
}

function toggleMiniMode() {
  if (!win) return;
  miniMode = !miniMode;
  if (miniMode) {
    prevBounds = win.getBounds();
    if (win.isMaximized()) win.unmaximize();
    win.setMinimumSize(320, 220);
    const { workArea } = screen.getPrimaryDisplay();
    win.setBounds({ x: workArea.x + workArea.width - 440, y: workArea.y + 20, width: 420, height: 300 });
    win.setAlwaysOnTop(true, 'screen-saver');
  } else {
    win.setAlwaysOnTop(false);
    win.setMinimumSize(960, 620);
    if (prevBounds) win.setBounds(prevBounds);
  }
  win.webContents.send('win:mini', miniMode);
  rebuildTray();
}

// ---------- трей ----------
function rebuildTray() {
  if (!tray) return;
  const roomItems = trayRooms.map((r) => ({
    label: (r.active ? '● ' : ' ') + r.name,
    click: () => {
      win.show();
      win.webContents.send('room:activate', r.id);
    }
  }));

  const menu = Menu.buildFromTemplate([
    { label: 'Открыть ВЕТРОДУЙ', click: () => { win.show(); win.focus(); } },
    { label: miniMode ? 'Обычный режим' : 'Мини-режим поверх окон', click: () => toggleMiniMode() },
    { label: 'Мут микрофона (Ctrl+Shift+M)', click: () => win.webContents.send('hotkey:mute') },
    { type: 'separator' },
    ...(roomItems.length ? [...roomItems, { type: 'separator' }] : []),
    { label: 'Выйти', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  try {
    tray = new Tray(iconPath());
    tray.setToolTip('ВЕТРОДУЙ');
    tray.on('click', () => { win.show(); win.focus(); });
    rebuildTray();
  } catch (e) {
    console.error('tray failed', e);
  }
}

// ---------- разрешения для Телемоста (камера/микрофон/уведомления) ----------
function setupSession() {
  const s = session.defaultSession;
  const botSession = session.fromPartition('persist:musicbot');

  const allowed = new Set([
    'media',
    'mediaKeySystem',
    'notifications',
    'fullscreen',
    'display-capture',
    'clipboard-read',
    'clipboard-sanitized-write',
    'speaker-selection'
  ]);

  for (const ses of [s, botSession]) {
    // Убираем "Electron" из user agent, чтобы Яндекс не ругался на браузер
    const ua = ses.getUserAgent()
      .replace(/\sElectron\/[\d.]+/, '')
      .replace(/\s(vetroduy|telemostushka)\/[\d.]+/i, '');
    ses.setUserAgent(ua);
    ses.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission)));
    ses.setPermissionCheckHandler((wc, permission) => allowed.has(permission));
  }

  // CSP Телемоста не пускает аудио с localhost-прокси — снимаем его
  // только в изолированной сессии музыкального бота
  botSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (/^content-security-policy/i.test(key)) delete headers[key];
    }
    callback({ responseHeaders: headers });
  });

  // Демонстрация экрана: своё окно выбора экрана/окна
  s.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      await openSharePicker(request, callback);
    } catch {
      try { callback({}); } catch {}
    }
  });
}

// ---------- музыкальный бот: аудио-прокси ----------
// Радио-потоки почти никогда не отдают CORS-заголовки, а WebAudio без них
// «глушит» звук. Поэтому гоняем поток через локальный прокси.
let musicProxyPort = 0;

function startMusicProxy() {
  const srv = http.createServer((req, res) => {
    let target;
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/stream') { res.writeHead(404); res.end(); return; }
      target = u.searchParams.get('url');
      if (!/^https?:\/\//i.test(target)) { res.writeHead(400); res.end(); return; }
    } catch { res.writeHead(400); res.end(); return; }

    const r = net.request(target);
    r.on('response', (rr) => {
      try {
        res.writeHead(rr.statusCode || 200, {
          'Content-Type': rr.headers['content-type'] || 'audio/mpeg',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        });
      } catch {}
      rr.on('data', (chunk) => { try { res.write(chunk); } catch {} });
      rr.on('end', () => { try { res.end(); } catch {} });
      rr.on('error', () => { try { res.end(); } catch {} });
    });
    r.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
    req.on('close', () => { try { r.abort(); } catch {} });
    r.end();
  });
  srv.listen(0, '127.0.0.1', () => { musicProxyPort = srv.address().port; });
}

ipcMain.handle('music:proxyPort', () => musicProxyPort);

// поиск радиостанций через открытый Radio Browser API (без ключей);
// балансировщик all.* нестабилен, поэтому перебираем зеркала
const RADIO_MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  'https://all.api.radio-browser.info'
];

ipcMain.handle('music:search', async (e, q) => {
  let lastError = 'нет ответа';
  for (const base of RADIO_MIRRORS) {
    try {
      const url = base + '/json/stations/search?limit=8&hidebroken=true&order=votes&reverse=true&name=' + encodeURIComponent(q);
      const res = await net.fetch(url, { headers: { 'User-Agent': 'vetroduy/1.0' } });
      if (!res.ok) { lastError = 'HTTP ' + res.status; continue; }
      const data = await res.json();
      return {
        ok: true,
        items: data.map((st) => ({
          name: st.name,
          url: st.url_resolved || st.url,
          country: st.country || '',
          bitrate: st.bitrate || 0
        })).filter((st) => st.url)
      };
    } catch (err) {
      lastError = String(err.message || err);
    }
  }
  return { ok: false, error: lastError };
});

// ---------- окно выбора источника демонстрации ----------
let pickerWin = null;
let pickerCallback = null;
let pickerSources = [];

function settlePicker(sourceId) {
  const cb = pickerCallback;
  pickerCallback = null;
  if (cb) {
    const src = sourceId ? pickerSources.find((s) => s.id === sourceId) : null;
    try {
      if (src) {
        const result = { video: src };
        // системный звук имеет смысл только при показе всего экрана
        if (src.id.startsWith('screen')) result.audio = 'loopback';
        cb(result);
      } else {
        cb({});
      }
    } catch {}
  }
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
}

async function openSharePicker(request, callback) {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 400, height: 240 },
    fetchWindowIcons: true
  });

  if (pickerCallback) settlePicker(null);

  pickerSources = sources;
  pickerCallback = callback;

  pickerWin = new BrowserWindow({
    width: 820,
    height: 620,
    parent: win,
    modal: true,
    frame: false,
    resizable: false,
    backgroundColor: '#12142a',
    webPreferences: {
      preload: path.join(__dirname, 'picker-preload.js'),
      contextIsolation: true
    }
  });
  pickerWin.removeMenu();

  const payload = sources
    .filter((s) => !/^(ВЕТРОДУЙ|TELEMOSTushka)$/i.test(s.name)) // не предлагаем показывать самого себя
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
    }));

  pickerWin.webContents.once('did-finish-load', () => {
    if (pickerWin && !pickerWin.isDestroyed()) pickerWin.webContents.send('picker:sources', payload);
  });
  pickerWin.on('closed', () => {
    pickerWin = null;
    if (pickerCallback) { const cb = pickerCallback; pickerCallback = null; try { cb({}); } catch {} }
  });

  pickerWin.loadFile(path.join(__dirname, 'renderer', 'picker.html'));
}

ipcMain.on('picker:choose', (e, id) => settlePicker(id));
ipcMain.on('picker:cancel', () => settlePicker(null));

// ---------- ссылки из webview ----------
app.on('web-contents-created', (event, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      // Авторизация Яндекса внутри Телемоста — во всплывающем окне
      if (/(^https:\/\/)([\w-]+\.)*(yandex\.(ru|com|net)|ya\.ru|yastatic\.net)\//.test(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            width: 900,
            height: 700
          }
        };
      }
      shell.openExternal(url);
      return { action: 'deny' };
    });
  }
});

// ---------- IPC ----------
ipcMain.handle('config:get', () => loadConfig());

ipcMain.handle('config:set', (e, patch) => {
  const cfg = { ...loadConfig(), ...patch };
  saveConfig(cfg);
  return cfg;
});

// общий список комнат по ссылке (JSON: [{name, url}]); грузим в main — нет проблем с CORS
ipcMain.handle('shared:fetch', async (e, url) => {
  try {
    if (!/^https:\/\//.test(url)) return { ok: false, error: 'Нужна https-ссылка' };
    const res = await net.fetch(url, { cache: 'no-store' });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------- поиск песен через yt-dlp ----------
function ytdlpPath() {
  const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', name)
    : path.join(__dirname, '..', 'bin', name);
  if (fs.existsSync(bundled)) return bundled;
  return name; // на Linux берём из системы (pacman -S yt-dlp)
}

function runYtdlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(ytdlpPath(), args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      // иначе yt-dlp пишет в пайп в системной кодировке и кириллица бьётся
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function fmtDuration(sec) {
  if (!sec || !isFinite(sec)) return '';
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

ipcMain.handle('music:ytsearch', async (e, q) => {
  try {
    // -J дампит JSON с \uXXXX-экранированием — кириллица не зависит от кодировки консоли
    const out = await runYtdlp(['ytsearch6:' + q, '--flat-playlist', '--no-warnings', '-J'], 30000);
    const data = JSON.parse(out);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const items = entries.map((en) => ({
      id: en.id,
      dur: fmtDuration(en.duration),
      title: en.title || '',
      channel: en.channel || en.uploader || ''
    })).filter((x) => x.id && x.title);
    return { ok: true, items };
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
});

ipcMain.handle('music:yturl', async (e, id) => {
  try {
    const safeId = String(id).replace(/[^\w-]/g, '');
    // берём самый высокий битрейт (opus обычно лучше m4a), m4a — запасной
    const out = await runYtdlp([
      '-f', 'bestaudio[acodec=opus]/bestaudio/best',
      '-g', 'https://www.youtube.com/watch?v=' + safeId
    ], 40000);
    const url = out.split(/\r?\n/).filter(Boolean)[0];
    if (!/^https?:\/\//.test(url || '')) throw new Error('прямая ссылка не получена');
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
});

ipcMain.handle('app:version', () => app.getVersion());

// ---------- 1-кнопочное обновление: скачать установщик и запустить ----------
// net.request сам НЕ следует за редиректами при ручном стриминге,
// поэтому идём по цепочке Location вручную (GitHub → CDN)
function downloadFollow(url, out, hops) {
  return new Promise((resolve, reject) => {
    if (hops > 6) return reject(new Error('слишком много редиректов'));
    const req = net.request(url);
    req.on('response', (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
        res.resume(); // сливаем тело редиректа
        resolve(downloadFollow(loc, out, hops + 1));
        return;
      }
      if (code !== 200) { reject(new Error('HTTP ' + code)); return; }
      const total = parseInt(res.headers['content-length'] || 0, 10);
      let got = 0;
      res.on('data', (c) => {
        got += c.length;
        out.write(c);
        if (total && win) win.webContents.send('update:progress', Math.min(100, Math.round((got / total) * 100)));
      });
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

ipcMain.handle('update:download', async (e, url) => {
  try {
    if (!/^https:\/\//.test(url)) return { ok: false, error: 'Нужна https-ссылка' };
    const isWin = process.platform === 'win32';
    const ext = isWin ? '.exe' : (url.match(/\.tar\.gz$|\.[a-z]+$/i) || ['.bin'])[0];
    const file = path.join(app.getPath('temp'), 'vetroduy-update' + ext);

    const out = fs.createWriteStream(file);
    try {
      await downloadFollow(url, out, 0);
    } finally {
      await new Promise((r) => out.end(r));
    }

    if (isWin) {
      // запускаем установщик и выходим, чтобы он смог обновить файлы
      isQuitting = true;
      await shell.openPath(file);
      setTimeout(() => app.quit(), 800);
    } else {
      // на Linux tar.gz — открываем папку со скачанным архивом
      shell.showItemInFolder(file);
    }
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
});

ipcMain.on('rooms:update', (e, rooms) => {
  trayRooms = Array.isArray(rooms) ? rooms : [];
  rebuildTray();
});

// ---------- прокси к бэкенду (Firebase RTDB REST) для чата/presence/пинга ----------
// Ходим из main, чтобы обойти CORS. base задаёт renderer (из манифеста).
ipcMain.handle('db:req', async (e, opts) => {
  try {
    const { base, method, path, body, query } = opts || {};
    if (!/^https?:\/\//.test(base || '')) return { ok: false, error: 'нет бэкенда' };
    let url = base.replace(/\/+$/, '') + '/' + String(path || '').replace(/^\/+/, '') + '.json';
    if (query) url += (url.includes('?') ? '&' : '?') + query;
    const init = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined && method && method !== 'GET') init.body = JSON.stringify(body);
    const res = await net.fetch(url, init);
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 160) };
  }
});

ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win:close', () => win && win.close());
ipcMain.on('win:mini-toggle', () => toggleMiniMode());

ipcMain.on('open:external', (e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ---------- запуск ----------
app.whenReady().then(() => {
  migrateOldConfig();
  setupSession();
  startMusicProxy();
  createWindow();
  createTray();

  // глобальный мут — работает даже когда окно не в фокусе (в игре и т.д.)
  globalShortcut.register('Control+Shift+M', () => {
    if (win) win.webContents.send('hotkey:mute');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else win.show();
  });
});

app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
