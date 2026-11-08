import {
  DEFAULT_CONFIG, DEFAULT_GOAL, copy, parseConfig, eligible, evidenceFromTurn,
  makePrompt, modelText, validateLesson, conceptKey, freshMetrics, addUsage, updateRecords, parseRecords, relevantRecords,
  DEMO_EVIDENCE, DEMO_REPLY,
} from '../lib/core.js';

/** @typedef {import('claude-code').EngineInterface} Engine */
/** @type {any} Per-module state; no Node globals or external dependencies. */
const s = {
  config: copy(DEFAULT_CONFIG), path: '', id: '', epoch: 0, sequence: 0,
  pending: null, latest: null, card: null, expanded: false, working: false,
  inFlight: null, timer: null, known: [], history: [], metrics: freshMetrics(null),
  status: 'Set a goal to begin. Demo uses no model.', ready: false, saving: false, recordSaving: false, records: [], recordsPath: '', view: 'lesson',
};
const PANE = 'learning-goal-mod';

/** @param {Engine} $ */
async function load($) {
  s.epoch += 1;
  s.ready = false;
  s.pending = null;
  s.latest = null;
  s.card = null;
  s.expanded = false;
  s.working = false;
  s.timer?.cancel();
  s.id = await $.session.id();
  const home = await $.env.get('HOME');
  if (!home || !home.startsWith('/')) throw new Error('An absolute HOME is needed for the goal file.');
  s.path = home + '/.config/learning-goal-mod/goals.json';
  s.recordsPath = home + '/.config/learning-goal-mod/learning-records.json';
  // Preserve existing data when upgrading the earlier plugin. Never overwrite
  // new files or delete old ones; validate both inputs before copying either.
  const oldDir = home + '/.config/claude-goal-companion/';
  if (!(await $.fs.exists(s.path)) && await $.fs.exists(oldDir + 'goals.json')) {
    const oldGoal = await $.fs.read(oldDir + 'goals.json');
    parseConfig(oldGoal);
    const oldRecords = await $.fs.exists(oldDir + 'learning-records.json') ? await $.fs.read(oldDir + 'learning-records.json') : null;
    if (oldRecords !== null) parseRecords(oldRecords);
    if (oldRecords !== null && !(await $.fs.exists(s.recordsPath))) await $.fs.write(s.recordsPath, oldRecords);
    await $.fs.write(s.path, oldGoal);
  }
  s.config = await $.fs.exists(s.path) ? parseConfig(await $.fs.read(s.path)) : copy(DEFAULT_CONFIG);
  s.metrics = freshMetrics(await $.store.get('metrics:' + s.id));
  const oldMetrics = (await $.store.keys()).filter(k => k.startsWith('metrics:') && k !== 'metrics:' + s.id);
  for (const key of oldMetrics.slice(0, Math.max(0, oldMetrics.length - 19))) await $.store.delete(key);
  s.history = [];
  s.known = [];
  const legacyHistory = [];
  // Feedback is scoped to an exact goal intent so a new goal does not inherit unrelated concepts.
  for (const key of (await $.store.keys()).filter(k => k.startsWith('feedback:')).slice(-100)) {
    /** @type {any} */
    const record = await $.store.get(key);
    if (validRecord(record)) legacyHistory.push(record);
    if (validRecord(record) && record.goalIntent === s.config.goal.intent) {
      s.history.push(record);
      if (record.action === 'known') s.known.push(conceptKey(record.lesson.concept));
    }
  }
  if (await $.fs.exists(s.recordsPath)) s.records = parseRecords(await $.fs.read(s.recordsPath));
  else {
    // Legacy plugin-store feedback remains intact; migrate usable engaged lessons into memory.
    s.records = [];
    for (const record of legacyHistory) {
      const l = record.lesson;
      if (typeof l.quote === 'string' && typeof l.explanation === 'string' && typeof l.nextQuestion === 'string' &&
          ['proposed', 'reported'].includes(l.evidenceStatus) && Number.isFinite(record.at)) {
        s.records = updateRecords(s.records, record.goalIntent, l, record.action, record.at);
      }
    }
  }
  for (const record of s.records) {
    if (record.goalIntent === s.config.goal.intent && record.actions.includes('known')) s.known.push(conceptKey(record.concept));
  }
  s.status = s.config.goal.active ? 'Ready. Coaching runs only at idle boundaries.' : 'Set a goal to begin. Demo uses no model.';
  s.ready = true;
  s.timer = $.clock.every(1000, () => { void tick($).catch(() => problem($, 'Background check failed.')); });
  $.ui.invalidate('ui.render');
}

