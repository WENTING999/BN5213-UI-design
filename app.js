/* Catch Your Bus — integrated front-end prototype
 * One session store drives Safety -> Warm-up -> Game -> Rest -> Dashboard.
 * Mouse inputs are a demo adapter. Hardware integrations call window.CatchYourBus.inputs.
 */
(() => {
  'use strict';

  const APP_VERSION = '1.0.0';
  const TOTAL_SETS = 3;
  const REPS_PER_SET = 10;
  const REST_SECONDS = 60;
  const FAST_MODE = new URLSearchParams(location.search).get('fast') === '1';
  const TIMING = {
    memoryVisibleMs: FAST_MODE ? 700 : 2700,
    memoryFadeMs: 300,
    feedbackMs: FAST_MODE ? 450 : 1400,
    demoMovementMs: FAST_MODE ? 850 : 6000,
    nextTrialMs: FAST_MODE ? 180 : 550,
    restSeconds: FAST_MODE ? 5 : REST_SECONDS
  };
  const STORAGE_KEY = 'catch-your-bus:completed-sessions:v1';
  const REAL_ROUTES = ['10', '14', '33', '38', '45', '52', '58', '67', '72', '74', '88', '97', '100', '105', '147', '154', '157', '166', '171', '174', '190', '196', '197', '198', '200', '241', '243', '262', '265', '858'];
  const GAME_DISTRACTORS = ['00', '01', '02', '03', '04', '05', '06', '08', '09', '11', '13', '18', '28', '39', '68'];

  const $ = (id) => document.getElementById(id);
  const screens = {
    safety: $('safetyScreen'), warmup: $('warmupScreen'), game: $('gameScreen'),
    rest: $('restScreen'), dashboard: $('dashboardScreen')
  };
  const timers = { phase: null, feedback: null, movement: null, rest: null, next: null };
  let restRemaining = 0;
  let autoCompleteMovement = true;
  let mouseInputEnabled = true;
  let currentAttempt = null;
  let findShownAt = 0;
  let currentCards = [];
  let currentTarget = null;
  let currentSelectedRoute = null;
  let eventListeners = new Set();
  let activeDashboardView = 'patient';

  function makeId() {
    return 'cyb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function nowIso() { return new Date().toISOString(); }
  function freshSession() {
    return {
      id: makeId(),
      schemaVersion: 1,
      status: 'in_progress',
      startedAt: nowIso(),
      completedAt: null,
      protocol: { sets: TOTAL_SETS, repsPerSet: REPS_PER_SET, restSeconds: REST_SECONDS },
      safetyChecks: [],
      warmup: { gazeLockedAt: null, footPressConfirmedAt: null },
      attempts: [],
      completedReps: 0,
      movementMetrics: []
    };
  }
  let state = {
    phase: 'safety',
    session: null,
    currentSet: 1,
    completedRepsInSet: 0,
    warmupStep: 0,
    dashboardView: 'patient'
  };
  let completedSessions = loadHistory();

  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const value = raw ? JSON.parse(raw) : [];
      return Array.isArray(value) ? value : [];
    } catch (error) {
      console.warn('Could not read saved Catch Your Bus sessions.', error);
      return [];
    }
  }
  function persistHistory() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(completedSessions.slice(-50))); }
    catch (error) { console.warn('Could not save session history.', error); }
  }
  function publicState() {
    return JSON.parse(JSON.stringify({
      appVersion: APP_VERSION,
      phase: state.phase,
      currentSet: state.currentSet,
      repsPerSet: REPS_PER_SET,
      totalSets: TOTAL_SETS,
      completedRepsInSet: state.completedRepsInSet,
      session: state.session,
      completedSessions
    }));
  }
  function publish(type, detail = {}) {
    const message = { type, detail: JSON.parse(JSON.stringify(detail)), state: publicState(), timestamp: nowIso() };
    eventListeners.forEach((listener) => {
      try { listener(message); } catch (error) { console.error('CatchYourBus subscriber error:', error); }
    });
  }
  function clearTimer(name) {
    if (timers[name] != null) {
      if (name === 'rest') clearInterval(timers[name]); else clearTimeout(timers[name]);
      timers[name] = null;
    }
  }
  function clearAllTimers() { Object.keys(timers).forEach(clearTimer); }

  function showScreen(name, headerLabel) {
    Object.entries(screens).forEach(([key, element]) => element.classList.toggle('hidden', key !== name));
    $('appHeader').hidden = name === 'dashboard';
    state.phase = name;
    $('headerStep').textContent = headerLabel || name.toUpperCase();
    publish('screen_changed', { screen: name });
  }

  // ---------- Safety check ----------
  function updateSafetyState() {
    const checks = [...document.querySelectorAll('input[name="safety"]')];
    const checked = checks.filter((item) => item.checked).map((item) => item.value);
    const complete = checked.length === checks.length;
    $('startSessionButton').disabled = !complete;
    $('safetyHint').textContent = complete ? 'All checks complete. You are ready to begin.' : 'Complete all four checks to continue.';
    return checked;
  }
  document.querySelectorAll('input[name="safety"]').forEach((input) => input.addEventListener('change', updateSafetyState));
  $('startSessionButton').addEventListener('click', () => {
    const checked = updateSafetyState();
    if (checked.length !== 4) return;
    state.session = freshSession();
    state.session.safetyChecks = checked;
    state.currentSet = 1;
    state.completedRepsInSet = 0;
    state.warmupStep = 0;
    $('warmupBus').classList.remove('gaze-locked', 'foot-confirmed');
    $('warmupBus').disabled = false;
    $('warmupStatus').classList.remove('active');
    $('warmupStatus').lastElementChild.textContent = 'Waiting for gaze selection';
    $('warmupNote').textContent = 'Select the bus once to lock your gaze target.';
    showScreen('warmup', 'WARM-UP');
    publish('session_started', { sessionId: state.session.id, safetyChecks: checked });
  });

  // ---------- Warm-up bridge ----------
  function warmupGazeLocked(source = 'external') {
    if (state.phase !== 'warmup' || state.warmupStep !== 0) return false;
    state.warmupStep = 1;
    $('warmupBus').classList.add('gaze-locked');
    $('warmupStatus').classList.add('active');
    $('warmupStatus').lastElementChild.textContent = 'Gaze target locked';
    $('warmupNote').textContent = 'Now confirm the selection with a foot press.';
    if (state.session) state.session.warmup.gazeLockedAt = nowIso();
    publish('warmup_gaze_locked', { source });
    return true;
  }
  function warmupFootPressConfirmed(source = 'external') {
    if (state.phase !== 'warmup' || state.warmupStep !== 1) return false;
    state.warmupStep = 2;
    $('warmupBus').classList.add('foot-confirmed');
    $('warmupStatus').lastElementChild.textContent = 'Selection confirmed';
    $('warmupNote').textContent = 'Practice complete. Starting the game.';
    if (state.session) state.session.warmup.footPressConfirmedAt = nowIso();
    publish('warmup_foot_press_confirmed', { source });
    timers.next = setTimeout(startGame, FAST_MODE ? 350 : 900);
    return true;
  }
  $('warmupBus').addEventListener('click', () => {
    if (!mouseInputEnabled) return;
    if (state.warmupStep === 0) warmupGazeLocked('mouse');
    else if (state.warmupStep === 1) warmupFootPressConfirmed('mouse');
  });

  // ---------- Main game ----------
  function sample(items, count) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, count);
  }
  function makeRound() {
    const real = sample(REAL_ROUTES, 7);
    currentTarget = real[Math.floor(Math.random() * real.length)];
    const distractors = sample(GAME_DISTRACTORS, 2);
    currentCards = sample([...real, ...distractors], 9);
  }
  function updateTrainingCounter() {
    $('setLabel').textContent = `SET ${state.currentSet} / ${TOTAL_SETS}`;
    $('repLabel').textContent = `${state.completedRepsInSet} / ${REPS_PER_SET}`;
    $('progressFill').style.width = `${(state.completedRepsInSet / REPS_PER_SET) * 100}%`;
  }
  function renderBusGrid() {
    const grid = $('busGrid');
    grid.replaceChildren();
    currentCards.forEach((route) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bus-card';
      button.dataset.route = route;
      button.setAttribute('aria-label', `Bus route ${route}`);
      const art = document.createElement('span');
      art.className = 'bus-art';
      const img = document.createElement('img');
      img.src = 'assets/citaro-front-master.png';
      img.alt = '';
      img.draggable = false;
      const display = document.createElement('span');
      display.className = 'route-display';
      const number = document.createElement('span');
      number.className = 'route-number';
      number.textContent = route;
      display.appendChild(number);
      const check = document.createElement('span');
      check.className = 'checkmark';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      art.append(img, display);
      button.append(art, check);
      button.addEventListener('click', () => {
        if (!mouseInputEnabled) return;
        if (!currentSelectedRoute) gazeTarget(route, 'mouse');
        else if (currentSelectedRoute === route) emgConfirmed({ source: 'mouse' });
      });
      grid.appendChild(button);
    });
  }
  function beginTrial() {
    if (!state.session || state.session.status !== 'in_progress') return;
    clearTimer('phase'); clearTimer('feedback'); clearTimer('movement');
    currentAttempt = {
      id: makeId(),
      setNumber: state.currentSet,
      repNumber: state.completedRepsInSet + 1,
      targetRoute: null,
      selectedRoute: null,
      isCorrect: null,
      searchTimeMs: null,
      memoryShownAt: null,
      findShownAt: null,
      gazeLockedAt: null,
      emgConfirmedAt: null,
      repCompletedAt: null,
      movement: null,
      inputSource: 'mouse-demo'
    };
    currentSelectedRoute = null;
    makeRound();
    currentAttempt.targetRoute = currentTarget;
    currentAttempt.memoryShownAt = nowIso();
    $('gameTitle').textContent = 'Remember Your Bus!';
    $('memoryPanel').classList.remove('hidden');
    $('findPanel').classList.add('hidden');
    $('memoryNumber').textContent = currentTarget;
    $('memoryNumber').classList.remove('fade-out');
    updateTrainingCounter();
    showScreen('game', `SET ${state.currentSet} OF ${TOTAL_SETS}`);
    publish('trial_memory_shown', { attemptId: currentAttempt.id, set: state.currentSet, rep: currentAttempt.repNumber, targetRoute: currentTarget });
    timers.phase = setTimeout(() => {
      $('memoryNumber').classList.add('fade-out');
      timers.phase = setTimeout(() => {
        $('memoryPanel').classList.add('hidden');
        $('findPanel').classList.remove('hidden');
        $('gameTitle').textContent = 'Find Your Bus!';
        renderBusGrid();
        findShownAt = Date.now();
        currentAttempt.findShownAt = nowIso();
        publish('trial_search_started', { attemptId: currentAttempt.id, routes: currentCards });
      }, TIMING.memoryFadeMs);
    }, TIMING.memoryVisibleMs);
  }
  function startGame() {
    state.currentSet = 1;
    state.completedRepsInSet = 0;
    updateTrainingCounter();
    beginTrial();
  }
  function gazeTarget(routeNumber, source = 'external') {
    if (state.phase !== 'game' || !currentAttempt || currentAttempt.emgConfirmedAt || !currentAttempt.findShownAt) return false;
    const route = String(routeNumber);
    if (!currentCards.includes(route)) return false;
    if (currentSelectedRoute) return currentSelectedRoute === route;
    currentSelectedRoute = route;
    currentAttempt.selectedRoute = route;
    currentAttempt.searchTimeMs = Math.max(0, Date.now() - findShownAt);
    currentAttempt.gazeLockedAt = nowIso();
    currentAttempt.inputSource = source;
    const card = [...$('busGrid').querySelectorAll('.bus-card')].find((element) => element.dataset.route === route);
    if (card) card.classList.add('gaze-locked');
    publish('gaze_target_locked', { attemptId: currentAttempt.id, route, searchTimeMs: currentAttempt.searchTimeMs, source });
    return true;
  }
  function emgConfirmed(payload = {}) {
    if (state.phase !== 'game' || !currentAttempt || !currentSelectedRoute || currentAttempt.emgConfirmedAt) return false;
    currentAttempt.emgConfirmedAt = nowIso();
    currentAttempt.isCorrect = currentSelectedRoute === currentTarget;
    if (payload && payload.source) currentAttempt.inputSource = payload.source;
    const selectedCard = [...$('busGrid').querySelectorAll('.bus-card')].find((element) => element.dataset.route === currentSelectedRoute);
    if (selectedCard) selectedCard.classList.add('emg-confirmed');
    $('busGrid').querySelectorAll('.bus-card').forEach((card) => { card.disabled = true; });
    state.session.attempts.push(currentAttempt);
    showFeedback(currentAttempt.isCorrect ? 'Correct!' : 'Not quite!', !currentAttempt.isCorrect);
    publish('emg_confirmed', {
      attemptId: currentAttempt.id, targetRoute: currentTarget,
      selectedRoute: currentSelectedRoute, isCorrect: currentAttempt.isCorrect, source: payload.source || 'external'
    });
    if (autoCompleteMovement) {
      timers.movement = setTimeout(() => repCompleted({ source: 'demo-simulator' }), TIMING.demoMovementMs);
    }
    return true;
  }
  function showFeedback(message, incorrect = false) {
    clearTimer('feedback');
    const toast = $('feedbackToast');
    toast.textContent = message;
    toast.classList.toggle('incorrect', incorrect);
    toast.classList.add('show');
    timers.feedback = setTimeout(() => toast.classList.remove('show'), TIMING.feedbackMs);
  }
  function normaliseMovementPayload(payload) {
    // Preserve algorithm-supplied measurements; this UI does not derive clinical scores.
    if (!payload || typeof payload !== 'object') return null;
    const movement = {};
    ['standControl', 'leftLeg', 'rightLeg', 'bilateralBalance', 'qualityFlag', 'source'].forEach((key) => {
      if (payload[key] !== undefined) movement[key] = payload[key];
    });
    return Object.keys(movement).length ? movement : null;
  }
  function repCompleted(payload = {}) {
    if (state.phase !== 'game' || !currentAttempt || !currentAttempt.emgConfirmedAt || currentAttempt.repCompletedAt) return false;
    clearTimer('movement');
    clearTimer('feedback');
    $('feedbackToast').classList.remove('show');
    currentAttempt.repCompletedAt = payload.completedAt || nowIso();
    const finalMovementPayload = normaliseMovementPayload(payload);
    if (finalMovementPayload) currentAttempt.movement = finalMovementPayload;
    if (currentAttempt.movement) state.session.movementMetrics.push({ attemptId: currentAttempt.id, recordedAt: currentAttempt.repCompletedAt, ...currentAttempt.movement });
    state.session.completedReps += 1;
    state.completedRepsInSet += 1;
    publish('rep_completed', { attemptId: currentAttempt.id, set: state.currentSet, rep: currentAttempt.repNumber, completedReps: state.session.completedReps, movement: currentAttempt.movement });
    currentAttempt = null;
    currentSelectedRoute = null;
    updateTrainingCounter();
    if (state.completedRepsInSet >= REPS_PER_SET) {
      if (state.currentSet < TOTAL_SETS) startRest();
      else completeSession();
    } else {
      timers.next = setTimeout(beginTrial, TIMING.nextTrialMs);
    }
    return true;
  }

  // ---------- Rest timer ----------
  function startRest() {
    restRemaining = TIMING.restSeconds;
    $('completedSetLabel').textContent = String(state.currentSet);
    $('restCountdown').textContent = formatClock(restRemaining);
    $('continueSetButton').classList.add('hidden');
    $('restReadyNote').textContent = 'The Continue button will appear when your break is over.';
    showScreen('rest', 'REST BREAK');
    clearTimer('rest');
    timers.rest = setInterval(() => {
      restRemaining = Math.max(0, restRemaining - 1);
      $('restCountdown').textContent = formatClock(restRemaining);
      if (restRemaining === 0) {
        clearTimer('rest');
        $('restReadyNote').textContent = 'Your break is complete. Continue when you are ready.';
        $('continueSetButton').classList.remove('hidden');
        publish('rest_completed', { completedSet: state.currentSet });
      }
    }, 1000);
    publish('rest_started', { completedSet: state.currentSet, durationSeconds: TIMING.restSeconds });
  }
  function formatClock(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const secs = (totalSeconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  }
  $('continueSetButton').addEventListener('click', () => {
    if (restRemaining > 0) return;
    state.currentSet += 1;
    state.completedRepsInSet = 0;
    updateTrainingCounter();
    publish('set_started', { set: state.currentSet });
    beginTrial();
  });

  // ---------- Session completion and dashboard ----------
  function completeSession() {
    clearAllTimers();
    if (!state.session) return;
    state.session.status = 'completed';
    state.session.completedAt = nowIso();
    state.session.completedReps = state.session.attempts.filter((attempt) => Boolean(attempt.repCompletedAt)).length;
    completedSessions.push(JSON.parse(JSON.stringify(state.session)));
    completedSessions = completedSessions.slice(-50);
    persistHistory();
    publish('session_completed', { sessionId: state.session.id, completedReps: state.session.completedReps, totalSets: TOTAL_SETS });
    activeDashboardView = 'patient';
    setDashboardView('patient');
    renderDashboard();
    showScreen('dashboard', 'SESSION COMPLETE');
  }
  function allSessions() {
    return [...completedSessions].sort((a,b) => new Date(a.completedAt) - new Date(b.completedAt));
  }
  function statsForSession(session) {
    const attempts = (session && Array.isArray(session.attempts)) ? session.attempts : [];
    const completed = attempts.filter((attempt) => Boolean(attempt.repCompletedAt));
    const correct = attempts.filter((attempt) => attempt.isCorrect === true);
    const correctBoardings = completed.filter((attempt) => attempt.isCorrect === true);
    const searches = attempts.map((attempt) => Number(attempt.searchTimeMs)).filter((value) => Number.isFinite(value) && value >= 0);
    const averageSearchMs = searches.length ? searches.reduce((sum, value) => sum + value, 0) / searches.length : null;
    return {
      totalAttempts: attempts.length,
      completedReps: completed.length,
      correctSelections: correct.length,
      memoryAccuracy: attempts.length ? correct.length / attempts.length : null,
      correctBoardings: correctBoardings.length,
      boardingRate: completed.length ? correctBoardings.length / completed.length : null,
      averageSearchSeconds: averageSearchMs == null ? null : averageSearchMs / 1000
    };
  }
  function latestSession() {
    return allSessions().slice(-1)[0] || null;
  }
  function latestMovement() {
    const sessions = allSessions().slice().reverse();
    for (const session of sessions) {
      const attempts = (session.attempts || []).slice().reverse();
      for (const attempt of attempts) if (attempt.movement) return attempt.movement;
    }
    return null;
  }
  function percent(value) { return value == null ? '—' : `${Math.round(value * 100)}%`; }
  function oneDecimal(value) { return value == null ? '—' : `${value.toFixed(1)} sec`; }
  function dateLabel(dateValue) {
    if (!dateValue) return '—';
    const date = new Date(dateValue);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-SG', { day:'2-digit', month:'short', year:'numeric' });
  }
  function movementValue(value) {
    if (value == null) return null;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object') {
      if (value.display != null) return String(value.display);
      if (value.value != null) return `${value.value}${value.unit ? ` ${value.unit}` : ''}`;
      if (value.label != null) return String(value.label);
    }
    return null;
  }
  function renderMovement(containerId, data) {
    const container = $(containerId);
    const stand = data ? movementValue(data.standControl) : null;
    const left = data ? movementValue(data.leftLeg) : null;
    const right = data ? movementValue(data.rightLeg) : null;
    const balance = data ? movementValue(data.bilateralBalance) : null;
    const standText = stand || 'Awaiting movement data integration';
    let balanceText = 'Awaiting bilateral sensor data integration';
    if (left || right) balanceText = `Left: ${left || '—'} · Right: ${right || '—'}`;
    if (balance) balanceText = balance;
    container.innerHTML = `
      <div class="movement-measure"><span class="movement-measure-title">Stand control</span><span class="${stand ? 'ready-state' : 'pending-state'}">${escapeHtml(standText)}</span></div>
      <div class="movement-measure"><span class="movement-measure-title">Left / right leg balance</span><span class="${(left || right || balance) ? 'ready-state' : 'pending-state'}">${escapeHtml(balanceText)}</span></div>`;
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }
  function getSessionsInPeriod(weeks) {
    const cutoff = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000;
    return allSessions().filter((session) => new Date(session.completedAt).getTime() >= cutoff);
  }
  function renderPatientActivity(weeks) {
    const sessions = allSessions();
    if (!sessions.length) {
      $('patientActivityChart').innerHTML = '<div class="empty-chart">Your completed sessions will appear here.</div>';
      return;
    }
    const labels = Array.from({ length: weeks }, (_, index) => `Week ${index + 1}`);
    const counts = Array(weeks).fill(0);
    const recent = getSessionsInPeriod(weeks);
    const now = Date.now();
    recent.forEach((session) => {
      const ageWeeks = Math.floor((now - new Date(session.completedAt).getTime()) / (7 * 24 * 60 * 60 * 1000));
      const index = weeks - 1 - Math.min(weeks - 1, Math.max(0, ageWeeks));
      counts[index] += 1;
    });
    const maxCount = Math.max(1, ...counts);
    const bars = counts.map((count, index) => `
      <div class="activity-bar-group"><div class="activity-bar" style="height:${Math.max(3, (count / maxCount) * 145)}px"><span class="activity-bar-value">${count || ''}</span></div><span class="activity-bar-label">${labels[index]}</span></div>`).join('');
    $('patientActivityChart').innerHTML = `<div class="chart-bars">${bars}</div>`;
  }
  function renderLatestSession(session) {
    const stats = session ? statsForSession(session) : null;
    $('latestSessionDate').textContent = session ? dateLabel(session.completedAt) : 'No completed session';
    $('latestSessionState').textContent = session ? 'COMPLETED' : 'NOT STARTED';
    $('latestSummary').innerHTML = session
      ? `<strong>${stats.correctBoardings}/${stats.completedReps}</strong><span>correct boardings</span>`
      : '<strong>—</strong><span>Complete a session to see your results.</span>';
    $('latestDetails').innerHTML = session ? `
      <div class="latest-detail"><span>Bus memory</span><strong>${stats.correctSelections} / ${stats.totalAttempts}</strong></div>
      <div class="latest-detail"><span>Average search time</span><strong>${oneDecimal(stats.averageSearchSeconds)}</strong></div>
      <div class="latest-detail"><span>Completed repetitions</span><strong>${stats.completedReps} / ${TOTAL_SETS * REPS_PER_SET}</strong></div>` : '';
  }
  function renderPatientView() {
    const session = latestSession();
    const stats = session ? statsForSession(session) : null;
    $('patientMemory').textContent = stats ? `${stats.correctSelections}/${stats.totalAttempts}` : '—';
    $('patientMemoryNote').textContent = stats ? `${percent(stats.memoryAccuracy)} correct target selections` : 'No completed session yet';
    $('patientSearch').textContent = stats && stats.averageSearchSeconds != null ? oneDecimal(stats.averageSearchSeconds) : '—';
    $('patientSearchNote').textContent = stats && stats.averageSearchSeconds != null ? 'Seconds to locate the target bus' : 'Time to locate the target bus';
    $('patientBoardings').textContent = stats ? `${stats.correctBoardings}/${stats.completedReps}` : '—';
    $('patientBoardingsNote').textContent = stats ? 'Correct selections followed by a completed sit-to-stand' : 'Correct selections followed by a completed sit-to-stand';
    renderPatientActivity(Number($('patientPeriod').value));
    renderLatestSession(session);
    renderMovement('patientMovementMeasures', latestMovement());
  }
  function renderClinicalBars(sessions) {
    const root = $('clinicalAccuracyChart');
    if (!sessions.length) { root.innerHTML = '<div class="empty-chart">Session results will appear here.</div>'; return; }
    const selected = sessions.slice(-6);
    const html = selected.map((session, index) => {
      const stats = statsForSession(session);
      const memory = stats.memoryAccuracy == null ? 0 : stats.memoryAccuracy * 100;
      const boardings = stats.boardingRate == null ? 0 : stats.boardingRate * 100;
      return `<div class="session-bar-group"><div class="session-bar" style="height:${Math.max(3, memory * 1.55)}px" title="Memory ${Math.round(memory)}%"></div><div class="session-bar correct" style="height:${Math.max(3, boardings * 1.55)}px" title="Correct boardings ${Math.round(boardings)}%"></div><span class="session-bar-label">S${index + 1}</span></div>`;
    }).join('');
    root.innerHTML = html;
  }
  function renderSearchTrend(sessions) {
    const root = $('clinicalSearchChart');
    const rows = sessions.slice(-6).map(statsForSession).filter((stats) => stats.averageSearchSeconds != null);
    if (!rows.length) { root.innerHTML = '<div class="empty-chart">Search-time trends will appear here.</div>'; return; }
    const values = rows.map((row) => row.averageSearchSeconds);
    const min = Math.max(0, Math.min(...values) - .5);
    const max = Math.max(min + .5, Math.max(...values) + .5);
    const points = values.map((value, index) => {
      const x = 42 + (index * (330 / Math.max(1, values.length - 1)));
      const y = 150 - ((value - min) / (max - min)) * 112;
      return { x, y, value };
    });
    const poly = points.map((point) => `${point.x},${point.y}`).join(' ');
    const dots = points.map((point, index) => `<circle class="trend-point ${index === points.length - 1 ? 'latest' : ''}" cx="${point.x}" cy="${point.y}" r="4.5"><title>${point.value.toFixed(1)} seconds</title></circle>`).join('');
    root.innerHTML = `<svg viewBox="0 0 390 185" role="img" aria-label="Average visual search time across completed sessions"><line class="grid-line" x1="34" y1="38" x2="376" y2="38"/><line class="grid-line" x1="34" y1="94" x2="376" y2="94"/><line class="grid-line" x1="34" y1="150" x2="376" y2="150"/><text x="2" y="41">${max.toFixed(1)}s</text><text x="2" y="97">${((max+min)/2).toFixed(1)}s</text><text x="2" y="153">${min.toFixed(1)}s</text><polyline class="trend-line" points="${poly}"/>${dots}</svg>`;
  }
  function renderSessionTable(sessions) {
    const body = $('sessionTableBody');
    if (!sessions.length) { body.innerHTML = '<tr><td colspan="6" class="empty-table">No completed sessions have been recorded.</td></tr>'; return; }
    body.innerHTML = sessions.slice().reverse().map((session, index) => {
      const stats = statsForSession(session);
      return `<tr><td><strong>${dateLabel(session.completedAt)}</strong></td><td>${stats.completedReps} / ${TOTAL_SETS * REPS_PER_SET}</td><td>${stats.correctSelections} / ${stats.totalAttempts}</td><td>${oneDecimal(stats.averageSearchSeconds)}</td><td>${stats.correctBoardings} / ${stats.completedReps}</td><td>Local</td></tr>`;
    }).join('');
  }
  function renderClinicalView() {
    const sessions = allSessions();
    const session = latestSession();
    const stats = session ? statsForSession(session) : null;
    $('clinicalMemory').textContent = stats ? percent(stats.memoryAccuracy) : '—';
    $('clinicalSearch').textContent = stats ? oneDecimal(stats.averageSearchSeconds) : '—';
    $('clinicalBoardings').textContent = stats ? `${stats.correctBoardings}/${stats.completedReps}` : '—';
    renderClinicalBars(sessions);
    renderSearchTrend(sessions);
    renderMovement('clinicalMovementMeasures', latestMovement());
    renderSessionTable(sessions);
  }
  function renderDashboard() {
    const session = latestSession();
    $('dashboardDate').textContent = session ? `LATEST SESSION · ${dateLabel(session.completedAt).toUpperCase()}` : 'NO COMPLETED SESSIONS';
    renderPatientView();
    renderClinicalView();
    setDashboardView(activeDashboardView);
  }
  function setDashboardView(which) {
    activeDashboardView = which === 'clinical' ? 'clinical' : 'patient';
    $('patientView').classList.toggle('active', activeDashboardView === 'patient');
    $('clinicalView').classList.toggle('active', activeDashboardView === 'clinical');
    $('patientTab').classList.toggle('active', activeDashboardView === 'patient');
    $('clinicalTab').classList.toggle('active', activeDashboardView === 'clinical');
    $('patientTab').setAttribute('aria-pressed', String(activeDashboardView === 'patient'));
    $('clinicalTab').setAttribute('aria-pressed', String(activeDashboardView === 'clinical'));
    state.dashboardView = activeDashboardView;
  }
  $('patientTab').addEventListener('click', () => setDashboardView('patient'));
  $('clinicalTab').addEventListener('click', () => setDashboardView('clinical'));
  $('patientPeriod').addEventListener('change', () => renderPatientActivity(Number($('patientPeriod').value)));
  $('printPatient').addEventListener('click', () => window.print());
  $('exportReport').addEventListener('click', exportSessionCsv);
  function exportSessionCsv() {
    const rows = [['Session ID','Session date','Set','Rep','Target route','Selected route','Correct selection','Search time (ms)','Rep completed','Stand control','Left leg','Right leg','Bilateral balance']];
    allSessions().forEach((session) => (session.attempts || []).forEach((attempt) => {
      const movement = attempt.movement || {};
      rows.push([
        session.id, session.completedAt || '', attempt.setNumber, attempt.repNumber,
        attempt.targetRoute || '', attempt.selectedRoute || '', attempt.isCorrect == null ? '' : attempt.isCorrect,
        attempt.searchTimeMs == null ? '' : Math.round(attempt.searchTimeMs), Boolean(attempt.repCompletedAt),
        movementValue(movement.standControl) || '', movementValue(movement.leftLeg) || '', movementValue(movement.rightLeg) || '', movementValue(movement.bilateralBalance) || ''
      ]);
    }));
    const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'catch-your-bus-session-data.csv';
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    publish('session_data_exported', { records: rows.length - 1 });
  }
  $('newSessionButton').addEventListener('click', () => resetForNewSession());
  $('brandHome').addEventListener('click', (event) => {
    if (state.phase !== 'safety') { event.preventDefault(); resetForNewSession(); }
  });
  function resetForNewSession() {
    clearAllTimers();
    state = { phase:'safety', session:null, currentSet:1, completedRepsInSet:0, warmupStep:0, dashboardView:'patient' };
    currentAttempt = null; currentSelectedRoute = null; currentCards = []; currentTarget = null;
    $('safetyChecklist').querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
    updateSafetyState();
    activeDashboardView = 'patient';
    showScreen('safety', 'SESSION PREPARATION');
    publish('new_session_ready', {});
  }

  // ---------- Public integration contract ----------
  // WebGazer adapter: inputs.gazeTarget(routeNumber)
  // EMG adapter: inputs.emgConfirmed({ source: 'emg' })
  // Sit-to-stand processing: inputs.repCompleted({ standControl, leftLeg, rightLeg, bilateralBalance })
  // Warm-up: inputs.warmupGazeLocked() then inputs.warmupFootPressConfirmed()
  const publicApi = {
    version: APP_VERSION,
    config: { totalSets: TOTAL_SETS, repsPerSet: REPS_PER_SET, restSeconds: REST_SECONDS },
    getState: publicState,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe(listener) requires a function');
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    configure(options = {}) {
      if (typeof options.autoCompleteMovement === 'boolean') autoCompleteMovement = options.autoCompleteMovement;
      if (typeof options.mouseInputEnabled === 'boolean') mouseInputEnabled = options.mouseInputEnabled;
      publish('configuration_changed', { autoCompleteMovement, mouseInputEnabled });
    },
    inputs: {
      warmupGazeLocked: () => warmupGazeLocked('webgazer'),
      warmupFootPressConfirmed: () => warmupFootPressConfirmed('foot-press'),
      gazeTarget: (routeNumber) => gazeTarget(routeNumber, 'webgazer'),
      emgConfirmed: () => emgConfirmed({ source:'emg' }),
      repCompleted: (payload = {}) => repCompleted(payload),
      movementMetricsUpdated(payload = {}) {
        if (!currentAttempt || state.phase !== 'game') return false;
        currentAttempt.movement = normaliseMovementPayload(payload);
        publish('movement_metrics_updated', { attemptId: currentAttempt.id, movement: currentAttempt.movement });
        return true;
      }
    }
  };
  window.CatchYourBus = publicApi;

  // Expose a demo shortcut only when explicitly requested via ?fast=1.
  if (FAST_MODE) {
    document.body.insertAdjacentHTML('beforeend', '<div class="fast-mode-note" aria-label="Fast demo mode">FAST DEMO</div>');
    const noteStyle = document.createElement('style');
    noteStyle.textContent = '.fast-mode-note{position:fixed;right:12px;bottom:10px;z-index:50;padding:5px 8px;border-radius:5px;background:#F8EEDC;color:#755D37;font:800 9px Inter,Arial,sans-serif;letter-spacing:.1em;opacity:.8;pointer-events:none}';
    document.head.appendChild(noteStyle);
  }

  updateSafetyState();
  showScreen('safety', 'SESSION PREPARATION');
  publish('app_ready', { version: APP_VERSION, fastMode: FAST_MODE });
})();
