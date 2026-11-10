# Front-end architecture

## Single application shell

`index.html` is the only page entry point. It contains five screen sections, and `app.js` controls which one is visible:

1. Safety Check
2. Warm-up
3. Main game
4. Rest timer
5. Dashboard

The dashboard is no longer a separate HTML page. It is part of the same application, so it reads the same session state as the training flow.

## State ownership

`app.js` owns the active session and its lifecycle. The UI does not keep separate counters or calculate session results independently in each screen.

- The game records target route, selected route, correctness, search time, gaze lock and EMG confirmation.
- The movement processor reports a completed repetition through one explicit event.
- The training counter is derived from completed repetition events.
- Rest and set transitions are derived from the same set/repetition state.
- Dashboard values are calculated from completed session records.

## Repetition lifecycle

`Gaze target locked -> EMG confirmed -> Full sit-to-stand completed`

The first two events describe selection and confirmation. They do not increment training repetitions. Only `repCompleted()` advances the repetition counter. The nine-bus grid stays unchanged after confirmation while the movement cycle is in progress.

## Persistence boundary

Completed sessions are saved in browser `localStorage`. There is no remote database, participant account or cloud sync in this prototype. A future backend can replace the local persistence function without changing the UI event contract.

## Data interpretation note

The current task combines remembering a bus number with visually locating and selecting it. The UI therefore reports bus-memory accuracy as target-selection accuracy and labels it accordingly. It does not claim to isolate memory from visual search. Correct boardings are correct target selections that were followed by a completed movement repetition. These metrics can overlap in a fully completed session; a separate memory-only test would be needed to measure memory independently.