function validRecord(record) {
  return record && typeof record === 'object' && typeof record.goalIntent === 'string' &&
    typeof record.action === 'string' && typeof record.lesson?.concept === 'string' &&
    typeof record.lesson?.connection === 'string';
}

/** @param {Engine} $ */
function problem($, message) {
  s.status = message;
  $.ui.invalidate('ui.render');
}

/** @param {Engine} $ */
async function saveMetrics($) {
  await $.store.set('metrics:' + s.id, s.metrics);
}

/** @param {Engine} $ */
async function changeConfig($, patch) {
  if (!s.ready) throw new Error('Goal configuration is not loaded. Check the goal file and reload the plugin.');
  if (s.saving) return;
  const candidate = parseConfig(JSON.stringify({ ...s.config, ...patch }));
  s.saving = true;
  const epoch = s.epoch;
  try {
    // Disk first: a failed save must not silently activate an unsaved goal.
    await $.fs.write(s.path, JSON.stringify(candidate, null, 2) + '\n');
    if (epoch !== s.epoch) return;
    const goalChanged = candidate.goal.intent !== s.config.goal.intent;
    s.config = candidate;
    s.epoch += 1;
    s.card = null;
    s.pending = null;
    if (goalChanged) { s.known = []; s.history = []; }
    s.status = candidate.paused ? 'Settings saved. Coaching paused.' : 'Settings saved. Ready for your next completed turn.';
    $.ui.invalidate('ui.render');
  } finally { s.saving = false; }
}

/** @param {Engine} $ */
async function setGoal($, intent) {
  const text = intent.trim();
  if (text.length < 8 || text.length > 1000) throw new Error('Use a goal between 8 and 1000 characters.');
  await changeConfig($, { goal: { id: 'personal-goal', revision: s.config.goal.revision + 1, intent: text,
    why: s.config.goal.why, active: true } });
}

async function setWhy($, why) {
  if (why.length > 2000) throw new Error('Rationale is too long.');
  await changeConfig($, { goal: { ...s.config.goal, revision: s.config.goal.revision + 1, why: why.trim() } });
}

/** @param {Engine} $ */
async function feedback($, action) {
  const card = s.card;
  if (!card) return;
  const epoch = s.epoch;
  if (!card.demo) {
    if (s.recordSaving) throw new Error('Learning record save in progress.');
    s.recordSaving = true;
    try {
    const record = {
      at: await $.clock.now(), goalIntent: s.config.goal.intent,
      action, lesson: card.lesson,
    };
    if (epoch !== s.epoch || s.card !== card) return;
    if (['opened', 'later', 'known', 'done'].includes(action)) {
      const records = updateRecords(s.records, record.goalIntent, card.lesson, action, record.at);
      await $.fs.write(s.recordsPath, JSON.stringify({ schemaVersion: 1, records }, null, 2) + '\n');
      s.records = records;
    }
    // Each feedback action has its own key; no shared-array read/modify/write.
    await $.store.set('feedback:' + record.at + ':' + s.id + ':' + (++s.sequence), record);
    if (epoch !== s.epoch || s.card !== card) return;
    s.history.push(record);
    s.history = s.history.slice(-100);
    if (action === 'known') s.known.push(conceptKey(card.lesson.concept));
    const keys = (await $.store.keys()).filter(k => k.startsWith('feedback:'));
    for (const key of keys.slice(0, Math.max(0, keys.length - 100))) await $.store.delete(key);
    } finally { s.recordSaving = false; }
  }
  if (epoch !== s.epoch || s.card !== card) return;
  if (action === 'opened') s.expanded = true;
  else { s.card = null; s.expanded = false; }
  s.status = action === 'done' ? 'Lesson marked as done. This does not imply mastery.' :
    action === 'known' ? 'Introductory explanations of this concept are suppressed.' :
    action === 'later' ? 'Saved for later in History.' : 'Feedback saved.';
  $.ui.invalidate('ui.render');
}

/** @param {Engine} $ */
async function openPane($) {
  await $.ui.open({ id: PANE, title: 'Learning Goal Mod', focus: true, closeOnEscape: true });
}

