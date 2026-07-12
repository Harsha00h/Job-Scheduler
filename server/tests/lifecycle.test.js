const { canTransition, TRANSITIONS } = require('../src/lib/lifecycle');

describe('job lifecycle state machine', () => {
  test('happy path: queued -> claimed -> running -> completed', () => {
    expect(canTransition('queued', 'claimed')).toBe(true);
    expect(canTransition('claimed', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
  });

  test('retry path: running -> scheduled -> claimed', () => {
    expect(canTransition('running', 'scheduled')).toBe(true);
    expect(canTransition('scheduled', 'claimed')).toBe(true);
  });

  test('permanent failure and DLQ replay', () => {
    expect(canTransition('running', 'dead')).toBe(true);
    expect(canTransition('dead', 'queued')).toBe(true);
  });

  test('terminal and illegal transitions are rejected', () => {
    expect(canTransition('completed', 'queued')).toBe(false);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('queued', 'running')).toBe(false); // must be claimed first
    expect(canTransition('dead', 'completed')).toBe(false);
  });

  test('cancellation is only possible before a worker picks the job up', () => {
    expect(canTransition('queued', 'cancelled')).toBe(true);
    expect(canTransition('scheduled', 'cancelled')).toBe(true);
    expect(canTransition('running', 'cancelled')).toBe(false);
  });

  test('every state in the map is reachable or initial', () => {
    const reachable = new Set(Object.values(TRANSITIONS).flat());
    reachable.add('queued').add('scheduled'); // initial states
    for (const state of Object.keys(TRANSITIONS)) {
      expect(reachable.has(state)).toBe(true);
    }
  });
});
