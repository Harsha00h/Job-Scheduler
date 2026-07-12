// Single source of truth for the job state machine.
// queued/scheduled -> claimed -> running -> completed | scheduled (retry) | dead
const TRANSITIONS = {
  queued: ['claimed', 'cancelled'],
  scheduled: ['claimed', 'queued', 'cancelled'],
  claimed: ['running', 'queued'], // back to queued if the worker dies before starting
  running: ['completed', 'scheduled', 'dead', 'queued'], // queued = requeued after worker loss
  completed: [],
  dead: ['queued'], // DLQ replay
  cancelled: ['queued'], // manual retry
};

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

module.exports = { TRANSITIONS, canTransition };
