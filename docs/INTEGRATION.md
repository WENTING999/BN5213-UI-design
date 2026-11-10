# Catch Your Bus — UI and input integration contract

Version: 1.0.0

The integrated app is a plain HTML/CSS/JavaScript front end. `window.CatchYourBus` is the single public bridge for WebGazer, EMG and movement-processing modules.

## Lifecycle

`Safety Check -> Warm-up -> Game -> Rest -> Game -> ... -> Dashboard`

Protocol constants:

- 3 sets
- 10 completed sit-to-stand repetitions per set
- 60 seconds rest between sets
- 3-second memory cue (2.7 seconds visible + 0.3-second fade)
- The final set proceeds directly to the Dashboard

The rep counter increments only when `inputs.repCompleted(...)` is called. `inputs.emgConfirmed()` alone does not increment the counter.

## Public API

```js
window.CatchYourBus.version
window.CatchYourBus.config
window.CatchYourBus.getState()
window.CatchYourBus.subscribe((event) => { /* observe app events */ })
window.CatchYourBus.configure({
  autoCompleteMovement: false,
  mouseInputEnabled: false
})
```

### Warm-up

```js
CatchYourBus.inputs.warmupGazeLocked();
CatchYourBus.inputs.warmupFootPressConfirmed();
```

Call the second method only after the foot-press confirmation event. These are separate integration points.

### Main game

```js
// WebGazer calls this when the gaze dwell/lock algorithm selects a route.
CatchYourBus.inputs.gazeTarget('33');

// EMG module calls this when the defined confirmation signal is detected.
CatchYourBus.inputs.emgConfirmed();

// Movement processor calls this only after the full stand-and-sit repetition
// has been detected and validated.
CatchYourBus.inputs.repCompleted({
  completedAt: new Date().toISOString(),
  standControl: { value: 0.92, unit: 'score' },
  leftLeg: { value: 0.44, unit: 'mV RMS' },
  rightLeg: { value: 0.46, unit: 'mV RMS' },
  bilateralBalance: { display: '4.4% difference' },
  source: 'movement-processor'
});
```

The numeric values above are schema examples only. They are not reference ranges, validated clinical measures or recommended thresholds. The processing team must define the actual calculations, units, quality checks and clinical interpretation before sending them to the UI.

### Optional live movement update

```js
CatchYourBus.inputs.movementMetricsUpdated({
  standControl: { value: 0.92, unit: 'score' }
});
```

This updates the active repetition's pending movement payload. The UI still waits for `repCompleted()` to count that repetition.

## Events

Subscribers receive `{ type, detail, state, timestamp }`.

Events currently emitted include:

- `app_ready`
- `screen_changed`
- `session_started`
- `warmup_gaze_locked`
- `warmup_foot_press_confirmed`
- `trial_memory_shown`
- `trial_search_started`
- `gaze_target_locked`
- `emg_confirmed`
- `movement_metrics_updated`
- `rep_completed`
- `rest_started`
- `rest_completed`
- `set_started`
- `session_completed`
- `session_data_exported`

## Demo vs. hardware mode

The default prototype has two mouse-based UI actions in the main game and an automatic six-second demo movement completion. The automatic completion must be disabled when connecting the actual movement processor:

```js
CatchYourBus.configure({ autoCompleteMovement: false });
```

To disable mouse input once real gaze and EMG feeds are connected:

```js
CatchYourBus.configure({ mouseInputEnabled: false });
```

Do not enable both demo completion and real movement completion in the same session, or repetitions may be double-counted. `repCompleted()` is guarded against duplicate completion for the current attempt.

## Data model

A completed session stores:

- session ID, start/end timestamps and protocol
- safety check acknowledgements
- separate warm-up gaze and foot-press timestamps
- one attempt record per bus-selection trial
- target route, selected route, correctness and visual search time
- gaze-lock and EMG-confirmation timestamps
- sit-to-stand completion timestamp
- optional processor-supplied movement metrics

Completed session history is stored locally under `catch-your-bus:completed-sessions:v1`. This is browser-local demo persistence, not a secure clinical database.
