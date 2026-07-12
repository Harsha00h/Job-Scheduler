// Computes the delay before retry number `attempt` (1-based: the delay
// applied after the attempt-th failure). Always capped at maxDelayMs so
// exponential growth can't push retries out indefinitely.
function computeBackoffMs(strategy, baseDelayMs, maxDelayMs, attempt) {
  let delay;
  switch (strategy) {
    case 'fixed':
      delay = baseDelayMs;
      break;
    case 'linear':
      delay = baseDelayMs * attempt;
      break;
    case 'exponential':
      delay = baseDelayMs * 2 ** (attempt - 1);
      break;
    default:
      delay = baseDelayMs;
  }
  return Math.min(delay, maxDelayMs);
}

module.exports = { computeBackoffMs };
