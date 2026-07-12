// Minimal structured logger: one JSON object per line so output can be
// shipped to any log aggregator without parsing free-form text.
function log(level, msg, meta) {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  debug: (msg, meta) => {
    if (process.env.LOG_LEVEL === 'debug') log('debug', msg, meta);
  },
};
