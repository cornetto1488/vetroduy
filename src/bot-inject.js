/* Музыкальный бот TELEMOSTushka.
   Инжектируется в страницу Телемоста бота через executeJavaScript
   (мир страницы) ДО первого запроса микрофона.
   Подменяем getUserMedia: вместо микрофона бот отдаёт в звонок музыку. */
(function () {
  if (window.__bot) return; // уже установлен
  const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  let ctx = null;
  let gain = null;
  let dest = null;
  let audioEl = null;
  let sfxEl = null;
  let sfxGain = null;
  let duckTimer = null;

  function ensureGraph() {
    if (ctx) return;
    ctx = new AudioContext();
    gain = ctx.createGain();
    gain.gain.value = 0.5;
    dest = ctx.createMediaStreamDestination();
    gain.connect(dest);

    audioEl = new Audio();
    audioEl.crossOrigin = 'anonymous';
    const src = ctx.createMediaElementSource(audioEl);
    src.connect(gain);
    // локально музыку не воспроизводим — только в звонок

    // отдельная дорожка для коротких звуков (саундборд, реплики воздухана):
    // играет поверх музыки, не сбивая текущий трек
    sfxEl = new Audio();
    sfxEl.crossOrigin = 'anonymous';
    sfxGain = ctx.createGain();
    sfxGain.gain.value = 1;
    ctx.createMediaElementSource(sfxEl).connect(sfxGain);
    sfxGain.connect(dest);
  }

  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints && constraints.audio) {
      ensureGraph();
      const stream = new MediaStream();
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      if (constraints.video) {
        // камера боту не нужна — чёрная заглушка, чтобы Телемост не падал
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 640; canvas.height = 360;
          const c2d = canvas.getContext('2d');
          c2d.fillStyle = '#000'; c2d.fillRect(0, 0, 640, 360);
          const vs = canvas.captureStream(5);
          vs.getVideoTracks().forEach((t) => stream.addTrack(t));
        } catch {}
      }
      return stream;
    }
    return origGUM(constraints);
  };

  window.__bot = {
    play(url) {
      ensureGraph();
      try { ctx.resume(); } catch {}
      audioEl.src = url;
      return audioEl.play().then(() => 'playing').catch((e) => 'err:' + (e && e.message));
    },
    // короткий звук поверх музыки: мем из саундборда или реплика воздухана
    sfx(url, volume) {
      ensureGraph();
      try { ctx.resume(); } catch {}
      const was = gain.gain.value;
      const restore = () => {
        if (duckTimer) { clearTimeout(duckTimer); duckTimer = null; }
        gain.gain.value = was;
      };
      sfxGain.gain.value = Math.max(0, Math.min(1, typeof volume === 'number' ? volume : 1));
      gain.gain.value = was * 0.25;            // музыку на время приглушаем
      // саундборд — это короткие звуки: длинное обрываем, чтобы кнопка
      // случайно не заиграла пятиминутный трек поверх музыки
      duckTimer = setTimeout(() => { try { sfxEl.pause(); } catch {} restore(); }, 20000);
      sfxEl.onended = restore;
      sfxEl.onerror = restore;
      sfxEl.src = url;
      return sfxEl.play().then(() => 'playing').catch((e) => { restore(); return 'err:' + (e && e.message); });
    },
    pause() {
      if (audioEl) audioEl.pause();
      return 'paused';
    },
    resume() {
      if (!audioEl || !audioEl.currentSrc) return 'nosrc';
      try { ctx.resume(); } catch {}
      return audioEl.play().then(() => 'playing').catch((e) => 'err:' + (e && e.message));
    },
    stop() {
      if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); try { audioEl.load(); } catch {} }
      return 'stopped';
    },
    volume(v) {
      ensureGraph();
      gain.gain.value = Math.max(0, Math.min(1, v));
      return gain.gain.value;
    },
    state() {
      return {
        playing: !!(audioEl && !audioEl.paused && !audioEl.ended && audioEl.currentSrc),
        paused: !!(audioEl && audioEl.paused && audioEl.currentSrc),
        ended: !!(audioEl && audioEl.ended),
        time: audioEl ? Math.floor(audioEl.currentTime) : 0,
        volume: gain ? gain.gain.value : 0.5,
        src: audioEl ? audioEl.currentSrc : ''
      };
    }
  };
})();
