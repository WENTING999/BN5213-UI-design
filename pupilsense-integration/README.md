# PupilSense + WebGazer integration for Catch Your Bus

Adds eye tracking, pupil-based workload measurement and adaptive difficulty to the
Catch Your Bus prototype **without changing any of the game's own files**.

| File | What it is |
|---|---|
| `pupil_server.py` | Python server: runs the PupilSense pupil model on the GPU, serves the game, and patches `app.js` in memory (the file on disk is untouched) |
| `pupilsense-adapter.js` | Browser overlay injected into the game: calibration, gaze selection, workload bar, adaptive difficulty, data export |
| `pupil_workload.html` | Optional stand-alone pupil monitor (light check, baseline, LOW/MEDIUM/HIGH without the game) |

> **Research prototype.** Webcam eye tracking and webcam pupil size are approximate.
> Do not use for clinical assessment.

---

## How it works

```
Browser (localhost:8000/game/)                    Python (pupil_server.py)
  Catch Your Bus (unchanged files)
  + pupilsense-adapter.js
  + WebGazer (gaze, runs in browser)
  webcam frame ──── WebSocket /ws ──────────────►  PupilSense: face → eye crops → blink check
                ◄── {left_mm, right_mm, blink} ──  → ResNet18 → pupil diameter (mm)
```

The game and overlay talk through the game's public API (`CatchYourBus.subscribe`, `CatchYourBus.inputs`).

---

## Setup (once)

Requirements: Windows, Anaconda, Git, Git LFS, Chrome or Edge, NVIDIA GPU recommended.

```bat
git lfs install
git clone https://huggingface.co/spaces/vijulshah/pupilsense
git clone https://github.com/WENTING999/BN5213-UI-design

conda create -n pupil python=3.10 -y
conda activate pupil
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126
pip install "mediapipe==0.10.21" "numpy<2" transformers opencv-python pillow fastapi "uvicorn[standard]"
```

Copy the three files from this folder **into the `pupilsense` folder** (next to its `app.py`).
The server must run from there, because it imports the PupilSense code and model weights.

Check `pupilsense\pre_trained_models\ResNet18\left_eye.pt` is ~47 MB. If it is tiny, run `git lfs pull` inside `pupilsense`.

The PupilSense model and weights are **not** included in this repo (CC BY-NC 4.0, non-commercial; large files).

---

## Run

```bat
conda activate pupil
cd <path>\pupilsense
python pupil_server.py --game-dir ..\BN5213-UI-design
```

Open **http://localhost:8000/game/** (must be `localhost`, not `127.0.0.1`).
Add `?fast=1` for short timers when testing. Stop with `Ctrl + C`.

Server options: `--model ResNet50`, `--port 8000`, `--no-blink`, `--exact` (authors' original, slower pipeline).

---

## Session flow

1. **Safety check** (game) → Start Session
2. **Calibration** (overlay)
   - Camera: face in the box, live lighting check, optional **Lock brightness**
   - Eye tracking: click each red dot 5× while looking at it (one at a time), then look at 5 orange check dots → accuracy rated Good / OK / Poor against bus-card size.
     Hands-free version: `?cal=look`
   - Pupil baseline: 10 s on the game background + 10 s on a bus-grid screen
3. **Warm-up** (game): look at the bus 3 s to lock, confirm with foot press (mouse click in demo)
4. **Game**: remember the bus → look at the matching bus 3 s → confirm. Look at another bus 3 s to change your mind.

---

## Changes applied to the game at runtime (please consider building these in properly)

| Change | Why |
|---|---|
| **3×2 grid (6 buses)** instead of 3×3 | Webcam gaze is least accurate near screen corners; bigger, more widely spaced targets |
| **Change selection** (`inputs.clearGazeTarget()`) | Players could not unselect a wrongly locked bus |
| **Difficulty settings** (memory time, blank delay, look-alike numbers, destinations) | Needed for adaptive difficulty |
| **Bus identity by position** (`route@position`) | Several buses can show the same number at the hardest levels |

If `app.js` changes so a patch no longer fits, the server prints a warning and that feature is skipped.

---

## Workload measurement

- PupilSense reads pupil size ~20×/s from the webcam.
- Live level: smoothed pupil (1.5 s) compared with the baseline **for the same screen**
  (the Remember and Find screens differ in brightness).
  `index = (pupil − baseline) / (3 × baseline SD)` → LOW < 0.33 ≤ MEDIUM < 0.66 ≤ HIGH
- Shows **PAUSED** when the reading can't be trusted:
  just stood up (EMG confirm → 4 s after the stand-up), face lost / blinking,
  light changed > 15 %, or sitting closer/farther than at baseline (face height > 15 %).

## Adaptive difficulty (after each confirmed answer, using the Find-phase workload)

| Result | Change |
|---|---|
| Wrong answer | down 1 level |
| Correct + HIGH | down 1 level |
| Correct + LOW, 2× in a row | up 1 level |
| Correct + MEDIUM | stay |
| Correct, no reliable reading | stay |

| Level | Number shown | Blank delay | Other buses | Destination |
|---|---|---|---|---|
| 1 Very easy | 4.0 s | 0 s | random | – |
| 2 Easy (start) | 3.2 s | 1.0 s | random | – |
| 3 Medium | 2.7 s | 1.5 s | half look-alikes | – |
| 4 Hard | 2.0 s | 2.5 s | all look-alikes | – |
| 5 Number + destination | 3.0 s | 1.5 s | look-alikes | yes |
| 6 Number + destination, hard | 2.2 s | 3.0 s | look-alikes | yes |

Every level uses the same 3×2 screen, so screen brightness does not change with difficulty.

---

## Researcher panel (Pupil ▾ at the top)

Calibrate again · Light check · Export CSV · show/hide level to participant · gaze selection on/off ·
gaze dot · mouse-as-gaze (testing) · dwell time · lock brightness · distance check % · smoothing ·
readings/s · adaptive on/off · raise-after count · manual level

**Export** saves three files:
- `pupilsense_trials_*.csv` — one row per trial (target, selection, correct, search time, pupil per phase, level, level change and reason)
- `pupilsense_samples_*.csv` — every pupil reading with phase, gaze, light and face size
- `pupilsense_meta_*.json` — calibration accuracy, baseline, light check, settings

---

## Known limitations

- **Validate the pupil signal first.** Run *Light check* (white vs black screen); the pupil must read clearly larger on black. If it fails, workload levels are not meaningful on that setup.
- WebGazer accuracy is typically 100–200 px; recalibrate if selections drift.
- Lighting matters: light the face from the front; avoid bright light behind the player.
- Pupil responses are smaller and slower in older adults; validate per participant before adaptive use.
- The sit-to-stand is still simulated in the game prototype (6 s timer) until the movement processor is connected.

## Requests for the game

- A 3–5 s seated "Get ready" screen before each memory cue (per-trial pupil baseline; lets the pupil settle after standing)
- Build in: 3×2 layout, change-selection, `setDifficulty()` / `getDifficulty()`, a `difficulty_changed` event, level stored per attempt
- Keep screen brightness identical across levels; no bright flashes for feedback
