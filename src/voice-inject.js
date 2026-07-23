/* Войс-ченджер ВЕТРОДУЙ.
   Инжектируется в страницу Телемоста комнаты ДО захвата микрофона.
   Подменяем getUserMedia: твой микрофон проходит через цепочку
   WebAudio-эффектов, и в звонок уходит уже изменённый голос.
   Управление: window.__voice.set('normal'|'robot'|'helium'|'demon'|'megaphone'|'echo') */
(function () {
  if (window.__voice) return;
  const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  let ctx = null;
  let source = null;   // микрофон
  let dest = null;     // что уходит в звонок
  let nodes = [];      // активные узлы эффекта
  let current = 'normal';

  function ensureCtx() { if (!ctx) ctx = new AudioContext(); }

  function disconnectChain() {
    try { source && source.disconnect(); } catch {}
    for (const n of nodes) { try { n.disconnect(); } catch {} try { n.stop && n.stop(); } catch {} }
    nodes = [];
  }

  function distortionCurve(amount) {
    const k = amount, n = 44100, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  // Гранулярный питч-шифтер: кольцевой буфер, чтение со скоростью ratio,
  // периодическая пересинхронизация с коротким кроссфейдом (шов сглажен).
  function buildPitchShifter(input, output, ratio) {
    const proc = ctx.createScriptProcessor(1024, 1, 1);
    const RB = 16384;
    const rb = new Float32Array(RB);
    let wp = 0;
    let rp = 0;
    const XFADE = 96;

    proc.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      const y = e.outputBuffer.getChannelData(0);
      for (let i = 0; i < x.length; i++) { rb[wp] = x[i]; wp = (wp + 1) % RB; }
      for (let i = 0; i < y.length; i++) {
        const i0 = rp | 0;
        const frac = rp - i0;
        const s = rb[i0 % RB] * (1 - frac) + rb[(i0 + 1) % RB] * frac;
        y[i] = s;
        rp += ratio;
      }
      // не даём указателю чтения убежать/отстать больше чем на полбуфера
      let dist = (wp - rp % RB + RB) % RB;
      if (dist < 2048 || dist > RB - 4096) {
        // мягкий скачок: переставляем rp на комфортную дистанцию позади wp
        const target = (wp - RB / 2 + RB) % RB;
        // кроссфейд простым затуханием последних сэмплов блока
        for (let i = Math.max(0, y.length - XFADE); i < y.length; i++) {
          y[i] *= (y.length - i) / XFADE;
        }
        rp = target;
      }
    };
    input.connect(proc);
    proc.connect(output);
    nodes.push(proc);
  }

  function applyEffect(name) {
    current = name;
    if (!ctx || !source || !dest) return; // применится при захвате микрофона
    disconnectChain();

    if (name === 'robot') {
      // кольцевая модуляция ~35 Гц
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.frequency.value = 35;
      const ring = ctx.createGain(); ring.gain.value = 0;
      osc.connect(ring.gain); osc.start();
      const boost = ctx.createGain(); boost.gain.value = 1.6;
      source.connect(ring); ring.connect(boost); boost.connect(dest);
      nodes.push(osc, ring, boost);
    } else if (name === 'helium') {
      buildPitchShifter(source, dest, 1.38);
    } else if (name === 'demon') {
      buildPitchShifter(source, dest, 0.72);
    } else if (name === 'megaphone') {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 0.7;
      const ws = ctx.createWaveShaper(); ws.curve = distortionCurve(50); ws.oversample = '2x';
      const g = ctx.createGain(); g.gain.value = 1.3;
      source.connect(bp); bp.connect(ws); ws.connect(g); g.connect(dest);
      nodes.push(bp, ws, g);
    } else if (name === 'echo') {
      const d = ctx.createDelay(1); d.delayTime.value = 0.22;
      const fb = ctx.createGain(); fb.gain.value = 0.34;
      d.connect(fb); fb.connect(d);
      source.connect(dest);
      source.connect(d); d.connect(dest);
      nodes.push(d, fb);
    } else {
      source.connect(dest); // normal
    }
  }

  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await origGUM(constraints);
    try {
      if (!constraints || !constraints.audio) return stream;
      const at = stream.getAudioTracks();
      if (!at.length) return stream;
      ensureCtx();
      try { ctx.resume(); } catch {}
      source = ctx.createMediaStreamSource(new MediaStream([at[0]]));
      dest = ctx.createMediaStreamDestination();
      applyEffect(current);
      const out = new MediaStream();
      dest.stream.getAudioTracks().forEach((t) => out.addTrack(t));
      stream.getVideoTracks().forEach((t) => out.addTrack(t));
      return out;
    } catch {
      return stream; // при любой ошибке отдаём оригинальный микрофон
    }
  };

  window.__voice = {
    set(name) {
      try { ensureCtx(); try { ctx.resume(); } catch {} applyEffect(name); return 'ok:' + name; }
      catch (e) { return 'err:' + (e && e.message); }
    },
    state() { return { effect: current, captured: !!(source && dest) }; }
  };
})();
