/* pupilsense-adapter.js — calibration, workload, adaptive difficulty and EMG confirmation for "Catch Your Bus".
 *
 * Injected by pupil_server.py into the unchanged game (BN5213-UI-design); the server also patches the game's
 * app.js in memory for the 2x2 grid, difficulty levels, destinations and two/three-bus frames.
 *
 * After the Safety Check ("Start Session") a calibration scene runs:
 *   1. camera + face positioning (optional brightness lock)
 *   2. WebGazer calibration: click each of 9 dots 5 times, then look at 5 check dots (validation)
 *   3. pupil baseline: 10 s on the Remember screen + 10 s on the Find screen (PupilSense)
 *   4. EMG muscle sensor: connect Arduino, 5 s relaxed baseline, check the threshold (or skip = mouse click)
 *
 * During the game:
 *   - look at a bus for 2 s (dwell) to select it; look at another bus 2 s to change; EMG activation confirms
 *   - live workload LOW / MEDIUM / HIGH from pupil size vs each screen's own baseline
 *   - adaptive difficulty after each answer (6 levels); pupil samples just after a sit-to-stand are excluded
 *   - end page with score and pupil dilation per game; Excel summary exported automatically
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
    win: 6,                        // seconds used for baseline variation windows
    smoothS: 1.5,
    distTol: 0.15,                 // pause if face size differs from baseline by more than this (0.15 = 15%)
    distCheck: true,                  // live level: smoothing time constant in seconds (lower = faster, noisier)
    settleS: 4,                    // seconds excluded after a sit-to-stand
    t1: 0.33, t2: 0.66,            // index positions of the two thresholds (gauge only)
    medSD: 2, medMin: 0.10,        // MEDIUM from pupil >= baseline + max(2 SD, 0.10 mm)
    highSD: 3, highMin: 0.20,      // HIGH   from pupil >= baseline + max(3 SD, 0.20 mm)
    sdMin: 0.05,                   // baseline SD is never taken as smaller than this
    baseS: FAST ? 6 : 10,          // seconds per baseline screen
    checkS: FAST ? 4 : 12,         // seconds per colour in the light check
    valSettleMs: 900, valRecordMs: 1200,              // gaze validation per dot
    dwellMs: 2000, dwellGraceMs: 350, dwellPad: 40,   // gaze selection (look 2 s to select)
    pageBg: getComputedStyle(document.documentElement).getPropertyValue('--page').trim() || '#F4F1E9',
    gridImage: '/game/previews/game.png',
  };
  // Bus-grid layout, moved in from the screen corners where webcam gaze is least accurate.
  // Needs pupil_server.py's app.js patch to change the card count from the original 9.
  const GRID_KEY = '2x2', GRID = { cols: 2, rows: 2, cards: 4 };
  window.PupilSenseGrid = { cards: GRID.cards, layout: GRID_KEY };

  // ---- Difficulty levels (same 2x2 screen on every level; timing, look-alikes, destinations and bus count change)
  const LEVELS = [
    null,
    { memoryMs: 2500, delayMs: 1000, similarity: 'mid',  destination: false, duplicates: 0, twoBus: false, label: 'Look-alikes' },
    { memoryMs: 1800, delayMs: 2500, similarity: 'high', destination: false, duplicates: 0, twoBus: false, label: 'Look-alikes, fast' },
    { memoryMs: 2200, delayMs: 2500, similarity: 'high', destination: true,  duplicates: 1, twoBus: false, label: 'Number + destination' },
    { memoryMs: 4500, delayMs: 2000, similarity: 'high', destination: true,  duplicates: 0, twoBus: true,  label: 'Two buses' },
    { memoryMs: 3200, delayMs: 3500, similarity: 'high', destination: true,  duplicates: 0, twoBus: true,  label: 'Two buses, fast' },
    { memoryMs: 6000, delayMs: 2500, similarity: 'high', destination: true,  duplicates: 0, twoBus: true,  buses: 3, label: 'Three buses' },
  ];
  window.PupilSenseDestinations = ['Jurong East', 'Woodlands', 'Tampines', 'Bedok', 'Yishun', 'Clementi', 'Punggol', 'Bishan', 'Toa Payoh', 'Pasir Ris', 'Sengkang', 'Bukit Batok'];
  const DIFF = { level: 1, adaptive: true, upAfter: 1, streak: 0 };
  function applyDifficulty() {
    const L = LEVELS[DIFF.level], f = new URLSearchParams(location.search).get('fast') === '1' ? 0.3 : 1;
    window.PupilSenseDifficulty = { level: DIFF.level, memoryMs: Math.round(L.memoryMs * f), delayMs: Math.round(L.delayMs * f),
                                    similarity: L.similarity, destination: !!L.destination, duplicates: L.duplicates || 0, twoBus: !!L.twoBus, buses: L.twoBus ? (L.buses || 2) : 1 };
    const el = document.getElementById('ps-diff'); if (el) el.textContent = `Lv ${DIFF.level}`;
    const sel = document.getElementById('ps-lvl'); if (sel) sel.value = String(DIFF.level);
  }
  applyDifficulty();
  // Gaze calibration mode: 'click' = WebGazer standard (click each dot 5x while looking at it, default),
  // 'look' = hands-free (look at each dot, recorded automatically). Choose with ?cal=look
  const CAL_MODE = 'click';
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
  let live = { ema: null, phase: null, t: 0, n: 0 };   // live smoothed pupil for the current screen
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
  .route-display:has(.route-dest){flex-direction:column;gap:0}
  .route-display:has(.route-dest) .route-number{font-size:clamp(18px,3svh,27px)}
  .route-dest{color:#F7C66B;font:800 clamp(10px,1.45svh,14px)/1 Inter,"Segoe UI",Arial,sans-serif;letter-spacing:.02em;text-transform:uppercase;white-space:nowrap;margin-top:2px}
  #ps-memdest{color:#28362F;font:800 clamp(30px,4.5svh,52px)/1.1 Inter,"Segoe UI",Arial,sans-serif;letter-spacing:-.02em;margin-top:-10px;text-align:center;transition:opacity 300ms ease}
  #ps-memdest.fade-out{opacity:0}
  #ps-memtwo{display:flex;gap:clamp(40px,10vw,160px);justify-content:center;align-items:flex-start;transition:opacity 300ms ease}
  #ps-memtwo.fade-out{opacity:0}
  #ps-memtwo .b{text-align:center}
  #ps-memtwo .n{color:#E99A2E;font:900 clamp(72px,11svh,120px)/.95 "Arial Black",Inter,Arial,sans-serif;letter-spacing:.015em}
  #ps-memtwo .d{color:#28362F;font:800 clamp(26px,4svh,44px)/1.1 Inter,"Segoe UI",Arial,sans-serif;margin-top:8px}
  body.ps-pairs .game-screen .bus-grid{width:min(1560px,94vw) !important}
  body.ps-pairs .game-screen .bus-card{width:calc(var(--bus-card-h) * 2.05) !important;padding:10px 14px !important}
  body.ps-three .game-screen .bus-grid{width:min(1720px,97vw) !important}
  body.ps-three .game-screen .bus-card{width:min(calc(var(--bus-card-h) * 3), 47.5vw) !important;padding:8px 10px !important}
  body.ps-three .bus-art.ps-pair{gap:8px}
  #ps-memtwo.three{gap:clamp(30px,6vw,110px)}
  .bus-art.ps-pair{display:flex !important;gap:14px;aspect-ratio:auto !important;width:100%;height:100%;align-items:center}
  .bus-art.ps-pair>.bus-art{flex:1;min-width:0}
  #ps-final{max-width:1180px;margin:0 auto;padding:28px 28px 48px;color:#28362F;font-family:Inter,"Segoe UI",Arial,sans-serif}
  #ps-final .eyebrow{font-size:12px;letter-spacing:.14em;font-weight:800;color:#267B53;margin:0}
  #ps-final h1{font-size:44px;margin:6px 0 20px}
  #ps-final h2{font-size:20px;margin:0 0 6px}
  .ps-fcards{display:grid;grid-template-columns:2fr 1fr;gap:18px;margin-bottom:34px}
  .ps-fcard{background:#fff;border:1px solid #DDE2DB;border-radius:18px;padding:22px 26px;display:flex;flex-direction:column;gap:4px}
  .ps-fcard span{font-size:14px;font-weight:700;color:#5D6B62;text-transform:uppercase;letter-spacing:.08em}
  .ps-fcard strong{font-size:64px;line-height:1;color:#1D6041;font-weight:900}
  .ps-fscore strong{color:#E99A2E;font-size:84px}
  .ps-fcard em{font-style:normal;font-size:22px;font-weight:700}
  .ps-fcard small{font-size:16px;color:#5D6B62}
  .ps-qhead{border-top:1px solid #DDE2DB;padding-top:26px;margin-bottom:14px}
  #ps-final .ps-qtitle{font-size:28px;letter-spacing:-.02em;margin:6px 0 8px}
  .ps-qwarn{background:#FBEBCB;color:#7A5410;border-radius:12px;padding:12px 16px;font-size:15px;font-weight:600;margin-bottom:16px}
  .ps-qtiles{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}
  .ps-qtile{background:#fff;border:1px solid #DDE2DB;border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:4px}
  .ps-qtile span{font-size:12px;font-weight:700;color:#5D6B62;text-transform:uppercase;letter-spacing:.07em}
  .ps-qtile strong{font-size:30px;line-height:1.1;font-weight:850;color:#28362F;font-variant-numeric:tabular-nums}
  .ps-qtile small{font-size:13px;color:#5D6B62;line-height:1.35}
  @media (max-width:1000px){.ps-qtiles{grid-template-columns:1fr 1fr}}
  .ps-step{float:left;width:30px;height:30px;margin:-3px 12px 0 0;border-radius:50%;background:#267B53;color:#fff;font:800 15px/30px Inter,Arial,sans-serif;text-align:center}
  .ps-fpanel{background:#fff;border:1px solid #DDE2DB;border-radius:18px;padding:22px 26px;margin-bottom:18px}
  .ps-fnote{font-size:14px;color:#5D6B62;margin:0 0 12px;line-height:1.5}
  .ps-empty{color:#8A968E;font-size:15px;padding:30px 0;text-align:center}
  .ps-svg{width:100%;height:auto;display:block;font-family:Inter,"Segoe UI",Arial,sans-serif}
  .ps-svg .ax{font-size:12px;fill:#5D6B62}.ps-svg .ax.ink{fill:#28362F;font-weight:600}
  .ps-svg .val{font-size:15px;font-weight:800;fill:#28362F}.ps-svg .lvl{font-size:14px;font-weight:700;fill:#28362F}
  .ps-svg .trk{font-size:13px;font-weight:700;fill:#28362F}
  .ps-svg .mk{font-size:12px;font-weight:800;fill:#fff;pointer-events:none}
  .ps-svg .arr{font-size:16px;font-weight:800;fill:#28362F;pointer-events:none}
  .ps-svg .ok{font-size:18px;font-weight:800}.ps-svg .ok.yes{fill:#267B53}.ps-svg .ok.no{fill:#C2412D}
  .ps-svg .col{fill:transparent}.ps-svg .col:hover{fill:#28362F0D}
  .ps-svg *{pointer-events:none}.ps-svg [data-tip]{pointer-events:all;cursor:default}
  .ps-legend{display:flex;flex-wrap:wrap;gap:8px 20px;font-size:13px;color:#5D6B62;margin-top:6px}
  .ps-legend span{display:inline-flex;align-items:center;gap:6px}
  .ps-legend i,#ps-final i.chip{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;color:#fff;font:800 11px Inter,Arial,sans-serif;font-style:normal;flex:none}
  #ps-final i.chip{margin-right:8px;vertical-align:-4px}
  .ps-legend b.ok{font-size:15px}.ps-legend b.ok.yes{color:#267B53}.ps-legend b.ok.no{color:#C2412D}
  #ps-final .ps-ftable{width:100%;border-collapse:collapse;font-size:16px !important}
  #ps-final .ps-ftable th{text-align:left;font-size:12px !important;color:#5D6B62;font-weight:700;padding:8px 10px;border-bottom:2px solid #DDE2DB;letter-spacing:.06em;text-transform:uppercase}
  #ps-final .ps-ftable td{padding:11px 10px;border-bottom:1px solid #EEF0EC;font-size:16px !important;color:#28362F;font-variant-numeric:tabular-nums}
  #ps-final .ps-ftable td b{font-size:16px !important}
  #ps-final .ps-ftable td.muted,#ps-final .ps-ftable .muted{color:#5D6B62;font-size:14px !important}
  #ps-final .ps-dtable td{font-size:15px !important}
  #ps-final .ps-dtable tr.nochip td:first-child{padding-left:38px}
  #ps-final .cnt{display:inline-flex;align-items:center;margin-right:14px}#ps-final .cnt i.chip{margin-right:5px}
  .ps-details summary{font-size:17px;font-weight:700;cursor:pointer}.ps-details[open] summary{margin-bottom:10px}
  .ps-flink{background:none;border:0;color:#267B53;font:inherit;font-weight:700;text-decoration:underline;cursor:pointer}
  #ps-ftip{position:fixed;z-index:9800;display:none;max-width:360px;white-space:pre-line;padding:10px 12px;border-radius:10px;background:#28362F;color:#fff;
    font:500 13px/1.45 Inter,"Segoe UI",Arial,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.18);pointer-events:none}
  #ps-dwell{position:fixed;z-index:8900;height:10px;border-radius:6px;background:#267B53;display:none;pointer-events:none}
  body.ps-hidden-level #ps-level,body.ps-hidden-level #ps-meta,body.ps-hidden-level #ps-diff{visibility:hidden}`;
  document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);
  {   // 2x2: every level uses the same big, wide frames (one bus centred, or two/three buses side by side)
    const gw = 'min(1560px, 94vw)', cw = 'calc(var(--bus-card-h)*2.05)';
    document.head.insertAdjacentHTML('beforeend', `<style id="ps-grid-css">
      :root{--bus-card-h:min(31svh,calc((100svh - 300px)/2)) !important;--bus-card-w:${cw} !important;--bus-row-gap:clamp(36px,6svh,72px) !important}
      .game-screen .bus-card,.ps-fake .bus-card{width:var(--bus-card-w) !important;padding:10px 14px !important}
      .game-screen .bus-card .bus-art:not(.ps-pair):not(.ps-pair>.bus-art){height:100%;width:auto !important;max-width:100%;margin:0 auto}
      .game-screen .bus-grid,.ps-fake .bus-grid{width:${gw} !important;margin:clamp(10px,3svh,40px) auto 0 !important;
        grid-template-columns:repeat(${GRID.cols},1fr) !important;justify-items:center}
    </style>`);
  }
  document.body.insertAdjacentHTML('beforeend', `
  <div id="ps-bar" role="status" aria-live="polite">
    <span class="dot" id="ps-sdot" title="PupilSense connection"></span>
    <span id="ps-level">—</span>
    <span id="ps-diff" title="Current difficulty level" style="font-weight:800;color:#425248;background:#EDF0EB;border-radius:99px;padding:5px 10px">Lv 1</span>
    <span id="ps-meta">Calibration starts after the safety check</span>
    <span id="ps-emgchip" title="EMG muscle sensor" style="font-weight:800;font-size:12px;border-radius:99px;padding:5px 10px;background:#EDF0EB;color:#78847B">EMG off</span>
    <button class="ps-btn" id="ps-toggle" aria-expanded="false">Pupil ▾</button>
  </div>
  <div id="ps-panel" aria-label="PupilSense controls">
    <div class="row"><label>Participant <input id="ps-pid" placeholder="P01" style="width:90px;border:1px solid #D7DED7;border-radius:6px;padding:4px 6px"></label>
      <button class="ps-btn" id="ps-xlsx">Export Excel</button></div>
    <div class="res" id="ps-r-xlsx"></div>
    <div class="row"><button class="ps-btn" id="ps-recal">Calibrate again</button><button class="ps-btn" id="ps-check">Light check</button></div>
    <div class="res" id="ps-r-gaze"></div><div class="res" id="ps-r-base"></div><div class="res" id="ps-r-check"></div><div class="res" id="ps-r-cam"></div>
    <div class="ps-eyes"><img id="ps-eyeL" alt=""><img id="ps-eyeR" alt=""><span class="res" id="ps-mm"></span></div>
    <canvas id="ps-chart"></canvas>
    <div class="warn" id="ps-warn"></div>
    <div class="row"><label><input type="checkbox" id="ps-show" checked> Show level to participant</label>
      <label><input type="checkbox" id="ps-gsel" checked> Gaze selection (dwell)</label>
      <label title="Fixes camera brightness at its current setting. Lock when the image looks right; unlock if it gets too dark."><input type="checkbox" id="ps-lock"> Lock camera brightness</label>
      <label><input type="checkbox" id="ps-gdot"> Show gaze dot</label>
      <label title="For testing without eye tracking: the mouse pointer acts as the gaze"><input type="checkbox" id="ps-mgaze"> Mouse as gaze (test)</label></div>
    <div class="row"><label><input type="checkbox" id="ps-adapt" checked> Adaptive difficulty</label>
      <label>Raise after <input type="number" id="ps-upafter" value="${DIFF.upAfter}" min="1" max="10" style="width:44px"> LOW + correct</label>
      <label>Level <select id="ps-lvl">${LEVELS.slice(1).map((L, i) => `<option value="${i + 1}">${i + 1} · ${L.label}</option>`).join('')}</select></label></div>
    <div class="res" id="ps-r-diff" style="color:#78847B">Starts at level 1. Up after LOW + correct; down after a wrong answer or HIGH; MEDIUM + correct stays.</div>
    <div class="row"><label>Dwell <input type="number" id="ps-dwellms" value="${CFG.dwellMs}" min="400" max="4000" step="100" style="width:64px"> ms</label>
      <label title="Pause the level if you sit closer/farther than at baseline"><input type="checkbox" id="ps-dist" checked> Distance check ±<input type="number" id="ps-disttol" value="${Math.round(CFG.distTol * 100)}" min="3" max="50" style="width:44px">%</label>
      <label title="Live level smoothing: lower reacts faster but is noisier">Smoothing <input type="number" id="ps-smooth" value="${CFG.smoothS}" min="0.2" max="10" step="0.1" style="width:52px"> s</label>
      <label>Readings/s <input type="number" id="ps-fps" value="${CFG.fps}" min="2" max="30" style="width:48px"></label>
      <label>Exclude after stand-up <input type="number" id="ps-settle" value="${CFG.settleS}" min="0" max="15" style="width:48px"> s</label></div>
    <div class="row"><label title="MEDIUM when the pupil is this far above the seated baseline (the larger of the two)">MEDIUM ≥ <input type="number" id="ps-medsd" value="${CFG.medSD}" min="0.5" max="10" step="0.5" style="width:46px"> SD and ≥ <input type="number" id="ps-medmin" value="${CFG.medMin}" min="0" max="2" step="0.05" style="width:54px"> mm</label>
      <label title="HIGH when the pupil is this far above the seated baseline (the larger of the two)">HIGH ≥ <input type="number" id="ps-highsd" value="${CFG.highSD}" min="1" max="15" step="0.5" style="width:46px"> SD and ≥ <input type="number" id="ps-highmin" value="${CFG.highMin}" min="0" max="3" step="0.05" style="width:54px"> mm</label>
      <label title="Baseline SD is never taken as smaller than this">Min SD <input type="number" id="ps-sdmin" value="${CFG.sdMin}" min="0" max="1" step="0.01" style="width:54px"> mm</label></div>
    <div class="res" id="ps-r-thr" style="color:#78847B"></div>
    <h4 style="margin:12px 0 4px">EMG muscle sensor (confirms the selection)</h4>
    <div class="row"><button class="ps-btn" id="ps-emg-serial">Connect Arduino</button><button class="ps-btn" id="ps-emg-sim">Simulation</button>
      <button class="ps-btn" id="ps-emg-cal">Relaxed baseline (5 s)</button><button class="ps-btn" id="ps-emg-off">Disconnect</button>
      <label title="When on, a muscle activation confirms the bus you are looking at (mouse click still works)"><input type="checkbox" id="ps-emg-use" checked> Confirm with EMG</label></div>
    <div class="row" style="align-items:center"><div id="ps-emg-meter" style="position:relative;flex:1;min-width:220px;height:14px;background:#EDF0EB;border-radius:7px;overflow:hidden">
      <i id="ps-emg-fill" style="position:absolute;left:0;top:0;bottom:0;width:0;background:#7FA88F"></i><b id="ps-emg-thr" style="position:absolute;top:-2px;bottom:-2px;width:3px;background:#C2412D;display:none"></b></div>
      <span id="ps-emg-val" style="font-size:12px;color:#425248;min-width:170px">—</span></div>
    <div class="res" id="ps-r-emg" style="color:#78847B">Not connected. Upload firmware/BN5213_EMG_filtered (raw EMG on A0) to the Arduino Uno, then Connect Arduino (Chrome/Edge). (Simulation button = researcher test only; hold M to activate.)</div>
    <div class="res" style="color:#78847B">Each game screen is compared with its own seated baseline.</div>
  </div>
  <div id="ps-calib" role="dialog" aria-modal="true" aria-labelledby="ps-c-title">
    <div class="card">
      <div class="steps"><span id="ps-st1">1 Camera</span><span id="ps-st2">2 Eye tracking</span><span id="ps-st3">3 Pupil baseline</span><span id="ps-st4">4 Muscle sensor</span></div>
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
  $('ps-lock').onchange = async e => {
    const track = camTrack(); if (!track) { e.target.checked = false; return; }
    if (e.target.checked) await lockExposure(track); else await unlockExposure(track);
  };
  $('ps-dist').onchange = e => { CFG.distCheck = e.target.checked; };
  $('ps-disttol').oninput = e => { CFG.distTol = Math.min(0.5, Math.max(0.03, (+e.target.value || 15) / 100)); };
  $('ps-adapt').onchange = e => { DIFF.adaptive = e.target.checked; DIFF.streak = 0; };
  $('ps-upafter').oninput = e => { DIFF.upAfter = Math.max(1, +e.target.value || 1); };
  $('ps-lvl').onchange = e => { DIFF.level = +e.target.value; DIFF.streak = 0; applyDifficulty();
    $('ps-r-diff').textContent = `Level set to ${DIFF.level} (${LEVELS[DIFF.level].label}) by researcher — applies from the next trial.`; };
  applyDifficulty();
  function thrText() {
    const f = b => { const t = thresholdsFor(b); return `MEDIUM ≥ +${t.med.toFixed(2)} mm, HIGH ≥ +${t.high.toFixed(2)} mm`; };
    $('ps-r-thr').textContent = baseline ? `Now: Remember ${f(baseline.memory)} · Find ${f(baseline.search)} (above each screen's baseline)`
                                          : 'Thresholds in mm appear once the pupil baseline is recorded.';
  }
  [['ps-medsd', 'medSD'], ['ps-medmin', 'medMin'], ['ps-highsd', 'highSD'], ['ps-highmin', 'highMin'], ['ps-sdmin', 'sdMin']].forEach(([id, k]) =>
    $(id).oninput = e => { const v = +e.target.value; if (isFinite(v) && v >= 0) CFG[k] = v; thrText(); });
  setInterval(thrText, 2000); setTimeout(thrText, 0);
  $('ps-smooth').oninput = e => { CFG.smoothS = Math.min(10, Math.max(0.2, +e.target.value || CFG.smoothS)); };
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
                   pupil, left: r.left_mm, right: r.right_mm, blink: r.blink, face: r.face, valid, postMove, lum: r.lum, faceW: r.face_w, faceS: r.face_h ?? r.face_w,
                   gx: gaze && t - gaze.t < 0.5 ? Math.round(gaze.x) : '', gy: gaze && t - gaze.t < 0.5 ? Math.round(gaze.y) : '' });
    // live: exponential smoothing per reading, restarted on every new screen (screens differ in brightness)
    const lp = phase === 'confirm' ? 'search' : phase;
    if (lp !== live.phase || (trial && live.trialId !== trial.attemptId)) live = { ema: null, phase: lp, t: 0, n: 0, trialId: trial?.attemptId };
    if (valid && !postMove && (lp === 'memory' || lp === 'search')) {
      const a = live.ema == null ? 1 : 1 - Math.exp(-(t - live.t) / Math.max(0.1, CFG.smoothS));
      live.ema = live.ema == null ? pupil : live.ema + a * (pupil - live.ema);
      live.t = t; live.n++;
    }
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

  let exposureLocked = false;
  const session = { participant: '', start: null, end: null };
  const frameLum = (sec = 1.5) => mean(samples.filter(x => x.t > now() - sec && x.lum != null).map(x => x.lum));
  async function lockExposure(track) {
    // Lock camera brightness (exposure + white balance) at its current setting, when YOU choose.
    // Some Windows webcams report the wrong exposure value and get darker when locked - then just unlock.
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {}, set = track.getSettings(), adv = {};
      if (caps.exposureMode?.includes('manual')) { adv.exposureMode = 'manual'; if (set.exposureTime) adv.exposureTime = set.exposureTime; }
      if (caps.whiteBalanceMode?.includes('manual')) { adv.whiteBalanceMode = 'manual'; if (set.colorTemperature) adv.colorTemperature = set.colorTemperature; }
      if (!Object.keys(adv).length) { setLockUI(false, 'This camera cannot lock brightness from the browser — keep room lighting steady.'); return false; }
      const before = frameLum();
      await track.applyConstraints({ advanced: [adv] });
      exposureLocked = true;
      setLockUI(true, 'Locking…');
      await sleep(1500);
      const after = frameLum(1.0);
      const darker = isFinite(before) && isFinite(after) && after < before * 0.85;
      setLockUI(true, `Brightness locked (image ${isFinite(before) ? Math.round(before) : '–'} → ${isFinite(after) ? Math.round(after) : '–'})` +
        (darker ? ' — it got darker; unlock if the face is too dark' : ' ✓'));
      return true;
    } catch { setLockUI(false, 'Brightness could not be locked — keep room lighting steady.'); return false; }
  }
  function setLockUI(locked, msg) {
    exposureLocked = locked;
    $('ps-lock').checked = locked;
    $('ps-r-cam').textContent = msg;
    const b = document.getElementById('ps-lockbtn'), m = document.getElementById('ps-lockmsg');
    if (b) b.textContent = locked ? 'Unlock brightness' : 'Lock brightness';
    if (m) m.textContent = msg;
  }
  async function unlockExposure(track) {
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {}, adv = {};
      if (caps.exposureMode?.includes('continuous')) adv.exposureMode = 'continuous';
      if (caps.whiteBalanceMode?.includes('continuous')) adv.whiteBalanceMode = 'continuous';
      if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv] });
    } catch {}
    setLockUI(false, 'Camera brightness: automatic.');
  }
  const camTrack = () => video?.srcObject?.getVideoTracks?.()[0];

  function onGaze(data, fromMouse = false) {
    if (!data) return;
    if (mouseGaze && !fromMouse) return;     // test mode: ignore the camera gaze
    const t = now();
    gazeBuf.push({ x: data.x, y: data.y }); if (gazeBuf.length > 5) gazeBuf.shift();
    gaze = { x: mean(gazeBuf.map(p => p.x)), y: mean(gazeBuf.map(p => p.y)), t };
    if (valCollect) valCollect.push({ x: gaze.x, y: gaze.y });
    if (gazeSelect && !calibrating) updateDwell(t);
  }

  // ------------------------------------------------------------------ EMG ----
  // Muscle-activation confirmation using the EMG team's code (BN5213-final-EMG, served by pupil_server.py at /emg/).
  // Detector: 20 ms envelope, threshold = relaxed baseline mean + max(3 SD, 10 ADC), 30 ms onset, 300 ms refractory.
  // Rule: an activation confirms only if its onset is AFTER the gaze lock and the eyes are still on the locked bus.
  const EMG = { ctl: null, source: 'off', baseOk: false, active: false, adc: null, env: null, thr: null, rows: [], events: [],
                use: true, warmTimer: null, keepT: 0, viaEmg: false, lastRej: '', filter: null };
  async function emgLoad() {
    if (EMG.ctl) return EMG.ctl;
    let mod;
    try { mod = await import('/emg/lib/emg-controller.mjs'); }
    catch (e) { throw new Error('EMG code not found. Clone BN5213-final-EMG next to pupil_server.py or start the server with --emg-dir <folder>.'); }
    const ctl = EMG.ctl = new mod.EmgController();
    ctl.on('sample', d => {
      const r = d.results[0], t = now();
      EMG.adc = d.row.adc0; EMG.env = r.filtered ?? d.row.filtered0; EMG.thr = d.row.threshold0; EMG.active = !!r.active;
      if (t - EMG.keepT >= 0.05) {   // keep 20 readings/s for the Excel file
        EMG.keepT = t;
        EMG.rows.push({ t, iso: new Date().toISOString(), phase, set: attempt?.set ?? '', rep: attempt?.rep ?? '', adc: EMG.adc, env: EMG.env, thr: EMG.thr, active: EMG.active });
        if (EMG.rows.length > 120000) EMG.rows.shift();
      }
    });
    ctl.on('baseline_start', () => { EMG.baseOk = false; emgStatus('Relaxed baseline: keep the muscle relaxed for 5 s…'); });
    ctl.on('baseline_ready', () => { EMG.baseOk = true; const b = ctl.processors[0].baseline;
      emgStatus(`Ready — relaxed ${b.mean.toFixed(0)} ± ${b.sd.toFixed(1)} ADC, activation above ${ctl.processors[0].threshold.toFixed(0)} ADC. ${EMG.filter ? 'Arduino filter: ' + EMG.filter : 'No filter reported (original firmware?)'}`); });
    ctl.on('baseline_failed', e => { EMG.baseOk = false; emgStatus('Baseline failed (' + (e.reason || 'signal') + '). Relax the muscle and press Relaxed baseline again.', true); });
    ctl.on('activation', emgActivation);
    ctl.on('release', () => { clearTimeout(EMG.warmTimer); emgLog('release'); });
    ctl.on('closed', () => { EMG.source = 'off'; EMG.baseOk = false; emgStatus('Disconnected.', true); });
    ctl.on('error', e => emgStatus('EMG error: ' + (e.message || e), true));
    return ctl;
  }
  function emgReady() { return !!EMG.ctl && EMG.ctl.connected && EMG.baseOk && EMG.ctl.latest && performance.now() - EMG.ctl.latest.row.received_perf_ms < 1000; }
  function emgStatus(text, err) { const el = $('ps-r-emg'); if (el) { el.textContent = text; el.style.color = err ? '#C2412D' : '#425248'; } }
  function emgLog(type, extra = {}) {
    EMG.events.push({ t: now(), iso: new Date().toISOString(), type, phase, set: attempt?.set ?? '', rep: attempt?.rep ?? '', ...extra });
  }
  async function emgConnect(kind) {
    const ctl = await emgLoad();
    emgStatus(kind === 'sim' ? 'Starting simulation…' : 'Choose the Arduino port in the browser window…');
    if (kind === 'sim') await ctl.connectSimulation(); else await ctl.connectSerial();
    EMG.source = kind === 'sim' ? 'simulation' : 'serial';
    for (let i = 0; i < 100 && !ctl.latest; i++) await new Promise(r => setTimeout(r, 100));   // UNO resets when the port opens
    if (!ctl.latest) throw new Error('No samples from the Arduino. Check the firmware (BN5213_EMG_filtered.ino) and the USB cable.');
    EMG.source = ctl.source;
    // ask the board to describe its filters (BN5213_EMG_filtered.ino answers 'I' with a '#filter,...' line)
    EMG.filter = null;
    if (ctl.transport?.kind === 'serial') {
      ctl.transport.on('message', m => { if (m.type === 'comment' && m.text.startsWith('#filter')) EMG.filter = m.text.slice(8).replace(/,/g, ', '); });
      await ctl.transport.send('I').catch(() => {});
      for (let i = 0; i < 10 && !EMG.filter; i++) await new Promise(r => setTimeout(r, 100));
    } else EMG.filter = 'simulation (no filter)';
    return emgBaseline();
  }
  function emgBaseline() {
    const ctl = EMG.ctl; if (!ctl?.latest) return Promise.reject(new Error('Connect the EMG first.'));
    return new Promise((resolve, reject) => {
      let u1 = null, u2 = null;
      const off = () => { u1?.(); u2?.(); };
      u1 = ctl.on('baseline_ready', () => { off(); resolve(true); });
      u2 = ctl.on('baseline_failed', e => { off(); reject(new Error('EMG baseline failed (' + (e?.reason || 'signal') + '). Relax the muscle and try again.')); });
      ctl.calibrate(5000);
    });
  }
  function emgActivation(ev) {
    const onset = (Number.isFinite(ev.perfMs) ? ev.perfMs : performance.now()) / 1000;
    emgLog('activation', { onset_s: onset });
    if (!EMG.use || !emgReady() || ev.channel !== 0) return;
    if (screen === 'warmup' && warmupLocked) {   // practice: hold for 0.5 s
      clearTimeout(EMG.warmTimer);
      EMG.warmTimer = setTimeout(() => { if (EMG.ctl?.latest?.results[0].active) { emgLog('confirm_warmup'); CYB.inputs.warmupFootPressConfirmed(); } }, 500);
      return;
    }
    if (phase !== 'confirm' || !trial || trial.lockAt == null) { emgLog('ignored', { reason: 'no bus selected' }); return; }
    if (onset < trial.lockAt - 0.05) { emgLog('rejected', { reason: 'activation started before the bus was selected' }); return; }
    const locked = document.querySelector('#busGrid .bus-card.gaze-locked');
    if (gazeSelect && gaze && now() - gaze.t < 0.6 && locked && !hit(gaze.x, gaze.y, [locked])) {
      EMG.lastRej = 'looking at another bus'; emgLog('rejected', { reason: 'eyes not on the selected bus' }); return;
    }
    trial.emgOnsetAfterLock = onset - trial.lockAt;
    EMG.viaEmg = true; emgLog('confirm', { onset_after_lock_s: trial.emgOnsetAfterLock });
    CYB.inputs.emgConfirmed();
  }
  setInterval(() => {   // live meter + chip
    const chip = $('ps-emgchip'); if (!chip) return;
    const on = emgReady();
    chip.textContent = !EMG.ctl?.connected ? 'EMG off' : !EMG.baseOk ? 'EMG baseline…' : EMG.active ? 'EMG ACTIVE' : 'EMG ready';
    chip.style.background = !on ? '#EDF0EB' : EMG.active ? '#E99A2E' : '#D8EDDF';
    chip.style.color = !on ? '#78847B' : EMG.active ? '#fff' : '#1D6041';
    if (!EMG.ctl?.latest) return;
    const fill = $('ps-emg-fill'), mark = $('ps-emg-thr'), max = 1023;
    if (fill) { fill.style.width = `${Math.min(100, (EMG.env ?? 0) / max * 100)}%`; fill.style.background = EMG.active ? '#E99A2E' : '#7FA88F'; }
    if (mark && EMG.thr != null) { mark.style.display = 'block'; mark.style.left = `${EMG.thr / max * 100}%`; }
    const v = $('ps-emg-val'); if (v) v.textContent = `${EMG.source} · ${Math.round(EMG.env ?? 0)} / ${EMG.thr != null ? Math.round(EMG.thr) : '–'} ADC · ${EMG.active ? 'ACTIVE' : 'relaxed'} · missed ${EMG.ctl.latest.row.missed_slots ?? 0}`;
    v && (v.title = EMG.filter ? 'Arduino filter: ' + EMG.filter : 'No filter reported by the Arduino');
    const note = document.getElementById('warmupNote');
    if (note && on && EMG.use && screen === 'warmup' && warmupLocked && !/complete/i.test(note.textContent))
      note.textContent = 'Now tighten the muscle with the sensor and hold it for half a second.';
  }, 100);
  const emgTry = fn => async () => { try { await fn(); } catch (e) { emgStatus(e.message || String(e), true); } };
  $('ps-emg-serial').onclick = emgTry(() => emgConnect('serial'));
  $('ps-emg-sim').onclick = emgTry(() => emgConnect('sim'));
  $('ps-emg-cal').onclick = emgTry(() => emgBaseline());
  $('ps-emg-off').onclick = emgTry(async () => { await EMG.ctl?.disconnect(); EMG.baseOk = false; });
  $('ps-emg-use').onchange = e => { EMG.use = e.target.checked; };
  window.addEventListener('keydown', e => { if (e.code === 'KeyM' && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) EMG.ctl?.setHold(true); });
  window.addEventListener('keyup', e => { if (e.code === 'KeyM') EMG.ctl?.setHold(false); });

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
        CYB.inputs.gazeTarget(el.dataset.key || el.dataset.route);
      }
    }
  }

  // ---------------------------------------------------- game phase events ----
  CYB.subscribe(ev => {
    const t = now(), d = ev.detail || {};
    switch (ev.type) {
      case 'screen_changed': screen = d.screen; if (d.screen !== 'game') phase = d.screen; resetDwell(); break;
      case 'session_started': warmupLocked = false; DIFF.streak = 0; openCalibration(); break;
      case 'warmup_gaze_locked': warmupLocked = true; resetDwell(); break;
      case 'trial_memory_shown':
        phase = 'memory'; attempt = { attemptId: d.attemptId, set: d.set, rep: d.rep };
        showMemoryGrid(d.targetPos, d.targetRoute, d.targetDest, d.two);
        document.body.classList.toggle('ps-pairs', !!d.two);
        document.body.classList.toggle('ps-three', !!(d.two && d.two.routes.length >= 3));
        trial = { attemptId: d.attemptId, set: d.set, rep: d.rep, target: d.targetRoute, targetPos: d.targetPos ?? '', targetDest: d.targetDest ?? '', destMode: d.targetDest != null, two: d.two || null, memStart: t,
                  sinceStandUp: settleUntil ? +(t - (settleUntil - CFG.settleS)).toFixed(2) : '' };
        break;
      case 'trial_search_started':
        phase = 'search'; hideMemoryGrid(); if (trial) trial.searchStart = t;
        if (trial?.two) { const title = document.getElementById('gameTitle'); if (title) title.textContent = trial.two.routes.length >= 3 ? 'Find all 3 buses!' : 'Find the pair!'; }
        break;
      case 'gaze_target_locked':
        phase = 'confirm'; resetDwell();
        if (trial) { trial.lockAt = t; trial.searchTimeMs = d.searchTimeMs; trial.selected = d.route; trial.selectedPos = d.pos ?? ''; trial.selectedDest = d.dest ?? ''; trial.lockSource = d.source; }
        break;
      case 'gaze_target_cleared':
        resetDwell();
        phase = 'search'; if (trial) { trial.reselections = (trial.reselections || 0) + 1; trial.lockAt = null; }
        break;
      case 'emg_confirmed':
        phase = 'movement';
        if (trial) { trial.confirmBy = EMG.viaEmg ? 'EMG' : 'mouse'; EMG.viaEmg = false; }
        if (trial) { trial.correct = d.isCorrect; trial.emgAt = t; finaliseTrial(trial); adapt(trial); trials.push(trial); trial = null; }
        break;
      case 'rep_completed': phase = 'settle'; settleUntil = t + CFG.settleS; break;
      case 'rest_started': phase = 'rest'; attempt = null; break;
      case 'session_completed': phase = 'done'; attempt = null; session.end = new Date(); exportExcel(true); setTimeout(showFinal, 50); break;
      case 'new_session_ready': phase = 'setup'; attempt = null; trials = []; samples = []; hideFinal(); break;
    }
  });

  // ----------------------------------------- destination-mode memory screen ----
  function showMemoryGrid(pos, route, dest, two) {
    hideMemoryGrid();
    if (!dest && !two) return;
    const panel = document.getElementById('memoryPanel'), num = document.getElementById('memoryNumber');
    if (!panel || !num) return;
    if (two) {   // two buses: both numbers with their destinations, side by side
      num.style.display = 'none';
      num.insertAdjacentHTML('afterend', `<div id="ps-memtwo" class="${two.routes.length >= 3 ? 'three' : ''}">${two.routes.map((r, i) =>
        `<div class="b"><div class="n">${r}</div><div class="d">${two.dests[i]}</div></div>`).join('')}</div>`);
      const title = document.getElementById('gameTitle'); if (title) title.textContent = two.routes.length >= 3 ? 'Remember all 3 buses!' : 'Remember both buses!';
    } else {
      num.insertAdjacentHTML('afterend', `<p id="ps-memdest">${dest}</p>`);
    }
    const obs = new MutationObserver(() => {
      const f = num.classList.contains('fade-out');
      document.getElementById('ps-memdest')?.classList.toggle('fade-out', f);
      document.getElementById('ps-memtwo')?.classList.toggle('fade-out', f);
    });
    obs.observe(num, { attributes: true, attributeFilter: ['class'] });
    panel._psObs = obs;
  }
  function hideMemoryGrid() {
    const panel = document.getElementById('memoryPanel');
    document.getElementById('ps-memdest')?.remove();
    document.getElementById('ps-memtwo')?.remove();
    const num = document.getElementById('memoryNumber'); if (num) num.style.display = '';
    panel?._psObs?.disconnect();
  }

  // ------------------------------------------------- difficulty controller ----
  // After each confirmed answer (uses the workload level of the Find phase of THAT trial):
  //   wrong answer            -> down one level
  //   correct + HIGH workload -> down one level
  //   correct + LOW workload  -> count it; after DIFF.upAfter in a row -> up one level
  //   correct + MEDIUM        -> stay (streak resets)
  //   correct + no reading    -> stay (streak kept) — pupil was paused/unreliable
  function adapt(tr) {
    tr.level_played = DIFF.level;
    if (!DIFF.adaptive) { tr.level_change = 0; tr.level_reason = 'adaptive off'; return; }
    const before = DIFF.level, lvl = tr.search_level;
    let reason;
    if (!tr.correct) { DIFF.level = Math.max(1, DIFF.level - 1); DIFF.streak = 0; reason = 'wrong answer'; }
    else if (lvl === 'high') { DIFF.level = Math.max(1, DIFF.level - 1); DIFF.streak = 0; reason = 'correct but HIGH workload'; }
    else if (lvl === 'low') {
      DIFF.streak++;
      if (DIFF.streak >= DIFF.upAfter) { DIFF.level = Math.min(LEVELS.length - 1, DIFF.level + 1); DIFF.streak = 0; reason = `${DIFF.upAfter}× LOW + correct`; }
      else reason = `LOW + correct (${DIFF.streak}/${DIFF.upAfter})`;
    }
    else if (lvl === 'medium') { DIFF.streak = 0; reason = 'correct, MEDIUM workload — stay'; }
    else reason = 'correct, no reliable pupil reading — stay';
    tr.level_change = DIFF.level - before; tr.level_reason = reason; tr.level_next = DIFF.level;
    applyDifficulty();
    $('ps-r-diff').textContent = `Trial ${tr.set}-${tr.rep}: ${reason} → level ${before}${DIFF.level !== before ? ' → ' + DIFF.level : ''} (${LEVELS[DIFF.level].label})`;
  }

  // ---------------------------------------------------- calibration scene ----
  const C = { title: $('ps-c-title'), text: $('ps-c-text'), result: $('ps-c-result'), actions: $('ps-c-actions'), status: $('ps-c-status'), kicker: $('ps-c-kicker') };
  let skipRequested = false;
  $('ps-c-skip').onclick = () => { skipRequested = true; };
  function stepMarks(active) {
    [1, 2, 3, 4].forEach(i => { const el = $('ps-st' + i); el.className = i < active ? 'done' : i === active ? 'on' : ''; });
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
      C.result.innerHTML = `<label style="font-size:16px;color:#425248">Participant ID
        <input id="ps-pid2" value="${$('ps-pid').value}" placeholder="P01" style="margin-left:8px;font-size:16px;width:120px;padding:6px 8px;border:1px solid #D7DED7;border-radius:8px"></label>`;
      $('ps-pid2').oninput = e => { $('ps-pid').value = e.target.value; };
      await choose([{ label: 'Start camera', value: 1, primary: true }]);
      session.participant = $('ps-pid').value.trim(); session.start = new Date();
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
      C.result.insertAdjacentHTML('beforeend', `<div><span id="ps-light">Checking light…</span></div>
        <div style="margin-top:10px;display:flex;gap:10px;justify-content:center;align-items:center;flex-wrap:wrap">
          <button class="ps-btn" id="ps-lockbtn">${exposureLocked ? 'Unlock brightness' : 'Lock brightness'}</button>
          <span id="ps-lockmsg" style="font-size:13px;color:#78847B">Optional: lock when your face looks clear, so brightness can't change during the game.</span></div>`);
      $('ps-lockbtn').onclick = async () => {
        const track = camTrack(); if (!track) return;
        $('ps-lockbtn').disabled = true;
        if (exposureLocked) await unlockExposure(track); else await lockExposure(track);
        $('ps-lockbtn').disabled = false;
      };
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

      // 2. gaze calibration + validation
      let again = true;
      while (again) {
        stepMarks(2);
        view({ title: 'Click the red dot.', text: 'A red dot will appear in different places, one at a time. Look at it and click it 5 times — keep looking at it while you click. It turns green, then the next dot appears.' });
        if (await choose([{ label: 'Start', value: 'go', primary: true }, { label: 'Skip eye tracking', value: 'skip' }]) === 'skip') { gazeCal = { skipped: true }; break; }
        skipRequested = false;
        hideCard();
        await webgazer.clearData();
        const ok = await runClickCalibration();
        if (!ok) { gazeCal = { skipped: true }; break; }
        view({ title: 'Now just look.', text: 'Orange dots will appear one at a time. Look at each one — do not click. This checks how well the eye tracking works.' });
        await choose([{ label: 'Start check', value: 1, primary: true }]); hideCard();
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
        } catch { /* cancelled */ }
      }

      // 4. EMG muscle sensor (confirms the selected bus)
      stepMarks(4);
      let emgAgain = !emgReady();
      while (emgAgain) {
        view({ title: 'Muscle sensor.', text: 'After you pick a bus with your eyes, you confirm it with the muscle sensor. First we measure the muscle while it is relaxed (5 seconds).',
               result: 'Plug in the Arduino USB cable, then press Connect Arduino and choose its port.' });
        const pick = EMG.ctl?.connected && EMG.source === 'serial' ? 'serial'     // already connected: just redo the baseline
          : await choose([{ label: 'Connect Arduino', value: 'serial', primary: true }, { label: 'Skip — confirm by clicking', value: 'skip' }]);
        if (pick === 'skip') { EMG.use = false; $('ps-emg-use').checked = false; break; }
        view({ title: 'Relax the muscle.', text: 'Keep still and relaxed for 5 seconds — the baseline is being recorded…' });
        try {
          if (EMG.ctl?.connected && EMG.source === 'serial') await emgBaseline(); else await emgConnect(pick);
          const b = EMG.ctl.processors[0];
          view({ kicker: 'CHECK THE THRESHOLD', title: 'Baseline recorded.', text: 'Activate the muscle: the bar should pass the red line and turn orange. Relax: it drops below the line and turns green.',
                 result: `<div style="width:min(460px,80vw);height:22px;margin:6px auto;background:#EDF0EB;border-radius:11px;position:relative;overflow:hidden"><i id="ps-emg-try" style="position:absolute;left:0;top:0;bottom:0;width:0;background:#7FA88F"></i><b style="position:absolute;top:0;bottom:0;width:3px;left:${b.threshold / 1023 * 100}%;background:#C2412D"></b></div>
                          <span style="font-size:13px;color:#78847B">Relaxed ${b.baseline.mean.toFixed(0)} ± ${b.baseline.sd.toFixed(1)} ADC · activation above ${b.threshold.toFixed(0)} ADC (red line)</span><br>
                          <span style="font-size:13px;color:${EMG.filter ? '#78847B' : '#C2412D'}">${EMG.filter ? 'Filter on the Arduino: ' + EMG.filter : 'No filter reported — upload BN5213_EMG_filtered.ino for 50 Hz rejection and band-pass'}</span>` });
          const tryT = setInterval(() => { const f = document.getElementById('ps-emg-try'); if (f) { f.style.width = `${Math.min(100, (EMG.env ?? 0) / 10.23)}%`; f.style.background = EMG.active ? '#E99A2E' : '#7FA88F'; } }, 60);
          emgAgain = await choose([{ label: 'Threshold OK — continue', value: false, primary: true }, { label: 'Record baseline again', value: true }]);
          clearInterval(tryT);
          EMG.use = true; $('ps-emg-use').checked = true;
        } catch (e) {
          view({ title: 'The muscle sensor did not start.', text: e.message || String(e) });
          emgAgain = await choose([{ label: 'Try again', value: true, primary: true }, { label: 'Skip — confirm by clicking', value: false }]);
          if (!emgAgain) { EMG.use = false; $('ps-emg-use').checked = false; }
        }
      }

      view({ kicker: 'ALL SET', title: 'Calibration complete.', text: 'Next, a quick practice with one bus.',
             result: [$('ps-r-gaze').textContent, baseline ? baselineText(baseline) : 'No pupil baseline (workload levels off).',
                      emgReady() && EMG.use ? 'Muscle sensor ready — look at a bus, then tighten the muscle to confirm.' : 'Confirm with a mouse click.'].join('<br>') });
      if (baseline && (baseline.memory.validFrac < 0.6 || baseline.search.validFrac < 0.6))
        C.status.textContent = 'Note: the camera could not see the eyes clearly for part of the baseline. You can redo it from the Pupil menu.';
      await choose([{ label: 'Start practice', value: 1, primary: true }]);
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
                 lum: mean(w.map(x => x.lum).filter(x => x != null)), faceW: mean(w.map(x => x.faceW).filter(x => x != null)),
                 faceS: median(w.map(x => x.faceS).filter(x => x != null)) };
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
    if (!b || p == null || !isFinite(p)) return NaN;
    const { med, high } = thresholdsFor(b), d = p - b.pupil;
    // piecewise so that index 0.33 = MEDIUM threshold, 0.66 = HIGH threshold (gauge and levels agree)
    if (d < med) return CFG.t1 * d / med;
    if (d < high) return CFG.t1 + (CFG.t2 - CFG.t1) * (d - med) / (high - med);
    return CFG.t2 + (CFG.t2 - CFG.t1) * (d - high) / (high - med);
  }
  function thresholdsFor(b) {   // mm above this screen's baseline
    const sdv = Math.max(b?.sd || 0, CFG.sdMin);
    const med = Math.max(CFG.medSD * sdv, CFG.medMin);
    return { sd: sdv, med, high: Math.max(CFG.highSD * sdv, CFG.highMin, med + 0.01) };
  }
  const levelOf = idx => !isFinite(idx) ? null : idx < CFG.t1 ? 'low' : idx < CFG.t2 ? 'medium' : 'high';
  // ------------------------------------------------------- final page ----
  // Replaces the game's end dashboard. Built to answer Q2 directly:
  //   per round: Find-screen pupil = median of valid readings from 0.5 s after the cards appeared until the bus
  //   was locked, minus this participant's Find baseline (Δ mm); Δ averaged per level; plus the level decisions
  //   the pupil rule made live. Everything is within this participant only.
  const WL = {
    low:    { c: '#3E8E63', k: 'L', name: 'LOW' },
    medium: { c: '#D9952B', k: 'M', name: 'MEDIUM' },
    high:   { c: '#C2412D', k: 'H', name: 'HIGH' },
    none:   { c: '#A9B2AB', k: '–', name: 'No reading' },
  };
  const sgn = (v, d = 2) => (v == null || !isFinite(v)) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const decisionOf = t => t.level_reason === 'adaptive off' ? 'off' : !t.correct ? 'wrong' : (t.search_level || 'none');
  const DECISIONS = [
    { key: 'low',    rule: 'Correct + LOW',                rule2: `level up after ${DIFF.upAfter} in a row`, pupil: true },
    { key: 'medium', rule: 'Correct + MEDIUM',             rule2: 'stay', pupil: true },
    { key: 'high',   rule: 'Correct + HIGH',               rule2: 'level down', pupil: true },
    { key: 'none',   rule: 'Correct, no reliable reading', rule2: 'stay (pupil paused)', pupil: false },
    { key: 'wrong',  rule: 'Wrong answer',                 rule2: 'level down (accuracy, not pupil)', pupil: false },
    { key: 'off',    rule: 'Adaptive difficulty off',      rule2: 'no change', pupil: false },
  ];

  function hideFinal() {
    document.getElementById('ps-final')?.remove();
    document.getElementById('ps-ftip')?.remove();
    const m = document.querySelector('#dashboardScreen .dashboard-main'); if (m) m.style.display = '';
  }
  function showFinal() {
    renderFinal({ trials, samples, baseline, participant: ($('ps-pid')?.value || session.participant || '').trim() });
  }
  function q2Rows(T) {
    return T.map((t, i) => {
      const pupil = isFinite(t.search_pupil) ? t.search_pupil : null;
      const base = isFinite(t.base_search) ? t.base_search : null;
      return { i, t, set: t.set, rep: t.rep, level: t.level_played, correct: !!t.correct, pupil, base,
               delta: pupil != null && base != null ? pupil - base : null, valid: t.search_valid,
               wl: t.search_level || null, dec: decisionOf(t), change: t.level_change ?? 0, next: t.level_next,
               reason: t.level_reason || '', med: t.thr_med, high: t.thr_high, searchS: t.searchTimeMs != null ? t.searchTimeMs / 1000 : null };
    });
  }
  function roundTip(r) {
    const w = WL[r.wl || 'none'];
    return [`Set ${r.set} · round ${r.rep} · Level ${r.level} (${LEVELS[r.level]?.label || ''})`,
            `Find pupil ${fmt(r.pupil)} mm · baseline ${fmt(r.base)} mm`,
            `Change ${sgn(r.delta)} mm → ${w.name}` + (isFinite(r.med) ? ` (MEDIUM ≥ +${r.med.toFixed(2)}, HIGH ≥ +${r.high.toFixed(2)})` : ''),
            `${r.correct ? 'Correct' : 'Wrong'} · usable readings ${r.valid != null && isFinite(r.valid) ? Math.round(r.valid * 100) + '%' : '–'}`,
            `Decision: ${r.reason || '–'}${r.next != null ? ` → next level ${r.next}` : ''}`].join('\n');
  }

  // Q2 figure 1: pupil change by level — every round as a dot, mean per level as a bar
  function svgByLevel(rows, thr) {
    const lv = [...new Set(rows.map(r => r.level))].filter(v => v != null).sort((a, b) => a - b);
    const W = 1100, H = 360, L = 74, R = 150, TOP = 22, B = 62, pw = W - L - R, ph = H - TOP - B;
    const bw = pw / Math.max(1, lv.length);
    const vals = rows.map(r => r.delta).filter(v => v != null).concat([0], thr ? [thr.med, thr.high] : []);
    let lo = Math.min(...vals), hi = Math.max(...vals); const pad = Math.max(0.04, (hi - lo) * 0.12); lo -= pad; hi += pad;
    const Y = v => TOP + ph * (1 - (v - lo) / (hi - lo));
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Find-screen pupil change by difficulty level" class="ps-svg">`;
    for (let k = 0; k <= 4; k++) {
      const v = lo + (hi - lo) * k / 4, y = Y(v);
      s += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="#0000000F"/><text x="${L - 8}" y="${y + 4}" text-anchor="end" class="ax">${sgn(v)}</text>`;
    }
    s += `<text transform="translate(14 ${TOP + ph / 2}) rotate(-90)" text-anchor="middle" class="ax">Pupil change vs Find baseline (mm)</text>`;
    const ref = (v, col, dash, label) => {
      if (v == null || !isFinite(v)) return '';
      return `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${col}" stroke-width="1.5" ${dash ? 'stroke-dasharray="6 5"' : ''}/>` +
             `<text x="${W - R + 8}" y="${Y(v) + 4}" class="ax ink">${label}</text>`;
    };
    s += ref(0, '#28362F', false, 'Baseline (0)');
    if (thr) { s += ref(thr.med, WL.medium.c, true, `MEDIUM ≥ +${thr.med.toFixed(2)}`) + ref(thr.high, WL.high.c, true, `HIGH ≥ +${thr.high.toFixed(2)}`); }
    const means = [];
    lv.forEach((level, j) => {
      const cx = L + bw * (j + 0.5), g = rows.filter(r => r.level === level), d = g.filter(r => r.delta != null);
      const step = Math.min(22, (bw * 0.5) / Math.max(1, d.length));
      d.forEach((r, k) => {
        const x = cx + (k - (d.length - 1) / 2) * step, y = Y(r.delta);
        s += `<circle cx="${x}" cy="${y}" r="7" fill="#28362F" fill-opacity=".5" stroke="#fff" stroke-width="2"/>` +
             `<circle cx="${x}" cy="${y}" r="13" fill="transparent" data-tip="${esc(roundTip(r))}"/>`;
      });
      const m = d.length ? mean(d.map(r => r.delta)) : null;
      if (m != null) {
        means.push([cx, Y(m)]);
        const hw = Math.min(70, bw * 0.32);
        s += `<line x1="${cx - hw}" x2="${cx + hw}" y1="${Y(m)}" y2="${Y(m)}" stroke="#267B53" stroke-width="4" stroke-linecap="round"/>` +
             `<text x="${cx + hw + 6}" y="${Y(m) + 5}" class="val">${sgn(m)}</text>`;
      }
      s += `<text x="${cx}" y="${H - B + 22}" text-anchor="middle" class="lvl">Level ${level}</text>` +
           `<text x="${cx}" y="${H - B + 40}" text-anchor="middle" class="ax">${d.length} of ${g.length} round${g.length === 1 ? '' : 's'} usable</text>`;
    });
    if (means.length > 1) s += `<path d="${means.map((p, k) => (k ? 'L' : 'M') + p[0] + ',' + p[1]).join('')}" fill="none" stroke="#267B53" stroke-width="1.5" stroke-opacity=".55"/>`;
    return s + '</svg>';
  }

  // Q2 figure 2: round by round — level played (top track) and the Find-screen change that drove the decision (bottom track)
  function svgRounds(rows, thr) {
    const n = rows.length, W = 1100, L = 74, R = 120, pw = W - L - R, cw = pw / Math.max(1, n);
    const T1 = 34, H1 = 150, T2 = T1 + H1 + 44, H2 = 170, BOT = T2 + H2, H = BOT + 58;
    const maxLv = LEVELS.length - 1, Y1 = l => T1 + H1 * (1 - (l - 0.5) / maxLv);
    const vals = rows.map(r => r.delta).filter(v => v != null).concat([0], thr ? [thr.med, thr.high] : []);
    let lo = Math.min(...vals), hi = Math.max(...vals); const pad = Math.max(0.04, (hi - lo) * 0.12); lo -= pad; hi += pad;
    const Y2 = v => T2 + H2 * (1 - (v - lo) / (hi - lo));
    const X = i => L + cw * (i + 0.5);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Level played and Find-screen pupil change in every round" class="ps-svg">`;
    // column hover targets (drawn first, under the marks)
    rows.forEach((r, i) => { s += `<rect class="col" x="${L + cw * i + 1}" y="${T1 - 22}" width="${cw - 2}" height="${BOT - T1 + 72}" rx="6" data-tip="${esc(roundTip(r))}"/>`; });
    // track 1: level played
    for (let l = 1; l <= maxLv; l++) s += `<line x1="${L}" x2="${W - R}" y1="${Y1(l)}" y2="${Y1(l)}" stroke="#0000000F"/><text x="${L - 10}" y="${Y1(l) + 4}" text-anchor="end" class="ax">Lv ${l}</text>`;
    s += `<text x="${L}" y="${T1 - 14}" class="trk">Level played · marker = pupil rule reading (L / M / H)</text>`;
    let path = '';
    rows.forEach((r, i) => {
      const x0 = L + cw * i, x1 = x0 + cw, y = Y1(r.level);
      path += (i ? `L${x0},${y}` : `M${x0},${y}`) + `L${x1},${y}`;
    });
    if (n) s += `<path d="${path}" fill="none" stroke="#28362F" stroke-opacity=".35" stroke-width="2"/>`;
    rows.forEach((r, i) => {
      const w = WL[r.wl || 'none'], x = X(i), y = Y1(r.level);
      s += `<circle cx="${x}" cy="${y}" r="12" fill="${w.c}" stroke="#fff" stroke-width="2"/><text x="${x}" y="${y + 4.5}" text-anchor="middle" class="mk">${w.k}</text>`;
      const arrow = r.change > 0 ? '↑' : r.change < 0 ? '↓' : '';
      if (arrow) s += `<text x="${x + 17}" y="${y + 5}" class="arr">${arrow}</text>`;
    });
    // track 2: Find-screen change per round
    s += `<text x="${L}" y="${T2 - 14}" class="trk">Find-screen pupil change vs baseline (mm)</text>`;
    for (let k = 0; k <= 3; k++) { const v = lo + (hi - lo) * k / 3; s += `<line x1="${L}" x2="${W - R}" y1="${Y2(v)}" y2="${Y2(v)}" stroke="#0000000F"/><text x="${L - 10}" y="${Y2(v) + 4}" text-anchor="end" class="ax">${sgn(v)}</text>`; }
    const ref = (v, col, dash, label) => (v == null || !isFinite(v)) ? '' :
      `<line x1="${L}" x2="${W - R}" y1="${Y2(v)}" y2="${Y2(v)}" stroke="${col}" stroke-width="1.5" ${dash ? 'stroke-dasharray="6 5"' : ''}/><text x="${W - R + 8}" y="${Y2(v) + 4}" class="ax ink">${label}</text>`;
    s += ref(0, '#28362F', false, 'Baseline');
    if (thr) s += ref(thr.med, WL.medium.c, true, `MEDIUM +${thr.med.toFixed(2)}`) + ref(thr.high, WL.high.c, true, `HIGH +${thr.high.toFixed(2)}`);
    const bwid = Math.min(30, cw * 0.46);
    rows.forEach((r, i) => {
      const x = X(i);
      if (r.delta == null) { s += `<text x="${x}" y="${Y2(0) - 8}" text-anchor="middle" class="ax">no reading</text>`; return; }
      const y0 = Y2(0), y1 = Y2(r.delta), top = Math.min(y0, y1), h = Math.max(2, Math.abs(y1 - y0));
      s += `<rect x="${x - bwid / 2}" y="${top}" width="${bwid}" height="${h}" rx="3" fill="${WL[r.wl || 'none'].c}"/>`;
    });
    // set separators + round labels + correctness
    rows.forEach((r, i) => {
      const x = X(i);
      if (i && r.set !== rows[i - 1].set) s += `<line x1="${L + cw * i}" x2="${L + cw * i}" y1="${T1 - 8}" y2="${BOT + 50}" stroke="#28362F" stroke-opacity=".35" stroke-dasharray="3 4"/><text x="${L + cw * i + 6}" y="${T1 - 0}" class="ax">Set ${r.set}</text>`;
      s += `<text x="${x}" y="${BOT + 22}" text-anchor="middle" class="ax">${r.set}·${r.rep}</text>` +
           `<text x="${x}" y="${BOT + 46}" text-anchor="middle" class="ok ${r.correct ? 'yes' : 'no'}">${r.correct ? '✓' : '✗'}</text>`;
    });
    if (n && rows[0]) s += `<text x="${L + 6}" y="${T1 - 0}" class="ax">Set ${rows[0].set}</text>`;
    return s + '</svg>';
  }

  function renderFinal(D) {
    const scr = document.getElementById('dashboardScreen'), main = scr?.querySelector('.dashboard-main');
    if (!scr || !main) return;
    hideFinal(); main.style.display = 'none';
    const T = (D.trials || []).slice(), SM = D.samples || [], BL = D.baseline || null;
    const n = T.length, nOK = T.filter(t => t.correct).length;
    const rows = q2Rows(T);
    const usable = rows.filter(r => r.delta != null);
    // thresholds: values recorded with each round (fall back to the current settings)
    const lastThr = [...rows].reverse().find(r => isFinite(r.med) && isFinite(r.high));
    const thr = lastThr ? { med: lastThr.med, high: lastThr.high } : (BL ? thresholdsFor(BL.search) : null);
    const thrChanged = new Set(rows.filter(r => isFinite(r.med)).map(r => r.med.toFixed(3) + '/' + r.high.toFixed(3))).size > 1;
    // per level
    const lvls = [...new Set(T.map(t => t.level_played))].filter(v => v != null).sort((a, b) => a - b);
    const byLevel = lvls.map(lv => {
      const g = rows.filter(r => r.level === lv), d = g.map(r => r.delta).filter(v => v != null);
      return { lv, name: LEVELS[lv]?.label || '', n: g.length, ok: g.filter(r => r.correct).length, k: d.length,
               mean: d.length ? mean(d) : null, sd: d.length > 1 ? Math.sqrt(d.reduce((a, v) => a + (v - mean(d)) ** 2, 0) / (d.length - 1)) : null,
               low: g.filter(r => r.wl === 'low').length, med: g.filter(r => r.wl === 'medium').length, high: g.filter(r => r.wl === 'high').length };
    });
    const withMean = byLevel.filter(r => r.mean != null);
    // decisions
    const dec = DECISIONS.map(d => {
      const g = rows.filter(r => r.dec === d.key);
      return { ...d, n: g.length, up: g.filter(r => r.change > 0).length, down: g.filter(r => r.change < 0).length, stay: g.filter(r => !r.change).length };
    }).filter(d => d.n || ['low', 'medium', 'high', 'wrong'].includes(d.key));
    const pupilDriven = dec.filter(d => d.pupil).reduce((a, d) => a + d.n, 0);
    const ups = rows.filter(r => r.change > 0).length, downs = rows.filter(r => r.change < 0).length;
    const sets = [...new Set(T.map(t => t.set))].map(sv => { const g = T.filter(t => t.set === sv); return `Set ${sv}: ${g.filter(t => t.correct).length} / ${g.length}`; }).join(' · ');
    const best = n ? Math.max(...T.map(t => t.level_played)) : '–';
    const pid = D.participant || '';

    // per-round pupil traces (Remember + Find), kept as a secondary view
    const traceSvg = (() => {
      if (!n) return '';
      const hasBase = !!BL, baseFor = ph => !BL ? null : ph === 'memory' ? BL.memory.pupil : BL.search.pupil;
      const games = T.map(t => {
        const t0 = t.memStart, t1 = t.emgAt ?? t.lockAt ?? t0 + 1, bins = new Map();
        for (const x of SM) {
          if (x.t < t0 || x.t > t1 || !x.valid || x.postMove || !['memory', 'search', 'confirm'].includes(x.phase)) continue;
          const v = hasBase ? x.pupil - baseFor(x.phase) : x.pupil, k = Math.floor(x.t - t0);
          (bins.get(k) || bins.set(k, []).get(k)).push(v);
        }
        const pts = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [(k + 0.5) / Math.max(1, t1 - t0), median(v)]);
        return { t, pts, split: t.searchStart ? (t.searchStart - t0) / Math.max(1, t1 - t0) : null };
      });
      const W = 1100, H = 300, L = 64, R = 16, TOP = 30, B = 40, cw = (W - L - R) / n;
      const vals = games.flatMap(g => g.pts.map(p => p[1])).filter(isFinite).concat(hasBase ? [0] : []);
      let lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 1;
      const pad = Math.max(0.05, (hi - lo) * 0.12); lo -= pad; hi += pad;
      const Y = v => TOP + (H - TOP - B) * (1 - (v - lo) / (hi - lo));
      let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pupil trace in every round" class="ps-svg">`;
      for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4; s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#0000000F"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end" class="ax">${hasBase ? sgn(v) : v.toFixed(2)}</text>`; }
      if (hasBase) s += `<line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" stroke="#28362F" stroke-width="1.5"/>`;
      games.forEach((g, i) => {
        const x0 = L + i * cw;
        if (i) s += `<line x1="${x0}" x2="${x0}" y1="${TOP}" y2="${H - B}" stroke="#0000001A"/>`;
        if (g.split != null) s += `<line x1="${x0 + g.split * cw}" x2="${x0 + g.split * cw}" y1="${TOP}" y2="${H - B}" stroke="#00000030" stroke-dasharray="2 4"/>`;
        const d = g.pts.map((p, k) => `${k ? 'L' : 'M'}${(x0 + 4 + p[0] * (cw - 8)).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
        s += d ? `<path d="${d}" fill="none" stroke="#267B53" stroke-width="2" stroke-linejoin="round"/>` : `<text x="${x0 + cw / 2}" y="${H - B - 10}" text-anchor="middle" class="ax">no reading</text>`;
        s += `<text x="${x0 + cw / 2}" y="${TOP - 10}" text-anchor="middle" class="ax">Lv ${g.t.level_played}</text><text x="${x0 + cw / 2}" y="${H - B + 20}" text-anchor="middle" class="ax">${g.t.set}·${g.t.rep}</text>`;
      });
      return s + '</svg>';
    })();

    const tile = (label, value, note) => `<div class="ps-qtile"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
    const lowLv = withMean[0], highLv = withMean[withMean.length - 1];
    const legend = `<div class="ps-legend">${['low', 'medium', 'high', 'none'].map(k => `<span><i style="background:${WL[k].c}">${WL[k].k}</i>${WL[k].name}</span>`).join('')}
      <span><b class="ok yes">✓</b>/<b class="ok no">✗</b> answer</span><span><b>↑ ↓</b> level changed after this round</span></div>`;

    const el = document.createElement('main'); el.id = 'ps-final';
    el.innerHTML = `
      <p class="eyebrow">SESSION COMPLETE${pid ? ' · ' + esc(pid.toUpperCase()) : ''}</p>
      <h1>Well done!</h1>
      <section class="ps-fcards">
        <div class="ps-fcard ps-fscore"><span>Score</span><strong>${nOK} / ${n}</strong><em>${n ? Math.round(nOK / n * 100) : 0}% correct</em><small>${sets}</small></div>
        <div class="ps-fcard"><span>Highest level</span><strong>${best}</strong><em>${esc(LEVELS[best]?.label || '')}</em></div>
      </section>

      <div class="ps-qhead">
        <p class="eyebrow">Q2 · RESEARCH VIEW · WITHIN THIS PARTICIPANT ONLY</p>
        <h2 class="ps-qtitle">Did the pupil grow with difficulty, and what did the pupil rule decide?</h2>
        <p class="ps-fnote">Each round: median of valid Find-screen readings from 0.5 s after the cards appeared until the bus was locked,
          minus this participant’s Find-screen baseline. Changes are averaged per level and compared only within this participant,
          because pupil effort measures are reliable only per person (Neagu et al., 2023).</p>
      </div>
      ${!BL ? '<div class="ps-qwarn">No Find-screen baseline was recorded in this session, so pupil change cannot be computed and the pupil rule could not run. Record the baseline (Pupil ▾ → Calibrate again) before the next session.</div>' : ''}

      <section class="ps-qtiles">
        ${tile('Find-screen baseline', BL ? `${fmt(BL.search.pupil)} mm` : '–', BL ? `± ${fmt(BL.search.sd)} mm · ${Math.round((BL.search.validFrac || 0) * 100)}% usable` : 'not recorded')}
        ${tile('Rounds with a pupil reading', `${usable.length} / ${n}`, 'rounds without valid readings are left out of the means')}
        ${tile('Mean change, lowest → highest level', withMean.length > 1 ? `${sgn(lowLv.mean)} → ${sgn(highLv.mean)}` : withMean.length ? sgn(withMean[0].mean) : '–',
               withMean.length > 1 ? `mm · Level ${lowLv.lv} vs Level ${highLv.lv}` : withMean.length ? `mm · only Level ${withMean[0].lv} had readings` : 'no usable rounds')}
        ${tile('Level decisions set by the pupil', `${pupilDriven} / ${n}`, `${ups} up · ${downs} down · ${n - ups - downs} stayed (all reasons)`)}
      </section>

      <section class="ps-fpanel">
        <p class="ps-step">1</p><h2>Pupil change by level</h2>
        <p class="ps-fnote">Dots = single rounds · green bar and number = mean change for that level · dashed lines = the MEDIUM / HIGH thresholds the live rule used. Hover a dot for that round.${thrChanged ? ' Thresholds were changed during the session; the lines show the final values.' : ''}</p>
        ${usable.length ? svgByLevel(rows, thr) : '<p class="ps-empty">No round had a usable Find-screen reading.</p>'}
        <table class="ps-ftable" style="margin-top:14px"><thead><tr><th>Level</th><th>Rounds</th><th>Correct</th><th>With reading</th><th>Mean change (mm)</th><th>SD</th><th>Pupil rule read</th></tr></thead><tbody>
        ${byLevel.map(r => `<tr><td><b>${r.lv}</b> ${esc(r.name)}</td><td>${r.n}</td><td>${r.ok} / ${r.n}</td><td>${r.k} / ${r.n}</td>
          <td>${r.mean == null ? '<span class="muted">no reading</span>' : `<b>${sgn(r.mean)}</b>`}</td><td class="muted">${r.sd == null ? '–' : r.sd.toFixed(2)}</td>
          <td>${[['low', r.low], ['medium', r.med], ['high', r.high]].map(([k, c]) => `<span class="cnt"><i class="chip" style="background:${WL[k].c}">${WL[k].k}</i>${c}</span>`).join('')}</td></tr>`).join('')}
        </tbody></table>
      </section>

      <section class="ps-fpanel">
        <p class="ps-step">2</p><h2>Level decisions the pupil rule made during the game</h2>
        <p class="ps-fnote">Top: the level each round was played at, marked with the reading the live rule used (L / M / H). Bottom: that round’s Find-screen change — same colour, so a bar crossing a dashed line explains the decision. Hover a round for details.</p>
        ${n ? svgRounds(rows, thr) + legend : '<p class="ps-empty">No rounds recorded.</p>'}
        <table class="ps-ftable ps-dtable" style="margin-top:18px"><thead><tr><th>After the round</th><th>Rule</th><th>Rounds</th><th>What the level did</th></tr></thead><tbody>
        ${dec.map(d => `<tr class="${d.key in WL ? '' : 'nochip'}"><td>${d.key in WL ? `<i class="chip" style="background:${WL[d.key].c}">${WL[d.key].k}</i>` : ''}${d.rule}</td><td class="muted">${d.rule2}</td><td><b>${d.n}</b></td>
          <td class="muted">${d.n ? [d.up && `↑ ${d.up}`, d.down && `↓ ${d.down}`, d.stay && `= ${d.stay}`].filter(Boolean).join(' · ') : '–'}</td></tr>`).join('')}
        </tbody></table>
        <p class="ps-fnote" style="margin-top:12px">Rows marked L / M / H are decisions set by pupil size (${pupilDriven} of ${n} rounds); a wrong answer always lowers the level, whatever the pupil.
          ${DIFF.upAfter > 1 ? `LOW + correct raises the level only after ${DIFF.upAfter} in a row, so some LOW rounds stay.` : ''}</p>
      </section>

      ${n ? `<details class="ps-fpanel ps-details"><summary>Pupil trace in every round (Remember + Find)</summary>
        <p class="ps-fnote">1-s medians of valid readings, relative to each screen’s own baseline. Find starts after the dotted line. Not used for Q2.</p>${traceSvg}</details>` : ''}

      <p class="ps-fnote" style="text-align:center">The full results were saved to Excel.
        <button class="ps-flink" type="button" id="ps-fcsv">Download Q2 table (CSV)</button> ·
        <button class="ps-flink" type="button" id="ps-frec">Show training record</button></p>`;
    main.after(el);

    // shared hover tooltip
    let tip = document.getElementById('ps-ftip');
    if (!tip) { tip = document.createElement('div'); tip.id = 'ps-ftip'; document.body.appendChild(tip); }
    el.addEventListener('mousemove', e => {
      const t = e.target.closest?.('[data-tip]');
      if (!t) { tip.style.display = 'none'; return; }
      tip.textContent = t.getAttribute('data-tip'); tip.style.display = 'block';
      const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8), y = e.clientY + 16 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 16;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    });
    el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    el.querySelector('#ps-frec').onclick = () => { el.remove(); tip.remove(); main.style.display = ''; };
    el.querySelector('#ps-fcsv').onclick = () => {
      const head = ['participant', 'set', 'round', 'level_played', 'correct', 'find_pupil_mm', 'find_baseline_mm', 'find_change_mm', 'find_valid_frac',
                    'pupil_reading', 'medium_threshold_mm', 'high_threshold_mm', 'decision', 'level_next', 'search_time_s'];
      const lines = [head].concat(rows.map(r => [pid, r.set, r.rep, r.level, r.correct, fmt(r.pupil, 3), fmt(r.base, 3), r.delta == null ? '' : r.delta.toFixed(3),
        r.valid != null && isFinite(r.valid) ? r.valid.toFixed(2) : '', r.wl ? WL[r.wl].name : '', isFinite(r.med) ? r.med.toFixed(3) : '', isFinite(r.high) ? r.high.toFixed(3) : '',
        r.reason, r.next ?? '', r.searchS == null ? '' : r.searchS.toFixed(2)]));
      lines.push([]); lines.push(['level', 'name', 'rounds', 'correct', 'rounds_with_reading', 'mean_change_mm', 'sd_mm', 'LOW', 'MEDIUM', 'HIGH']);
      byLevel.forEach(r => lines.push([r.lv, r.name, r.n, r.ok, r.k, r.mean == null ? '' : r.mean.toFixed(3), r.sd == null ? '' : r.sd.toFixed(3), r.low, r.med, r.high]));
      const csv = lines.map(l => l.map(v => `"${String(v ?? '').replace(/"/g, '""').replace(/^–$/, '')}"`).join(',')).join('\r\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
      a.download = `CatchYourBus_Q2_${pid || 'participant'}.csv`; document.body.appendChild(a); a.click(); a.remove();
    };
  }
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
    if (baseline) { const th = thresholdsFor(baseline.search); tr.thr_med = th.med; tr.thr_high = th.high; }   // thresholds in force for this round
  }

  setInterval(() => { tick(); sendState(); }, 200);
  // live state for the monitor page (http://localhost:8000/) - relayed by the server, nothing is stored there
  function sendState() {
    if (ws?.readyState !== 1) return;
    const t = now(), last = samples[samples.length - 1];
    const which = phase === 'memory' ? 'memory' : (phase === 'search' || phase === 'confirm') ? 'search' : null;
    const b = baseline && which ? baseline[which] : null;
    const p = which && live.phase === which ? live.ema : null;
    const L = LEVELS[DIFF.level] || {};
    try {
      ws.send(JSON.stringify({ type: 'state', streaming, calibrating, phase, phaseName: phaseName(), screen,
        level: $('ps-level').className || null, label: $('ps-level').textContent, meta: $('ps-meta').textContent, warn: $('ps-warn').textContent,
        pupil: p, raw: last && t - last.t < 1 ? last.pupil : null, valid: last ? !!last.valid : false, blink: last ? !!last.blink : false,
        baseline: b ? b.pupil : null, baselineSD: b ? b.sd : null, index: isFinite(indexFor(p, which)) ? indexFor(p, which) : null,
        t1: CFG.t1, t2: CFG.t2, set: attempt?.set ?? null, game: attempt?.rep ?? null,
        difficulty: DIFF.level, difficultyName: L.label || '', adaptive: DIFF.adaptive, games: trials.length,
        correct: trials.filter(x => x.correct).length, lastTrial: trials.length ? { correct: trials.at(-1).correct, level: trials.at(-1).search_level } : null,
        participant: ($('ps-pid')?.value || '').trim(),
        emg: EMG.ctl?.connected ? { source: EMG.source, ready: emgReady(), active: EMG.active, env: EMG.env, thr: EMG.thr, use: EMG.use } : null }));
    } catch {}
  }
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
      const b = baseline[which];
      const recent = samples.filter(s => s.t > t - 2);              // quality checks on the last 2 s
      const usable = recent.filter(s => s.valid && !s.postMove).length / (recent.length || 1);
      const postFrac = recent.filter(s => s.postMove).length / (recent.length || 1);
      const p = live.phase === which ? live.ema : null;
      const idx = indexFor(p, which);
      const w = { pupil: p };
      if (postFrac > 0.5) warn.push('just stood up — waiting to settle');
      else if (live.phase !== which || live.n < 5) warn.push('collecting readings…');
      else if (usable < 0.5) warn.push(`only ${Math.round(usable * 100)}% usable frames (face/eyes lost or blinking)`);
      const lum = mean(recent.map(s => s.lum).filter(x => x != null));
      if (b.lum && isFinite(lum) && Math.abs(lum / b.lum - 1) > 0.15) warn.push(`light ${Math.round((lum / b.lum - 1) * 100)}% vs baseline`);
      // distance: median face HEIGHT over the last 3 s vs baseline (height is not affected by turning the head left/right)
      const fs = median(samples.filter(s => s.t > t - 3 && s.faceS != null).map(s => s.faceS));
      const bS = b.faceS ?? b.faceW;
      if (CFG.distCheck && bS && isFinite(fs) && Math.abs(fs / bS - 1) > CFG.distTol)
        warn.push(`sitting ${fs > bS ? 'closer' : 'farther'} than at baseline (${fs > bS ? '+' : ''}${Math.round((fs / bS - 1) * 100)}%)`);
      const ok = !warn.length && isFinite(idx);
      if (ok) levelShown = levelOf(idx);
      setLevel(ok ? levelShown : null, ok ? null : 'PAUSED');
      const hasP = w.pupil != null && isFinite(w.pupil);
      $('ps-meta').textContent = `${phaseName()} · ${fmt(w.pupil)} mm (Δ ${hasP ? (w.pupil - b.pupil >= 0 ? '+' : '') + fmt(w.pupil - b.pupil) : '–'}) · idx ${fmt(idx)}` + (ok ? '' : ` · ${warn[0]}`);
    }
    $('ps-warn').textContent = warn.join(' · ');
    if ($('ps-panel').classList.contains('open') && (++chartTick % 5 === 0)) drawChart();
  }
  let chartTick = 0;
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
  function exportRows() {
    const tr = trials.map(t => ({ attemptId: t.attemptId, set: t.set, rep: t.rep,
      target: t.two ? t.two.routes.join(' + ') : t.target, target_dest: t.two ? t.two.dests.join(' + ') : t.targetDest,
      selected: String(t.selected ?? '').split('|').join(' + '), selected_dest: String(t.selectedDest ?? '').split('|').join(' + '), buses_to_remember: t.two ? t.two.routes.length : 1,
      destination_mode: t.destMode, correct: t.correct,
      level_played: t.level_played ?? '', level_next: t.level_next ?? '', level_change: t.level_change ?? '', level_reason: t.level_reason ?? '',
      lock_source: t.lockSource, reselections: t.reselections ?? 0, search_time_ms: t.searchTimeMs, s_since_stand_up_at_memory: t.sinceStandUp,
      mem_pupil_mm: fmt(t.mem_pupil, 3), mem_pupil_incl_postmove_mm: fmt(t.mem_pupil_incl_postmove, 3), mem_valid: fmt(t.mem_valid), mem_postmove_frac: fmt(t.mem_postmove_frac),
      search_pupil_mm: fmt(t.search_pupil, 3), search_valid: fmt(t.search_valid), search_postmove_frac: fmt(t.search_postmove_frac),
      base_memory_mm: fmt(t.base_memory, 3), base_search_mm: fmt(t.base_search, 3),
      confirm_by: t.confirmBy ?? '', emg_onset_after_lock_s: t.emgOnsetAfterLock != null ? fmt(t.emgOnsetAfterLock, 3) : '',
      mem_index: fmt(t.mem_index, 3), mem_level: t.mem_level ?? '', search_index: fmt(t.search_index, 3), search_level: t.search_level ?? '' }));
    const sm = samples.map(s => ({ time: s.iso, phase: s.phase, screen: s.screen, attemptId: s.attemptId, set: s.set, rep: s.rep,
      pupil_mm: fmt(s.pupil, 3), left_mm: fmt(s.left, 3), right_mm: fmt(s.right, 3), blink: s.blink, face: s.face, valid: s.valid,
      post_movement: s.postMove, gaze_x: s.gx, gaze_y: s.gy, light: fmt(s.lum, 1), face_w: fmt(s.faceW, 3), face_h: fmt(s.faceS, 3) }));
    return { tr, sm };
  }
  async function exportExcel(auto = false) {
    const { tr, sm } = exportRows();
    if (!tr.length) { $('ps-r-xlsx').textContent = 'No games recorded yet.'; return; }
    const pad = n => String(n).padStart(2, '0'), t = d => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : '';
    const st = CYB.getState();
    const payload = {
      trials: tr, samples: sm, levels: LEVELS.slice(1),
      emg: EMG.rows.map(r => ({ time: r.iso, phase: r.phase, set: r.set, rep: r.rep, adc: r.adc, envelope: fmt(r.env, 1), threshold: r.thr != null ? fmt(r.thr, 1) : '', active: r.active })),
      emg_events: EMG.events.map(e => ({ time: e.iso, type: e.type, phase: e.phase, set: e.set, rep: e.rep, detail: e.reason || (e.onset_after_lock_s != null ? `onset ${fmt(e.onset_after_lock_s, 3)} s after selection` : '') })),
      meta: {
        participant: $('ps-pid').value.trim() || session.participant, date: (session.start || new Date()).toISOString().slice(0, 10),
        start: t(session.start), end: t(session.end || new Date()), sets: st.totalSets, reps: st.repsPerSet, grid: GRID_KEY,
        gazeQuality: gazeCal?.skipped ? 'not calibrated' : (gazeCal?.quality || ''), gazeMedianPx: gazeCal?.median,
        baseMemory: baseline?.memory?.pupil, baseSearch: baseline?.search?.pupil, baseMemorySD: baseline?.memory?.sd, baseSearchSD: baseline?.search?.sd,
        emgSource: EMG.ctl?.connected ? EMG.source : 'not used', emgBaseline: EMG.ctl?.processors?.[0]?.baseline ? `${EMG.ctl.processors[0].baseline.mean.toFixed(1)} ± ${EMG.ctl.processors[0].baseline.sd.toFixed(1)} ADC` : '',
        emgThreshold: EMG.ctl?.processors?.[0]?.threshold ?? null,
        emgFilter: EMG.ctl?.connected ? (EMG.filter || 'none reported (original firmware)') : '',
        emgMissed: EMG.ctl?.latest?.row?.missed_slots ?? null,
        baseMemoryValid: baseline?.memory?.validFrac, baseSearchValid: baseline?.search?.validFrac, lightDiff: check?.diff, exposureLocked,
        settings: { calibration: CAL_MODE, dwellMs: CFG.dwellMs, smoothingS: CFG.smoothS, readingsPerS: CFG.fps,
                    distanceCheck: CFG.distCheck ? `±${Math.round(CFG.distTol * 100)}%` : 'off', settleAfterStandS: CFG.settleS,
                    adaptive: DIFF.adaptive, raiseAfterLow: DIFF.upAfter, thresholds: `MEDIUM >= max(${CFG.medSD} SD, ${CFG.medMin} mm); HIGH >= max(${CFG.highSD} SD, ${CFG.highMin} mm); min SD ${CFG.sdMin} mm`,
                    thresholdsMm: baseline ? `Remember +${thresholdsFor(baseline.memory).med.toFixed(2)} / +${thresholdsFor(baseline.memory).high.toFixed(2)} mm; Find +${thresholdsFor(baseline.search).med.toFixed(2)} / +${thresholdsFor(baseline.search).high.toFixed(2)} mm` : 'no baseline' },
      },
    };
    $('ps-r-xlsx').textContent = 'Building Excel summary…';
    try {
      const res = await fetch('/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const name = (res.headers.get('content-disposition') || '').match(/filename="?([^";]+)/)?.[1] || 'CatchYourBus_summary.xlsx';
      const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      $('ps-r-xlsx').textContent = `${auto ? 'Session finished — ' : ''}Excel summary downloaded (${name}); a copy is in the server's exports folder.`;
    } catch (e) { $('ps-r-xlsx').textContent = 'Excel export failed: ' + e.message; }
  }
  $('ps-xlsx').onclick = () => exportExcel(false);

  window.PupilSenseOverlay = { getSamples: () => samples, getTrials: () => trials, getBaseline: () => baseline,
                               getGazeCalibration: () => gazeCal, openCalibration, simulateGaze: (x, y) => onGaze({ x, y }, true), config: CFG,
                               showFinal, previewFinal: data => renderFinal(data) };   // previewFinal({trials, samples, baseline, participant}) re-draws the end page from saved data
  console.info('[PupilSense] overlay ready');
})();
