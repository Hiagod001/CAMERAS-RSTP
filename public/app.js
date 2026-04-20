/* =====================================================
   NVR Web — app.js
   Melhorias principais:
   1. Monitor: lazy load com IntersectionObserver → muitas câmeras sem travar
   2. Câmeras: formulário completo + edição inline
   3. Gravações: filtros, busca, seleção múltipla, modal de preview
   ===================================================== */

const state = {
  user: null,
  cameras: [],
  players: new Map(),        // cameraId → { hls, video, watchdog, ready }
  visibleTiles: new Set(),   // tiles com observer ativo
  currentView: 'monitor',
  layout: 9,
  recordings: [],
  selectedRecordings: new Set(),
  users: [],
  settings: { recordingRetentionDays: null },
  focusedCameraId: localStorage.getItem('uai.focusedCameraId') || null
};

/* ── HELPERS ── */
const $  = (id) => document.getElementById(id);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

function showToast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${type === 'error' ? 'err' : type === 'success' ? 'ok' : ''}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 2800);
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro na requisição');
  return data;
}

function confirm(title, msg) {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title;
    $('confirmMsg').textContent   = msg;
    $('confirmModal').classList.remove('hidden');
    const ok  = $('confirmOk');
    const no  = $('confirmCancel');
    function cleanup(val) {
      $('confirmModal').classList.add('hidden');
      ok.replaceWith(ok.cloneNode(true));
      no.replaceWith(no.cloneNode(true));
      resolve(val);
    }
    $('confirmOk').addEventListener('click', () => cleanup(true),  { once: true });
    $('confirmCancel').addEventListener('click', () => cleanup(false), { once: true });
  });
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1024/1024).toFixed(1)} MB`;
}
function formatDate(iso) {
  return new Date(iso).toLocaleString('pt-BR');
}

function setAuthMode() {
  $('loginForm').classList.remove('hidden');
  $('loginMsg').textContent = '';
  if ($('registerMsg')) $('registerMsg').textContent = '';
}

function updateFullscreenButtons() {
  const isFull = document.body.classList.contains('fullscreen-grid');
  $('fullscreenBtn').textContent = isFull ? '⛶ Monitor em tela cheia' : '⛶ Tela cheia';
  $('exitFullscreenBtn').classList.toggle('hidden', !isFull);
}

function persistMonitorPrefs() {
  localStorage.setItem('uai.monitorLayout', String(state.layout));
  if (state.focusedCameraId) localStorage.setItem('uai.focusedCameraId', state.focusedCameraId);
  else localStorage.removeItem('uai.focusedCameraId');
}

function focusCamera(cameraId) {
  state.focusedCameraId = cameraId;
  state.layout = 1;
  $('layoutSelect').value = '1';
  persistMonitorPrefs();
  renderGrid();
}

function clearFocusedCamera() {
  state.focusedCameraId = null;
  persistMonitorPrefs();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function applyZoom(tile, zoomState) {
  const media = tile.querySelector('.camera-media');
  if (!media) return;
  media.style.transform = `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`;
  tile.classList.toggle('zoomed', zoomState.scale > 1.01);
}

function resetZoom(tile) {
  tile._zoomState = { scale: 1, x: 0, y: 0, startDistance: 0, startScale: 1, pinchCenter: null, dragStartX: 0, dragStartY: 0, baseX: 0, baseY: 0, dragging: false };
  applyZoom(tile, tile._zoomState);
}

function setupZoom(tile) {
  const media = tile.querySelector('.camera-media');
  if (!media) return;
  resetZoom(tile);

  const getDistance = (touches) => Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY
  );

  const getCenter = (touches) => ({
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2
  });

  tile.addEventListener('wheel', (e) => {
    e.preventDefault();
    const z = tile._zoomState;
    const previous = z.scale;
    const next = clamp(previous + (e.deltaY < 0 ? 0.18 : -0.18), 1, 5);
    if (next === previous) return;
    const rect = tile.getBoundingClientRect();
    const ox = e.clientX - rect.left - rect.width / 2;
    const oy = e.clientY - rect.top - rect.height / 2;
    const ratio = next / previous;
    z.x = clamp((z.x - ox) * ratio + ox, -rect.width * 2, rect.width * 2);
    z.y = clamp((z.y - oy) * ratio + oy, -rect.height * 2, rect.height * 2);
    z.scale = next;
    if (next === 1) { z.x = 0; z.y = 0; }
    applyZoom(tile, z);
  }, { passive: false });

  tile.addEventListener('pointerdown', (e) => {
    if (tile._zoomState.scale <= 1.01) return;
    tile._zoomState.dragging = true;
    tile._zoomState.dragStartX = e.clientX;
    tile._zoomState.dragStartY = e.clientY;
    tile._zoomState.baseX = tile._zoomState.x;
    tile._zoomState.baseY = tile._zoomState.y;
    tile.setPointerCapture?.(e.pointerId);
  });

  tile.addEventListener('pointermove', (e) => {
    const z = tile._zoomState;
    if (!z.dragging) return;
    z.x = z.baseX + (e.clientX - z.dragStartX);
    z.y = z.baseY + (e.clientY - z.dragStartY);
    applyZoom(tile, z);
  });

  const stopDrag = (e) => {
    tile._zoomState.dragging = false;
    try { tile.releasePointerCapture?.(e.pointerId); } catch {}
  };
  tile.addEventListener('pointerup', stopDrag);
  tile.addEventListener('pointercancel', stopDrag);

  tile.addEventListener('touchstart', (e) => {
    const z = tile._zoomState;
    if (e.touches.length === 2) {
      z.startDistance = getDistance(e.touches);
      z.startScale = z.scale;
      z.pinchCenter = getCenter(e.touches);
    }
  }, { passive: true });

  tile.addEventListener('touchmove', (e) => {
    const z = tile._zoomState;
    if (e.touches.length !== 2 || !z.startDistance) return;
    e.preventDefault();
    const newDistance = getDistance(e.touches);
    z.scale = clamp(z.startScale * (newDistance / z.startDistance), 1, 5);
    if (z.scale === 1) { z.x = 0; z.y = 0; }
    applyZoom(tile, z);
  }, { passive: false });

  tile.addEventListener('touchend', () => {
    const z = tile._zoomState;
    if (z.scale <= 1.01) { z.x = 0; z.y = 0; }
    z.startDistance = 0;
    applyZoom(tile, z);
  }, { passive: true });
}


function showTileLoading(tile, label) {
  let spinner = tile.querySelector('.cam-loading-indicator');
  if (!spinner) {
    spinner = el('div', 'cam-loading-indicator');
    spinner.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;background:#000;font-size:12px;color:var(--text-3);';
    tile.appendChild(spinner);
  }
  spinner.innerHTML = `<div class="spinner"></div><span>${label || 'Carregando...'}</span>`;
}

function hideTileLoading(tile) {
  tile.querySelector('.cam-loading-indicator')?.remove();
}

function markTilePlaying(tile) {
  hideTileLoading(tile);
  tile.classList.add('stream-playing');
}

function markTileError(tile, message) {
  showTileLoading(tile, message || 'Reconectando...');
  tile.classList.remove('stream-playing');
}

/* ── PLAYER ── */
function mountPlayer(video, src, cameraId, attempt = 0, tile = null) {
  const source = `${src}${src.includes('?') ? '&' : '?'}t=${Date.now()}`;
  const playingEvents = ['loadeddata', 'canplay', 'playing'];
  let ready = false;
  const onReady = () => {
    ready = true;
    if (tile) markTilePlaying(tile);
    video.play().catch(() => {});
  };
  playingEvents.forEach((evt) => video.addEventListener(evt, onReady, { once: true }));

  const scheduleRetry = (message) => {
    if (tile) markTileError(tile, message || 'Reconectando stream...');
    const tries = Math.min(attempt + 1, 10);
    setTimeout(() => {
      if (state.currentView !== 'monitor') return;
      const cur = state.players.get(cameraId);
      if (cur && cur.video === video) {
        state.players.set(cameraId, mountPlayer(video, src, cameraId, tries, tile));
      }
    }, Math.min(tries * 1500, 8000));
  };

  const watchdog = setTimeout(() => {
    if (!ready && state.currentView === 'monitor') {
      try { video.pause(); } catch {}
      scheduleRetry('Sem imagem no monitor. Tentando novamente...');
    }
  }, 8000);

  video.addEventListener('error', () => scheduleRetry('Erro no player. Reconectando...'), { once: true });

  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({
      liveSyncDurationCount: 2,
      maxLiveSyncPlaybackRate: 1.4,
      enableWorker: true,
      manifestLoadingRetryDelay: 1200,
      levelLoadingRetryDelay: 1200,
      fragLoadingRetryDelay: 1200,
      xhrSetup(xhr) { xhr.timeout = 10000; }
    });
    hls.loadSource(source);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
    hls.on(Hls.Events.ERROR, (_ev, data) => {
      if (data?.fatal) {
        try { hls.destroy(); } catch {}
        clearTimeout(watchdog);
        scheduleRetry('Stream indisponível. Reconectando...');
      }
    });
    return { hls, video, watchdog, ready };
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = source;
    video.addEventListener('loadedmetadata', () => video.play().catch(() => {}), { once: true });
    return { hls: null, video, watchdog, ready };
  }

  video.src = source;
  video.addEventListener('loadedmetadata', () => video.play().catch(() => {}), { once: true });
  return { hls: null, video, watchdog, ready };
}

function destroyPlayer(cameraId) {
  const p = state.players.get(cameraId);
  if (!p) return;
  try { if (p.watchdog) clearTimeout(p.watchdog); } catch {}
  try { if (p.hls) p.hls.destroy(); } catch {}
  try { p.video.pause(); p.video.removeAttribute('src'); p.video.load(); } catch {}
  state.players.delete(cameraId);
}

function destroyAllPlayers() {
  for (const id of state.players.keys()) destroyPlayer(id);
}

/* ── VIEW ROUTING ── */
function setView(view) {
  state.currentView = view;

  document.querySelectorAll('.view').forEach(e => e.classList.remove('active'));
  document.querySelectorAll('.menu-btn').forEach(e => e.classList.remove('active'));
  $(`view-${view}`).classList.add('active');
  document.querySelector(`.menu-btn[data-view="${view}"]`)?.classList.add('active');

  const titles = { monitor: 'Monitoramento', cameras: 'Câmeras', users: 'Usuários', recordings: 'Gravações', settings: 'Status' };
  $('topbarTitle').textContent = titles[view] || '';
  $('monitorTools').style.display = view === 'monitor' ? '' : 'none';

  if (view !== 'monitor') destroyAllPlayers();
  if (view === 'monitor')   renderGrid();
  if (view === 'recordings') loadRecordings();
  if (view === 'settings')  loadHealth();
}

/* ═══════════════════════════════════════════════════════
   MONITOR — lazy loading com IntersectionObserver
   ═══════════════════════════════════════════════════════ */

// Observer: só carrega o stream quando o tile está visível na tela
const tileObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const tile = entry.target;
    const camId = tile.dataset.camId;
    if (!camId) continue;

    if (entry.isIntersecting) {
      // Tile visível → inicia stream se ainda não iniciou
      if (!state.players.has(camId)) {
        const camera = state.cameras.find(c => c.id === camId);
        if (camera) activateTile(tile, camera);
      }
    } else {
      // Tile fora da tela → destrói player para liberar recursos
      // Só destroi se o grid tiver muitas câmeras (>6) para evitar flickering
      if (state.layout > 6 && state.players.has(camId)) {
        destroyPlayer(camId);
        // Reseta tile para estado de "aguardando"
        const video = tile.querySelector('video');
        if (video) { try { video.pause(); video.removeAttribute('src'); video.load(); } catch {} }
      }
    }
  }
}, {
  threshold: 0.1,  // 10% visível já ativa
  rootMargin: '50px'
});

function activateTile(tile, camera) {
  const video = tile.querySelector('video');
  if (!video) return;
  showTileLoading(tile, `Conectando: ${camera.name}`);
  state.players.set(camera.id, mountPlayer(video, camera.hlsUrl, camera.id, 0, tile));
}

function cameraTile(camera) {
  const tile = el('div', 'camera-tile');
  tile.dataset.camId = camera.id;
  tile.dataset.recording = camera.recording ? '1' : '0';
  tile.dataset.online = camera.online ? '1' : '0';

  // Indicador de status
  const dot = el('div', `cam-status-dot monitor-status-dot${camera.online ? ' live' : ''}`);
  tile.appendChild(dot);

  // Badge de gravação
  if (camera.recording) {
    const recBadge = el('div', 'cam-rec-badge monitor-rec-badge');
    recBadge.textContent = '● REC';
    tile.appendChild(recBadge);
  }

  // Video element
  const media = el('div', 'camera-media');
  const video = el('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.controls = false;
  media.appendChild(video);
  tile.appendChild(media);

  // Spinner (substituído quando o player inicia)
  showTileLoading(tile, camera.name);

  // Overlay com nome e ações
  const overlay = el('div', 'camera-overlay');
  const name = el('div', 'camera-tile-name monitor-name');
  name.textContent = camera.name;
  const meta = el('div', 'camera-tile-meta monitor-meta');
  meta.textContent = camera.recording ? '● Gravando' : (camera.online ? 'Ao vivo' : 'Reconectando...');
  if (camera.recording) meta.style.color = 'var(--red)';

  const actions = el('div', 'cam-tile-actions');
  const recBtn = el('button', `monitor-rec-btn ${camera.recording ? 'btn-danger' : ''}`.trim());
  recBtn.textContent = camera.recording ? '■ Parar' : '⏺ Gravar';
  recBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isRecording = tile.dataset.recording === '1';
    try {
      await api(`/api/cameras/${camera.id}/record/${isRecording ? 'stop' : 'start'}`, { method: 'POST' });
      showToast(isRecording ? 'Gravação parada' : 'Gravação iniciada', 'success');
      $('layoutSelect').value = String(state.layout);
  await refreshCameras();
    } catch (err) { showToast(err.message, 'error'); }
  });

  const focusBtn = el('button', 'btn-ghost');
  focusBtn.textContent = state.focusedCameraId === camera.id ? '↺ Voltar ao mosaico' : '⛶ Focar';
  focusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.focusedCameraId === camera.id) {
      clearFocusedCamera();
      renderGrid();
      return;
    }
    focusCamera(camera.id);
  });

  actions.append(recBtn, focusBtn);
  overlay.append(name, meta, actions);
  tile.appendChild(overlay);

  // Clique no tile → foca câmera (layout 1)
  tile.addEventListener('dblclick', () => {
    focusCamera(camera.id);
  });

  setupZoom(tile);
  return tile;
}


function getVisibleMonitorCameras() {
  const enabled = state.cameras.filter(c => c.enabled);
  if (state.focusedCameraId) {
    const focused = enabled.find((c) => c.id === state.focusedCameraId);
    if (focused) return [focused];
    state.focusedCameraId = null;
    persistMonitorPrefs();
  }
  return enabled.slice(0, state.layout);
}

function currentGridSignature() {
  return Array.from(document.querySelectorAll('#cameraGrid .camera-tile[data-cam-id]')).map(t => t.dataset.camId).join('|');
}

function desiredGridSignature() {
  return getVisibleMonitorCameras().map(c => c.id).join('|');
}

function updateMonitorTile(tile, camera) {
  tile.dataset.recording = camera.recording ? '1' : '0';
  tile.dataset.online = camera.online ? '1' : '0';

  const dot = tile.querySelector('.monitor-status-dot');
  if (dot) dot.classList.toggle('live', !!camera.online);

  let recBadge = tile.querySelector('.monitor-rec-badge');
  if (camera.recording) {
    if (!recBadge) {
      recBadge = el('div', 'cam-rec-badge monitor-rec-badge');
      recBadge.textContent = '● REC';
      tile.appendChild(recBadge);
    }
  } else {
    recBadge?.remove();
  }

  const name = tile.querySelector('.monitor-name');
  if (name) name.textContent = camera.name;

  const meta = tile.querySelector('.monitor-meta');
  if (meta) {
    meta.textContent = camera.recording ? '● Gravando' : (camera.online ? 'Ao vivo' : (camera.reconnecting ? 'Reconectando em breve...' : 'Conectando...'));
    meta.style.color = camera.recording ? 'var(--red)' : '';
  }

  const recBtn = tile.querySelector('.monitor-rec-btn');
  if (recBtn) {
    recBtn.textContent = camera.recording ? '■ Parar' : '⏺ Gravar';
    recBtn.classList.toggle('btn-danger', !!camera.recording);
  }

  if (!state.players.has(camera.id) && !tile._activationScheduled) {
    tile._activationScheduled = true;
    setTimeout(() => {
      tile._activationScheduled = false;
      if (state.currentView !== 'monitor') return;
      if (!document.body.contains(tile)) return;
      if (tile._observed) return;
      tileObserver.observe(tile);
      tile._observed = true;
    }, 50);
  }
}

function syncMonitorGrid() {
  const desired = desiredGridSignature();
  if (currentGridSignature() !== desired) {
    renderGrid();
    return;
  }
  const visible = getVisibleMonitorCameras();
  for (const camera of visible) {
    const tile = document.querySelector(`#cameraGrid .camera-tile[data-cam-id="${camera.id}"]`);
    if (tile) updateMonitorTile(tile, camera);
  }
}

