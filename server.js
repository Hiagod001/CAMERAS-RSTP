const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8085;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const HLS_DIR = path.join(ROOT, 'hls');
const RECORDS_DIR = path.join(ROOT, 'records');
const CAMERAS_FILE = path.join(DATA_DIR, 'cameras.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'troque-esta-chave-em-producao';

for (const dir of [DATA_DIR, HLS_DIR, RECORDS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(CAMERAS_FILE)) fs.writeFileSync(CAMERAS_FILE, '[]');
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify([{ username: 'admin', password: 'admin123', role: 'admin', name: 'Administrador' }], null, 2));
}
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ recordingRetentionDays: null, updatedAt: new Date().toISOString() }, null, 2));
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 12
  }
}));

app.use('/vendor/hls', express.static(path.join(ROOT, 'node_modules', 'hls.js', 'dist')));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/hls', express.static(HLS_DIR, { maxAge: 0 }));
app.use('/records', express.static(RECORDS_DIR));

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function saveJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function safeName(v) {
  return String(v || 'camera').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
}
function cameraSegmentDir(id) {
  return path.join(HLS_DIR, String(id));
}
function ensureCameraSegmentDir(id) {
  const dir = cameraSegmentDir(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function playlistPath(id) {
  return path.join(cameraSegmentDir(id), 'index.m3u8');
}
function publicPlaylist(id) {
  return `/hls/${id}/index.m3u8`;
}
function getCameras() {
  return loadJson(CAMERAS_FILE, []);
}
function saveCameras(cameras) {
  saveJson(CAMERAS_FILE, cameras);
}
function getUsers() {
  return loadJson(USERS_FILE, []);
}
function saveUsers(users) {
  saveJson(USERS_FILE, users);
}
function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}
function getSettings() {
  return loadJson(SETTINGS_FILE, { recordingRetentionDays: null });
}
function saveSettings(settings) {
  saveJson(SETTINGS_FILE, { ...settings, updatedAt: new Date().toISOString() });
}
function authRequired(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, error: 'Não autenticado' });
  next();
}
function adminRequired(req, res, next) {
  if (!req.session.user) return res.status(401).json({ ok: false, error: 'Não autenticado' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Apenas administrador pode acessar este recurso' });
  next();
}

const streamProcesses = new Map();
const recordingProcesses = new Map();
const STREAM_START_TIMEOUT_MS = 15000;
const STREAM_RETRY_BASE_MS = 60000;
const STREAM_RETRY_MAX_MS = 180000;

function cleanHlsDirectory(id) {
  const dir = ensureCameraSegmentDir(id);
  for (const file of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, file), { force: true, recursive: true });
  }
}

function ffmpegExists() {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

function buildHlsArgs(camera) {
  const out = playlistPath(camera.id);
  const targetWidth = Math.max(320, Number(camera.width) || 960);
  const targetFps = Math.max(4, Number(camera.fps) || 12);
  const gop = Math.max(12, targetFps * 2);

  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-y',
    '-rtsp_transport', camera.transport || 'tcp',
    '-fflags', '+genpts+discardcorrupt',
    '-use_wallclock_as_timestamps', '1',
    '-analyzeduration', '1000000',
    '-probesize', '1000000',
    '-i', camera.rtsp,
    '-map', '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf', `scale='min(iw,${targetWidth})':-2,fps=${targetFps},format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${Math.max(1, Math.round(gop / targetFps))})`,
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '5',
    '-hls_allow_cache', '0',
    '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments+temp_file',
    '-hls_segment_type', 'mpegts',
    '-start_number', '0',
    '-hls_segment_filename', path.join(cameraSegmentDir(camera.id), 'seg_%05d.ts'),
    out
  ];
}