/** @param {Engine} $ */
async function askMain($) {
  if (!s.card) return;
  const lesson = s.card.lesson;
  const draft = (await $.prompt.read()).text;
  const result = await $.prompt.fill({
    mode: 'append',
    text: (draft && !/\s$/.test(draft) ? ' ' : '') +
      'Help me understand ' + lesson.concept + ' in this work. ' + lesson.nextQuestion,
  });
  problem($, result.isFilled ? 'Question added to your draft. Edit it and send when ready.' : 'Draft unavailable. Try again when the prompt is available.');
}

/** @param {Engine} $ */
async function demo($) {
  s.epoch += 1;
  s.pending = null;
  s.card = { demo: true, lesson: validateLesson(JSON.stringify(DEMO_REPLY), DEMO_EVIDENCE) };
  s.expanded = false;
  s.view = 'lesson';
  s.status = 'Illustrative demo. No model request or learning record.';
  $.ui.invalidate('ui.render');
}

/** @param {Engine} $ */
async function tick($) {
  if (!s.ready) return;
  const now = await $.clock.now();
  if (s.inFlight) {
    if (now - s.inFlight.startedAt > 20_000 && !s.inFlight.expired) {
      s.inFlight.expired = true;
      problem($, 'Coach response is late. Its result will be discarded; no further requests until it finishes.');
    }
    return;
  }
  if (!eligible({ config: s.config, pending: s.pending, busy: false, working: s.working,
    card: s.card, now, cards: s.metrics.cards, lastCard: s.metrics.lastCard })) return;
  if ((await $.prompt.read()).text.trim()) return;
  await requestLesson($, false);
}

/** @param {Engine} $ */
async function requestLesson($, manual) {
  if (!s.ready || !s.config.goal.active) { problem($, 'Set your goal first.'); return; }
  if (s.config.paused) { problem($, 'Coaching is paused. Resume before requesting a lesson.'); return; }
  if (s.inFlight || s.working) { problem($, 'Wait until the current task or coaching check finishes.'); return; }
  const evidence = manual ? s.latest : s.pending;
  if (!evidence) { problem($, 'Complete a substantive turn first, or try Demo.'); return; }
  // Claim the slot before the first await: overlapping ticks cannot issue duplicate requests.
  const job = { epoch: s.epoch, sessionId: s.id, startedAt: 0, expired: false, evidence };
  s.inFlight = job;
  s.pending = null;
  try {
    job.startedAt = await $.clock.now();
    if (job.epoch !== s.epoch || s.working) return;
    if (manual) s.metrics.manualChecks += 1;
    else { s.metrics.checks += 1; s.metrics.lastCheck = job.startedAt; }
    await saveMetrics($);
    if (job.epoch !== s.epoch || s.working) return;
    problem($, 'Checking for one useful connection to your goal…');
    const result = await $.model.fork({ prompt: makePrompt(s.config.goal, evidence, s.known, relevantRecords(s.records, s.config.goal.intent, evidence)) });
    // Never race a watchdog against the request and then start another paid call.
    // Public fork types expose no cancellation option. Keep the slot until settlement.
    const finishedAt = await $.clock.now();
    const charged = freshMetrics(await $.store.get('metrics:' + job.sessionId));
    addUsage(charged, result?.usage);
    await $.store.set('metrics:' + job.sessionId, charged);
    if (s.id === job.sessionId) s.metrics = charged;
    if (job.epoch !== s.epoch) return;
    if (job.expired || finishedAt - job.startedAt > 20_000) {
      problem($, 'Late coach response discarded. You can request another lesson.'); return;
    }
    const text = modelText(result);
    if (text === null) { problem($, 'No coach response. A completed live turn is needed for a fork.'); return; }
    const lesson = validateLesson(text, evidence);
    if (!lesson || (s.known.includes(conceptKey(lesson.concept)) && !lesson.buildsOnKnown)) {
      problem($, 'No new teaching moment this time.'); return;
    }
    if (s.working || s.latest?.ref !== evidence.ref) { problem($, 'Work moved on; an older lesson was discarded.'); return; }
    s.card = { lesson, demo: false };
    s.expanded = manual;
    if (!manual) { s.metrics.cards.push(finishedAt); s.metrics.lastCard = finishedAt; }
    s.metrics.cards = s.metrics.cards.filter(t => finishedAt - t < 3_600_000).slice(-20);
    await saveMetrics($);
    if (job.epoch !== s.epoch) return;
    problem($, 'A connection to your goal is ready.');
    if (manual) { s.view = 'lesson'; await openPane($); }
  } catch {
    if (job.epoch === s.epoch) problem($, 'Coaching check failed or returned invalid evidence. Your main task is unaffected.');
  } finally {
    if (s.inFlight === job) s.inFlight = null;
  }
}