function renderGrid() {
  // Remove observers anteriores
  for (const tile of document.querySelectorAll('.camera-tile[data-cam-id]')) {
    tileObserver.unobserve(tile);
    tile._observed = false;
  }
  destroyAllPlayers();

  const grid = $('cameraGrid');
  grid.className = `camera-grid layout-${state.layout}`;
  grid.innerHTML = '';

  const visible = getVisibleMonitorCameras();

  visible.forEach((camera, i) => {
    const tile = cameraTile(camera);
    grid.appendChild(tile);
    // Escalonamento suave para não criar todos os players de vez
    setTimeout(() => {
      if (state.currentView !== 'monitor') return;
      tileObserver.observe(tile);
      tile._observed = true;
    }, i * 80);
  });

  // Slots vazios
  const empties = Math.max(0, state.layout - visible.length);
  for (let i = 0; i < empties; i++) {
    const e = el('div', 'camera-tile empty-tile');
    e.textContent = 'Sem câmera';
    grid.appendChild(e);
  }
}

/* ═══════════════════════════════════════════════════════
   CÂMERAS — CRUD completo
   ═══════════════════════════════════════════════════════ */

function resetCameraForm() {
  $('editCameraId').value = '';
  $('cameraForm').reset();
  $('camEnabled').checked = true;
  $('camTransport').value = 'tcp';
  $('camMode').value = 'copy';
  $('camWidth').value = 640;
  $('camFps').value = 10;
  $('formTitle').textContent = 'Nova Câmera';
  $('formSubmitBtn').textContent = '+ Cadastrar câmera';
  $('cancelEditBtn').classList.add('hidden');
  $('formMsg').textContent = '';
  $('formMsg').className = 'msg-inline';
  toggleTranscodeOpts();
}

