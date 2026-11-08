import { test, expect, mock } from 'claude-code/testing';
import { DEMO_REPLY, DEMO_EVIDENCE } from '../lib/core.js';

const commandContext = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } };
const paneProps = { title: 'Learning Goal', isFocused: true, bodyColumns: 90, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} };

test('demo uses no model and its controls draw on terminal and desktop', async ($, on) => {
  let requests = 0;
  on('model.fork', () => { requests += 1; return { value: null }; });
  on('ui.open', () => ({ value: undefined }));
  on('ui.close', () => ({ value: undefined }));
  await $.command.run({ ...commandContext, command: 'learning-goal', args: 'demo' });
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'learning-goal-mod', surface, component: 'Pane', requestId: 'learning-goal-mod',
      props: paneProps,
    });
    expect(await ui.find({ type: 'Text', text: /Publish and subscribe/ })).toBeDefined();
    await ui.press({ key: 'expand' });
    expect(await ui.find({ key: 'draft' })).toBeDefined();
    await ui.press({ key: 'dismiss' });
    expect(await ui.find({ key: 'draft' })).toBeUndefined();
    await ui.unmount();
    await $.command.run({ ...commandContext, command: 'learning-goal', args: 'demo' });
  }
  expect(requests).toBe(0);
});

test('goal setup persists and a completed turn passes through without a model call', async ($, on) => {
  mock.store(on);
  mock.env(on, { HOME: '/native-test-home' });
  mock.clock(on, { now: 1_000_000 });
  on('session.id', () => ({ value: 'native-test-session' }));
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('turn.complete', () => ({ text: '' }));
  on('fs.exists', () => ({ value: false }));
  let saved = '';
  on('fs.write', (_$, e) => { saved = e.text; return { value: undefined }; });
  on('command.register', () => ({ value: undefined }));
  on('ui.open', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  let requests = 0;
  on('model.fork', () => { requests += 1; return { value: null }; });
  await $.session.start({ cwd: '/native-test', surface: 'terminal', isInteractive: true });
  await $.command.run({ ...commandContext, command: 'learning-goal', args: 'set Understand classical software engineering' });
  expect(JSON.parse(saved).goal.active).toBe(true);
  await $.turn.complete({
    answer: 'I propose a publisher and independent subscribers for the order notification system. We should define retries and delivery behavior.',
    durationMs: 100, isAborted: false, turnId: 'turn-one', reason: 'answer',
  });
  expect(requests).toBe(0);
});

test('background fork creates a grounded card and preserves a user draft', async ($, on) => {
  mock.store(on);
  mock.env(on, { HOME: '/native-test-home' });
  const clock = mock.clock(on, { now: 1_000_000 });
  on('session.id', () => ({ value: 'native-test-session' }));
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('turn.complete', () => ({ text: '' }));
  on('fs.exists', () => ({ value: false }));
  on('fs.write', () => ({ value: undefined }));
  on('command.register', () => ({ value: undefined }));
  on('ui.open', () => ({ value: undefined }));
  let draft = '';
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }));
  on('prompt.fill', (_$, e) => {
    expect(e.mode).toBe('append');
    draft += e.text;
    return { isFilled: true, text: draft, cursor: draft.length };
  });
  let requests = 0;
  on('model.fork', () => {
    requests += 1;
    return { value: { text: JSON.stringify({ ...DEMO_REPLY, evidenceRef: 'turn-1' }),
      usage: { input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } };
  });
  await $.session.start({ cwd: '/native-test', surface: 'terminal', isInteractive: true });
  await $.command.run({ ...commandContext, command: 'learning-goal', args: 'set Understand classical software engineering' });
  await $.turn.complete({ answer: DEMO_EVIDENCE.text, durationMs: 100, isAborted: false, turnId: 'one', reason: 'answer' });
  expect(requests).toBe(0);
  await clock.advance(1000);
  expect(requests).toBe(1);
  await $.command.run({ ...commandContext, command: 'learning-goal', args: 'show' });
  const ui = await $.ui.mount({ plugin: 'learning-goal-mod', surface: 'terminal', component: 'Pane',
    requestId: 'learning-goal-mod', props: paneProps });
  await ui.press({ key: 'expand' });
  expect(await ui.find({ key: 'draft' })).toBeDefined();
  draft = 'My existing question. ';
  await ui.press({ key: 'draft' });
  expect(draft).toStartWith('My existing question. ');
  expect(draft).toMatch(/Publish and subscribe/);
  await ui.unmount();
});
