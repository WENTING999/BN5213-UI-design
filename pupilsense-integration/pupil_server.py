"""
pupil_server.py — live webcam server around the PupilSense / EyeDentify engine
(https://huggingface.co/spaces/vijulshah/pupilsense, code from
 https://github.com/vijulshah/webcam-based-pupil-diameter-estimation).

Put this file, pupilsense-adapter.js, xlsx_report.py and pupil_workload.html INSIDE the cloned `pupilsense`
folder, then:
    python pupil_server.py --game-dir BN5213-UI-design     # game at http://localhost:8000/game/
                                                           # monitor at http://localhost:8000/monitor

It uses the authors' own code unchanged:
  * preprocessing.dataset_creation.EyeDentityDatasetCreation  -> face check, 32x16 eye crops,
    blink detection (eye-aspect-ratio + ViT confirm)
  * utils.get_model + registrations/models.py                 -> ResNet regressors
  * pre_trained_models/<model>/left_eye.pt, right_eye.pt      -> trained weights
and the same pre-processing as their app: frame thumbnail to max 640x480, eye crop ->
Resize([32, 64], bicubic, antialias) -> ToTensor (no normalisation).

Model licence: CC BY-NC 4.0 (non-commercial).
"""
import argparse, asyncio, base64, io, json, os, sys, time
import numpy as np
import cv2
import torch
from PIL import Image
from torchvision import transforms

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

try:
    from registry_utils import import_registered_modules
    from utils import get_model
    from preprocessing.dataset_creation import EyeDentityDatasetCreation
except ImportError as e:
    sys.exit(f"Could not import the PupilSense code ({e}).\n"
             f"Put pupil_server.py inside the cloned 'pupilsense' folder (next to app.py).")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.concurrency import run_in_threadpool
import uvicorn
try:
    import websockets  # noqa: F401  — uvicorn needs this (or wsproto) for the /ws stream
except ImportError:
    try:
        import wsproto  # noqa: F401
    except ImportError:
        sys.exit('uvicorn has no WebSocket support installed.\nRun:  pip install "uvicorn[standard]"   (or: pip install websockets)')

import_registered_modules()

# ------------------------------------------------------------ their logic ----
@torch.no_grad()
def load_model(model_name, eye, device):
    """Same as app_utils.load_model in the PupilSense app."""
    path = os.path.join(ROOT, "pre_trained_models", model_name, f"{eye}.pt")
    if not os.path.isfile(path) or os.path.getsize(path) < 1_000_000:
        sys.exit(f"Weights missing or not downloaded: {path}\n"
                 f"Run `git lfs install` then `git lfs pull` inside the pupilsense folder.")
    state = torch.load(path, map_location=device)
    model = get_model(model_configs={"registered_model_name": model_name, "num_classes": 1})
    model.load_state_dict(state)
    return model.to(device).eval()


def resize_frame(image, max_width=640, max_height=480):
    """Copied from app_utils.resize_frame in the PupilSense app."""
    if not isinstance(image, Image.Image):
        image = Image.fromarray(image)
    original_size = image.size
    if original_size[0] == original_size[1] and original_size[0] >= 256:
        max_size = (256, 256)
    else:
        max_size = list(original_size)
        if original_size[0] >= max_width:
            max_size[0] = max_width
        elif original_size[0] < 64:
            max_size[0] = 64
        if original_size[1] >= max_height:
            max_size[1] = max_height
        elif original_size[1] < 32:
            max_size[1] = 32
    image.thumbnail(max_size)
    return image


PREPROCESS = transforms.Compose([   # same order as process_frames() in the app
    transforms.Resize([32, 64], interpolation=transforms.InterpolationMode.BICUBIC, antialias=True),
    transforms.ToTensor(),
])

