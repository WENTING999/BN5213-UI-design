# Catch Your Bus — eye tracking, pupil workload and EMG integration

Adds gaze selection (WebGazer), pupil-based workload (PupilSense), adaptive difficulty and EMG confirmation
to the Catch Your Bus prototype **without changing the game's own files**.

| File | What it does |
|---|---|
| `pupil_server.py` | Runs the PupilSense pupil model, serves the game with the overlay, patches `app.js` in memory, serves the EMG team's code, builds the Excel file |
| `pupilsense-adapter.js` | Overlay injected into the game: calibration, gaze dwell, live workload, adaptive levels, EMG confirmation, end page |
| `xlsx_report.py` | End-of-session Excel summary |
| `pupil_workload.html` | Researcher monitor at `/monitor`: live camera, workload, pupil chart and EMG of the running game |

> Research prototype. Webcam eye tracking and webcam pupil size are approximate; not for clinical use.

```
Browser: localhost:8000/game/                         pupil_server.py
  Catch Your Bus (unchanged) + pupilsense-adapter.js
  WebGazer (gaze, in the browser)
  webcam frames ─────── WebSocket /ws ────────────►  PupilSense: face → eye crops → ResNet18 → pupil mm
  Arduino EMG ── Web Serial (EMG team's code, /emg/lib) ── activation confirms the selected bus
```

## Setup (once)

Windows, Anaconda, Git + Git LFS, Chrome or Edge; NVIDIA GPU recommended.

```bat
git lfs install
git clone https://huggingface.co/spaces/vijulshah/pupilsense
cd pupilsense
git clone https://github.com/WENTING999/BN5213-UI-design
git clone https://github.com/WENTING999/BN5213-final-EMG

conda create -n pupil python=3.10 -y
conda activate pupil
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126
pip install "mediapipe==0.10.21" "numpy<2" transformers opencv-python pillow fastapi "uvicorn[standard]" openpyxl
```

Copy the four files of this folder into `pupilsense` (next to its `app.py`): the server imports the PupilSense
code and weights from there. `pre_trained_models\ResNet18\left_eye.pt` must be ~47 MB (else `git lfs pull`).
The PupilSense model is not included here (CC BY-NC 4.0).

## Run

```bat
conda activate pupil
cd C:\Users\<you>\pupilsense
python pupil_server.py --game-dir BN5213-UI-design
```

The startup text should list `Overlay script: latest`, `Monitor page: latest` and the `EMG code` folder.

- Game: **http://localhost:8000/game/** (Chrome/Edge, `localhost`, allow the camera)
- Researcher monitor (optional, second window): **http://localhost:8000/monitor**

Options: `--sets 2 --games 5` (default protocol), `--model ResNet50`, `--port 8000`, `--emg-dir <folder>`.
Add `?fast=1` to the game URL for short timers when testing. Stop the server with `Ctrl + C`.

## Session flow

1. **Safety check** → Start Session
2. **Calibration**
   1. Camera: participant ID, face in the box, lighting check, optional *Lock brightness*
   2. Eye tracking: click each red dot 5× while looking at it, then look at 5 orange check dots (rated Good / OK / Poor)
   3. Pupil baseline: 10 s on the Remember screen + 10 s on the Find screen, looking at a cross
   4. Muscle sensor: *Connect Arduino* → 5 s relaxed baseline → activate to pass the red threshold line → continue
      (*Skip* = confirm with a mouse click)
3. **Practice**: look at the bus 2 s, then activate the muscle for 0.5 s
4. **Game** (2 sets × 5 games): remember the bus(es) → look at the matching bus 2 s → activate the muscle to confirm.
   Looking at another bus for 2 s changes the selection.