function startStream(camera) {
  if (!camera || !camera.enabled) return;
  const existing = streamProcesses.get(camera.id);
  if (existing?.child) return;
  if (existing?.retryTimer) clearTimeout(existing.retryTimer);
  cleanHlsDirectory(camera.id);
  const args = buildHlsArgs(camera);
  const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const previousRestarts = existing?.restarts || 0;
  const state = {
    child,
    startedAt: new Date().toISOString(),
    restarts: previousRestarts,
    errors: existing?.errors || [],
    startTimer: null,
    retryTimer: null,
    retryAt: null
  };
  streamProcesses.set(camera.id, state);

  state.startTimer = setTimeout(() => {
    const playlist = playlistPath(camera.id);
    try {
      const exists = fs.existsSync(playlist);
      const size = exists ? fs.statSync(playlist).size : 0;
      if (!exists || size < 32) {
        state.errors.push('Stream sem playlist HLS válida; reiniciando monitoramento');
        state.errors = state.errors.slice(-10);
        try { child.kill('SIGINT'); } catch {}
      }
    } catch (err) {
      state.errors.push(`Falha ao validar playlist: ${err.message}`);
      state.errors = state.errors.slice(-10);
    }
  }, STREAM_START_TIMEOUT_MS);

  child.stderr.on('data', (buf) => {
    const line = String(buf).trim();
    if (!line) return;
    state.errors.push(line);
    state.errors = state.errors.slice(-10);
  });

  child.on('close', () => {
    if (state.startTimer) clearTimeout(state.startTimer);
    const latest = getCameras().find((c) => c.id === camera.id);
    if (!latest || !latest.enabled) {
      streamProcesses.delete(camera.id);
      return;
    }

    state.child = null;
    state.restarts += 1;
    const retryDelay = Math.min(STREAM_RETRY_BASE_MS * Math.max(1, state.restarts), STREAM_RETRY_MAX_MS);
    state.retryAt = new Date(Date.now() + retryDelay).toISOString();
    state.errors.push(`Stream indisponível; nova tentativa em ${Math.round(retryDelay / 1000)}s`);
    state.errors = state.errors.slice(-10);
    state.retryTimer = setTimeout(() => {
      const current = streamProcesses.get(camera.id);
      if (!current || current !== state) return;
      startStream(latest);
    }, retryDelay);
    streamProcesses.set(camera.id, state);
  });

  child.on('error', (err) => {
    state.errors.push(`Falha ao iniciar ffmpeg: ${err.message}`);
    state.errors = state.errors.slice(-10);
  });
}

function stopStream(cameraId) {
  const state = streamProcesses.get(cameraId);
  if (!state) return;
  if (state.startTimer) clearTimeout(state.startTimer);
  if (state.retryTimer) clearTimeout(state.retryTimer);
  try {
    state.child?.kill('SIGINT');
  } catch {}
  streamProcesses.delete(cameraId);
}

function startAllStreams() {
  const cameras = getCameras();
  for (const camera of cameras) startStream(camera);
}

function buildRecordArgs(camera, filePath) {
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-rtsp_transport', camera.transport || 'tcp',
    '-i', camera.rtsp,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-f', 'mp4',
    filePath
  ];
}

function persistRecordingIntent(cameraId, shouldRecord) {
  const cameras = getCameras();
  const idx = cameras.findIndex((c) => c.id === cameraId);
  if (idx === -1) return null;
  cameras[idx] = { ...cameras[idx], shouldRecord: !!shouldRecord, updatedAt: new Date().toISOString() };
  saveCameras(cameras);
  return cameras[idx];
}

