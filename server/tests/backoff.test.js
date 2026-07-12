const { computeBackoffMs } = require('../src/lib/backoff');

describe('computeBackoffMs', () => {
  test('fixed strategy returns the base delay for every attempt', () => {
    expect(computeBackoffMs('fixed', 2000, 60000, 1)).toBe(2000);
    expect(computeBackoffMs('fixed', 2000, 60000, 5)).toBe(2000);
  });

  test('linear strategy grows proportionally with the attempt number', () => {
    expect(computeBackoffMs('linear', 1000, 60000, 1)).toBe(1000);
    expect(computeBackoffMs('linear', 1000, 60000, 3)).toBe(3000);
  });

  test('exponential strategy doubles per attempt', () => {
    expect(computeBackoffMs('exponential', 1000, 600000, 1)).toBe(1000);
    expect(computeBackoffMs('exponential', 1000, 600000, 2)).toBe(2000);
    expect(computeBackoffMs('exponential', 1000, 600000, 5)).toBe(16000);
  });

  test('all strategies are capped at max_delay_ms', () => {
    expect(computeBackoffMs('exponential', 1000, 5000, 10)).toBe(5000);
    expect(computeBackoffMs('linear', 1000, 2500, 10)).toBe(2500);
    expect(computeBackoffMs('fixed', 9000, 5000, 1)).toBe(5000);
  });

  test('unknown strategy falls back to the base delay', () => {
    expect(computeBackoffMs('mystery', 1234, 60000, 3)).toBe(1234);
  });
});