5. **End page**: score, highest level, pupil dilation in every game (shaded by level), table by level.
   The Excel summary downloads automatically and is saved in `pupilsense\exports\`.

## Difficulty levels (2×2 grid, same screen brightness on every level)

| Level | Remember | Shown | Blank | Decoys |
|---|---|---|---|---|
| 1 Look-alikes (start) | 1 number | 2.5 s | 1.0 s | half look-alike numbers |
| 2 Look-alikes, fast | 1 number | 1.8 s | 2.5 s | all look-alike numbers |
| 3 Number + destination | 1 bus | 2.2 s | 2.5 s | same number / other destination, same destination / other number |
| 4 Two buses | 2 buses | 4.5 s | 2.0 s | frames of 2 buses, one thing wrong |
| 5 Two buses, fast | 2 buses | 3.2 s | 3.5 s | frames of 2 buses, one thing wrong |
| 6 Three buses | 3 buses | 6.0 s | 2.5 s | frames of 3 buses, one thing wrong |

"One thing wrong": a wrong destination, two destinations swapped, or a look-alike number. The player makes one
selection: the frame showing exactly the remembered buses.

**Adaptive rule** (after each answer, using the workload on the Find screen):
wrong → down 1 · correct + HIGH → down 1 · correct + LOW → up 1 · correct + MEDIUM or no reading → stay.

## Workload

- Pupil size ~20 readings/s, smoothed over 1.5 s, compared with the baseline **of the same screen**.
- Δ = pupil − baseline. **MEDIUM** if Δ ≥ max(2 × SD, 0.10 mm); **HIGH** if Δ ≥ max(3 × SD, 0.20 mm); else LOW
  (SD = baseline SD, at least 0.05 mm). Adjustable in Pupil ▾.
- **PAUSED** when the reading can't be trusted: just stood up (4 s), face lost / blinking, light changed > 15 %,
  or sitting closer / farther than at baseline (face height > 15 %).

## EMG confirmation

Uses the EMG team's browser code from `BN5213-final-EMG` unchanged (Web Serial, clock sync, envelope detector).
Threshold = relaxed mean + max(3 SD, 10 ADC), held 30 ms. An activation confirms only if it **starts after** the bus
was selected and the eyes are still on that bus; otherwise it is logged as rejected. A mouse click always works as
a backup. Arduino firmware for this branch is still being finalised.

## Researcher panel (Pupil ▾)

Export Excel · Calibrate again · Light check · show level to participant · gaze selection · brightness lock ·
gaze dot · mouse as gaze (testing) · adaptive on/off · manual level · dwell · distance check · smoothing ·
workload thresholds · EMG connect / simulation (M key) / baseline / confirm on-off.

## Excel summary

*Summary* (session, results, by set, by level, charts) · *Pupil diameter* (baselines, per-game Remember/Find mean,
Δ, min/max, left/right, blinks, charts) · *Trials* (one row per game incl. confirmation source and EMG onset) ·
*Pupil samples* (every reading) · *EMG* (envelope 20/s and every activation) · *Levels and settings*.

## Changes made to the game at runtime

`pupil_server.py` patches `app.js` in memory (the file on disk is untouched); if `app.js` changes so a patch no
longer fits, the server prints a warning and skips that feature.

| Change | Why |
|---|---|
| 2×2 grid instead of 3×3, wide frames | webcam gaze is least accurate near corners; bigger targets |
| Change selection (`inputs.clearGazeTarget()`) | a wrongly locked bus could not be changed |
| Difficulty settings (timing, look-alikes, destinations, 2–3 buses per frame) | adaptive difficulty |
| Bus identity by position (`route@position`) | several buses can show the same number |
| 2 sets × 5 games | shorter sessions for older players |

## Known limitations

- Check the pupil signal first with *Light check* (white vs black screen): the pupil must read clearly larger on
  black, otherwise workload levels are not meaningful on that setup.
- WebGazer error is typically 100–200 px; recalibrate if selections drift. Light the face from the front.
- Pupil responses are smaller in older adults; validate per participant before relying on adaptive changes.
- The sit-to-stand is still a timer in the game; EMG does not detect standing.