function startRecording(cameraId, options = {}) {
  const cameras = getCameras();
  const camera = cameras.find((c) => c.id === cameraId);
  if (!camera) throw new Error('Câmera não encontrada');
  if (recordingProcesses.has(cameraId)) throw new Error('Esta câmera já está gravando');
  const base = `${safeName(camera.name)}_${nowStamp()}.mp4`;
  const filePath = path.join(RECORDS_DIR, base);
  const child = spawn('ffmpeg', buildRecordArgs(camera, filePath), { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  const state = {
    child,
    cameraId,
    file: base,
    startedAt: new Date().toISOString(),
    errors: [],
    requested: options.requested !== false
  };
  recordingProcesses.set(cameraId, state);
  if (state.requested) persistRecordingIntent(cameraId, true);
  child.stderr.on('data', (buf) => {
    const line = String(buf).trim();
    if (!line) return;
    state.errors.push(line);
    state.errors = state.errors.slice(-10);
  });
  child.on('close', () => {
    recordingProcesses.delete(cameraId);
    const latest = getCameras().find((c) => c.id === cameraId);
    if (state.requested && latest?.shouldRecord) {
      setTimeout(() => {
        try {
          if (!recordingProcesses.has(cameraId)) startRecording(cameraId, { requested: true });
        } catch {}
      }, 2000);
    }
  });
  child.on('error', (err) => {
    state.errors.push(`Falha ao iniciar gravação: ${err.message}`);
  });
}

function stopRecording(cameraId) {
  const state = recordingProcesses.get(cameraId);
  if (!state) throw new Error('Esta câmera não está gravando');
  persistRecordingIntent(cameraId, false);
  state.requested = false;
  recordingProcesses.delete(cameraId);
  try {
    state.child.stdin.write('q');
    state.child.stdin.end();
  } catch {
    try { state.child.kill('SIGINT'); } catch {}
  }
}

function listRecordings() {
  const files = fs.readdirSync(RECORDS_DIR)
    .filter((name) => /\.(mp4|mkv|webm)$/i.test(name))
    .map((name) => {
      const full = path.join(RECORDS_DIR, name);
      const st = fs.statSync(full);
      return {
        name,
        url: `/records/${encodeURIComponent(name)}`,
        sizeBytes: st.size,
        createdAt: st.birthtime.toISOString(),
        updatedAt: st.mtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return files;
}


function pruneOldRecordings() {
  const settings = getSettings();
  const retentionDays = Number(settings.recordingRetentionDays);
  if (!retentionDays || retentionDays < 1) return { removed: 0 };
  const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  let removed = 0;
  for (const rec of listRecordings()) {
    const full = path.join(RECORDS_DIR, rec.name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch {}
  }
  return { removed };
}

setInterval(() => {
  try { pruneOldRecordings(); } catch (err) { console.error('Falha ao limpar gravações antigas:', err.message); }
}, 60 * 60 * 1000);

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const normalized = normalizeUsername(username);
  const user = getUsers().find((u) => normalizeUsername(u.username) === normalized && u.password === password);
  if (!user) return res.status(401).json({ ok: false, error: 'Usuário ou senha inválidos' });
  req.session.user = { username: user.username, name: user.name || user.username, role: user.role || 'admin' };
  res.json({ ok: true, user: req.session.user });
});

app.get('/api/users', authRequired, adminRequired, (req, res) => {
  const users = getUsers().map((u) => ({
    username: u.username,
    name: u.name || u.username,
    role: u.role || 'operator',
    createdAt: u.createdAt || null
  }));
  res.json({ ok: true, users });
});

app.post('/api/users', authRequired, adminRequired, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '').trim();
  const name = String(req.body?.name || '').trim();
  const role = req.body?.role === 'admin' ? 'admin' : 'operator';

  if (username.length < 3) return res.status(400).json({ ok: false, error: 'Usuário deve ter pelo menos 3 caracteres' });
  if (password.length < 4) return res.status(400).json({ ok: false, error: 'Senha deve ter pelo menos 4 caracteres' });

  const users = getUsers();
  const normalized = normalizeUsername(username);
  if (users.some((u) => normalizeUsername(u.username) === normalized)) {
    return res.status(400).json({ ok: false, error: 'Este usuário já existe' });
  }

  const user = {
    username,
    password,
    name: name || username,
    role,
    shouldRecord: false,
    createdAt: new Date().toISOString()
  };

  users.push(user);
  saveUsers(users);
  res.json({ ok: true, user: { username: user.username, role: user.role, name: user.name } });
});

app.get('/api/settings/recordings', authRequired, (req, res) => {
  res.json({ ok: true, settings: getSettings() });
});

app.put('/api/settings/recordings', authRequired, adminRequired, (req, res) => {
  const raw = req.body?.recordingRetentionDays;
  const retentionDays = raw === null || raw === '' || typeof raw === 'undefined' ? null : Number(raw);
  if (retentionDays !== null && (!Number.isFinite(retentionDays) || retentionDays < 1)) {
    return res.status(400).json({ ok: false, error: 'Informe um número de dias válido, maior ou igual a 1' });
  }
  const settings = { ...getSettings(), recordingRetentionDays: retentionDays === null ? null : Math.floor(retentionDays) };
  saveSettings(settings);
  const result = pruneOldRecordings();
  res.json({ ok: true, settings, removedNow: result.removed });
});

app.post('/api/logout', authRequired, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ ok: true, user: req.session.user || null });
});

app.get('/api/health', authRequired, async (req, res) => {
  const ffmpegOk = await ffmpegExists();
  res.json({
    ok: true,
    ffmpegOk,
    activeStreams: Array.from(streamProcesses.keys()).length,
    activeRecordings: Array.from(recordingProcesses.keys()).length,
    port: PORT
  });
});

app.get('/api/cameras', authRequired, (req, res) => {
  const cameras = getCameras().map((c) => {
    const streamState = streamProcesses.get(c.id);
    return {
      ...c,
      hlsUrl: publicPlaylist(c.id),
      online: !!streamState?.child,
      reconnecting: !!streamState?.retryAt,
      reconnectAt: streamState?.retryAt || null,
      recording: recordingProcesses.has(c.id),
      streamErrors: streamState?.errors || [],
      recordErrors: recordingProcesses.get(c.id)?.errors || []
    };
  });
  res.json({ ok: true, cameras });
});

