# PupilSense + WebGazer integration for Catch Your Bus

Adds eye tracking, pupil-based workload measurement and adaptive difficulty to the
Catch Your Bus prototype **without changing any of the game's own files**.

| File | What it is |
|---|---|
| `pupil_server.py` | Python server: runs the PupilSense pupil model on the GPU, serves the game, and patches `app.js` in memory (the file on disk is untouched) |
| `pupilsense-adapter.js` | Browser overlay injected into the game: calibration, gaze selection, workload bar, adaptive difficulty, data export |
| `xlsx_report.py` | Builds the end-of-session Excel summary (used by the server) |
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
pip install "mediapipe==0.10.21" "numpy<2" transformers opencv-python pillow fastapi "uvicorn[standard]" openpyxl
```

Copy the four files from this folder **into the `pupilsense` folder** (next to its `app.py`).
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
**Live monitor for the researcher:** while the game runs, open **http://localhost:8000/monitor** in a second window (e.g. on a second screen). It shows the game's live camera, the eye crops, the current workload level, pupil vs baseline, screen, set/game, difficulty and a 60 s pupil chart. Readings and workload are relayed from the game by the server (nothing extra is saved). The page's own standalone tests are under *Show standalone monitor*. The camera box shows the webcam directly (smooth); if that stream freezes or is black it switches to the game's relayed frames by itself, and says so.

Add `?fast=1` for short timers when testing, `?grid=3x2` for 6 buses instead of 4. Stop with `Ctrl + C`.
Re-record the pupil baseline if you change the grid.

Protocol: **2 sets × 5 games** with a 60 s rest between sets (change with `--sets 3 --games 10`).

Server options: `--model ResNet50`, `--port 8000`, `--no-blink`, `--exact` (authors' original, slower pipeline).

---

## Session flow

1. **Safety check** (game) → Start Session
2. **Calibration** (overlay)
   - Camera: face in the box, live lighting check, optional **Lock brightness**
   - Eye tracking: click each red dot 5× while looking at it (one at a time), then look at 5 orange check dots → accuracy rated Good / OK / Poor against bus-card size.
     Hands-free version: `?cal=look`
   - Pupil baseline: 10 s on the game background + 10 s on a bus-grid screen
3. **Warm-up** (game): look at the bus 2 s to lock, then tighten the EMG muscle for 0.5 s (or click)
4. **Game**: remember the bus → look at the matching bus 2 s → tighten the EMG muscle to confirm (or click). Look at another bus 2 s to change your mind.

---

## Changes applied to the game at runtime (please consider building these in properly)

| Change | Why |
|---|---|
| **2×2 grid (4 buses)** by default, `?grid=3x2` for 6 buses, instead of 3×3 | Webcam gaze is least accurate near screen corners; bigger, more widely spaced targets |
| **Change selection** (`inputs.clearGazeTarget()`) | Players could not unselect a wrongly locked bus |
| **Difficulty settings** (memory time, blank delay, look-alike numbers, destinations, two buses) | Needed for adaptive difficulty |
| **2 sets × 5 games** instead of 3 × 10 | Shorter sessions for older players |
| **Bus identity by position** (`route@position`) | Several buses can show the same number at the hardest levels |
| **Two buses per frame** (wider frames) | Two-bus levels |

If `app.js` changes so a patch no longer fits, the server prints a warning and that feature is skipped.

---

## EMG muscle confirmation (BN5213-final-EMG)

The EMG team's browser code is reused unchanged (`web/lib/*.mjs`: Web Serial reader, clock sync, 20 ms envelope
detector). `pupil_server.py` serves it at `/emg/lib/` and finds it automatically when the repo is cloned next to it:

```
cd C:\Users\rojan\pupilsense
git clone https://github.com/WENTING999/BN5213-final-EMG.git
```

(or start the server with `--emg-dir <folder>`). At startup it prints `EMG code: <folder>` or `NOT FOUND`.

1. Upload **`firmware/BN5213_EMG_filtered/BN5213_EMG_filtered.ino`** (in this zip) to the Arduino Uno with the
   Arduino IDE, sensor **RAW** output on A0. Close the IDE serial monitor afterwards (only one program can use the port).
   It samples A0 at **1000 Hz** and filters on the board, then sends 200 values/s in the EMG team's protocol:
   - band-pass **20–450 Hz** (4th-order Butterworth high-pass 20 Hz + 2nd-order low-pass 450 Hz): removes movement
     drift, electrode offset and high-frequency noise
   - **50 Hz notch** (Q 30) plus 100 Hz and 150 Hz harmonics: Singapore mains hum
   - full-wave rectify and average 5 samples → envelope (ADC counts), × `BN_EMG_GAIN` (default 1)
   In a bench test with a 40-count 50 Hz hum on the input, the resting envelope was 1.5 ADC with the notch
   vs 26 ADC without (the hum alone would have looked like a muscle activation).
   If a strong contraction does not pass the red threshold line in calibration, set `#define BN_EMG_GAIN 2.0f`
   (or 4.0f) at the top of the sketch and upload again. The calibration screen and Excel show the filter the board
   reports ("No filter reported" = the original unfiltered firmware is still on the board).
   Do not use the original `BN5213_EMG.ino` with a raw EMG output: it samples only 200 Hz with no filtering.
   **Checking the electrodes in the Arduino IDE Serial Plotter:** set `#define BN_EMG_PLOTTER 1`, upload, open
   Tools → Serial Plotter at **115200 baud**. You see `raw_minus_offset` (with hum), `filtered` (20–450 Hz, no hum)
   and `envelope`. Set it back to `0` and upload again before playing, and close the plotter (it blocks the port).
2. Calibration step **4 Muscle sensor**: *Connect Arduino* (Chrome/Edge asks for the port) → 5 s relaxed baseline →
   *Check the threshold*: activate the muscle, the bar must pass the red line (orange), relax (green).
   *Threshold OK — continue* or *Record baseline again*. *Skip* = confirm with a mouse click.
   (Pupil ▾ → EMG → *Simulation* is a researcher-only test without hardware; hold M to activate.)
3. Threshold = relaxed mean + max(3 SD, 10 ADC); onset must stay above it 30 ms; 300 ms refractory.
4. A confirmation counts only if the activation **starts after** the bus was selected and the eyes are still on that
   bus (otherwise it is logged as rejected). Practice round: hold 0.5 s. Mouse click always works as a backup.
5. Pupil ▾ → *EMG muscle sensor*: connect / simulation / redo baseline / disconnect, live envelope bar,
   *Confirm with EMG* on/off. The top bar shows `EMG ready` / `EMG ACTIVE`; the monitor page shows EMG live.
6. Excel: Trials get *Confirmed by* (EMG / mouse) and *EMG onset after selection (s)*; sheet **EMG** has the envelope
   at 20 readings/s plus every activation / confirm / rejection; Summary lists the EMG source, baseline and threshold.

Values are ADC counts of the filtered, rectified envelope (not microvolts or force). Timing uses the EMG team's estimated serial
clock mapping; monitor, webcam and analogue delays are not physically calibrated.

## Workload measurement

- PupilSense reads pupil size ~20×/s from the webcam.
- Live level: smoothed pupil (1.5 s) compared with the baseline **for the same screen**
  (the Remember and Find screens differ in brightness).
  Δ = smoothed pupil − baseline for that screen. **MEDIUM** when Δ ≥ max(2 × SD, 0.10 mm); **HIGH** when Δ ≥ max(3 × SD, 0.20 mm);
  otherwise LOW. SD = baseline SD (never below 0.05 mm); the mm minimums stop a very steady baseline from making the thresholds tiny. All five numbers can be changed in Pupil ▾
  (the panel shows the resulting thresholds in mm) and are saved in the Excel *Levels and settings* sheet.
- Shows **PAUSED** when the reading can't be trusted:
  just stood up (EMG confirm → 4 s after the stand-up), face lost / blinking,
  light changed > 15 %, or sitting closer/farther than at baseline (face height > 15 %).

## Adaptive difficulty (after each confirmed answer, using the Find-phase workload)

| Result | Change |
|---|---|
| Wrong answer | down 1 level |
| Correct + HIGH | down 1 level |
| Correct + LOW | up 1 level (after 1 game; change in Pupil ▾ → Raise after) |
| Correct + MEDIUM | stay |
| Correct, no reliable reading | stay |

| Level | Buses to remember | Shown for | Blank delay | Other buses | Destination |
|---|---|---|---|---|---|
| 1 Look-alikes (start) | 1 | 2.5 s | 1.0 s | half look-alikes | – |
| 2 Look-alikes, fast | 1 | 1.8 s | 2.5 s | all look-alikes | – |
| 3 Number + destination | 1 | 2.2 s | 2.5 s | all look-alikes | yes (same-number and same-destination decoys) |
| 4 Two buses | **2** | 4.5 s | 2.0 s | pair frames, one bus wrong in each decoy | yes |
| 5 Two buses, fast | **2** | 3.2 s | 3.5 s | pair frames, one bus wrong in each decoy | yes |
| 6 Three buses | **3** | 6.0 s | 2.5 s | three buses per frame, one bus wrong in each decoy | yes |

**Two- and three-bus levels (4–6):** the player remembers two buses (three at level 6), each with number + destination. The Find screen shows wide frames,
each holding **two buses**; the player selects the **one frame** showing exactly that pair (single look + confirm).
Decoy frames get one bus wrong: wrong destination, swapped destinations, or a look-alike number.

Every level uses the same grid screen, so screen brightness does not change with difficulty.

---

## Researcher panel (Pupil ▾ at the top)

Calibrate again · Light check · Export CSV · show/hide level to participant · gaze selection on/off ·
gaze dot · mouse-as-gaze (testing) · dwell time · lock brightness · distance check % · smoothing ·
readings/s · adaptive on/off · raise-after count · manual level

**Excel summary** — downloaded automatically when the session ends (and saved in `pupilsense\exports\`),
or any time with *Export Excel*. Enter the participant ID on the first calibration screen.
Sheets: *Summary* (session info, accuracy, search time, levels reached, workload counts, by-set and by-level tables, two charts),
*Pupil diameter* (baselines ± SD; per game: Remember and Find mean, Δ vs baseline, % change, min/max, left/right eye, valid readings, blinks; chart per game and chart of every reading), *Trials* (one row per game), *Pupil samples* (every reading), *Levels and settings*.

**Export CSV** saves three raw files:
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
- Build in: 2×2 (or 3×2) layout, change-selection, `setDifficulty()` / `getDifficulty()`, a `difficulty_changed` event, level stored per attempt
- Keep screen brightness identical across levels; no bright flashes for feedback