/** @param {Engine} $ */
async function command($, args) {
  const [action = 'show', ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (action === 'demo') { await demo($); return { text: 'Illustrative invitation ready above the prompt. No model used.' }; }
  if (!s.ready) return { text: s.status + ' Check ' + s.path + ' and reload the plugin.' };
  if (action === 'set') await setGoal($, rest.join(' ') || DEFAULT_GOAL);
  else if (action === 'pause') await changeConfig($, { paused: true });
  else if (action === 'resume') await changeConfig($, { paused: false });
  else if (action === 'auto') {
    if (!['on', 'off'].includes(rest[0])) return { text: 'Use /learning-goal auto on or /learning-goal auto off.' };
    await changeConfig($, { automatic: rest[0] === 'on' });
  } else if (action === 'explain') {
    $.clock.after(1, () => { void requestLesson($, true).catch(() => problem($, 'Could not request a lesson.')); });
    return { text: 'Coaching request queued. You can keep using the main session.' };
  }
  else if (action === 'export') {
    // Export to an explicit, fixed path under the same user configuration directory.
    const exportPath = s.path.replace(/goals\.json$/, 'history-export.json');
    await $.fs.write(exportPath, JSON.stringify({ goal: s.config.goal, history: s.history, learningRecords: s.records.filter(r => r.goalIntent === s.config.goal.intent) }, null, 2) + '\n');
    return { text: 'Exported this goal’s history to ' + exportPath };
  } else if (!['show', 'history', 'status'].includes(action)) {
    return { text: 'Use /learning-goal [show | set <goal> | demo | explain | pause | resume | auto on/off | history | export | status].' };
  }
  if (action === 'status') return { text: statusText() };
  s.view = action === 'history' ? 'history' : (s.card ? 'lesson' : 'settings');
  await openPane($);
  return { text: s.status };
}

function statusText() {
  const u = s.metrics.usage;
  return `Goal: ${s.config.goal.active ? s.config.goal.intent : 'not activated'}\n` +
    `Paused: ${s.config.paused}. Automatic: ${s.config.automatic}.\n` +
    `Automatic cards: at most ${s.config.maxCardsPerHour} per hour; ${s.config.cardCooldownMs / 60000} minute cooldown. Limits apply per session.\n` +
    `Automatic checks: ${s.metrics.checks}; manual: ${s.metrics.manualChecks}.\n` +
    `Reported tokens: input ${u.input_tokens}, output ${u.output_tokens}, cache reads ${u.cache_read_input_tokens}, cache writes ${u.cache_creation_input_tokens}.\n` +
    `No dollar estimate. Requests use your Claude account.\n${s.status}`;
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'learning-goal', description: 'Learning Goal Mod: optional lessons connected to your work. Try /learning-goal demo.' });
    try { await load($); } catch { s.ready = false; problem($, 'Could not load goal settings. Existing files were left untouched.'); }
    return next(e);
  });

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try { await load($); } catch { s.ready = false; problem($, 'Could not reload goal settings.'); }
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    s.epoch += 1;
    s.ready = false;
    s.timer?.cancel();
    s.card = null;
    s.pending = null;
    s.latest = null;
    $.ui.invalidate('ui.render');
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    s.working = true;
    s.epoch += 1;
    s.pending = null;
    s.card = null;
    $.ui.invalidate('ui.render');
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      s.working = false;
      s.latest = evidenceFromTurn(e, ++s.sequence);
      s.pending = s.latest;
    }
    return next(e);
  });

  on('command.run', { command: 'learning-goal' }, async ($, e) => {
    try { return await command($, e.args); }
    catch { return { text: 'Could not complete the learning command. Check the goal file and try again; existing task work is unaffected.' }; }
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const others = await next(e);
    if (!s.card || s.config.paused || e.props.hasSurvey || e.props.isWorking ||
        !['terminal', 'desktop'].includes(e.surface)) return others;
    if ((await $.prompt.read()).text.trim()) return others;
    const { Box, Text, Button } = $.ui.resolve(e);
    return Box({ flexDirection: 'column', children: [
      ...(others ? [others] : []),
      Box({ flexDirection: 'column', rowGap: 'sm', paddingBottom: 'sm', children: [
      Text({ children: [(s.card.demo ? 'Demo · ' : 'Learning opportunity · ') + s.card.lesson.connection] }),
      Box({ flexDirection: 'row', columnGap: 'md', children: [
        Button({ key: 'open-lesson', label: 'Explain', variant: 'primary', onPress: () => {
          s.view = 'lesson';
          return feedback($, 'opened').then(() => openPane($)).catch(() => problem($, 'Could not open lesson.'));
        } }),
        Button({ key: 'dismiss-card', label: 'Dismiss', role: 'dismiss', onPress: () => {
          return feedback($, 'dismissed').catch(() => problem($, 'Could not dismiss lesson.'));
        } }),
      ] }),
      ] }),
    ] });
  });

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e);
    const { Box, Text, Button, Input } = $.ui.resolve(e);
    const heading = text => Text({ size: 'footnote', weight: 'semibold', dimColor: true, children: [text] });
    const body = text => Text({ children: [text] });
    const section = (title, content) => Box({ flexDirection: 'column', rowGap: 'sm', children: [heading(title), ...content] });
    const button = (key, label, onPress, extra = {}) => Button({ key, label, onPress, ...extra });
    const switchView = view => () => { s.view = view; $.ui.invalidate('ui.render'); };
    const children = [];
    if (s.view === 'settings') {
      children.push(Text({ size: 'heading', weight: 'semibold', children: ['Settings'] }));
      children.push(section('YOUR GOAL', [
        body(s.config.goal.active ? s.config.goal.intent : 'No goal saved yet.'),
        Input({ key: 'goal-input', label: '', value: s.config.goal.intent, rows: 6, submitLabel: 'Save',
          onSubmit: value => { return setGoal($, value).catch(() => problem($, 'Goal was not saved. Use 8–1000 characters and check file access.')); } }),
      ]));
      children.push(section('WHY THIS MATTERS TO ME (OPTIONAL)', [
        Input({ key: 'why-input', label: '', placeholder: 'What do you hope to do with this knowledge?', value: s.config.goal.why, rows: 4, submitLabel: 'Save',
          onSubmit: value => { return setWhy($, value).catch(() => problem($, 'Could not save why. Use at most 2000 characters.')); } }),
      ]));
      children.push(section('COACHING', [
        body(s.config.paused ? 'Paused' : (s.config.automatic ? 'Automatic checks on' : 'Manual checks only')),
        body(s.config.automatic ? 'Saving a goal enables automatic checks using your Claude account.' : 'Manual explanations use your Claude account.'),
        button('toggle-auto', s.config.automatic ? 'Turn automatic checks off' : 'Turn automatic checks on',
          () => changeConfig($, { automatic: !s.config.automatic }).catch(() => problem($, 'Preference not saved.'))),
        button('toggle-pause', s.config.paused ? 'Resume coaching' : 'Pause coaching',
          () => changeConfig($, { paused: !s.config.paused }).catch(() => problem($, 'Preference not saved.'))),
        button('manual', 'Explain recent work', () => requestLesson($, true)),
        button('demo', 'Show demo invitation', () => demo($).then(() => $.ui.close({ id: PANE })).catch(() => problem($, 'Could not open demo.'))),
      ]));
      children.push(section('AUTOMATIC CARD FREQUENCY', [
        body('Settings are shared; limits are counted per chat. Manual explanations do not count. Automatic checks can use your account even when no card appears.'),
        body('Maximum cards per rolling hour (0–20)'),
        Input({ key: 'cards-per-hour', label: '', value: String(s.config.maxCardsPerHour), submitLabel: 'Save',
          onSubmit: value => {
            if (!/^\d+$/.test(value.trim()) || Number(value) > 20) { problem($, 'Enter a whole number from 0 to 20.'); return; }
            return changeConfig($, { maxCardsPerHour: Number(value) }).catch(() => problem($, 'Could not save the hourly limit.'));
          } }),
        body('Minimum minutes between cards (0–1440)'),
        Input({ key: 'card-cooldown', label: '', value: String(s.config.cardCooldownMs / 60000), submitLabel: 'Save',
          onSubmit: value => {
            if (!/^\d+$/.test(value.trim()) || Number(value) > 1440) { problem($, 'Enter a whole number from 0 to 1440.'); return; }
            return changeConfig($, { cardCooldownMs: Number(value) * 60000 }).catch(() => problem($, 'Could not save the cooldown.'));
          } }),
        body('Checks can happen after each eligible completed turn, including when no card was shown previously.'),
        body(s.status),
      ]));
      children.push(section('USAGE', [body(statusText())]));
    } else if (s.view === 'history') {
      children.push(Text({ size: 'heading', weight: 'semibold', children: ['History'] }));
      const learning = s.records.filter(r => r.goalIntent === s.config.goal.intent).slice(-10).reverse();
      if (learning.length) children.push(section('LEARNING RECORDS', learning.map(r =>
        body(r.concept + '\n' + r.idea + '\nExample: “' + r.example + '”\nYour actions: ' + r.actions.join(', ') + '\nNext question: ' + r.nextAngle))));
      if (!s.history.length) children.push(body('No saved lesson activity yet.'));
      for (const record of s.history.slice(-10).reverse()) {
        children.push(section(record.action.toUpperCase(), [body(record.lesson.concept + ' · ' + record.lesson.connection),
          button('history-' + record.at + '-' + s.history.indexOf(record), 'Reopen ' + record.lesson.concept,
            () => { s.card = { lesson: record.lesson, demo: false }; s.expanded = true; s.view = 'lesson'; $.ui.invalidate('ui.render'); })]));
      }
    } else if (s.card) {
      const l = s.card.lesson;
      children.push(section('YOUR GOAL', [body(s.config.goal.intent)]));
      children.push(section(s.card.demo ? 'ILLUSTRATIVE LESSON' : 'LEARNING OPPORTUNITY', [
        Text({ size: 'heading', weight: 'semibold', children: [l.concept] }), body(l.connection),
      ]));
      if (s.expanded) {
        children.push(section('BASED ON ' + l.evidenceStatus.toUpperCase() + ' WORK', [body('“' + l.quote + '”')]));
        children.push(section('THE IDEA', [body(l.explanation)]));
        if (l.diagram) {
          const diagramWidth = Math.max(...l.diagram.split('\n').map(line => line.length));
          const fits = (e.props.bodyColumns ?? 0) >= diagramWidth + 4;
          children.push(section('HOW IT FITS TOGETHER', [fits ? Text({ mono: true, children: [l.diagram] }) :
            body('Widen the pane to see the diagram.') ]));
        }
        children.push(section('TRADEOFF', [body(l.tradeoff)]));
        if (l.nextQuestion) children.push(section('THINK ABOUT IT', [body(l.nextQuestion)]));
        children.push(section('EXPLORE', [
          button('pane-done', 'Mark as done', () => feedback($, 'done').catch(() => problem($, 'Could not save feedback.')), { variant: 'primary' }),
          button('draft', 'Ask main agent', () => askMain($).catch(() => problem($, 'Could not fill draft.'))),
          button('pane-known', 'Already know', () => feedback($, 'known').catch(() => problem($, 'Could not save feedback.'))),
          button('pane-later', 'Save for later', () => feedback($, 'later').catch(() => problem($, 'Could not save feedback.'))),
          button('dismiss', 'Dismiss lesson', () => feedback($, 'dismissed').catch(() => problem($, 'Could not save feedback.'))),
        ]));
      } else {
        children.push(button('expand', 'Explain', () => feedback($, 'opened').catch(() => problem($, 'Could not open lesson.')), { variant: 'primary' }));
      }
    } else {
      children.push(Text({ size: 'heading', weight: 'semibold', children: ['Your learning goal'] }));
      children.push(body(s.config.goal.active ? s.config.goal.intent : 'Save a goal to start looking for learning opportunities.'));
      children.push(body(s.status));
      children.push(button('manual', 'Explain recent work', () => requestLesson($, true)));
    }
    children.push(section('MORE', [
      ...(s.view !== 'lesson' ? [button('view-lesson', 'Lesson', switchView('lesson'))] : []),
      ...(s.view !== 'settings' ? [button('view-settings', 'Settings', switchView('settings'))] : []),
      ...(s.view !== 'history' ? [button('view-history', 'History', switchView('history'))] : []),
      button('close', 'Close pane', () => $.ui.close({ id: PANE })),
    ]));
    return Box({ flexDirection: 'column', rowGap: 'lg', padding: 'md', children });
  });
  return undefined;
};