# --------------------------------------------------------------- engine ----
class PupilEngine:
    def __init__(self, model_name="ResNet18", blink_detection=True, fast=True):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        if self.device.type == "cuda":
            torch.backends.cudnn.benchmark = True
        self.model_name = model_name
        self.fast = fast
        self.models = {eye: load_model(model_name, eye, self.device) for eye in ("left_eye", "right_eye")}
        self.ds = EyeDentityDatasetCreation(
            feature_extraction_configs={"extraction_library": "mediapipe",
                                        "blink_detection": blink_detection, "upscale": 1})
        fx = self.ds.features_extractor.feature_extractor
        self.face_detector = fx.face_detector
        if fast:
            # Live-video speed-ups (model input is unchanged: same 32x16 eye crops -> same ResNet):
            #  1. Face Mesh in tracking mode (the authors use single-image mode, which re-detects every frame)
            import mediapipe as mp
            fx.face_mesh = mp.solutions.face_mesh.FaceMesh(
                max_num_faces=1, static_image_mode=False, refine_landmarks=True,
                min_detection_confidence=0.5, min_tracking_confidence=0.5)
            #  2. Skip the iris crops/segmentation (a second Face Mesh pass; not used by the pupil model)
            fx.extract_iris = lambda image: None

    @staticmethod
    def _png(eye_rgb, scale=4):
        big = cv2.resize(eye_rgb, (eye_rgb.shape[1] * scale, eye_rgb.shape[0] * scale), interpolation=cv2.INTER_NEAREST)
        ok, buf = cv2.imencode(".png", cv2.cvtColor(big, cv2.COLOR_RGB2BGR))
        return "data:image/png;base64," + base64.b64encode(buf).decode() if ok else None

    @torch.no_grad()
    def process(self, rgb, extras=True):
        """extras=False skips face size + crop images (only needed a few times per second)."""
        t0 = time.perf_counter()
        img = np.array(resize_frame(rgb).convert("RGB"))
        h, w = img.shape[:2]
        out = {"face": False, "blink": False, "eyes_ratio": None, "left_mm": None, "right_mm": None,
               "lum": float(cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).mean()), "face_w": None, "face_h": None,
               "crops": {}, "frame_size": [w, h]}

        if extras:
            det = self.face_detector.process(img)      # face size = distance proxy
            if det.detections:
                bb = det.detections[0].location_data.relative_bounding_box
                out["face_w"] = float(bb.width)
                out["face_h"] = float(bb.height)   # height: barely changes when the head turns left/right

        res = self.ds(img)                             # authors' feature extraction
        if res is None or "face" not in res:
            out["ms"] = (time.perf_counter() - t0) * 1000
            return out
        out["face"] = True
        eyes = res.get("eyes")
        if eyes is not None:
            out["blink"] = bool(eyes["blinked"])
            out["eyes_ratio"] = None if eyes["eyes_ratio"] is None else float(eyes["eyes_ratio"])
            for eye in ("left_eye", "right_eye"):
                crop = eyes.get(eye)
                if crop is None or crop.size == 0:
                    continue
                if extras:
                    out["crops"][eye] = self._png(crop)
                if not out["blink"]:
                    x = PREPROCESS(Image.fromarray(crop).convert("RGB")).unsqueeze(0).to(self.device)
                    out[f"{eye.split('_')[0]}_mm"] = float(self.models[eye](x)[0].item())
        out["ms"] = (time.perf_counter() - t0) * 1000
        return out


# ------------------------------------------------------------------ app ----
def find_emg_dir(given=None):
    """Folder holding the EMG team's browser code (BN5213-final-EMG/web/lib/emg-controller.mjs)."""
    cands = [given] if given else [os.path.join(ROOT, "BN5213-final-EMG"), os.path.join(os.path.dirname(ROOT), "BN5213-final-EMG"),
                                   os.path.join(ROOT, "emg"), os.path.join(os.path.dirname(ROOT), "BN5213-final-EMG-main")]
    for c in cands:
        if not c:
            continue
        for web in (os.path.join(c, "web"), c):
            if os.path.isfile(os.path.join(web, "lib", "emg-controller.mjs")):
                return os.path.abspath(web)
    return None


