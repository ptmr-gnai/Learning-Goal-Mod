import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, copy, parseConfig, eligible, evidenceFromTurn, modelText, validateLesson, DEMO_REPLY, DEMO_EVIDENCE, makePrompt, updateRecords, parseRecords, relevantRecords } from '../lib/core.js';

test('configuration rejects damaged files and unsafe limits', () => {
  assert.deepEqual(parseConfig(JSON.stringify(DEFAULT_CONFIG)), DEFAULT_CONFIG);
  for (const value of ['{}', '{', JSON.stringify({ ...DEFAULT_CONFIG, cardCooldownMs: -1 }),
    JSON.stringify({ ...DEFAULT_CONFIG, automatic: 'yes' })]) assert.throws(() => parseConfig(value));
});
test('automatic selection honors every budget and quiet condition', () => {
  const config = copy(DEFAULT_CONFIG); config.goal.active = true;
  const base = { config, pending: {}, busy: false, working: false, card: null, now: 1_000_000, lastCheck: 0, checks: 0, cards: [] };
  assert.equal(eligible(base), true);
  for (const patch of [{ busy: true }, { working: true }, { card: {} }, { pending: null },
    { cards: [999_000, 999_100] },
    { config: { ...config, paused: true } }, { config: { ...config, automatic: false } }]) {
    assert.equal(eligible({ ...base, ...patch }), false);
  }
  assert.equal(eligible({ ...base, checks: 100, lastCheck: 999_999 }), true);
});
test('hourly cap and card cooldown are independent, including cooldowns longer than an hour', () => {
  const config = { ...copy(DEFAULT_CONFIG), goal: { ...DEFAULT_CONFIG.goal, active: true }, maxCardsPerHour: 3, cardCooldownMs: 7_200_000 };
  const base = { config, pending: {}, busy: false, working: false, card: null, now: 10_000_000, lastCheck: 0, checks: 0, cards: [], lastCard: 3_000_001 };
  assert.equal(eligible(base), false);
  assert.equal(eligible({ ...base, now: 10_200_001 }), true);
  assert.equal(eligible({ ...base, lastCard: 0, cards: [9_000_000, 9_100_000, 9_200_000] }), false);
  assert.equal(eligible({ ...base, config: { ...config, maxCardsPerHour: 0 }, lastCard: 0 }), false);
});
test('only substantive non-aborted main turns become evidence', () => {
  const event = { answer: DEMO_EVIDENCE.text, turnId: 'one' };
  assert.equal(evidenceFromTurn(event, 3).ref, 'turn-3');
  for (const patch of [{ agentId: 'child' }, { isAborted: true }, { answer: 'done' }])
    assert.equal(evidenceFromTurn({ ...event, ...patch }, 3), null);
});
test('both published model response shapes and abstention are handled', () => {
  assert.equal(modelText(null), null);
  assert.equal(modelText({ isAnswered: false, text: 'bad' }), null);
  assert.equal(modelText({ isAnswered: true, text: 'ok' }), 'ok');
  assert.equal(modelText({ text: 'ok', usage: {} }), 'ok');
  assert.equal(validateLesson('{"show":false}', DEMO_EVIDENCE), null);
});
test('lesson validation rejects fabricated quotes, references, verified claims and control codes', () => {
  assert.equal(validateLesson(JSON.stringify(DEMO_REPLY), DEMO_EVIDENCE).concept, 'Publish and subscribe');
  for (const patch of [{ evidenceRef: 'invented' }, { goalId: 'wrong' }, { quote: 'invented evidence here' },
    { evidenceStatus: 'verified' }, { explanation: '\u001b[31m dangerous terminal output' },
    { connection: 'x'.repeat(181) }, { show: 'yes' }]) {
    assert.throws(() => validateLesson(JSON.stringify({ ...DEMO_REPLY, ...patch }), DEMO_EVIDENCE));
  }
});
test('prompt includes explicit goal, known concepts and evidence as data', () => {
  const prompt = makePrompt(DEFAULT_CONFIG.goal, DEMO_EVIDENCE, ['pub-sub']);
  assert.match(prompt, /untrusted data/);
  assert.ok(prompt.includes(JSON.stringify(DEMO_EVIDENCE)));
  assert.ok(prompt.includes(DEFAULT_CONFIG.goal.intent));
});
test('old goals upgrade in memory without losing settings, and malformed rationale is rejected', () => {
  const old = copy(DEFAULT_CONFIG); old.schemaVersion = 1; delete old.goal.why; old.automatic = false;
  const upgraded = parseConfig(JSON.stringify(old));
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.goal.why, '');
  assert.equal(upgraded.automatic, false);
  assert.throws(() => parseConfig(JSON.stringify({ ...DEFAULT_CONFIG, goal: { ...DEFAULT_CONFIG.goal, why: 2 } })));
});
test('learning records retain distinct feedback and retrieve only related goal evidence', () => {
  let records = updateRecords([], DEFAULT_CONFIG.goal.intent, DEMO_REPLY, 'opened', 10);
  records = updateRecords(records, DEFAULT_CONFIG.goal.intent, DEMO_REPLY, 'known', 20);
  assert.deepEqual(records[0].actions, ['opened', 'known']);
  assert.equal(records[0].example, DEMO_REPLY.quote);
  assert.deepEqual(parseRecords(JSON.stringify({ schemaVersion: 1, records })), records);
  assert.equal(relevantRecords(records, DEFAULT_CONFIG.goal.intent, DEMO_EVIDENCE).length, 1);
  assert.equal(relevantRecords(records, 'another goal', DEMO_EVIDENCE).length, 0);
  assert.equal(relevantRecords(records, DEFAULT_CONFIG.goal.intent, { text: 'Refactor typography and button colors.' }).length, 0);
  assert.throws(() => parseRecords('{"schemaVersion":1,"records":[{}]}'));
  assert.match(makePrompt({ ...DEFAULT_CONFIG.goal, why: 'Understand tradeoffs' }, DEMO_EVIDENCE, [], records), /Understand tradeoffs/);
});
