(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const audio = $('audio');
  const app = document.querySelector('.app');
  const artBlock = document.querySelector('.art-block');
  const els = {
    fileInput: $('fileInput'),
    list: $('list'), empty: $('empty'), count: $('count'),
    art: $('art'),
    status: $('status'), title: $('title'), sub: $('sub'),
    viz: $('viz'),
    progress: $('progress'), fill: $('fill'), head: $('head'),
    tCur: $('tCur'), tDur: $('tDur'),
    play: $('play'), prev: $('prev'), next: $('next'),
    shuffle: $('shuffle'), repeat: $('repeat'), repeatBadge: $('repeatBadge'),
    mute: $('mute'), volume: $('volume'),
    toast: $('toast'),
  };

  const COLORS = { red: '#E8312A', blue: '#1B4BFF', yellow: '#FFD21F', black: '#0A0A0A', white: '#F4F1EA' };

  // ---------- state ----------
  let tracks = [];
  let current = -1;
  let shuffle = false;
  let repeat = 'off'; // off | all | one
  let nextId = 1;
  let seeking = false;

  // web audio
  let actx = null, analyser = null, freq = null;

  // ---------- helpers ----------
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) return '0:00';
    return `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;
  };

  function parseName(filename) {
    const base = filename.replace(/\.[^/.]+$/, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
    const parts = base.split(/\s+-\s+/);
    if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(' - ') };
    return { artist: 'Local file', title: base };
  }

  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  // ---------- generative cover art (Bauhaus tiles, seeded) ----------
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function drawArt(canvas, seed) {
    const c = canvas.getContext('2d');
    const S = canvas.width;
    const N = 4;
    const s = S / N;
    const rnd = mulberry32(hashStr(seed));
    const pal = [COLORS.red, COLORS.blue, COLORS.yellow, COLORS.black, COLORS.white];
    const pick = (not) => {
      let p;
      do { p = pal[Math.floor(rnd() * pal.length)]; } while (p === not);
      return p;
    };
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];

    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        const x = gx * s, y = gy * s;
        const bg = pick();
        const fg = pick(bg);
        const type = Math.floor(rnd() * 7);
        const r = Math.floor(rnd() * 4);

        c.save();
        c.translate(x, y);
        c.fillStyle = bg;
        c.fillRect(0, 0, s + 0.5, s + 0.5);
        c.fillStyle = fg;

        if (type === 1) {                       // full circle / ring
          c.beginPath(); c.arc(s / 2, s / 2, s * 0.42, 0, Math.PI * 2); c.fill();
          if (rnd() > 0.5) {
            c.fillStyle = pick(fg);
            c.beginPath(); c.arc(s / 2, s / 2, s * 0.2, 0, Math.PI * 2); c.fill();
          }
        } else if (type === 2) {                // quarter circle
          const [cx, cy] = corners[r];
          c.beginPath();
          c.moveTo(cx * s, cy * s);
          c.arc(cx * s, cy * s, s, r * Math.PI / 2, r * Math.PI / 2 + Math.PI / 2);
          c.closePath(); c.fill();
        } else if (type === 3) {                // half circle
          const mids = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
          const [mx, my] = mids[r];
          c.beginPath();
          c.arc(mx * s, my * s, s / 2, r * Math.PI / 2, r * Math.PI / 2 + Math.PI);
          c.closePath(); c.fill();
        } else if (type === 4) {                // triangle
          const a = corners[r], b = corners[(r + 1) % 4], d = corners[(r + 2) % 4];
          c.beginPath();
          c.moveTo(a[0] * s, a[1] * s); c.lineTo(b[0] * s, b[1] * s); c.lineTo(d[0] * s, d[1] * s);
          c.closePath(); c.fill();
        } else if (type === 5) {                // stripes
          const horizontal = r % 2 === 0;
          for (let i = 0; i < 3; i++) {
            if (horizontal) c.fillRect(0, s * (i * 0.34 + 0.02), s, s * 0.16);
            else c.fillRect(s * (i * 0.34 + 0.02), 0, s * 0.16, s);
          }
        } else if (type === 6) {                // inset square
          c.fillRect(s * 0.2, s * 0.2, s * 0.6, s * 0.6);
        }
        c.restore();
      }
    }
  }

  // ---------- audio graph ----------
  function ensureGraph() {
    if (actx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      actx = new AC();
      const src = actx.createMediaElementSource(audio);
      analyser = actx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.8;
      src.connect(analyser);
      analyser.connect(actx.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
    } catch (e) {
      actx = null; analyser = null;
    }
  }

  // ---------- queue ----------
  function makeRow(t) {
    const li = document.createElement('li');
    li.className = 'track';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');

    const thumb = document.createElement('canvas');
    thumb.className = 'thumb';
    thumb.width = 112; thumb.height = 112;
    drawArt(thumb, t.seed);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = t.title;
    const sub = document.createElement('div');
    sub.className = 'row-sub';
    const eq = document.createElement('span');
    eq.className = 'eq';
    eq.innerHTML = '<i></i><i></i><i></i>';
    const idx = document.createElement('span');
    const artist = document.createElement('span');
    artist.textContent = t.artist;
    sub.append(eq, idx, artist);
    meta.append(name, sub);

    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = '—:—';

    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.setAttribute('aria-label', `Remove ${t.title}`);
    rm.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 1l10 10M11 1L1 11"/></svg>';
    rm.addEventListener('click', (e) => { e.stopPropagation(); removeTrack(t); });

    li.append(thumb, meta, dur, rm);
    li.addEventListener('click', () => {
      const i = tracks.indexOf(t);
      if (i === current) togglePlay(); else load(i, true);
    });
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      if (e.key === 'Enter') { e.preventDefault(); li.click(); }
    });

    t.row = li; t.idxEl = idx; t.durEl = dur;
  }

  function renderQueue() {
    els.list.replaceChildren();
    if (tracks.length === 0) {
      els.list.appendChild(els.empty);
    } else {
      tracks.forEach((t, i) => {
        t.idxEl.textContent = pad2(i + 1);
        t.row.classList.toggle('active', i === current);
        els.list.appendChild(t.row);
      });
    }
    els.count.textContent = `${tracks.length} TRACK${tracks.length === 1 ? '' : 'S'}`;
  }

  function syncActive() {
    tracks.forEach((t, i) => t.row.classList.toggle('active', i === current));
  }

  function addFiles(fileList) {
    const files = [...fileList].filter(
      (f) => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac|opus|weba)$/i.test(f.name)
    );
    if (files.length === 0) { toast('No audio files found'); return; }

    const wasEmpty = tracks.length === 0;
    let added = 0;
    files.forEach((f) => {
      if (tracks.some((t) => t.file.name === f.name && t.file.size === f.size)) return;
      const { artist, title } = parseName(f.name);
      const t = { id: nextId++, file: f, url: URL.createObjectURL(f), artist, title, duration: null, seed: `${f.name}:${f.size}` };
      makeRow(t);
      tracks.push(t);
      added++;

      const probe = new Audio();
      probe.preload = 'metadata';
      probe.src = t.url;
      probe.addEventListener('loadedmetadata', () => {
        t.duration = probe.duration;
        t.durEl.textContent = fmt(probe.duration);
      }, { once: true });
    });

    if (added === 0) { toast('Already in your queue'); return; }
    renderQueue();
    toast(`${added} track${added === 1 ? '' : 's'} added`);
    if (wasEmpty) load(0, true);
  }

  function removeTrack(t) {
    const i = tracks.indexOf(t);
    if (i === -1) return;
    const wasPlaying = !audio.paused;
    tracks.splice(i, 1);
    URL.revokeObjectURL(t.url);

    if (tracks.length === 0) {
      current = -1;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      renderQueue(); renderNow(); renderStatus();
      return;
    }
    if (i < current) {
      current--;
    } else if (i === current) {
      current = -1;
      renderQueue();
      load(Math.min(i, tracks.length - 1), wasPlaying);
      return;
    }
    renderQueue();
  }

  // ---------- playback ----------
  function load(i, autoplay) {
    if (i < 0 || i >= tracks.length) return;
    current = i;
    audio.src = tracks[i].url;
    syncActive();
    renderNow();
    if (autoplay) play();
    renderStatus();
  }

  function play() {
    ensureGraph();
    if (actx && actx.state === 'suspended') actx.resume();
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
  }

  function togglePlay() {
    if (current === -1) {
      if (tracks.length) load(0, true); else els.fileInput.click();
      return;
    }
    if (audio.paused) play(); else audio.pause();
  }

  function next(fromEnded) {
    if (!tracks.length) return;
    if (fromEnded && repeat === 'one') { audio.currentTime = 0; play(); return; }
    let n;
    if (shuffle && tracks.length > 1) {
      do { n = Math.floor(Math.random() * tracks.length); } while (n === current);
    } else {
      n = current + 1;
      if (n >= tracks.length) {
        if (repeat === 'all' || !fromEnded) n = 0;
        else { audio.pause(); audio.currentTime = 0; renderStatus(); return; }
      }
    }
    load(n, true);
  }

  function prev() {
    if (!tracks.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    load((current - 1 + tracks.length) % tracks.length, true);
  }

  function seekBy(sec) {
    if (isFinite(audio.duration)) audio.currentTime = clamp(audio.currentTime + sec, 0, audio.duration);
  }

  // ---------- UI sync ----------
  function renderNow() {
    const t = tracks[current];
    if (!t) {
      els.title.textContent = 'Drop some sound';
      els.sub.textContent = 'Load audio files to begin';
      drawArt(els.art, 'prima');
      document.title = 'PRIMA — Music Player';
      updateProgress(true);
      return;
    }
    els.title.textContent = t.title;
    els.sub.textContent = `${t.artist} · ${pad2(current + 1)}/${pad2(tracks.length)}`;
    drawArt(els.art, t.seed);
    artBlock.classList.remove('swap');
    void artBlock.offsetWidth;
    artBlock.classList.add('swap');
    document.title = `${t.title} — PRIMA`;
    updateMediaSession(t);
  }

  function renderStatus() {
    const playing = current !== -1 && !audio.paused;
    els.status.textContent = current === -1 ? 'Nothing playing' : playing ? 'Now playing' : 'Paused';
    app.classList.toggle('is-playing', playing);
    els.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  let lastCur = '', lastDur = '';
  function updateProgress(force) {
    const d = audio.duration, c = audio.currentTime;
    const ok = current !== -1 && isFinite(d) && d > 0;
    const p = ok ? c / d : 0;
    els.fill.style.width = `${p * 100}%`;
    els.head.style.left = `${p * 100}%`;
    const cs = fmt(ok ? c : 0), ds = fmt(ok ? d : 0);
    if (force || cs !== lastCur) { els.tCur.textContent = cs; lastCur = cs; }
    if (force || ds !== lastDur) { els.tDur.textContent = ds; lastDur = ds; }
    els.progress.setAttribute('aria-valuenow', Math.round(p * 100));
  }

  function syncVolumeUI() {
    const v = audio.muted ? 0 : audio.volume;
    els.volume.value = audio.volume;
    els.volume.style.setProperty('--v', `${audio.volume * 100}%`);
    els.mute.querySelector('svg').classList.toggle('muted', audio.muted || v === 0);
    els.mute.setAttribute('aria-label', audio.muted ? 'Unmute' : 'Mute');
  }

  function setVolume(v) {
    audio.volume = clamp(v, 0, 1);
    if (audio.volume > 0) audio.muted = false;
    syncVolumeUI();
  }

  function syncModes() {
    els.shuffle.setAttribute('aria-pressed', String(shuffle));
    els.repeat.setAttribute('aria-pressed', String(repeat !== 'off'));
    els.repeat.setAttribute('aria-label', `Repeat: ${repeat}`);
    els.repeatBadge.textContent = repeat === 'one' ? '1' : '';
  }

  // ---------- media session ----------
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) { /* unsupported */ } };
    set('play', play);
    set('pause', () => audio.pause());
    set('previoustrack', prev);
    set('nexttrack', () => next(false));
    set('seekto', (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
  }
  function updateMediaSession(t) {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: t.artist, album: 'PRIMA',
        artwork: [{ src: els.art.toDataURL('image/png'), sizes: '640x640', type: 'image/png' }],
      });
    } catch (e) { /* ignore */ }
  }

  // ---------- spectrum + progress loop ----------
  const vctx = els.viz.getContext('2d');
  let vw = 1, vh = 1, dpr = 1;
  const BARS = 32;
  const peaks = new Float32Array(BARS);
  const barColors = [COLORS.yellow, COLORS.red, COLORS.black];

  function resizeViz() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = els.viz.getBoundingClientRect();
    vw = Math.max(1, Math.round(r.width * dpr));
    vh = Math.max(1, Math.round(r.height * dpr));
    els.viz.width = vw; els.viz.height = vh;
  }
  new ResizeObserver(resizeViz).observe(els.viz.parentElement);
  resizeViz();

  function drawViz(t) {
    vctx.clearRect(0, 0, vw, vh);
    const live = analyser && !audio.paused && current !== -1;
    if (live) analyser.getByteFrequencyData(freq);

    const gap = Math.round(6 * dpr);
    const bw = (vw - gap * (BARS + 1)) / BARS;
    const maxH = vh - gap * 2;

    for (let i = 0; i < BARS; i++) {
      let v;
      if (live) {
        v = freq[i] / 255;
        v = Math.min(1, v * (1 + (i / BARS) * 0.9));
        v = Math.pow(v, 1.2);
      } else {
        v = 0.05 + 0.04 * (Math.sin(t / 600 + i * 0.55) + 1);
      }
      const h = Math.max(4 * dpr, v * maxH);
      const x = gap + i * (bw + gap);
      vctx.fillStyle = barColors[i % 3];
      vctx.fillRect(x, vh - h, bw, h);

      peaks[i] = Math.max(v, peaks[i] - 0.007);
      if (peaks[i] > v + 0.03) {
        vctx.fillStyle = COLORS.white;
        vctx.fillRect(x, vh - peaks[i] * maxH - 6 * dpr, bw, 3 * dpr);
      }
    }
  }

  function frame(t) {
    requestAnimationFrame(frame);
    if (!seeking) updateProgress();
    drawViz(t);
  }

  // ---------- seeking ----------
  function seekFromPointer(e) {
    if (!isFinite(audio.duration)) return;
    const r = els.progress.getBoundingClientRect();
    const p = clamp((e.clientX - r.left) / r.width, 0, 1);
    audio.currentTime = p * audio.duration;
    els.fill.style.width = `${p * 100}%`;
    els.head.style.left = `${p * 100}%`;
    els.tCur.textContent = fmt(audio.currentTime);
  }
  els.progress.addEventListener('pointerdown', (e) => {
    if (current === -1) return;
    seeking = true;
    els.progress.setPointerCapture(e.pointerId);
    seekFromPointer(e);
  });
  els.progress.addEventListener('pointermove', (e) => { if (seeking) seekFromPointer(e); });
  const endSeek = () => { seeking = false; };
  els.progress.addEventListener('pointerup', endSeek);
  els.progress.addEventListener('pointercancel', endSeek);

  // ---------- events ----------
  document.querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', () => els.fileInput.click()));
  els.fileInput.addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) addFiles(files);
  });

  els.play.addEventListener('click', togglePlay);
  els.prev.addEventListener('click', prev);
  els.next.addEventListener('click', () => next(false));
  els.shuffle.addEventListener('click', () => { shuffle = !shuffle; syncModes(); });
  els.repeat.addEventListener('click', () => {
    repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
    syncModes();
  });
  els.mute.addEventListener('click', () => { audio.muted = !audio.muted; syncVolumeUI(); });
  els.volume.addEventListener('input', () => setVolume(parseFloat(els.volume.value)));

  audio.addEventListener('play', renderStatus);
  audio.addEventListener('pause', renderStatus);
  audio.addEventListener('ended', () => next(true));
  audio.addEventListener('loadedmetadata', () => {
    const t = tracks[current];
    if (t) { t.duration = audio.duration; t.durEl.textContent = fmt(audio.duration); }
    updateProgress(true);
  });
  audio.addEventListener('error', () => {
    if (current === -1) return;
    toast("Couldn't play that file");
    if (current + 1 < tracks.length) next(false);
  });

  // drag & drop anywhere
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0;
    document.body.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target.tagName;
    const isRange = tag === 'INPUT' && e.target.type === 'range';
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && !isRange)) return;

    switch (e.code) {
      case 'Space':
        if (tag === 'BUTTON') return;
        e.preventDefault(); togglePlay(); break;
      case 'ArrowRight': if (isRange) return; e.preventDefault(); seekBy(5); break;
      case 'ArrowLeft':  if (isRange) return; e.preventDefault(); seekBy(-5); break;
      case 'ArrowUp':    if (isRange) return; e.preventDefault(); setVolume(audio.volume + 0.05); break;
      case 'ArrowDown':  if (isRange) return; e.preventDefault(); setVolume(audio.volume - 0.05); break;
      case 'KeyN': next(false); break;
      case 'KeyP': prev(); break;
      case 'KeyM': audio.muted = !audio.muted; syncVolumeUI(); break;
      case 'KeyS': shuffle = !shuffle; syncModes(); break;
      case 'KeyR': els.repeat.click(); break;
    }
  });

  // ---------- init ----------
  audio.volume = 0.8;
  drawArt(els.art, 'prima');
  syncVolumeUI();
  syncModes();
  renderQueue();
  renderStatus();
  updateProgress(true);
  setupMediaSession();
  requestAnimationFrame(frame);
})();