def create_app(engine, game_dir=None, protocol=(2, 5), export_dir=None, emg_web=None):
    app = FastAPI()

    @app.get("/emg/lib/{name}")
    def emg_lib(name: str):
        """EMG team's modules (EmgController, envelope detector, Web Serial), served as JavaScript modules."""
        import re
        if not emg_web or not re.fullmatch(r"[A-Za-z0-9_-]+\.mjs", name):
            return JSONResponse({"error": "EMG code not available"}, status_code=404)
        path = os.path.join(emg_web, "lib", name)
        if not os.path.isfile(path):
            return JSONResponse({"error": "not found"}, status_code=404)
        return FileResponse(path, media_type="application/javascript", headers={"Cache-Control": "no-store"})

    @app.get("/")
    @app.get("/monitor")
    def index():
        return FileResponse(os.path.join(ROOT, "pupil_workload.html"), headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"})

    @app.get("/pupilsense-adapter.js")
    def adapter():
        return FileResponse(os.path.join(ROOT, "pupilsense-adapter.js"), media_type="application/javascript",
                            headers={"Cache-Control": "no-store"})

    if game_dir:
        # Serve the Catch Your Bus game unchanged, injecting the PupilSense overlay script.
        from fastapi.responses import HTMLResponse, RedirectResponse
        from fastapi.staticfiles import StaticFiles
        game_dir = os.path.abspath(game_dir)

        @app.get("/game")
        def game_redirect():
            return RedirectResponse("/game/")

        @app.get("/game/")
        @app.get("/game/index.html")
        def game_index():
            with open(os.path.join(game_dir, "index.html"), encoding="utf-8") as f:
                html = f.read()
            v = int(os.path.getmtime(os.path.join(ROOT, "pupilsense-adapter.js")))   # changes whenever the file changes
            tag = f'<script src="/pupilsense-adapter.js?v={v}"></script>\n'
            html = html.replace("</body>", tag + "</body>") if "</body>" in html else html + tag
            return HTMLResponse(html, headers={"Cache-Control": "no-store"})

        # Patch their app.js in memory (file on disk untouched). Each patch is applied only if its
        # anchor text is found, so an upstream change just disables that feature (with a warning).
        PATCHES = [
            ("protocol length (sets x games)", [
                ("const TOTAL_SETS = 3;", f"const TOTAL_SETS = {int(protocol[0])};"),
                ("const REPS_PER_SET = 10;", f"const REPS_PER_SET = {int(protocol[1])};"),
            ]),
            ("grid size (window.PupilSenseGrid.cards: 9 = 3x3, 6 = 3x2, 4 = 2x2)", [
                ("const real = sample(REAL_ROUTES, 7);",
                 "const __n = (window.PupilSenseGrid && window.PupilSenseGrid.cards) || 9;\n"
                 "    const __d = __n >= 6 ? 2 : 1;\n"
                 "    const real = sample(REAL_ROUTES, __n - __d);"),
                ("const distractors = sample(GAME_DISTRACTORS, 2);",
                 "const distractors = sample(GAME_DISTRACTORS, __d);"),
                ("currentCards = sample([...real, ...distractors], 9);",
                 "currentCards = sample([...real, ...distractors], __n);"),
            ]),
            ("difficulty (window.PupilSenseDifficulty: memoryMs, delayMs, similarity)", [
                ("currentCards = sample([...real, ...distractors], __n);",
                 "const __sim = (window.PupilSenseDifficulty && window.PupilSenseDifficulty.similarity) || 'low';\n"
                 "    if (__sim === 'low') { currentCards = sample([...real, ...distractors], __n); }\n"
                 "    else {\n"
                 "      const t = currentTarget, look = new Set();\n"
                 "      const perm = (s) => s.length <= 1 ? [s] : [...s].flatMap((c, i) => perm(s.slice(0, i) + s.slice(i + 1)).map((r) => c + r));\n"
                 "      perm(t).forEach((v) => look.add(v));\n"
                 "      for (let i = 0; i < t.length; i++) for (let d = 0; d <= 9; d++) look.add(t.slice(0, i) + d + t.slice(i + 1));\n"
                 "      look.delete(t);\n"
                 "      const k = __sim === 'high' ? __n - 1 : Math.ceil((__n - 1) / 2);\n"
                 "      const alike = sample([...look].filter((v) => !(v.length > 1 && v[0] === '0' && t[0] !== '0')), k);\n"
                 "      const others = sample(REAL_ROUTES.filter((r) => r !== t && !alike.includes(r)), __n - 1 - alike.length);\n"
                 "      currentCards = sample([t, ...alike, ...others], __n);\n"
                 "    }\n"
                 "    // destination mode: every bus shows number + destination. Only the bus with the remembered\n"
                 "    // number AND destination is correct; others share the number (other destination) or the destination (other number).\n"
                 "    const __dst = window.PupilSenseDifficulty && window.PupilSenseDifficulty.destination;\n"
                 "    if (__dst) {\n"
                 "      const __D = (window.PupilSenseDestinations && window.PupilSenseDestinations.length >= __n) ? window.PupilSenseDestinations\n"
                 "        : ['Jurong East', 'Woodlands', 'Tampines', 'Bedok', 'Yishun', 'Clementi', 'Punggol', 'Bishan', 'Toa Payoh', 'Pasir Ris'];\n"
                 "      const __pos = Math.floor(Math.random() * __n);\n"
                 "      const __dests = sample(__D, __n);\n"
                 "      const __dups = Math.min(__n - 1, (window.PupilSenseDifficulty.duplicates || 1));\n"
                 "      const __free = currentCards.map((_, i) => i).filter((i) => i !== __pos);\n"
                 "      const __sameNum = sample(__free, __dups);                      // same number, different destination\n"
                 "      const __sameDest = sample(__free.filter((i) => !__sameNum.includes(i)), Math.min(__dups, __free.length - __dups)); // same destination, different number\n"
                 "      const __fill = sample(currentCards.filter((c) => c !== currentTarget), __n);\n"
                 "      currentCards = currentCards.map((c, i) => (i === __pos || __sameNum.includes(i)) ? currentTarget : (c === currentTarget ? __fill.pop() : c));\n"
                 "      window.__psDest = __dests.map((d, i) => __sameDest.includes(i) ? __dests[__pos] : d);\n"
                 "      window.__psTargetPos = __pos;\n"
                 "    } else { window.__psTargetPos = null; window.__psDest = null; }"),
                ("    }, TIMING.memoryVisibleMs);",
                 "    }, (window.PupilSenseDifficulty && window.PupilSenseDifficulty.memoryMs) || TIMING.memoryVisibleMs);"),
                ("      }, TIMING.memoryFadeMs);",
                 "      }, TIMING.memoryFadeMs + ((window.PupilSenseDifficulty && window.PupilSenseDifficulty.delayMs) || 0));"),
            ]),
            ("card identity by position (route@pos) for location mode", [
                ("  let currentSelectedRoute = null;",
                 "  let currentSelectedRoute = null;\n  let currentSelectedKey = null;"),
                ("    currentCards.forEach((route) => {",
                 "    currentCards.forEach((route, __i) => {"),
                ("      button.dataset.route = route;",
                 "      button.dataset.route = route;\n      button.dataset.key = route + '@' + __i;\n"
                 "      if (window.__psDest) button.dataset.dest = window.__psDest[__i];"),
                ("      number.textContent = route;\n      display.appendChild(number);",
                 "      number.textContent = route;\n      display.appendChild(number);\n"
                 "      if (window.__psDest) { const __dest = document.createElement('span'); __dest.className = 'route-dest'; __dest.textContent = window.__psDest[__i]; display.appendChild(__dest); }"),
                ("        if (!currentSelectedRoute) gazeTarget(route, 'mouse');\n"
                 "        else if (currentSelectedRoute === route) emgConfirmed({ source: 'mouse' });",
                 "        const __key = route + '@' + __i;\n"
                 "        if (!currentSelectedRoute) gazeTarget(__key, 'mouse');\n"
                 "        else if (currentSelectedKey === __key) emgConfirmed({ source: 'mouse' });"),
                ("    const route = String(routeNumber);\n    if (!currentCards.includes(route)) return false;\n"
                 "    if (currentSelectedRoute) return currentSelectedRoute === route;\n    currentSelectedRoute = route;",
                 "    let __key = String(routeNumber);\n"
                 "    if (!__key.includes('@')) { const __i = currentCards.indexOf(__key); if (__i < 0) return false; __key = __key + '@' + __i; }\n"
                 "    const route = __key.split('@')[0], __pos = Number(__key.split('@')[1]);\n"
                 "    if (currentCards[__pos] !== route) return false;\n"
                 "    if (currentSelectedRoute) return currentSelectedKey === __key;\n"
                 "    currentSelectedRoute = route; currentSelectedKey = __key;\n"
                 "    currentAttempt.selectedPos = __pos; currentAttempt.targetPos = window.__psTargetPos == null ? null : window.__psTargetPos;"),
                ("    const card = [...$('busGrid').querySelectorAll('.bus-card')].find((element) => element.dataset.route === route);",
                 "    const card = [...$('busGrid').querySelectorAll('.bus-card')].find((element) => element.dataset.key === currentSelectedKey);"),
                ("    publish('gaze_target_locked', { attemptId: currentAttempt.id, route, searchTimeMs: currentAttempt.searchTimeMs, source });",
                 "    publish('gaze_target_locked', { attemptId: currentAttempt.id, route, pos: __pos, dest: window.__psDest ? window.__psDest[__pos] : null, targetPos: currentAttempt.targetPos, searchTimeMs: currentAttempt.searchTimeMs, source });"),
                ("    currentAttempt.isCorrect = currentSelectedRoute === currentTarget;",
                 "    currentAttempt.isCorrect = currentSelectedRoute === currentTarget && (window.__psTargetPos == null || currentSelectedKey === currentTarget + '@' + window.__psTargetPos);"),
                ("    const selectedCard = [...$('busGrid').querySelectorAll('.bus-card')].find((element) => element.dataset.route === currentSelectedRoute);",
                 "    const selectedCard = [...$('busGrid').querySelectorAll('.bus-card')].find((element) => element.dataset.key === currentSelectedKey);"),
                ("    publish('trial_memory_shown', { attemptId: currentAttempt.id, set: state.currentSet, rep: currentAttempt.repNumber, targetRoute: currentTarget });",
                 "    publish('trial_memory_shown', { attemptId: currentAttempt.id, set: state.currentSet, rep: currentAttempt.repNumber, targetRoute: currentTarget, targetPos: window.__psTargetPos == null ? null : window.__psTargetPos, targetDest: window.__psDest ? window.__psDest[window.__psTargetPos] : null, cards: GRID_CARDS_SNAPSHOT() });"),
                ("  function makeRound() {",
                 "  function GRID_CARDS_SNAPSHOT() { return currentCards.slice(); }\n  function makeRound() {"),
                ("    currentSelectedRoute = null;\n    makeRound();",
                 "    currentSelectedRoute = null; currentSelectedKey = null;\n    makeRound();"),
            ]),
            ("unselect / change selection (inputs.clearGazeTarget)", [
                ("  function emgConfirmed(payload = {}) {",
                 "  function clearGazeTarget(source = 'external') {\n"
                 "    if (state.phase !== 'game' || !currentAttempt || currentAttempt.emgConfirmedAt || !currentSelectedRoute) return false;\n"
                 "    const previous = currentSelectedRoute;\n"
                 "    $('busGrid').querySelectorAll('.bus-card.gaze-locked').forEach((c) => c.classList.remove('gaze-locked'));\n"
                 "    currentSelectedRoute = null; currentSelectedKey = null;\n"
                 "    currentAttempt.selectedRoute = null; currentAttempt.gazeLockedAt = null; currentAttempt.searchTimeMs = null;\n"
                 "    currentAttempt.reselections = (currentAttempt.reselections || 0) + 1;\n"
                 "    publish('gaze_target_cleared', { attemptId: currentAttempt.id, route: previous, source });\n"
                 "    return true;\n"
                 "  }\n"
                 "  function emgConfirmed(payload = {}) {"),
                ("        else if (currentSelectedKey === __key) emgConfirmed({ source: 'mouse' });",
                 "        else if (currentSelectedKey === __key) emgConfirmed({ source: 'mouse' });\n"
                 "        else { clearGazeTarget('mouse'); gazeTarget(__key, 'mouse'); }"),
                ("      gazeTarget: (routeNumber) => gazeTarget(routeNumber, 'webgazer'),",
                 "      gazeTarget: (routeNumber) => gazeTarget(routeNumber, 'webgazer'),\n"
                 "      clearGazeTarget: () => clearGazeTarget('webgazer'),"),
            ]),
            ("two or three buses per frame (window.PupilSenseDifficulty.twoBus, .buses)", [
                ("    } else { window.__psTargetPos = null; window.__psDest = null; }\n  }\n  function updateTrainingCounter() {",
                 "    } else { window.__psTargetPos = null; window.__psDest = null; }\n"
                 "    // two-bus mode: each frame shows TWO buses (number + destination). The player remembers a pair\n"
                 "    // and selects the ONE frame showing exactly that pair. Decoy frames get one bus wrong.\n"
                 "    window.__psTwo = null; window.__psPairs = false;\n"
                 "    if (window.PupilSenseDifficulty && window.PupilSenseDifficulty.twoBus) {\n"
                 "      const __D = (window.PupilSenseDestinations && window.PupilSenseDestinations.length >= 6) ? window.PupilSenseDestinations\n"
                 "        : ['Jurong East', 'Woodlands', 'Tampines', 'Bedok', 'Yishun', 'Clementi', 'Punggol', 'Bishan', 'Toa Payoh', 'Pasir Ris'];\n"
                 "      const __k = Math.max(2, Math.min(3, window.PupilSenseDifficulty.buses || 2));   // buses per frame\n"
                 "      const nums = sample(REAL_ROUTES, __k), __ds = sample(__D, __k + 2);\n"
                 "      const dests = __ds.slice(0, __k), spare = __ds.slice(__k);\n"
                 "      const alike = (t) => { for (let k = 0; k < 60; k++) { const i = Math.floor(Math.random() * t.length);\n"
                 "        const v = t.slice(0, i) + Math.floor(Math.random() * 10) + t.slice(i + 1);\n"
                 "        if (v !== t && v[0] !== '0' && !nums.includes(v)) return v; }\n"
                 "        return sample(REAL_ROUTES.filter((r) => !nums.includes(r)), 1)[0]; };\n"
                 "      const target = nums.map((n, i) => [n, dests[i]]);\n"
                 "      const variants = [];\n"
                 "      for (let i = 0; i < __k; i++) {\n"
                 "        variants.push(target.map((b, j) => j === i ? [b[0], spare[i % spare.length]] : b));   // bus i: wrong destination\n"
                 "        variants.push(target.map((b, j) => j === i ? [alike(b[0]), b[1]] : b));              // bus i: look-alike number\n"
                 "        for (let j = i + 1; j < __k; j++)                                                       // buses i, j: destinations swapped\n"
                 "          variants.push(target.map((b, q) => q === i ? [b[0], target[j][1]] : q === j ? [b[0], target[i][1]] : b));\n"
                 "      }\n"
                 "      const decoys = sample(variants, __n - 1);\n"
                 "      const frames = sample([target, ...decoys], __n);\n"
                 "      const tPos = frames.indexOf(target);\n"
                 "      currentCards = frames.map((f) => f.map((b) => b[0]).join('|'));\n"
                 "      window.__psDest = frames.map((f) => f.map((b) => b[1]).join('|'));\n"
                 "      currentTarget = currentCards[tPos]; window.__psTargetPos = tPos; window.__psPairs = true;\n"
                 "      window.__psTwo = { routes: nums, dests };\n"
                 "    }\n"
                 "  }\n  function updateTrainingCounter() {"),
                ("      art.append(img, display);",
                 "      art.append(img, display);\n"
                 "      if (window.__psPairs) {   // two buses side by side in one frame\n"
                 "        const __nums = route.split('|'), __ds = (window.__psDest ? window.__psDest[__i] : '|').split('|');\n"
                 "        art.replaceChildren(); art.className = 'bus-art ps-pair';\n"
                 "        __nums.forEach((__n1, __j) => {\n"
                 "          const one = document.createElement('span'); one.className = 'bus-art';\n"
                 "          const im = document.createElement('img'); im.src = 'assets/citaro-front-master.png'; im.alt = ''; im.draggable = false;\n"
                 "          const dp = document.createElement('span'); dp.className = 'route-display';\n"
                 "          const nu = document.createElement('span'); nu.className = 'route-number'; nu.textContent = __n1;\n"
                 "          const de = document.createElement('span'); de.className = 'route-dest'; de.textContent = __ds[__j] || '';\n"
                 "          dp.append(nu, de); one.append(im, dp); art.appendChild(one);\n"
                 "        });\n"
                 "        button.setAttribute('aria-label', `Buses ${__nums.join(' and ')}`);\n"
                 "      }"),
                ("cards: GRID_CARDS_SNAPSHOT() });",
                 "cards: GRID_CARDS_SNAPSHOT(), two: window.__psTwo || null });"),
            ]),
        ]

        @app.get("/game/app.js")
        def game_app_js():
            with open(os.path.join(game_dir, "app.js"), encoding="utf-8") as f:
                js = f.read()
            for name, edits in PATCHES:
                if all(old in js for old, _ in edits):
                    for old, new in edits:
                        js = js.replace(old, new, 1)
                else:
                    print(f"WARNING: app.js changed upstream - patch not applied: {name}")
            from fastapi.responses import Response
            return Response(js, media_type="application/javascript", headers={"Cache-Control": "no-store"})

        app.mount("/game", StaticFiles(directory=game_dir), name="game")

    @app.get("/info")
    def info():
        return JSONResponse({"model": engine.model_name, "device": str(engine.device), "fast": engine.fast,
                             "gpu": torch.cuda.get_device_name(0) if engine.device.type == "cuda" else None})

    @app.post("/export")
    async def export_xlsx(payload: dict):
        """Build the end-of-session Excel summary, save a copy in exports/, and return it."""
        try:
            import xlsx_report
        except ImportError as e:
            return JSONResponse({"error": f"Excel export needs openpyxl: pip install openpyxl ({e})"}, status_code=500)
        import re
        from datetime import datetime
        out_dir = export_dir or os.path.join(ROOT, "exports")
        os.makedirs(out_dir, exist_ok=True)
        pid = re.sub(r"[^A-Za-z0-9_-]+", "_", str((payload.get("meta") or {}).get("participant") or "participant")).strip("_") or "participant"
        name = f"CatchYourBus_{pid}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
        path = os.path.join(out_dir, name)
        await run_in_threadpool(xlsx_report.build, payload, path)
        print(f"Saved session summary: {path}")
        return FileResponse(path, filename=name,
                            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    # latest frame / reading / game state, shown live on the monitor page (memory only, nothing saved)
    hub = {"frame": None, "frame_t": 0.0, "seq": 0, "result": None, "crops": {}, "state": None, "state_t": 0.0}

    @app.websocket("/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        n = 0
        try:
            while True:
                msg = await sock.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                if msg.get("text") is not None:           # game overlay state (workload level etc.)
                    try:
                        hub["state"] = json.loads(msg["text"]); hub["state_t"] = time.time()
                    except ValueError:
                        pass
                    continue
                data = msg.get("bytes")
                if not data:
                    continue
                n += 1
                hub["frame"], hub["frame_t"], hub["seq"] = data, time.time(), hub["seq"] + 1   # relay before processing
                try:
                    rgb = np.array(Image.open(io.BytesIO(data)).convert("RGB"))
                    result = await run_in_threadpool(engine.process, rgb, n % 4 == 1)
                except Exception as e:  # keep the stream alive on a bad frame
                    result = {"error": str(e)}
                hub["result"] = {k: v for k, v in result.items() if k != "crops"}
                if result.get("crops"):
                    hub["crops"] = result["crops"]
                await sock.send_json(result)
        except WebSocketDisconnect:
            pass

    @app.websocket("/watch")
    async def watch(sock: WebSocket):
        """Monitor page: ~12 updates/s with the game's latest camera frame, reading and workload state."""
        await sock.accept()
        sent_seq, sent_crops, last_json = -1, None, 0.0
        want_frames = sock.query_params.get("frames", "1") != "0"   # monitor showing its own camera -> no frames
        try:
            while True:
                t = time.time()
                if want_frames and hub["seq"] != sent_seq and hub["frame"] is not None:
                    await sock.send_bytes(hub["frame"])              # raw JPEG, sent as soon as a new one arrives
                    sent_seq = hub["seq"]
                if t - last_json >= 0.1:                            # readings + workload state, 10x per second
                    msg = {"type": "watch", "now": t, "live": hub["frame"] is not None and t - hub["frame_t"] < 2,
                           "state": hub["state"] if t - hub["state_t"] < 2 else None, "result": hub["result"]}
                    if hub["crops"] is not sent_crops:
                        msg["crops"] = hub["crops"]; sent_crops = hub["crops"]
                    await sock.send_json(msg)
                    last_json = t
                await asyncio.sleep(0.015)
        except (WebSocketDisconnect, RuntimeError):
            pass

    return app


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="ResNet18", choices=["ResNet18", "ResNet50"])
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-blink", action="store_true", help="skip blink detection (faster, noisier)")
    ap.add_argument("--exact", action="store_true",
                    help="use the authors' pipeline exactly (single-image Face Mesh + iris step) - slower")
    ap.add_argument("--game-dir", help="folder of the Catch Your Bus game (BN5213-UI-design) to serve at /game/")
    ap.add_argument("--sets", type=int, default=2, help="number of sets (default 2)")
    ap.add_argument("--games", type=int, default=5, help="games per set (default 5)")
    ap.add_argument("--emg-dir", help="folder of the EMG code (BN5213-final-EMG); found automatically next to this file")
    a = ap.parse_args()
    if a.game_dir and not os.path.isfile(os.path.join(a.game_dir, "index.html")):
        sys.exit(f"--game-dir: no index.html in {a.game_dir}")
    print("Loading PupilSense models…")
    engine = PupilEngine(a.model, blink_detection=not a.no_blink, fast=not a.exact)
    engine.process(np.zeros((480, 640, 3), np.uint8))   # warm-up
    print(f"Ready: {a.model} on {engine.device}.")
    with open(os.path.join(ROOT, "pupilsense-adapter.js"), encoding="utf-8") as f:
        _js = f.read()
    print("  Overlay script: " + ("latest (2x2, 6 levels, EMG confirm)" if "emgActivation" in _js else
          "OLD VERSION - replace pupilsense-adapter.js with the one from the latest zip"))
    with open(os.path.join(ROOT, "pupil_workload.html"), encoding="utf-8") as f:
        _html = f.read()
    print("  Monitor page:   " + ("latest (live game view)" if "gchip" in _html else
          "OLD VERSION - replace pupil_workload.html with the one from the latest zip"))
    emg_web = find_emg_dir(a.emg_dir)
    print("  EMG code:       " + (emg_web if emg_web else "NOT FOUND - clone BN5213-final-EMG next to pupil_server.py (or --emg-dir); EMG confirm disabled"))
    print(f"  Pupil monitor:          http://localhost:{a.port}/monitor")
    if a.game_dir:
        print(f"  Catch Your Bus + pupil: http://localhost:{a.port}/game/")
    print(f"  Protocol: {a.sets} sets x {a.games} games. Excel summaries are saved in {os.path.join(ROOT, 'exports')}")
    uvicorn.run(create_app(engine, a.game_dir, (a.sets, a.games), emg_web=emg_web), host=a.host, port=a.port, log_level="warning")
