/* pupilsense-adapter.js — calibration + PupilSense workload overlay for "Catch Your Bus" (BN5213-UI-design).
 *
 * Injected by pupil_server.py (--game-dir) into the unchanged game.
 *
 * Flow added after the Safety Check ("Start Session"):
 *   Calibration scene  1. camera + face positioning
 *                      2. WebGazer gaze calibration (9 dots, look only — no clicking) + validation (5 new dots)
 *                      3. PupilSense pupil baseline (game-background screen + bus-grid screen)
 *   -> then the game's own Warm-up continues.
 *
 * During the game:
 *   - WebGazer dwell (look ~1.2 s) selects the warm-up bus / a bus card via CatchYourBus.inputs (gaze lock).
 *     Confirmation stays with EMG / foot press (or the mouse demo).
 *   - Webcam frames (the same camera stream WebGazer opened) go to PupilSense (/ws); a slim bar at the top
 *     shows the live workload level per game phase. Observation only — difficulty is not changed.
 *   - Pupil samples during / just after a sit-to-stand are flagged and excluded.
 */
(() => {
  'use strict';
  const CYB = window.CatchYourBus;
  if (!CYB) { console.warn('[PupilSense] window.CatchYourBus not found — adapter not started'); return; }

  // ------------------------------------------------------------- settings ----
  const WG_VERSION = '3.5.3';
  const WG_URL = `https://cdn.jsdelivr.net/npm/webgazer@${WG_VERSION}/dist/webgazer.js`;
  const WG_MESH = `https://cdn.jsdelivr.net/npm/webgazer@${WG_VERSION}/dist/mediapipe/face_mesh`;
  const FAST = new URLSearchParams(location.search).get('fast') === '1';
  const CFG = {
    fps: 20,                       // readings per second requested from PupilSense
    inflight: 2,                   // frames in flight (hides network/encode latency)
    win: 6,                        // seconds used for the live level
    settleS: 4,                    // seconds excluded after a sit-to-stand
    t1: 0.33, t2: 0.66,            // LOW->MEDIUM, MEDIUM->HIGH on the index
    baseS: FAST ? 6 : 10,          // seconds per baseline screen
    checkS: FAST ? 4 : 12,         // seconds per colour in the light check
    calSettleMs: 900, calRecordMs: 1500, calHz: 10,   // gaze calibration per dot
    valSettleMs: 900, valRecordMs: 1200,              // gaze validation per dot
    dwellMs: 3000, dwellGraceMs: 350, dwellPad: 40,   // gaze selection (look 3 s to select)
    pageBg: getComputedStyle(document.documentElement).getPropertyValue('--page').trim() || '#F4F1E9',
    gridImage: '/game/previews/game.png',
  };
  // Bus-grid layout: fixed 3x2 (6 buses), moved in from the screen corners where webcam gaze is least accurate.
  // Needs pupil_server.py's app.js patch to change the card count from the original 9.
  const GRID_KEY = '3x2';
  const GRID = { cols: 3, rows: 2, cards: 6 };
  window.PupilSenseGrid = { cards: GRID.cards, layout: GRID_KEY };
  // Gaze calibration mode: 'click' = WebGazer standard (click each dot 5x while looking at it, default),
  // 'look' = hands-free (look at each dot, recorded automatically). Choose with ?cal=look
  const CAL_MODE = new URLSearchParams(location.search).get('cal') === 'look' ? 'look' : 'click';
  const now = () => performance.now() / 1000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
  const median = a => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y), k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };
  const fmt = (v, d = 2) => (v == null || !isFinite(v)) ? '–' : (+v).toFixed(d);

  // ---------------------------------------------------------------- state ----
  let ws = null, inflight = 0, lastSend = 0, streaming = false, video = null;
  const grab = document.createElement('canvas'), gctx = grab.getContext('2d');
  let samples = [], phase = 'setup', screen = 'safety', attempt = null, settleUntil = 0;
  let baseline = null, trials = [], trial = null, check = null, gazeCal = null;
  let showToParticipant = true, levelShown = null;
  let wgReady = false, gazeSelect = true, calibrating = false, warmupLocked = false;
  const gazeBuf = []; let gaze = null;            // smoothed gaze {x, y, t}
  let dwell = { el: null, start: 0, lastSeen: 0 };

  // ------------------------------------------------------------------- UI ----
  const css = `
  #ps-bar{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9000;display:flex;align-items:center;gap:10px;
    padding:6px 8px 6px 12px;border:1px solid #DDE2DB;border-radius:99px;background:rgba(255,255,255,.94);
    font:600 12px Inter,"Segoe UI",Arial,sans-serif;color:#28362F;box-shadow:0 2px 10px rgba(38,55,43,.06)}
  #ps-bar .dot{width:8px;height:8px;border-radius:50%;background:#C4CFC6}#ps-bar .dot.on{background:#267B53}#ps-bar .dot.err{background:#AD594D}
  #ps-level{min-width:84px;text-align:center;padding:5px 12px;border-radius:99px;background:#EDF0EB;color:#78847B;font-weight:800;letter-spacing:.06em}
  #ps-level.low{background:#DDEFE3;color:#1D6041}#ps-level.medium{background:#FBEBCB;color:#7A5410}#ps-level.high{background:#F4D9D4;color:#8A3227}
  #ps-meta{color:#78847B;font-weight:600;white-space:nowrap;max-width:46vw;overflow:hidden;text-overflow:ellipsis}
  .ps-btn{border:1px solid #D7DED7;background:#fff;color:#425248;border-radius:8px;padding:6px 11px;font-weight:700;font-size:12px;font-family:inherit;cursor:pointer}
  .ps-btn.primary{background:#267B53;border-color:#267B53;color:#fff}
  #ps-panel{position:fixed;top:62px;left:50%;transform:translateX(-50%);z-index:9000;width:min(580px,92vw);display:none;
    padding:14px 16px;border:1px solid #DDE2DB;border-radius:13px;background:#fff;font:500 13px Inter,"Segoe UI",Arial,sans-serif;color:#28362F;box-shadow:0 8px 26px rgba(38,55,43,.08)}
  #ps-panel.open{display:block}
  #ps-panel .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
  #ps-panel .res{font-size:12px;color:#425248;margin:2px 0 6px;line-height:1.45}
  #ps-panel .warn{font-size:12px;color:#9A5B12;min-height:16px}
  #ps-panel canvas{width:100%;height:90px;display:block;margin-top:6px;border:1px solid #E7EBE5;border-radius:8px}
  #ps-panel label{font-size:12px;color:#78847B;display:flex;gap:6px;align-items:center}
  .ps-eyes{display:flex;gap:8px;align-items:center}.ps-eyes img{width:96px;height:48px;image-rendering:pixelated;background:#000;border-radius:5px}
  #ps-cover{position:fixed;inset:0;z-index:9500;display:none;align-items:center;justify-content:center;flex-direction:column;background-size:cover;background-position:center}
  #ps-cover .cross,#ps-cover .msg,#ps-cover .cnt{position:relative;z-index:2}#ps-cover .cnt{position:absolute}
  #ps-cover .cross{font:300 64px/1 Arial,sans-serif}#ps-cover .msg{margin-top:22px;font:600 24px Inter,Arial,sans-serif;text-align:center;padding:6px 14px;border-radius:10px}
  #ps-cover .cnt{position:absolute;top:16px;right:22px;font:600 15px Inter,Arial,sans-serif}
  #ps-calib{position:fixed;inset:0;z-index:9400;display:none;background:var(--page,#F4F1E9);color:#28362F;font-family:Inter,"Segoe UI",Arial,sans-serif}
  #ps-calib.open{display:block}
  #ps-calib .card{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(760px,90vw);text-align:center}
  #ps-calib .kicker{font-size:13px;font-weight:800;letter-spacing:.12em;color:#267B53}
  #ps-calib h1{margin:12px 0 10px;font-size:clamp(34px,4.6vh,52px);letter-spacing:-.04em;line-height:1.05}
  #ps-calib p{font-size:clamp(19px,2.3vh,24px);line-height:1.45;color:#425248;margin:0 auto 14px;max-width:640px}
  #ps-calib .steps{display:flex;justify-content:center;gap:10px;margin:0 0 22px}
  #ps-calib .steps span{padding:6px 12px;border-radius:99px;background:#E6EBE4;color:#78847B;font-size:13px;font-weight:700}
  #ps-calib .steps span.on{background:#267B53;color:#fff}#ps-calib .steps span.done{background:#DDEFE3;color:#1D6041}
  #ps-calib .big{min-height:56px;padding:0 28px;font-size:18px;border-radius:10px}
  #ps-calib .actions{display:flex;justify-content:center;gap:12px;margin-top:18px;flex-wrap:wrap}
  #ps-calib .result{font-size:16px;color:#28362F;margin:10px auto;max-width:640px;line-height:1.5}
  #ps-calib .skip{position:absolute;right:20px;bottom:16px;font-size:12px;color:#78847B;background:none;border:0;cursor:pointer;text-decoration:underline}
  #ps-calib .status{font-size:14px;color:#78847B;min-height:20px;margin-top:10px}
  #ps-dot{position:fixed;z-index:9450;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:#267B53;display:none;
    box-shadow:0 0 0 10px rgba(38,123,83,.18)}
  @keyframes ps-zoom{from{transform:scale(1.6)}to{transform:scale(.45)}}
  @keyframes ps-pop{from{transform:scale(1.8)}to{transform:scale(1)}}
  #ps-dot.zoom{animation:ps-zoom .9s ease forwards}
  #ps-dot::after{content:"";position:absolute;left:50%;top:50%;width:10px;height:10px;margin:-5px;border-radius:50%;background:#fff}
#ps-dot.val{background:#E99A2E;box-shadow:0 0 0 10px rgba(233,154,46,.2)}
  body.ps-positioning #webgazerVideoContainer{position:relative!important;left:auto!important;top:auto!important;
    margin:6px auto 0;border-radius:10px;overflow:hidden;z-index:1!important}
  #ps-light{display:inline-flex;align-items:center;gap:8px;margin-top:10px;padding:6px 14px;border-radius:99px;font-size:15px;font-weight:700;background:#EDF0EB;color:#425248}
  #ps-light.dark{background:#FBEBCB;color:#7A5410}#ps-light.ok{background:#DDEFE3;color:#1D6041}#ps-light.bright{background:#FBEBCB;color:#7A5410}
  #ps-cal-click{position:fixed;inset:0;z-index:9450;background:var(--page,#F4F1E9)}
  #ps-cal-click .tip{position:absolute;left:50%;top:36%;transform:translate(-50%,-50%);width:min(560px,70vw);text-align:center;
    font:600 clamp(18px,2.2vh,24px)/1.45 Inter,"Segoe UI",Arial,sans-serif;color:#425248;pointer-events:none}
  #ps-cal-click .cp{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:0;cursor:pointer;
    background:#D9473A;opacity:.25;box-shadow:0 0 0 8px rgba(217,71,58,.12);transition:opacity .15s,background .2s;animation:ps-pop .5s ease}
  #ps-cal-click .cp.done{background:#267B53;opacity:1;box-shadow:0 0 0 8px rgba(38,123,83,.18);cursor:default}
  #ps-cal-click .cp.hidden{display:none}
  #ps-dwell{position:fixed;z-index:8900;height:10px;border-radius:6px;background:#267B53;display:none;pointer-events:none}
  body.ps-hidden-level #ps-level,body.ps-hidden-level #ps-meta{visibility:hidden}`;
  document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);
  if (GRID_KEY !== '3x3') {
    const gw = GRID.cols === 3 ? 'min(1240px, 78vw)' : 'min(860px, 58vw)';
    document.head.insertAdjacentHTML('beforeend', `<style id="ps-grid-css">
      :root{--bus-card-h:min(31svh,calc((100svh - 300px)/2)) !important;--bus-card-w:calc(var(--bus-card-h)*.96) !important;--bus-row-gap:clamp(36px,6svh,72px) !important}
      .game-screen .bus-grid,.ps-fake .bus-grid{width:${gw} !important;margin:clamp(10px,3svh,40px) auto 0 !important;
        grid-template-columns:repeat(${GRID.cols},1fr) !important;justify-items:center}
    </style>`);
  }
  document.body.insertAdjacentHTML('beforeend', `
  <div id="ps-bar" role="status" aria-live="polite">
    <span class="dot" id="ps-sdot" title="PupilSense connection"></span>
    <span id="ps-level">—</span>
    <span id="ps-meta">Calibration starts after the safety check</span>
    <button class="ps-btn" id="ps-toggle" aria-expanded="false">Pupil ▾</button>
  </div>
  <div id="ps-panel" aria-label="PupilSense controls">
    <div class="row"><button class="ps-btn" id="ps-recal">Calibrate again</button><button class="ps-btn" id="ps-check">Light check</button>
      <button class="ps-btn" id="ps-export">Export CSV</button></div>
    <div class="res" id="ps-r-gaze"></div><div class="res" id="ps-r-base"></div><div class="res" id="ps-r-check"></div><div class="res" id="ps-r-cam"></div>
    <div class="ps-eyes"><img id="ps-eyeL" alt=""><img id="ps-eyeR" alt=""><span class="res" id="ps-mm"></span></div>
    <canvas id="ps-chart"></canvas>
    <div class="warn" id="ps-warn"></div>
    <div class="row"><label><input type="checkbox" id="ps-show" checked> Show level to participant</label>
      <label><input type="checkbox" id="ps-gsel" checked> Gaze selection (dwell)</label>
      <label><input type="checkbox" id="ps-gdot"> Show gaze dot</label>
      <label title="For testing without eye tracking: the mouse pointer acts as the gaze"><input type="checkbox" id="ps-mgaze"> Mouse as gaze (test)</label></div>
    <div class="row"><label>Dwell <input type="number" id="ps-dwellms" value="${CFG.dwellMs}" min="400" max="4000" step="100" style="width:64px"> ms</label>
      <label>Readings/s <input type="number" id="ps-fps" value="${CFG.fps}" min="2" max="30" style="width:48px"></label>
      <label>Exclude after stand-up <input type="number" id="ps-settle" value="${CFG.settleS}" min="0" max="15" style="width:48px"> s</label></div>
    <div class="res" style="color:#78847B">Observation only — difficulty is not changed. Each game phase is compared with its own seated baseline.</div>
  </div>
  <div id="ps-calib" role="dialog" aria-modal="true" aria-labelledby="ps-c-title">
    <div class="card">
      <div class="steps"><span id="ps-st1">1 Camera</span><span id="ps-st2">2 Eye tracking</span><span id="ps-st3">3 Pupil baseline</span></div>
      <div class="kicker" id="ps-c-kicker">CALIBRATION</div>
      <h1 id="ps-c-title">Let’s set up the camera.</h1>
      <p id="ps-c-text"></p>
      <div class="result" id="ps-c-result"></div>
      <div class="actions" id="ps-c-actions"></div>
      <div class="status" id="ps-c-status"></div>
    </div>
    <button class="skip" id="ps-c-skip">Researcher: skip this step</button>
  </div>
  <div id="ps-dot"></div><div id="ps-dwell"></div>
  <div id="ps-cover"><div class="cnt" id="ps-cnt"></div><div class="cross">+</div><div class="msg" id="ps-msg"></div></div>`);
  const $ = id => document.getElementById(id);
  $('ps-toggle').onclick = () => { const o = $('ps-panel').classList.toggle('open'); $('ps-toggle').setAttribute('aria-expanded', o); $('ps-toggle').textContent = o ? 'Pupil ▴' : 'Pupil ▾'; drawChart(); };
  $('ps-show').onchange = e => { showToParticipant = e.target.checked; document.body.classList.toggle('ps-hidden-level', !showToParticipant); };
  $('ps-gsel').onchange = e => { gazeSelect = e.target.checked; resetDwell(); };
  $('ps-gdot').onchange = e => { if (wgReady) webgazer.showPredictionPoints(e.target.checked); };
  let mouseGaze = false;
  $('ps-mgaze').onchange = e => { mouseGaze = e.target.checked; resetDwell(); };
  document.addEventListener('mousemove', e => { if (mouseGaze) onGaze({ x: e.clientX, y: e.clientY }, true); }, true);
  $('ps-dwellms').oninput = e => { CFG.dwellMs = Math.max(300, +e.target.value || CFG.dwellMs); };
  $('ps-fps').oninput = e => { CFG.fps = Math.min(30, Math.max(2, +e.target.value || CFG.fps)); };
  $('ps-settle').oninput = e => { CFG.settleS = Math.max(0, +e.target.value || 0); };
  $('ps-recal').onclick = () => { $('ps-panel').classList.remove('open'); openCalibration(); };

  // ------------------------------------------------------- PupilSense server ----
  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => { $('ps-sdot').className = 'dot' + (streaming ? ' on' : ''); };
    ws.onclose = () => { $('ps-sdot').className = 'dot err'; inflight = 0; setTimeout(connect, 2000); };
    ws.onmessage = ev => { inflight = Math.max(0, inflight - 1); onResult(JSON.parse(ev.data)); };
  }
  connect();

  function pump() {
    if (!streaming) return;
    const t = performance.now();
    if (inflight < CFG.inflight && ws?.readyState === 1 && t - lastSend >= 1000 / CFG.fps && video?.readyState >= 2 && video.videoWidth) {
      lastSend = t; inflight++;
      const vw = video.videoWidth, vh = video.videoHeight, s = Math.min(1, 640 / vw, 480 / vh);
      const W = Math.round(vw * s), H = Math.round(vh * s);
      if (grab.width !== W || grab.height !== H) { grab.width = W; grab.height = H; }
      gctx.drawImage(video, 0, 0, W, H);
      grab.toBlob(b => { if (b && ws.readyState === 1) ws.send(b); else inflight = Math.max(0, inflight - 1); }, 'image/jpeg', 0.9);
    }
    requestAnimationFrame(pump);
  }

  function onResult(r) {
    if (r.error) return;
    const t = now();
    const vals = [r.left_mm, r.right_mm].filter(v => v != null && isFinite(v));
    const pupil = vals.length ? mean(vals) : null;
    let valid = r.face && !r.blink && pupil != null && pupil > 1 && pupil < 9;
    if (valid) {
      const recent = samples.filter(s => s.valid && s.t > t - 2).map(s => s.pupil);
      if (recent.length >= 5 && Math.abs(pupil - median(recent)) > 1) valid = false;
    }
    const postMove = phase === 'movement' || t < settleUntil;
    samples.push({ t, iso: new Date().toISOString(), phase, screen, attemptId: attempt?.attemptId ?? '', set: attempt?.set ?? '', rep: attempt?.rep ?? '',
                   pupil, left: r.left_mm, right: r.right_mm, blink: r.blink, face: r.face, valid, postMove, lum: r.lum, faceW: r.face_w,
                   gx: gaze && t - gaze.t < 0.5 ? Math.round(gaze.x) : '', gy: gaze && t - gaze.t < 0.5 ? Math.round(gaze.y) : '' });
    if (r.crops?.left_eye) { $('ps-eyeL').src = r.crops.left_eye; }
    if (r.crops?.right_eye) { $('ps-eyeR').src = r.crops.right_eye; }
    const rate = samples.filter(x => x.t > t - 3).length / 3;
    $('ps-mm').textContent = (r.blink ? 'blink' : `L ${fmt(r.left_mm)} · R ${fmt(r.right_mm)} mm`) + ` · ${rate.toFixed(1)} readings/s · ${fmt(r.ms, 0)} ms`;
  }

  // ------------------------------------------------------------- WebGazer ----
  function loadWebGazer() {
    return new Promise((resolve, reject) => {
      if (window.webgazer) return resolve();
      const s = document.createElement('script'); s.src = WG_URL; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error('Could not load WebGazer — check the internet connection'));
      document.head.appendChild(s);
    });
  }
  async function startTracking() {
    if (wgReady) return;
    await loadWebGazer();
    webgazer.params.faceMeshSolutionPath = WG_MESH;
    webgazer.saveDataAcrossSessions(false);
    webgazer.applyKalmanFilter(true);
    webgazer.setRegression('ridge');
    webgazer.setGazeListener(onGaze);
    await webgazer.begin();
    webgazer.removeMouseEventListeners();      // train only from the calibration dots
    webgazer.showPredictionPoints(false);
    await webgazer.clearData();
    wgReady = true;
    // Share WebGazer's camera stream with PupilSense (one camera, no second permission prompt)
    video = document.getElementById('webgazerVideoFeed');
    streaming = true; $('ps-sdot').className = 'dot on'; requestAnimationFrame(pump);
  }
  function lockExposureNow() {
    const track = video?.srcObject?.getVideoTracks?.()[0];
    if (track) lockExposure(track);
  }
  async function lockExposure(track) {
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {}, set = track.getSettings(), adv = {};
      if (caps.exposureMode?.includes('manual')) { adv.exposureMode = 'manual'; if (set.exposureTime) adv.exposureTime = set.exposureTime; }
      if (caps.whiteBalanceMode?.includes('manual')) { adv.whiteBalanceMode = 'manual'; if (set.colorTemperature) adv.colorTemperature = set.colorTemperature; }
      if (Object.keys(adv).length) { await track.applyConstraints({ advanced: [adv] }); $('ps-r-cam').textContent = 'Camera exposure locked ✓'; }
      else $('ps-r-cam').textContent = 'Camera exposure could not be locked from the browser — keep room lighting steady.';
    } catch { $('ps-r-cam').textContent = 'Camera exposure could not be locked — keep room lighting steady.'; }
  }

  function onGaze(data, fromMouse = false) {
    if (!data) return;
    if (mouseGaze && !fromMouse) return;     // test mode: ignore the camera gaze
    const t = now();
    gazeBuf.push({ x: data.x, y: data.y }); if (gazeBuf.length > 5) gazeBuf.shift();
    gaze = { x: mean(gazeBuf.map(p => p.x)), y: mean(gazeBuf.map(p => p.y)), t };
    if (valCollect) valCollect.push({ x: gaze.x, y: gaze.y });
    if (gazeSelect && !calibrating) updateDwell(t);
  }

  // ---------------------------------------------------------- dwell select ----
  function dwellTargets() {
    if (screen === 'warmup' && !warmupLocked) return [document.getElementById('warmupBus')].filter(Boolean);
    if (phase === 'search') return [...document.querySelectorAll('#busGrid .bus-card')];
    // already locked: looking at a DIFFERENT bus for the dwell time changes the selection
    if (phase === 'confirm' && CYB.inputs.clearGazeTarget) return [...document.querySelectorAll('#busGrid .bus-card:not(.gaze-locked)')];
    return [];
  }
  function hit(x, y, els) {
    let best = null, bestD = Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect(), p = CFG.dwellPad;
      if (x < r.left - p || x > r.right + p || y < r.top - p || y > r.bottom + p) continue;
      const d = Math.hypot(x - (r.left + r.right) / 2, y - (r.top + r.bottom) / 2);
      if (d < bestD) { bestD = d; best = el; }
    }
    return best;
  }
  function resetDwell() { dwell = { el: null, start: 0, lastSeen: 0 }; $('ps-dwell').style.display = 'none'; }
  function updateDwell(t) {
    const els = dwellTargets();
    if (!els.length) { if (dwell.el) resetDwell(); return; }
    const h = hit(gaze.x, gaze.y, els), ms = t * 1000;
    if (h && h === dwell.el) dwell.lastSeen = ms;
    else if (h) { if (!dwell.el || ms - dwell.lastSeen > CFG.dwellGraceMs) dwell = { el: h, start: ms, lastSeen: ms }; }
    else if (dwell.el && ms - dwell.lastSeen > CFG.dwellGraceMs) { resetDwell(); return; }
    if (!dwell.el) return;
    const prog = Math.min(1, (ms - dwell.start) / CFG.dwellMs), r = dwell.el.getBoundingClientRect(), bar = $('ps-dwell');
    Object.assign(bar.style, { display: 'block', left: `${r.left + 10}px`, top: `${r.bottom - 18}px`, width: `${Math.max(4, (r.width - 20) * prog)}px` });
    if (prog >= 1) {
      const el = dwell.el; resetDwell();
      if (el.id === 'warmupBus') CYB.inputs.warmupGazeLocked();
      else if (el.dataset.route) {
        if (phase === 'confirm' && CYB.inputs.clearGazeTarget) CYB.inputs.clearGazeTarget();
        CYB.inputs.gazeTarget(el.dataset.route);
      }
    }
  }

  // ---------------------------------------------------- game phase events ----
  CYB.subscribe(ev => {
    const t = now(), d = ev.detail || {};
    switch (ev.type) {
      case 'screen_changed': screen = d.screen; if (d.screen !== 'game') phase = d.screen; resetDwell(); break;
      case 'session_started': warmupLocked = false; openCalibration(); break;
      case 'warmup_gaze_locked': warmupLocked = true; resetDwell(); break;
      case 'trial_memory_shown':
        phase = 'memory'; attempt = { attemptId: d.attemptId, set: d.set, rep: d.rep };
        trial = { attemptId: d.attemptId, set: d.set, rep: d.rep, target: d.targetRoute, memStart: t,
                  sinceStandUp: settleUntil ? +(t - (settleUntil - CFG.settleS)).toFixed(2) : '' };
        break;
      case 'trial_search_started': phase = 'search'; if (trial) trial.searchStart = t; break;
      case 'gaze_target_locked': phase = 'confirm'; resetDwell(); if (trial) { trial.lockAt = t; trial.searchTimeMs = d.searchTimeMs; trial.selected = d.route; trial.lockSource = d.source; } break;
      case 'gaze_target_cleared': phase = 'search'; resetDwell(); if (trial) { trial.reselections = (trial.reselections || 0) + 1; trial.lockAt = null; } break;
      case 'emg_confirmed':
        phase = 'movement';
        if (trial) { trial.correct = d.isCorrect; trial.emgAt = t; finaliseTrial(trial); trials.push(trial); trial = null; }
        break;
      case 'rep_completed': phase = 'settle'; settleUntil = t + CFG.settleS; break;
      case 'rest_started': phase = 'rest'; attempt = null; break;
      case 'session_completed': phase = 'done'; attempt = null; break;
      case 'new_session_ready': phase = 'setup'; attempt = null; trials = []; samples = []; break;
    }
  });

  // ---------------------------------------------------- calibration scene ----
  const C = { title: $('ps-c-title'), text: $('ps-c-text'), result: $('ps-c-result'), actions: $('ps-c-actions'), status: $('ps-c-status'), kicker: $('ps-c-kicker') };
  let skipRequested = false;
  $('ps-c-skip').onclick = () => { skipRequested = true; };
  function stepMarks(active) {
    [1, 2, 3].forEach(i => { const el = $('ps-st' + i); el.className = i < active ? 'done' : i === active ? 'on' : ''; });
  }
  function view({ kicker = 'CALIBRATION', title, text = '', result = '', status = '' }) {
    C.kicker.textContent = kicker; C.title.textContent = title; C.text.textContent = text;
    C.result.innerHTML = result; C.status.textContent = status; C.actions.replaceChildren();
    $('ps-calib').querySelector('.card').style.display = '';
  }
  function choose(buttons) {   // [{label, value, primary}] -> Promise(value)
    return new Promise(resolve => {
      C.actions.replaceChildren(...buttons.map(b => {
        const el = document.createElement('button'); el.className = 'ps-btn big' + (b.primary ? ' primary' : '');
        el.textContent = b.label; el.onclick = () => resolve(b.value); return el;
      }));
      C.actions.querySelector('.primary')?.focus();
    });
  }
  const hideCard = () => { $('ps-calib').querySelector('.card').style.display = 'none'; };
  let calOpen = false;

  async function openCalibration() {
    if (calOpen) return;
    calOpen = true; calibrating = true; resetDwell();
    $('ps-calib').classList.add('open');
    try {
      // 1. camera + positioning
      stepMarks(1);
      view({ title: 'Let’s set up the camera.', text: 'The camera follows your eyes during the game. Nothing is recorded or sent anywhere — it stays on this computer.' });
      await choose([{ label: 'Start camera', value: 1, primary: true }]);
      C.status.textContent = 'Starting the camera… (allow camera access if asked)';
      try { await startTracking(); }
      catch (e) {
        view({ title: 'The camera could not start.', text: e.message || String(e), result: 'Open this page as http://localhost:8000/game/ in Chrome or Edge, allow the camera, and close other apps using it.' });
        await choose([{ label: 'Continue without eye tracking', value: 1 }]); return;
      }
      view({ title: 'Sit comfortably.', text: 'Keep your face inside the box, about an arm’s length from the screen. Light your face from the front.' });
      const vc = document.getElementById('webgazerVideoContainer');
      const vh = Math.round(Math.min(360, innerHeight * 0.38)), vw = Math.round(vh * 4 / 3);
      webgazer.setVideoViewerSize(vw, vh);
      webgazer.showVideoPreview(true); webgazer.showFaceOverlay(false); webgazer.showFaceFeedbackBox(true);
      document.body.classList.add('ps-positioning');
      if (vc) C.result.appendChild(vc);
      C.result.insertAdjacentHTML('beforeend', '<div><span id="ps-light">Checking light…</span></div>');
      const meter = setInterval(() => {            // live lighting check from the camera image
        const el = $('ps-light'); if (!el) return;
        const lum = mean(samples.filter(x => x.t > now() - 1.5 && x.lum != null).map(x => x.lum));
        if (!isFinite(lum)) { el.className = ''; el.textContent = 'Checking light…'; return; }
        if (lum < 70) { el.className = 'dark'; el.textContent = `Too dark (${Math.round(lum)}) — turn on a light in front of you`; }
        else if (lum > 190) { el.className = 'bright'; el.textContent = `Very bright (${Math.round(lum)}) — avoid light shining into the camera`; }
        else { el.className = 'ok'; el.textContent = `Lighting OK (${Math.round(lum)})`; }
      }, 500);
      await choose([{ label: 'My face is in the box', value: 1, primary: true }]);
      clearInterval(meter);
      document.body.classList.remove('ps-positioning');
      if (vc) document.body.appendChild(vc);
      webgazer.showVideoPreview(false);
      webgazer.setVideoViewerSize(320, 240);
      lockExposureNow();                              // lock brightness now that lighting is set up

      // 2. gaze calibration + validation
      let again = true;
      while (again) {
        stepMarks(2);
        view(CAL_MODE === 'click'
          ? { title: 'Click the red dot.', text: 'A red dot will appear in different places, one at a time. Look at it and click it 5 times — keep looking at it while you click. It turns green, then the next dot appears.' }
          : { title: 'Follow the green dot.', text: 'A green dot will appear in different places. Look at the centre of each dot until it moves. You do not need to click.' });
        if (await choose([{ label: 'Start', value: 'go', primary: true }, { label: 'Skip eye tracking', value: 'skip' }]) === 'skip') { gazeCal = { skipped: true }; break; }
        skipRequested = false;
        hideCard();
        await webgazer.clearData();
        const ok = CAL_MODE === 'click' ? await runClickCalibration() : await runGazeCalibration();
        if (!ok) { gazeCal = { skipped: true }; break; }
        if (CAL_MODE === 'click') {
          view({ title: 'Now just look.', text: 'Orange dots will appear one at a time. Look at each one — do not click. This checks how well the eye tracking works.' });
          await choose([{ label: 'Start check', value: 1, primary: true }]); hideCard();
        }
        const v = await runGazeValidation();
        gazeCal = v; gazeCal.mode = CAL_MODE;
        if (!isFinite(v.median)) {
          gazeCal.quality = 'Failed';
          view({ title: 'The camera could not find your eyes.', text: 'Face the screen, make sure your face is well lit and inside the camera view, then try again.' });
          again = await choose([{ label: 'Try again', value: true, primary: true }, { label: 'Continue without eye tracking', value: false }]);
          if (!again) { gazeCal.skipped = true; }
          continue;
        }
        const card = cardSize();
        const quality = v.median <= card.w * 0.35 ? 'Good' : v.median <= card.w * 0.6 ? 'OK' : 'Poor';
        view({ title: quality === 'Poor' ? 'Let’s try that again.' : 'Eye tracking is ready.',
               text: quality === 'Poor' ? 'The camera had trouble following your eyes. Sit still, face the screen, and try once more.' : 'Well done.',
               result: `Accuracy: <b>${quality}</b> — typical error ${Math.round(v.median)} px (90% within ${Math.round(v.p90)} px). Bus cards are about ${Math.round(card.w)} px wide.` });
        gazeCal.quality = quality;
        again = (await choose(quality === 'Poor'
          ? [{ label: 'Try again', value: true, primary: true }, { label: 'Continue anyway', value: false }]
          : [{ label: 'Continue', value: false, primary: true }, { label: 'Calibrate again', value: true }]));
      }
      $('ps-r-gaze').textContent = gazeCal?.skipped ? 'Eye tracking not calibrated (skipped or failed).' :
        `Eye tracking: ${gazeCal.quality} — median error ${Math.round(gazeCal.median)} px, 90% within ${Math.round(gazeCal.p90)} px`;
      if (gazeCal?.skipped) gazeSelect = false, $('ps-gsel').checked = false;

      // 3. pupil baseline
      stepMarks(3);
      view({ title: 'Now just relax.', text: 'Look at the cross in the middle of the screen. This takes about 25 seconds. Blink normally.' });
      if (await choose([{ label: 'Start', value: 'go', primary: true }, { label: 'Skip pupil baseline', value: 'skip' }]) === 'go') {
        hideCard();
        try {
          baseline = await recordBaseline();
          $('ps-r-base').textContent = baselineText(baseline);
          view({ kicker: 'ALL SET', title: 'Calibration complete.', text: 'Next, a quick practice with one bus.',
                 result: `${$('ps-r-gaze').textContent}<br>${baselineText(baseline)}` });
          if (baseline.memory.validFrac < 0.6 || baseline.search.validFrac < 0.6)
            C.status.textContent = 'Note: the camera could not see the eyes clearly for part of the baseline. You can redo it from the Pupil menu.';
          await choose([{ label: 'Start practice', value: 1, primary: true }]);
        } catch { /* cancelled */ }
      }
    } finally {
      document.body.classList.remove('ps-positioning');
      $('ps-calib').classList.remove('open'); $('ps-dot').style.display = 'none';
      calOpen = false; calibrating = false; phase = screen;
    }
  }

  function cardSize() {   // actual bus-card size for the current layout (reads the game's CSS variables)
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;width:var(--bus-card-w);height:var(--bus-card-h)';
    document.body.appendChild(probe);
    const r = probe.getBoundingClientRect(); probe.remove();
    if (r.width > 0 && r.height > 0) return { w: r.width, h: r.height };
    const h = Math.min(0.23 * innerHeight, (innerHeight - 245) / 3);   // fallback: original 3x3 formula
    return { w: 0.96 * h, h };
  }
  const CAL_POINTS = [[.5, .5], [.1, .1], [.5, .1], [.9, .1], [.9, .5], [.9, .9], [.5, .9], [.1, .9], [.1, .5]];
  const VAL_POINTS = [[.3, .3], [.7, .3], [.5, .5], [.3, .7], [.7, .7]];
  async function showDot(fx, fy, cls) {   // every dot zooms in from large to small
    const dot = $('ps-dot'), x = fx * innerWidth, y = fy * innerHeight;
    dot.style.display = 'none'; dot.className = cls || '';
    dot.style.left = `${x}px`; dot.style.top = `${y}px`;
    dot.style.display = 'block';
    void dot.offsetWidth;                  // restart the animation
    dot.classList.add('zoom');
    return { x, y };
  }
  async function runGazeCalibration() {
    for (const [fx, fy] of CAL_POINTS) {
      if (skipRequested) return false;
      const { x, y } = await showDot(fx, fy);
      await sleep(CFG.calSettleMs);
      const n = Math.round(CFG.calRecordMs / 1000 * CFG.calHz);
      for (let i = 0; i < n; i++) { webgazer.recordScreenPosition(x, y, 'click'); await sleep(1000 / CFG.calHz); }
    }
    $('ps-dot').style.display = 'none';
    return true;
  }
  function runClickCalibration(clicksPerDot = 5) {   // WebGazer-style: click each dot 5x while looking at it
    return new Promise(resolve => {
      const wrap = document.createElement('div'); wrap.id = 'ps-cal-click';
      wrap.innerHTML = `<div class="tip">Look at the red dot and click it ${clicksPerDot} times.<br>Keep your eyes on the dot while you click.</div>`;
      const order = [...CAL_POINTS.slice(1), CAL_POINTS[0]];          // centre dot last
      const poll = setInterval(() => { if (skipRequested) end(false); }, 200);
      function end(ok) { clearInterval(poll); wrap.remove(); resolve(ok); }
      function showPoint(i) {                                          // one dot at a time
        if (i >= order.length) { setTimeout(() => end(true), 300); return; }
        const [fx, fy] = order[i];
        const b = document.createElement('button'); b.className = 'cp';
        b.setAttribute('aria-label', `Calibration dot ${i + 1} of ${order.length}`);
        b.style.left = `${fx * 100}%`; b.style.top = `${fy * 100}%`;
        let n = 0;
        b.onclick = e => {
          e.stopPropagation();
          if (b.classList.contains('done')) return;
          const r = b.getBoundingClientRect();
          webgazer.recordScreenPosition(r.left + r.width / 2, r.top + r.height / 2, 'click');
          n++; b.style.opacity = String(Math.min(1, 0.25 + 0.15 * n));
          if (n >= clicksPerDot) {
            b.classList.add('done');
            setTimeout(() => { b.remove(); showPoint(i + 1); }, 350);
          }
        };
        wrap.appendChild(b);
        if (fx === 0.5 && fy === 0.5) wrap.querySelector('.tip').style.display = 'none';
      }
      document.body.appendChild(wrap);
      showPoint(0);
    });
  }
  let valCollect = null;
  async function runGazeValidation() {
    const errs = [], points = [];
    for (const [fx, fy] of VAL_POINTS) {
      const { x, y } = await showDot(fx, fy, 'val');
      await sleep(CFG.valSettleMs);
      valCollect = []; await sleep(CFG.valRecordMs);
      const got = valCollect; valCollect = null;
      if (got.length) {
        const px = median(got.map(p => p.x)), py = median(got.map(p => p.y)), e = Math.hypot(px - x, py - y);
        errs.push(e); points.push({ target: [Math.round(x), Math.round(y)], predicted: [Math.round(px), Math.round(py)], error: Math.round(e) });
      }
    }
    $('ps-dot').style.display = 'none';
    const sorted = [...errs].sort((a, b) => a - b);
    return { median: median(errs), mean: mean(errs), p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? NaN,
             points, screen: [innerWidth, innerHeight], at: new Date().toISOString() };
  }

  // ------------------------------------------------- full-screen blocks ----
  let cancel = null;
  function fakeGrid() {   // same cards, layout and header as the real Find screen (for a brightness-matched baseline)
    const nums = ['154', '45', '858', '10', '197', '33', '262', '74', '100'];
    const cards = nums.slice(0, GRID.cards).map(n => `<span class="bus-card" style="cursor:default"><span class="bus-art">
      <img src="assets/citaro-front-master.png" alt=""><span class="route-display"><span class="route-number">${n}</span></span></span></span>`).join('');
    return `<div class="ps-fake" style="position:absolute;inset:0;background:var(--page,#F4F1E9)">
      <div style="height:76px;background:rgba(255,255,255,.88);border-bottom:1px solid #DDE2DB"></div>
      <div class="game-screen" style="display:flex"><div class="find-panel"><h2 style="visibility:hidden">Find Your Bus!</h2>
      <div class="bus-grid">${cards}</div></div></div></div>`;
  }
  function cover(seconds, { bg = CFG.pageBg, image = null, grid = false, msg = '', color = '#28362F' }) {
    return new Promise((resolve, reject) => {
      const el = $('ps-cover');
      el.querySelector('.ps-fake')?.remove();
      if (grid) el.insertAdjacentHTML('afterbegin', fakeGrid());
      el.style.background = bg; el.style.backgroundImage = image ? `url("${image}")` : 'none';
      el.style.backgroundSize = 'cover'; el.style.color = color; el.style.display = 'flex';
      $('ps-msg').textContent = msg; $('ps-msg').style.background = (image || grid) ? 'rgba(255,255,255,.85)' : 'transparent';
      const start = now();
      const iv = setInterval(() => {
        const left = seconds - (now() - start); $('ps-cnt').textContent = Math.max(0, Math.ceil(left)) + ' s';
        if (left <= 0) { clearInterval(iv); el.style.display = 'none'; el.querySelector('.ps-fake')?.remove(); resolve({ start, end: now() }); }
      }, 200);
      cancel = () => { clearInterval(iv); el.style.display = 'none'; reject(new Error('cancelled')); };
    });
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('ps-cover').style.display === 'flex') cancel?.(); });

  function windowPupil(t0, t1, excludePost = true) {
    const w = samples.filter(s => s.t >= t0 && s.t <= t1), v = w.filter(s => s.valid && !(excludePost && s.postMove));
    return { pupil: median(v.map(s => s.pupil)), validFrac: w.length ? v.length / w.length : 0, n: w.length,
             postFrac: w.length ? w.filter(s => s.postMove).length / w.length : 0 };
  }
  async function recordBaseline() {
    phase = 'baseline';
    try {
      await cover(5, { msg: 'Sit comfortably and look at the cross.' });
      const m = await cover(CFG.baseS, { msg: 'Relax. Just look at the cross.' });
      const s = await cover(CFG.baseS, { grid: true, msg: 'Relax. Just look at the cross — no need to search.' });
      const summ = blk => {
        const w = samples.filter(x => x.t >= blk.start + 3 && x.t <= blk.end), v = w.filter(x => x.valid);
        const per = []; for (let a = blk.start + 3; a + CFG.win <= blk.end; a += 1) { const p = windowPupil(a, a + CFG.win, false).pupil; if (isFinite(p)) per.push(p); }
        return { pupil: median(v.map(x => x.pupil)), sd: Math.max(sd(per), 0.05), validFrac: w.length ? v.length / w.length : 0,
                 lum: mean(w.map(x => x.lum).filter(x => x != null)), faceW: mean(w.map(x => x.faceW).filter(x => x != null)) };
      };
      return { memory: summ(m), search: summ(s), created: new Date().toISOString() };
    } finally { phase = screen; }
  }
  function baselineText(b) {
    return `Pupil baseline — Remember screen ${fmt(b.memory.pupil)} ± ${fmt(b.memory.sd)} mm (${Math.round(b.memory.validFrac * 100)}% usable) · ` +
           `Find screen ${fmt(b.search.pupil)} ± ${fmt(b.search.sd)} mm (${Math.round(b.search.validFrac * 100)}% usable)`;
  }

  $('ps-check').onclick = async () => {
    if (!streaming) { $('ps-r-check').textContent = 'Run the calibration first (it starts the camera).'; return; }
    const prev = phase; phase = 'check';
    try {
      const w = await cover(CFG.checkS, { bg: '#ffffff', color: '#000' });
      const k = await cover(CFG.checkS, { bg: '#000000', color: '#666' });
      const off = Math.min(4, CFG.checkS / 2), W = windowPupil(w.start + off, w.end), B = windowPupil(k.start + off, k.end), diff = B.pupil - W.pupil;
      check = { white: W.pupil, black: B.pupil, diff };
      $('ps-r-check').textContent = `Light check: white ${fmt(W.pupil)} mm · black ${fmt(B.pupil)} mm · Δ ${fmt(diff)} mm → ` +
        (!isFinite(diff) ? 'FAIL (no usable readings)' : diff >= 0.3 ? 'PASS' : diff >= 0.1 ? 'WEAK' : 'FAIL — the model is not tracking this pupil; treat levels as unreliable');
    } catch { $('ps-r-check').textContent = 'Light check cancelled'; }
    phase = prev;
  };

  // ------------------------------------------------------------ live level ----
  function indexFor(p, which) {
    const b = baseline?.[which];
    if (!b || !isFinite(p)) return NaN;
    return (p - b.pupil) / (3 * b.sd);
  }
  const levelOf = idx => !isFinite(idx) ? null : idx < CFG.t1 ? 'low' : idx < CFG.t2 ? 'medium' : 'high';
  function finaliseTrial(tr) {
    const m = windowPupil(tr.memStart, tr.searchStart ?? tr.memStart, true);
    const mAll = windowPupil(tr.memStart, tr.searchStart ?? tr.memStart, false);
    const s = windowPupil((tr.searchStart ?? 0) + 0.5, tr.lockAt ?? tr.emgAt, true);
    Object.assign(tr, {
      mem_pupil: m.pupil, mem_pupil_incl_postmove: mAll.pupil, mem_valid: m.validFrac, mem_postmove_frac: mAll.postFrac,
      search_pupil: s.pupil, search_valid: s.validFrac, search_postmove_frac: s.postFrac,
      base_memory: baseline?.memory?.pupil, base_search: baseline?.search?.pupil,
      mem_index: indexFor(m.pupil, 'memory'), search_index: indexFor(s.pupil, 'search'),
    });
    tr.mem_level = levelOf(tr.mem_index); tr.search_level = levelOf(tr.search_index);
  }

  setInterval(tick, 1000);
  function tick() {
    if (!streaming || calibrating) { if (calibrating) { setLevel(null, 'CALIBRATING'); $('ps-meta').textContent = 'Calibration in progress'; } return; }
    const t = now();
    const which = phase === 'memory' ? 'memory' : (phase === 'search' || phase === 'confirm') ? 'search' : null;
    const warn = [];
    if (!baseline) {
      setLevel(null, 'NO BASELINE'); $('ps-meta').textContent = 'Pupil baseline not recorded — Pupil ▾ → Calibrate again';
    } else if (!which) {
      const label = { movement: 'STANDING', settle: 'SETTLING', rest: 'REST', warmup: 'WARM-UP', safety: 'SETUP', dashboard: 'DONE', done: 'DONE' }[phase] || '—';
      setLevel(null, label);
      const last = trials[trials.length - 1];
      $('ps-meta').textContent = last ? `last trial: Find ${last.search_level?.toUpperCase() ?? '–'} (${fmt(last.search_pupil)} mm)` : phaseName();
    } else {
      const phaseStart = which === 'memory' ? trial?.memStart : trial?.searchStart;
      const t0 = Math.max(t - CFG.win, phaseStart ?? t - CFG.win);
      const w = windowPupil(t0, t, true), b = baseline[which];
      const nValid = samples.filter(s => s.t >= t0 && s.t <= t && s.valid && !s.postMove).length;
      const idx = indexFor(w.pupil, which);
      if (w.postFrac > 0.5) warn.push('just stood up — waiting to settle');
      else if (nValid < 8) warn.push('collecting readings…');
      else if (w.validFrac < 0.5) warn.push(`only ${Math.round(w.validFrac * 100)}% usable frames (face/eyes lost or blinking)`);
      const recent = samples.filter(s => s.t >= t0 && s.t <= t);
      const lum = mean(recent.map(s => s.lum).filter(x => x != null)), fw = mean(recent.map(s => s.faceW).filter(x => x != null));
      if (b.lum && isFinite(lum) && Math.abs(lum / b.lum - 1) > 0.15) warn.push(`light ${Math.round((lum / b.lum - 1) * 100)}% vs baseline`);
      if (b.faceW && isFinite(fw) && Math.abs(fw / b.faceW - 1) > 0.12) warn.push(`sitting ${fw > b.faceW ? 'closer' : 'farther'} than at baseline`);
      const ok = !warn.length && isFinite(idx);
      if (ok) levelShown = levelOf(idx);
      setLevel(ok ? levelShown : null, ok ? null : 'PAUSED');
      $('ps-meta').textContent = `${phaseName()} · ${fmt(w.pupil)} mm (Δ ${isFinite(w.pupil) ? (w.pupil - b.pupil >= 0 ? '+' : '') + fmt(w.pupil - b.pupil) : '–'}) · idx ${fmt(idx)}` + (ok ? '' : ` · ${warn[0]}`);
    }
    $('ps-warn').textContent = warn.join(' · ');
    if ($('ps-panel').classList.contains('open')) drawChart();
  }
  function setLevel(level, label) { const el = $('ps-level'); el.className = level || ''; el.textContent = level ? level.toUpperCase() : (label || '—'); }
  function phaseName() { return { memory: 'Remember', search: 'Find', confirm: 'Find (locked)', setup: 'Setup', warmup: 'Warm-up' }[phase] || phase; }

  // ----------------------------------------------------------------- chart ----
  function drawChart() {
    const cv = $('ps-chart'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W) return;
    cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const t1 = now(), t0 = t1 - 90, pts = samples.filter(s => s.t >= t0);
    const shade = { memory: '#FBEBCB', search: '#DDEFE3', confirm: '#DDEFE3', movement: '#F4D9D4', settle: '#F7E7E3' };
    const x = t => (t - t0) / 90 * W;
    for (let i = 0; i < pts.length - 1; i++) { const c = shade[pts[i].phase]; if (c) { g.fillStyle = c; g.fillRect(x(pts[i].t), 0, x(pts[i + 1].t) - x(pts[i].t) + 1, H); } }
    const vals = pts.filter(s => s.valid).map(s => s.pupil).concat([baseline?.memory?.pupil, baseline?.search?.pupil].filter(isFinite));
    if (!vals.length) return;
    const lo = Math.min(...vals) - 0.2, hi = Math.max(...vals) + 0.2, y = v => H - 4 - (v - lo) / (hi - lo) * (H - 8);
    g.fillStyle = '#28362F';
    for (const s of pts) if (s.valid) { g.globalAlpha = s.postMove ? 0.25 : 0.9; g.fillRect(x(s.t) - 1, y(s.pupil) - 1, 2.5, 2.5); }
    g.globalAlpha = 1; g.font = '10px Inter,Arial'; g.fillStyle = '#78847B';
    g.fillText('last 90 s · orange = Remember · green = Find · red = standing/settling', 6, 12);
  }

  // ---------------------------------------------------------------- export ----
  function csv(rows) {
    if (!rows.length) return '';
    const keys = Object.keys(rows[0]);
    return [keys.join(','), ...rows.map(r => keys.map(k => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','))].join('\r\n');
  }
  function download(name, text, type = 'text/csv') {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  $('ps-export').onclick = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tr = trials.map(t => ({ attemptId: t.attemptId, set: t.set, rep: t.rep, target: t.target, selected: t.selected, correct: t.correct,
      lock_source: t.lockSource, reselections: t.reselections ?? 0, search_time_ms: t.searchTimeMs, s_since_stand_up_at_memory: t.sinceStandUp,
      mem_pupil_mm: fmt(t.mem_pupil, 3), mem_pupil_incl_postmove_mm: fmt(t.mem_pupil_incl_postmove, 3), mem_valid: fmt(t.mem_valid), mem_postmove_frac: fmt(t.mem_postmove_frac),
      search_pupil_mm: fmt(t.search_pupil, 3), search_valid: fmt(t.search_valid), search_postmove_frac: fmt(t.search_postmove_frac),
      base_memory_mm: fmt(t.base_memory, 3), base_search_mm: fmt(t.base_search, 3),
      mem_index: fmt(t.mem_index, 3), mem_level: t.mem_level ?? '', search_index: fmt(t.search_index, 3), search_level: t.search_level ?? '' }));
    const sm = samples.map(s => ({ time: s.iso, phase: s.phase, screen: s.screen, attemptId: s.attemptId, set: s.set, rep: s.rep,
      pupil_mm: fmt(s.pupil, 3), left_mm: fmt(s.left, 3), right_mm: fmt(s.right, 3), blink: s.blink, face: s.face, valid: s.valid,
      post_movement: s.postMove, gaze_x: s.gx, gaze_y: s.gy, light: fmt(s.lum, 1), face_w: fmt(s.faceW, 3) }));
    if (tr.length) download(`pupilsense_trials_${stamp}.csv`, csv(tr));
    if (sm.length) download(`pupilsense_samples_${stamp}.csv`, csv(sm));
    download(`pupilsense_meta_${stamp}.json`, JSON.stringify({ gazeCalibration: gazeCal, baseline, lightCheck: check, settings: CFG,
      gridLayout: GRID_KEY, calibrationMode: CAL_MODE, webgazerVersion: WG_VERSION, exportedAt: new Date().toISOString() }, null, 2), 'application/json');
  };

  window.PupilSenseOverlay = { getSamples: () => samples, getTrials: () => trials, getBaseline: () => baseline,
                               getGazeCalibration: () => gazeCal, openCalibration, simulateGaze: (x, y) => onGaze({ x, y }, true), config: CFG };
  console.info('[PupilSense] overlay ready');
})();
