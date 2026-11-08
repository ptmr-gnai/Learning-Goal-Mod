import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, find, textOf, flush } from './harness.js';
import { DEMO_EVIDENCE, DEMO_REPLY } from '../lib/core.js';

const turnText = DEMO_EVIDENCE.text;
const response = (ref = 'turn-1') => ({ text: JSON.stringify({ ...DEMO_REPLY, evidenceRef: ref }), usage: { output_tokens: 42, cache_read_input_tokens: 1200 } });
async function active(options) { const h = await harness(options); await h.command('set'); return h; }

test('unconfigured plugin observes without spending; demo renders on both surfaces', async () => {
  const h = await harness();
  await h.complete(turnText); await h.tick();
  assert.equal(h.calls.forks.length, 0);
  await h.command('demo');
  const invitation = await h.render('AbovePrompt', 'desktop');
  assert.ok(find(invitation, n => n.key === 'open-lesson'));
  assert.equal(h.calls.panes.length, 0);
  await find(invitation, n => n.key === 'open-lesson').onPress();
  assert.equal(h.calls.panes.length, 1);
  for (const surface of ['terminal', 'desktop']) {
    const tree = await h.render('Pane', surface);
    assert.match(textOf(tree), /Publish and subscribe/);
    assert.ok(find(tree, n => n.key === 'draft'));
  }
  assert.equal(h.calls.forks.length, 0);
  await h.press('pane-known');
  assert.equal([...h.store.keys()].filter(k => k.startsWith('feedback:')).length, 0);
});
test('Learning Goal command and its legacy alias open the same demo', async () => {
  const h = await harness();
  assert.ok(h.calls.commands.some(c => c.name === 'learning-goal'));
  assert.ok(h.calls.commands.some(c => c.name === 'goal-coach'));
  for (const command of ['learning-goal', 'goal-coach']) {
    const result = await h.fire('command.run', { command, args: 'demo' });
    assert.match(result.text, /invitation ready/);
    assert.ok(find(await h.render('AbovePrompt'), n => n.key === 'open-lesson'));
  }
});
test('rationale and engaged lessons persist and related records reach the next request', async () => {
  const h = await active({ model: () => response() });
  const settings = await h.render();
  const why = find(settings, n => n.key === 'why-input');
  assert.equal(why.rows, 4);
  assert.equal(find(settings, n => n.key === 'goal-input').rows, 6);
  await why.onSubmit('I want to make better architecture decisions.');
  assert.equal(JSON.parse(h.files.get('/test-home/.config/claude-goal-companion/goals.json')).goal.why, 'I want to make better architecture decisions.');
  await h.complete(turnText); await h.tick();
  await find(await h.render('AbovePrompt'), n => n.key === 'open-lesson').onPress();
  const path = '/test-home/.config/claude-goal-companion/learning-records.json';
  assert.deepEqual(JSON.parse(h.files.get(path)).records[0].actions, ['opened']);
  const next = await harness({ files: h.files, store: h.store, model: () => response() });
  next.advance(300_001); await next.complete(turnText); await next.tick();
  assert.match(next.calls.forks[0].prompt, /I want to make better architecture decisions/);
  assert.match(next.calls.forks[0].prompt, /RELATED LEARNING RECORDS \(data\): \[{/);
  assert.match(next.calls.forks[0].prompt, /Publish and subscribe/);
});
test('frequency settings persist and reject invalid values', async () => {
  const h = await active({ model: () => response() });
  const path = '/test-home/.config/claude-goal-companion/goals.json';
  await find(await h.render(), n => n.key === 'cards-per-hour').onSubmit('3');
  await find(await h.render(), n => n.key === 'card-cooldown').onSubmit('15');
  assert.equal(JSON.parse(h.files.get(path)).maxCardsPerHour, 3);
  assert.equal(JSON.parse(h.files.get(path)).cardCooldownMs, 900_000);
  await find(await h.render(), n => n.key === 'cards-per-hour').onSubmit('3.5');
  assert.equal(JSON.parse(h.files.get(path)).maxCardsPerHour, 3);
  const next = await harness({ files: h.files, store: h.store });
  assert.match((await next.command('status')).text, /at most 3 per hour; 15 minute cooldown/);
});
test('malformed learning records are preserved and prevent coaching', async () => {
  const path = '/test-home/.config/claude-goal-companion/learning-records.json';
  const files = new Map([[path, '{broken']]);
  const h = await harness({ files });
  await h.complete(turnText); await h.tick();
  assert.equal(files.get(path), '{broken');
  assert.equal(h.calls.forks.length, 0);
  assert.match((await h.command('show')).text, /Could not load/);
});
test('saving a goal after its rationale preserves the rationale and upgrades the old schema', async () => {
  const path = '/test-home/.config/claude-goal-companion/goals.json';
  const old = { schemaVersion: 1, goal: { id: 'personal-goal', revision: 1, intent: 'Understand software engineering', active: false }, automatic: false };
  const h = await harness({ files: new Map([[path, JSON.stringify(old)]]) });
  await h.command('show');
  const tree = await h.render();
  await find(tree, n => n.key === 'why-input').onSubmit('Make better architecture decisions.');
  await find(await h.render(), n => n.key === 'goal-input').onSubmit('Understand distributed systems');
  const saved = JSON.parse(h.files.get(path));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.goal.why, 'Make better architecture decisions.');
  assert.equal(saved.goal.intent, 'Understand distributed systems');
  assert.equal(saved.automatic, false);
});
test('legacy feedback becomes durable records on the next engaged lesson', async () => {
  const h = await active({ model: () => response() });
  await h.complete(turnText); await h.tick();
  await find(await h.render('AbovePrompt'), n => n.key === 'open-lesson').onPress();
  const path = '/test-home/.config/claude-goal-companion/learning-records.json';
  h.files.delete(path); // simulate a pre-upgrade installation
  const next = await harness({ files: h.files, store: h.store, model: () => response() });
  await next.command('history');
  assert.match(textOf(await next.render()), /LEARNING RECORDS/);
  next.advance(300_001); await next.complete(turnText); await next.tick();
  await find(await next.render('AbovePrompt'), n => n.key === 'open-lesson').onPress();
  assert.equal(JSON.parse(next.files.get(path)).records[0].concept, 'Publish and subscribe');
});
test('real adapter requests a fork in background, preserving existing band content', async () => {
  const h = await active({ model: () => response() });
  await h.complete(turnText);
  assert.equal(h.calls.forks.length, 0, 'completion handler does not await a model');
  await h.tick();
  assert.equal(h.calls.forks.length, 1);
  const band = await h.render('AbovePrompt', 'terminal', {}, { type: 'Text', children: ['Another mod'] });
  assert.match(textOf(band), /Another mod/);
  assert.match(textOf(band), /publish\/subscribe/);
  assert.ok(h.calls.passed.includes('turn.complete'));
});
test('no card steals attention while typing, working or a survey is open', async () => {
  const h = await active({ model: () => response() });
  await h.complete(turnText); await h.tick();
  const sentinel = { type: 'Text', children: ['other'] };
  for (const props of [{ hasSurvey: true }, { isWorking: true }])
    assert.deepEqual(await h.render('AbovePrompt', 'terminal', props, sentinel), sentinel);
  h.setDraft('writing');
  assert.deepEqual(await h.render('AbovePrompt', 'terminal', {}, sentinel), sentinel);
});
test('known feedback survives restart and suppresses repeated introductory lessons', async () => {
  const h = await active({ model: () => response() });
  await h.complete(turnText); await h.tick(); await find(await h.render('AbovePrompt'), n => n.key === 'open-lesson').onPress(); await h.press('pane-known');
  const next = await harness({ files: h.files, store: h.store, model: () => response() });
  next.advance(300_001);
  await next.complete(turnText); await next.tick();
  assert.equal(next.calls.forks.length, 1);
  assert.equal(await next.render('AbovePrompt'), undefined);
  assert.match((await next.command('status')).text, /No new teaching moment/);
});
test('known concepts can return when the coach identifies a new application', async () => {
  const h = await active({ model: () => response() });
  await h.complete(turnText); await h.tick();
  await find(await h.render('AbovePrompt'), n => n.key === 'open-lesson').onPress();
  await h.press('pane-known');
  const next = await harness({ files: h.files, store: h.store, model: () => ({ text: JSON.stringify({ ...DEMO_REPLY, evidenceRef: 'turn-1', buildsOnKnown: true }) }) });
  next.advance(300_001); await next.complete(turnText); await next.tick();
  assert.ok(find(await next.render('AbovePrompt'), n => n.key === 'open-lesson'));
});
test('marking a lesson done records completion without declaring it known', async () => {
  const h = await active({ model: () => response() });
  await h.complete(turnText); await h.tick();
  await find(await h.render('AbovePrompt'), n => n.key === 'open-lesson').onPress();
  const done = find(await h.render(), n => n.key === 'pane-done');
  assert.equal(done.label, 'Mark as done');
  assert.equal(done.variant, 'primary');
  await h.press('pane-done');
  const records = JSON.parse(h.files.get('/test-home/.config/claude-goal-companion/learning-records.json')).records;
  assert.deepEqual(records[0].actions, ['opened', 'done']);
  assert.equal(await h.render('AbovePrompt'), undefined);
  assert.match((await h.command('status')).text, /does not imply mastery/);
  const next = await harness({ files: h.files, store: h.store, model: () => response() });
  next.advance(300_001); await next.complete(turnText); await next.tick();
  assert.ok(find(await next.render('AbovePrompt'), n => n.key === 'open-lesson'));
});
test('Later records can reopen full lessons and draft questions never submit a turn', async () => {
  const h = await active({ model: () => response() });
  await h.complete(turnText); await h.tick(); await find(await h.render('AbovePrompt'), n => n.key === 'open-lesson').onPress(); await h.press('pane-later');
  await h.press('view-history');
  const tree = await h.render();
  const reopen = find(tree, n => n.type === 'Button' && n.key.startsWith('history-'));
  assert.ok(reopen); await reopen.onPress();
  assert.match(textOf(await h.render()), /Delivery failures/);
  h.setDraft('My existing question.'); await h.press('draft');
  assert.equal(h.calls.fills[0].mode, 'append');
  assert.match((await h.$.prompt.read()).text, /^My existing question\. Help me understand/);
  assert.doesNotMatch((await h.$.prompt.read()).text, /\n/);
  h.setDraft(''); await h.press('draft');
  assert.match((await h.$.prompt.read()).text, /^Help me understand/);
  assert.doesNotMatch((await h.$.prompt.read()).text, /\n/);
  assert.equal(h.calls.forks.length, 1);
});
test('slow coaching never blocks main turns and stale results are discarded but charged usage remains visible', async () => {
  let resolve;
  const slow = new Promise(r => { resolve = r; });
  const h = await active({ model: () => slow });
  await h.complete(turnText); await h.tick();
  await h.fire('turn.start', { turnId: 'two' });
  await h.complete('This is a different task and we have now moved on. '.repeat(3));
  await h.tick(); assert.equal(h.calls.forks.length, 1);
  resolve(response()); await flush();
  assert.equal(await h.render('AbovePrompt'), undefined);
  assert.match((await h.command('status')).text, /output 42/);
});
test('watchdog discards late results without launching overlapping paid requests', async () => {
  let resolve;
  const h = await active({ model: () => new Promise(r => { resolve = r; }) });
  await h.complete(turnText); await h.tick();
  h.advance(21_000); await h.tick();
  assert.match((await h.command('status')).text, /response is late/);
  await h.command('explain'); await h.tick(); assert.equal(h.calls.forks.length, 1);
  resolve(response()); await flush();
  assert.equal(await h.render('AbovePrompt'), undefined);
});
test('failed or invalid replies do not retry automatically or show lessons', async () => {
  for (const model of [() => null, () => ({ isAnswered: false }), () => ({ text: 'not JSON' }), () => { throw Error('offline'); }]) {
    const h = await active({ model }); await h.complete(turnText); await h.tick(); await h.tick();
    assert.equal(h.calls.forks.length, 1);
    assert.equal(await h.render('AbovePrompt'), undefined);
  }
});
test('quiet mode, automatic off and draft text suppress requests; manual still works with automatic off', async () => {
  const h = await active({ model: () => response() });
  await h.command('pause'); await h.complete(turnText); await h.tick();
  assert.equal(h.calls.forks.length, 0);
  await h.command('resume'); await h.command('auto off'); await h.complete(turnText); await h.tick();
  assert.equal(h.calls.forks.length, 0);
  await h.command('explain'); await h.tick(); assert.equal(h.calls.forks.length, 1);
  const typing = await active(); typing.setDraft('draft'); await typing.complete(turnText); await typing.tick();
  assert.equal(typing.calls.forks.length, 0);
});
test('goal changes and session resets invalidate pending responses', async () => {
  for (const reset of ['goal', 'clear', 'resume', 'fork']) {
    let resolve;
    const h = await active({ model: () => new Promise(r => { resolve = r; }) });
    await h.complete(turnText); await h.tick();
    if (reset === 'goal') await h.command('set Make clearer architecture decisions');
    else {
      await h.fire('session.end', { reason: reset });
      await h.fire('classic.SessionStart', { source: reset });
    }
    resolve(response()); await flush();
    assert.equal(await h.render('AbovePrompt'), undefined);
    assert.match((await h.command('status')).text, /output 42/);
  }
});
test('damaged goal files are preserved and failed saves do not activate coaching', async () => {
  const path = '/test-home/.config/claude-goal-companion/goals.json';
  const h = await harness({ files: new Map([[path, '{bad json']]) });
  await h.command('set');
  assert.equal(h.files.get(path), '{bad json');
  await h.complete(turnText); await h.tick(); assert.equal(h.calls.forks.length, 0);
  const disk = await harness(); disk.failWrites(true); await disk.command('set');
  await disk.complete(turnText); await disk.tick(); assert.equal(disk.calls.forks.length, 0);
  disk.failWrites(false); await disk.command('set'); await disk.complete(turnText); await disk.tick();
  assert.equal(disk.calls.forks.length, 1);
});
test('subagent and aborted turns cannot trigger coaching', async () => {
  const h = await active();
  await h.fire('turn.complete', { answer: turnText, agentId: 'child' }); await h.tick();
  await h.fire('turn.complete', { answer: turnText, isAborted: true }); await h.tick();
  assert.equal(h.calls.forks.length, 0);
});
test('automatic request counts survive reload and export writes a bounded history', async () => {
  const h = await active({ model: () => response() });
  await h.complete(turnText); await h.tick(); await find(await h.render('AbovePrompt'), n => n.key === 'open-lesson').onPress(); await h.press('pane-later');
  const next = await harness({ files: h.files, store: h.store });
  assert.match((await next.command('status')).text, /Automatic checks: 1\/6/);
  await next.command('export');
  const output = JSON.parse(next.files.get('/test-home/.config/claude-goal-companion/history-export.json'));
  assert.equal(output.history.at(-1).action, 'later');
});