app.post('/api/cameras', authRequired, (req, res) => {
  const body = req.body || {};
  if (!body.rtsp) return res.status(400).json({ ok: false, error: 'RTSP é obrigatório' });
  const cameras = getCameras();
  const camera = {
    id: Date.now().toString(),
    name: String(body.name || `Câmera ${cameras.length + 1}`).trim(),
    rtsp: String(body.rtsp).trim(),
    enabled: body.enabled !== false,
    transport: body.transport === 'udp' ? 'udp' : 'tcp',
    streamMode: body.streamMode === 'copy' ? 'copy' : 'transcode',
    width: Number(body.width) || 640,
    fps: Number(body.fps) || 10,
    shouldRecord: false,
    createdAt: new Date().toISOString()
  };
  cameras.push(camera);
  saveCameras(cameras);
  startStream(camera);
  res.json({ ok: true, camera });
});

app.put('/api/cameras/:id', authRequired, (req, res) => {
  const cameras = getCameras();
  const idx = cameras.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Câmera não encontrada' });
  const current = cameras[idx];
  cameras[idx] = {
    ...current,
    name: req.body.name ? String(req.body.name).trim() : current.name,
    rtsp: req.body.rtsp ? String(req.body.rtsp).trim() : current.rtsp,
    enabled: typeof req.body.enabled === 'boolean' ? req.body.enabled : current.enabled,
    transport: req.body.transport === 'udp' ? 'udp' : (req.body.transport === 'tcp' ? 'tcp' : current.transport),
    streamMode: req.body.streamMode === 'copy' ? 'copy' : (req.body.streamMode === 'transcode' ? 'transcode' : current.streamMode),
    width: Number(req.body.width) || current.width || 640,
    fps: Number(req.body.fps) || current.fps || 10,
    updatedAt: new Date().toISOString()
  };
  saveCameras(cameras);
  stopStream(req.params.id);
  cleanHlsDirectory(req.params.id);
  if (cameras[idx].enabled) startStream(cameras[idx]);
  res.json({ ok: true, camera: cameras[idx] });
});

app.delete('/api/cameras/:id', authRequired, (req, res) => {
  const cameras = getCameras();
  const target = cameras.find((c) => c.id === req.params.id);
  if (!target) return res.status(404).json({ ok: false, error: 'Câmera não encontrada' });
  try {
    if (recordingProcesses.has(req.params.id)) stopRecording(req.params.id);
  } catch {}
  stopStream(req.params.id);
  cleanHlsDirectory(req.params.id);
  saveCameras(cameras.filter((c) => c.id !== req.params.id));
  res.json({ ok: true });
});

app.post('/api/cameras/:id/test', authRequired, (req, res) => {
  const cameras = getCameras();
  const camera = cameras.find((c) => c.id === req.params.id);
  if (!camera) return res.status(404).json({ ok: false, error: 'Câmera não encontrada' });
  const tester = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', camera.transport || 'tcp',
    '-i', camera.rtsp,
    '-frames:v', '1',
    '-f', 'null', '-'
  ], { windowsHide: true });
  let errors = '';
  tester.stderr.on('data', (buf) => { errors += String(buf); });
  tester.on('close', (code) => {
    if (code === 0) return res.json({ ok: true, message: 'Conexão RTSP OK' });
    res.status(400).json({ ok: false, error: errors || 'Falha ao conectar na câmera' });
  });
  tester.on('error', (err) => {
    res.status(500).json({ ok: false, error: err.message });
  });
});

app.post('/api/cameras/:id/record/start', authRequired, (req, res) => {
  try {
    startRecording(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/cameras/:id/record/stop', authRequired, (req, res) => {
  try {
    stopRecording(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/recordings', authRequired, (req, res) => {
  res.json({ ok: true, recordings: listRecordings() });
});

app.delete('/api/recordings/:name', authRequired, (req, res) => {
  const rawName = path.basename(req.params.name || '');
  if (!rawName) return res.status(400).json({ ok: false, error: 'Arquivo inválido' });
  const full = path.join(RECORDS_DIR, rawName);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: 'Gravação não encontrada' });
  try {
    fs.unlinkSync(full);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

startAllStreams();
for (const camera of getCameras()) {
  if (camera.enabled && camera.shouldRecord) {
    try { startRecording(camera.id, { requested: true }); } catch {}
  }
}
try { pruneOldRecordings(); } catch {}

app.listen(PORT, () => {
  console.log(`NVR rodando em http://localhost:${PORT}`);
});
