CATCH YOUR BUS — INTEGRATED FRONT-END PROTOTYPE v2

START HERE
1. Extract the ZIP file.
2. Keep index.html, styles.css, app.js and the assets folder together.
3. Open index.html in Chrome or Edge.
4. Complete all four Safety Check items.
5. In Warm-up, click the bus once to simulate gaze lock, then click it again to simulate a foot press.
6. In the main game, click a bus once to simulate gaze selection and click the same bus again to simulate EMG confirmation.
7. The demo movement adapter automatically reports a completed sit-to-stand after six seconds. The repetition counter only increases after that completion event.
8. Complete 10 repetitions in each of 3 sets. A 60-second rest is required between sets. The Continue button appears only when the timer reaches zero. After set 3, the app opens the Dashboard.

FAST TEST MODE
Open index.html?fast=1 in the browser address bar to shorten the memory display, demo movement cycle and rest break for UI testing. The regular app uses a 3-second memory cue, a 6-second demo movement cycle and 60-second rests.

APP PAGES
- Safety Check
- Warm-up interaction tutorial
- Main game (3 sets × 10 repetitions)
- Rest timer (60 seconds between sets)
- Dashboard: My Progress and Clinical Review

DATA
- The UI and dashboard share one in-memory session state.
- Completed session history is saved locally in this browser using localStorage.
- No server, database or user account is required for this front-end prototype.
- Search time is measured from the Find Your Bus screen appearing until the first gaze-lock event.
- Bus memory accuracy is the target-selection correctness in this task. The current task does not independently isolate memory from visual search, so interpret it as a combined target recall/selection outcome.
- Correct boardings count correct target selections that are followed by a completed sit-to-stand repetition.
- Stand control and left/right leg measures remain unavailable until validated sensor-derived values are provided.

IMPORTANT
Mouse clicks and the automatic movement completion are demo inputs only. They are not real eye tracking, EMG, foot-press or movement measurements. Do not use this prototype for clinical assessment.
