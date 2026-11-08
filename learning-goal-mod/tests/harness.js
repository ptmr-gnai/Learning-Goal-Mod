// Independent simulator of the APIs we use. This is not Claude Code's validator
// or test kit; it exercises the actual hooks with deterministic inputs.
import { copy, DEMO_REPLY } from '../lib/core.js';

let instance = 0;
export async function harness(options = {}) {
  const { register } = await import('../hooks/register.js?test=' + (++instance));
  const hooks = [];
  const files = options.files ?? new Map();
  const store = options.store ?? new Map();
  const timers = [];
  const calls = { forks: [], fills: [], panes: [], commands: [], passed: [], invalidations: 0 };
  let now = 1_000_000;
  let draft = '';
  let model = options.model ?? (() => ({ text: JSON.stringify({ ...DEMO_REPLY, evidenceRef: 'turn-1' }), usage: { output_tokens: 50 } }));
  let failWrites = false;
  const elements = Object.fromEntries(['Box', 'Text', 'Button', 'Input'].map(type => [type, props => ({ type, ...props })]));
  const $ = {
    session: { id: async () => 'test-session' },
    env: { get: async () => '/test-home' },
    fs: {
      exists: async path => files.has(path),
      read: async path => { if (!files.has(path)) throw Error('missing'); return files.get(path); },
      write: async (path, text) => { if (failWrites) throw Error('disk full'); files.set(path, text); },
    },
    store: {
      get: async key => store.has(key) ? copy(store.get(key)) : undefined,
      set: async (key, value) => { store.set(key, copy(value)); },
      keys: async () => [...store.keys()], delete: async key => { store.delete(key); },
    },
    clock: {
      now: async () => now,
      every: (ms, fn) => { const t = { ms, fn, active: true, cancel() { this.active = false; } }; timers.push(t); return t; },
      after: (ms, fn) => { const t = { ms, fn, once: true, active: true, cancel() { this.active = false; } }; timers.push(t); return t; },
    },
    prompt: { read: async () => ({ text: draft, cursor: draft.length }),
      fill: async args => { calls.fills.push(args); draft += args.text; return { isFilled: true, text: draft }; } },
    command: { register: async args => { calls.commands.push(args); } },
    model: { fork: async args => { calls.forks.push(args); return model(args); } },
    ui: {
      invalidate: () => { calls.invalidations++; }, resolve: () => elements,
      open: async args => { calls.panes.push(args); }, close: async () => {},
    },
  };
  const on = (name, matcher, fn) => {
    if (typeof matcher === 'function') { fn = matcher; matcher = {}; }
    hooks.push({ name, matcher, fn });
    return { catch() {} };
  };
  register(on, {});
  async function fire(name, event = {}, bottom = undefined) {
    const matches = hooks.filter(h => h.name === name && Object.entries(h.matcher).every(([key, value]) =>
      Array.isArray(value) ? value.includes(event[key]) : value === event[key]));
    const run = async i => i === matches.length ? (calls.passed.push(name), bottom) : matches[i].fn($, event, e => run(i + 1));
    return run(0);
  }
  async function render(component = 'Pane', surface = 'terminal', props = {}, bottom = undefined) {
    return fire('ui.render', { component, surface, requestId: component === 'Pane' ? 'learning-goal-mod' : 'band',
      props: { hasSurvey: false, isWorking: false, ...props } }, bottom);
  }
  async function press(key) {
    const tree = await render();
    const b = find(tree, node => node.key === key);
    if (!b) throw Error('No button ' + key);
    await b.onPress();
    await flush();
  }
  const h = {
    $, files, store, calls, fire, render, press,
    command: args => fire('command.run', { command: 'learning-goal', args }),
    tick: async () => { for (const timer of timers.filter(t => t.active)) { if (timer.once) timer.active = false; timer.fn(); } await flush(); },
    advance: ms => { now += ms; }, setDraft: text => { draft = text; },
    setModel: fn => { model = fn; }, failWrites: flag => { failWrites = flag; },
    complete: answer => fire('turn.complete', { answer, turnId: 'main-1', isAborted: false }),
  };
  await fire('session.start');
  return h;
}
export function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined;
  if (predicate(tree)) return tree;
  for (const child of tree.children ?? []) { const found = find(child, predicate); if (found) return found; }
}
export function textOf(tree) {
  if (typeof tree === 'string') return tree;
  return (tree?.children ?? []).map(textOf).join('\n');
}
export async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