function loadCameraIntoForm(camera) {
  $('editCameraId').value   = camera.id;
  $('camRtsp').value        = camera.rtsp;
  $('camName').value        = camera.name;
  $('camTransport').value   = camera.transport || 'tcp';
  $('camMode').value        = camera.streamMode || 'copy';
  $('camWidth').value       = camera.width || 640;
  $('camFps').value         = camera.fps || 10;
  $('camEnabled').checked   = camera.enabled !== false;
  $('formTitle').textContent  = 'Editar Câmera';
  $('formSubmitBtn').textContent = '✓ Salvar alterações';
  $('cancelEditBtn').classList.remove('hidden');
  $('formMsg').textContent = '';
  toggleTranscodeOpts();
  $('cameraFormPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleTranscodeOpts() {
  $('transcodeOpts').style.display = $('camMode').value === 'transcode' ? '' : 'none';
}

function renderCameraList() {
  const list = $('cameraList');
  const search = $('camSearch').value.toLowerCase();
  const filtered = state.cameras.filter(c =>
    !search || c.name.toLowerCase().includes(search) || c.rtsp.toLowerCase().includes(search)
  );

  $('camCount').textContent = `${state.cameras.length} câmera${state.cameras.length !== 1 ? 's' : ''}`;
  list.innerHTML = '';

  if (!filtered.length) {
    const empty = el('div', 'empty-state');
    empty.innerHTML = `<div class="empty-state-icon">◎</div><p>${search ? 'Nenhuma câmera encontrada.' : 'Nenhuma câmera cadastrada ainda.'}</p>`;
    list.appendChild(empty);
    return;
  }

  for (const camera of filtered) {
    const card = el('div', 'cam-card');
    const isEditing = $('editCameraId').value === camera.id;
    if (isEditing) card.classList.add('editing');

    // Header
    const header = el('div', 'cam-card-header');
    const dot = el('div', `cam-card-dot ${camera.online ? 'online' : 'offline'}`);
    const nameEl = el('div', 'cam-card-name');
    nameEl.textContent = camera.name;
    const badges = el('div', 'cam-card-badges');
    if (!camera.enabled) {
      const b = el('span', 'cam-badge off'); b.textContent = 'desativada'; badges.appendChild(b);
    } else if (camera.recording) {
      const b = el('span', 'cam-badge rec'); b.textContent = '● rec'; badges.appendChild(b);
    } else if (camera.online) {
      const b = el('span', 'cam-badge live'); b.textContent = 'ao vivo'; badges.appendChild(b);
    }
    header.append(dot, nameEl, badges);

    // RTSP
    const rtsp = el('div', 'cam-card-rtsp');
    rtsp.textContent = camera.rtsp;

    // Meta
    const meta = el('div', 'cam-card-meta');
    meta.textContent = `Modo: ${camera.streamMode || 'copy'} · Transporte: ${camera.transport || 'tcp'}`;
    if (camera.streamMode === 'transcode') meta.textContent += ` · ${camera.width || 640}px · ${camera.fps || 10}fps`;

    card.append(header, rtsp, meta);

    // Erros
    if (camera.streamErrors?.length) {
      const err = el('div', 'cam-card-error');
      err.textContent = '⚠ ' + camera.streamErrors[camera.streamErrors.length - 1];
      card.appendChild(err);
    }

    // Ações
    const actions = el('div', 'cam-card-actions');

    const editBtn = el('button', '');
    editBtn.textContent = isEditing ? '✎ Editando...' : '✎ Editar';
    editBtn.addEventListener('click', () => { loadCameraIntoForm(camera); renderCameraList(); });

    const toggleBtn = el('button', camera.enabled ? 'btn-ghost' : '');
    toggleBtn.textContent = camera.enabled ? '⏸ Desativar' : '▶ Ativar';
    toggleBtn.addEventListener('click', async () => {
      try {
        await api(`/api/cameras/${camera.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !camera.enabled }) });
        showToast(camera.enabled ? 'Câmera desativada' : 'Câmera ativada', 'success');
        await refreshCameras();
      } catch (err) { showToast(err.message, 'error'); }
    });

    const recBtn = el('button', camera.recording ? 'btn-danger' : '');
    recBtn.textContent = camera.recording ? '■ Parar gravação' : '⏺ Gravar';
    recBtn.addEventListener('click', async () => {
      try {
        await api(`/api/cameras/${camera.id}/record/${camera.recording ? 'stop' : 'start'}`, { method: 'POST' });
        showToast(camera.recording ? 'Gravação parada' : 'Gravação iniciada', 'success');
        await refreshCameras();
      } catch (err) { showToast(err.message, 'error'); }
    });

    const testBtn = el('button', 'btn-ghost');
    testBtn.textContent = '⚡ Testar';
    testBtn.addEventListener('click', async () => {
      testBtn.textContent = '...';
      testBtn.disabled = true;
      try {
        const r = await api(`/api/cameras/${camera.id}/test`, { method: 'POST' });
        showToast(r.message || 'Conexão OK', 'success');
      } catch (err) { showToast(err.message, 'error'); }
      testBtn.textContent = '⚡ Testar';
      testBtn.disabled = false;
    });

    const delBtn = el('button', 'btn-danger');
    delBtn.textContent = '🗑';
    delBtn.title = 'Excluir câmera';
    delBtn.addEventListener('click', async () => {
      const ok = await confirm('Excluir câmera?', `Tem certeza que deseja excluir "${camera.name}"? Esta ação não pode ser desfeita.`);
      if (!ok) return;
      try {
        await api(`/api/cameras/${camera.id}`, { method: 'DELETE' });
        showToast('Câmera excluída', 'success');
        if ($('editCameraId').value === camera.id) resetCameraForm();
        await refreshCameras();
      } catch (err) { showToast(err.message, 'error'); }
    });

    actions.append(editBtn, toggleBtn, recBtn, testBtn, delBtn);
    card.appendChild(actions);
    list.appendChild(card);
  }
}

async function refreshCameras() {
  const data = await api('/api/cameras');
  state.cameras = data.cameras;
  if (state.focusedCameraId && !state.cameras.some((c) => c.id === state.focusedCameraId && c.enabled)) {
    clearFocusedCamera();
  }
  renderCameraList();
  if (state.currentView === 'monitor') syncMonitorGrid();
  updateStatusBadge();
}

function updateStatusBadge() {
  const badge = $('statusBadge');
  const online = state.cameras.filter(c => c.online).length;
  const total  = state.cameras.filter(c => c.enabled).length;
  const rec = state.cameras.filter(c => c.recording).length;
  badge.textContent = `${online}/${total} online · ${rec} gravando`;
  badge.className = `badge ${online === total && total > 0 ? 'ok' : online < total ? 'err' : ''}`;
}

/* ═══════════════════════════════════════════════════════
   GRAVAÇÕES
   ═══════════════════════════════════════════════════════ */

async function loadRecordings() {
  const data = await api('/api/recordings');
  state.recordings = data.recordings;
  state.selectedRecordings.clear();
  renderRecordings();
  populateRecCamFilter();
}

function populateRecCamFilter() {
  const sel = $('recCamFilter');
  const current = sel.value;
  sel.innerHTML = '<option value="">Todas as câmeras</option>';
  // Extrai nomes únicos a partir dos arquivos (formato: NomeCam_YYYYMMDD_...)
  const names = new Set(state.recordings.map(r => {
    const parts = r.name.split('_');
    return parts.slice(0, -2).join('_') || r.name;
  }));
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = current;
}

function getFilteredRecordings() {
  let recs = [...state.recordings];
  const search = $('recSearch').value.toLowerCase().trim();
  const cam    = $('recCamFilter').value;
  const sort   = $('recSortFilter').value;

  if (search) recs = recs.filter(r => r.name.toLowerCase().includes(search));
  if (cam)    recs = recs.filter(r => r.name.startsWith(cam));

  if      (sort === 'date-desc') recs.sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  else if (sort === 'date-asc')  recs.sort((a,b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  else if (sort === 'size-desc') recs.sort((a,b) => b.sizeBytes - a.sizeBytes);
  else if (sort === 'size-asc')  recs.sort((a,b) => a.sizeBytes - b.sizeBytes);

  return recs;
}

function renderRecordings() {
  const list = $('recordingsList');
  const recs = getFilteredRecordings();

  // Stats
  const totalSize = state.recordings.reduce((s, r) => s + r.sizeBytes, 0);
  $('recStats').innerHTML = `
    <div class="rec-stat"><div class="rec-stat-val">${state.recordings.length}</div><div class="rec-stat-label">Total</div></div>
    <div class="rec-stat"><div class="rec-stat-val">${formatBytes(totalSize)}</div><div class="rec-stat-label">Tamanho total</div></div>
    <div class="rec-stat"><div class="rec-stat-val">${state.selectedRecordings.size || '—'}</div><div class="rec-stat-label">Selecionadas</div></div>
  `;

  // Botão excluir selecionadas
  $('deleteSelectedBtn').classList.toggle('hidden', state.selectedRecordings.size === 0);

  list.innerHTML = '';

  if (!recs.length) {
    const empty = el('div', 'empty-state');
    empty.innerHTML = `<div class="empty-state-icon">⬭</div><p>${state.recordings.length ? 'Nenhuma gravação encontrada com esses filtros.' : 'Nenhuma gravação disponível.'}</p>`;
    list.appendChild(empty);
    return;
  }

  for (const rec of recs) {
    const card = el('div', 'rec-card');
    if (state.selectedRecordings.has(rec.name)) card.classList.add('selected');

    // Checkbox seleção
    const cbWrap = el('div');
    cbWrap.style.display = 'flex';
    cbWrap.style.alignItems = 'center';
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = state.selectedRecordings.has(rec.name);
    cb.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:var(--accent);';
    cb.addEventListener('change', () => {
      if (cb.checked) state.selectedRecordings.add(rec.name);
      else state.selectedRecordings.delete(rec.name);
      renderRecordings();
    });
    cbWrap.appendChild(cb);

    // Ícone
    const icon = el('div', 'rec-file-icon');
    icon.textContent = '🎬';

    // Info
    const info = el('div', 'rec-card-info');
    const nameEl = el('div', 'rec-card-name');
    nameEl.textContent = rec.name;
    nameEl.title = rec.name;
    const meta = el('div', 'rec-card-meta');
    meta.innerHTML = `<span>${formatDate(rec.createdAt)}</span><span>${formatBytes(rec.sizeBytes)}</span>`;
    info.append(nameEl, meta);

    // Ações
    const actions = el('div', 'rec-card-actions');

    const playBtn = el('button', '');
    playBtn.textContent = '▶ Reproduzir';
    playBtn.addEventListener('click', () => openVideoModal(rec));

    const dlBtn = el('button', 'btn-ghost');
    dlBtn.innerHTML = '⬇';
    dlBtn.title = 'Baixar';
    const dlLink = document.createElement('a');
    dlLink.href = rec.url;
    dlLink.download = rec.name;
    dlLink.appendChild(dlBtn);

    const delBtn = el('button', 'btn-danger');
    delBtn.textContent = '🗑';
    delBtn.title = 'Excluir';
    delBtn.addEventListener('click', async () => {
      const ok = await confirm('Excluir gravação?', `Excluir "${rec.name}"? Esta ação não pode ser desfeita.`);
      if (!ok) return;
      try {
        await api(`/api/recordings/${encodeURIComponent(rec.name)}`, { method: 'DELETE' });
        showToast('Gravação excluída', 'success');
        await loadRecordings();
      } catch (err) { showToast(err.message, 'error'); }
    });

    actions.append(playBtn, dlLink, delBtn);
    card.append(cbWrap, info, actions);
    list.appendChild(card);
  }

  // Sync selectAll checkbox
  $('selectAllRec').checked = recs.length > 0 && recs.every(r => state.selectedRecordings.has(r.name));
  $('selectAllRec').indeterminate = state.selectedRecordings.size > 0 && !$('selectAllRec').checked;
}

function openVideoModal(rec) {
  $('modalTitle').textContent = rec.name;
  $('modalVideo').src = rec.url;
  $('videoModal').classList.remove('hidden');
  $('modalVideo').play().catch(() => {});
}

/* ═══════════════════════════════════════════════════════
   STATUS
   ═══════════════════════════════════════════════════════ */

async function loadHealth() {
  try {
    const data = await api('/api/health');
    $('healthBox').innerHTML = `
      <div class="health-row"><span class="health-key">FFmpeg</span><span class="health-val ${data.ffmpegOk ? 'ok' : 'err'}">${data.ffmpegOk ? '✓ Instalado' : '✗ Não encontrado'}</span></div>
      <div class="health-row"><span class="health-key">Streams ativos</span><span class="health-val">${data.activeStreams}</span></div>
      <div class="health-row"><span class="health-key">Gravações ativas</span><span class="health-val">${data.activeRecordings}</span></div>
      <div class="health-row"><span class="health-key">Porta</span><span class="health-val">${data.port}</span></div>
    `;

    const streamsBox = $('streamsBox');
    const active = state.cameras.filter(c => c.online);
    if (!active.length) {
      streamsBox.innerHTML = '<div style="color:var(--text-3);font-size:14px;">Nenhum stream ativo.</div>';
    } else {
      streamsBox.innerHTML = '';
      for (const c of active) {
        const row = el('div', 'stream-row');
        row.innerHTML = `
          <div class="stream-dot${c.recording ? ' style="background:var(--red)"' : ''}"></div>
          <div class="stream-name">${c.name}</div>
          <div class="stream-meta">${c.recording ? '● GRAVANDO' : 'AO VIVO'}</div>
        `;
        streamsBox.appendChild(row);
      }
    }
  } catch (err) {
    $('healthBox').innerHTML = `<div style="color:var(--red)">${err.message}</div>`;
  }
}


async function loadUsers() {
  const data = await api('/api/users');
  state.users = data.users || [];
  renderUsers();
}

function renderUsers() {
  const list = $('usersList');
  if (!list) return;
  list.innerHTML = '';
  $('userCount').textContent = `${state.users.length}`;
  if (!state.users.length) {
    const empty = el('div', 'empty-state');
    empty.innerHTML = `<div class="empty-state-icon">◉</div><p>Nenhum usuário cadastrado.</p>`;
    list.appendChild(empty);
    return;
  }
  for (const user of state.users) {
    const row = el('div', 'user-row');
    const main = el('div', 'user-row-main');
    const name = el('div', 'user-row-name');
    name.textContent = user.name || user.username;
    const meta = el('div', 'user-row-meta');
    meta.textContent = `${user.username} · ${user.role === 'admin' ? 'Administrador' : 'Operador'}`;
    main.append(name, meta);
    row.appendChild(main);
    list.appendChild(row);
  }
}

async function loadRecordingSettings() {
  const data = await api('/api/settings/recordings');
  state.settings = data.settings || { recordingRetentionDays: null };
  $('recordingSettingsPanel').classList.toggle('hidden', state.user?.role !== 'admin');
  $('retentionDays').value = state.settings.recordingRetentionDays || '';
  $('retentionMsg').textContent = state.settings.recordingRetentionDays ? `Exclusão automática ativa para arquivos mais antigos que ${state.settings.recordingRetentionDays} dia(s).` : 'Autoexclusão desativada.';
  $('retentionMsg').className = 'msg-inline';
}

/* ═══════════════════════════════════════════════════════
   EVENTOS
   ═══════════════════════════════════════════════════════ */

// Login
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginMsg').textContent = '';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('loginUser').value, password: $('loginPass').value })
    });
    state.user = data.user;
    await bootApp();
  } catch (err) { $('loginMsg').textContent = err.message; }
});

$('userForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('registerMsg');
  msg.textContent = '';
  msg.className = 'msg-inline';
  const password = $('registerPass').value;
  const confirmPassword = $('registerPassConfirm').value;
  if (password !== confirmPassword) {
    msg.textContent = 'As senhas não conferem';
    msg.className = 'msg-inline err';
    return;
  }
  try {
    const data = await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        name: $('registerName').value.trim(),
        username: $('registerUser').value.trim(),
        password,
        role: $('registerRole').value
      })
    });
    msg.textContent = `Usuário ${data.user.username} criado com sucesso`;
    msg.className = 'msg-inline ok';
    $('userForm').reset();
    $('registerRole').value = 'operator';
    await loadUsers();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg-inline err';
  }
});

$('saveRetentionBtn')?.addEventListener('click', async () => {
  const msg = $('retentionMsg');
  msg.textContent = '';
  msg.className = 'msg-inline';
  const raw = $('retentionDays').value.trim();
  try {
    const data = await api('/api/settings/recordings', {
      method: 'PUT',
      body: JSON.stringify({ recordingRetentionDays: raw ? Number(raw) : null })
    });
    state.settings = data.settings;
    msg.textContent = data.settings.recordingRetentionDays ? `Autoexclusão salva: arquivos com mais de ${data.settings.recordingRetentionDays} dia(s) serão removidos automaticamente.` : 'Autoexclusão desativada.';
    msg.className = 'msg-inline ok';
    await loadRecordings();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg-inline err';
  }
});

// Logout
$('logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  destroyAllPlayers();
  document.body.classList.remove('fullscreen-grid');
  updateFullscreenButtons();
  $('app').classList.add('hidden');
  $('loginScreen').classList.remove('hidden');
  setAuthMode();
});

// Nav
document.querySelectorAll('.menu-btn').forEach(btn =>
  btn.addEventListener('click', () => setView(btn.dataset.view))
);

// Layout
$('layoutSelect').addEventListener('change', (e) => {
  state.layout = Number(e.target.value);
  renderGrid();
});

// Fullscreen
$('fullscreenBtn').addEventListener('click', () => {
  document.body.classList.add('fullscreen-grid');
  updateFullscreenButtons();
});

$('exitFullscreenBtn').addEventListener('click', () => {
  document.body.classList.remove('fullscreen-grid');
  updateFullscreenButtons();
});

// Sidebar toggle
$('toggleMenuBtn').addEventListener('click', () => document.body.classList.toggle('sidebar-collapsed'));

// Formulário câmera — toggle transcode opts
$('camMode').addEventListener('change', toggleTranscodeOpts);

// Cancelar edição
$('cancelEditBtn').addEventListener('click', () => { resetCameraForm(); renderCameraList(); });

// Submit câmera (criar ou editar)
$('cameraForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('editCameraId').value;
  const body = {
    name:        $('camName').value.trim(),
    rtsp:        $('camRtsp').value.trim(),
    transport:   $('camTransport').value,
    streamMode:  $('camMode').value,
    width:       Number($('camWidth').value) || 640,
    fps:         Number($('camFps').value) || 10,
    enabled:     $('camEnabled').checked
  };
  const msg = $('formMsg');
  msg.textContent = '';
  msg.className = 'msg-inline';
  try {
    if (id) {
      await api(`/api/cameras/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('Câmera atualizada', 'success');
    } else {
      await api('/api/cameras', { method: 'POST', body: JSON.stringify(body) });
      showToast('Câmera cadastrada', 'success');
    }
    resetCameraForm();
    await refreshCameras();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg-inline err';
  }
});

// Testar conexão (nova câmera)
$('testNewCamBtn').addEventListener('click', async () => {
  const rtsp = $('camRtsp').value.trim();
  if (!rtsp) { showToast('Preencha a URL RTSP primeiro', 'error'); return; }
  const btn = $('testNewCamBtn');
  const msg = $('formMsg');
  btn.textContent = 'Testando...';
  btn.disabled = true;
  msg.textContent = '';
  // Tenta testar via câmera temporária se houver id em edição
  const editId = $('editCameraId').value;
  if (editId) {
    try {
      const r = await api(`/api/cameras/${editId}/test`, { method: 'POST' });
      msg.textContent = '✓ ' + (r.message || 'Conexão OK');
      msg.className = 'msg-inline ok';
    } catch (err) {
      msg.textContent = '✗ ' + err.message;
      msg.className = 'msg-inline err';
    }
  } else {
    // Sem câmera salva: informa ao usuário
    msg.textContent = 'Cadastre a câmera primeiro para testar a conexão.';
    msg.className = 'msg-inline';
  }
  btn.textContent = 'Testar RTSP';
  btn.disabled = false;
});

// Busca câmeras
$('camSearch').addEventListener('input', renderCameraList);

// Gravações — filtros
$('recSearch').addEventListener('input', renderRecordings);
$('recCamFilter').addEventListener('change', renderRecordings);
$('recSortFilter').addEventListener('change', renderRecordings);
$('refreshRecordingsBtn').addEventListener('click', loadRecordings);

// Selecionar todas as gravações
$('selectAllRec').addEventListener('change', () => {
  const recs = getFilteredRecordings();
  if ($('selectAllRec').checked) recs.forEach(r => state.selectedRecordings.add(r.name));
  else recs.forEach(r => state.selectedRecordings.delete(r.name));
  renderRecordings();
});

// Excluir selecionadas
$('deleteSelectedBtn').addEventListener('click', async () => {
  const count = state.selectedRecordings.size;
  const ok = await confirm('Excluir gravações?', `Excluir ${count} gravação(ões) selecionada(s)? Esta ação não pode ser desfeita.`);
  if (!ok) return;
  let errors = 0;
  for (const name of state.selectedRecordings) {
    try {
      await api(`/api/recordings/${encodeURIComponent(name)}`, { method: 'DELETE' });
    } catch { errors++; }
  }
  showToast(errors ? `Excluídas com ${errors} erro(s)` : `${count} gravação(ões) excluída(s)`, errors ? 'error' : 'success');
  await loadRecordings();
});

// Modal de vídeo
$('modalClose').addEventListener('click', () => {
  $('videoModal').classList.add('hidden');
  const v = $('modalVideo');
  v.pause();
  v.removeAttribute('src');
  v.load();
});
$('videoModal').addEventListener('click', (e) => {
  if (e.target === $('videoModal')) $('modalClose').click();
});

// Teclado Esc fecha modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('videoModal').classList.contains('hidden'))   $('modalClose').click();
    if (!$('confirmModal').classList.contains('hidden')) $('confirmCancel').click();
  }
});

/* ═══════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════ */

async function bootApp() {
  $('loginScreen').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('currentUser').textContent = state.user?.name || state.user?.username || '';
  $('currentUserRole').textContent = state.user?.role === 'admin' ? 'admin' : 'operador';
  $('usersMenuBtn').classList.toggle('hidden', state.user?.role !== 'admin');
  $('recordingSettingsPanel').classList.toggle('hidden', state.user?.role !== 'admin');
  $('layoutSelect').value = String(state.layout);
  updateFullscreenButtons();
  resetCameraForm();
  await refreshCameras();
  await loadRecordingSettings();
  if (state.user?.role === 'admin') await loadUsers();
  setView('monitor');
}

setInterval(() => {
  if (state.user && !document.hidden) {
    refreshCameras().catch(() => {});
    if (state.currentView === 'settings') loadHealth().catch(() => {});
  }
}, 15000);

state.layout = Number(localStorage.getItem('uai.monitorLayout') || state.layout) || 9;

async function init() {
  setAuthMode();
  updateFullscreenButtons();
  try {
    const data = await api('/api/session');
    if (data.user) {
      state.user = data.user;
      await bootApp();
    }
  } catch {}
}

init();
