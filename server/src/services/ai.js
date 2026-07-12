// AI-generated failure summaries. Provider chain: Claude (ANTHROPIC_API_KEY)
// -> Gemini (GEMINI_API_KEY) -> deterministic heuristic, so the feature
// degrades gracefully with whatever credentials are available.
const config = require('../config');
const { query } = require('../db');

const SYSTEM_PROMPT =
  'You are an SRE assistant embedded in a job scheduler dashboard. ' +
  'Summarize the failure data you are given: group related failures, name the ' +
  'likely root causes, and suggest 1-3 concrete next steps. Be brief and concrete.';

function failureSample(failures) {
  return failures.slice(0, 50).map((f) => ({
    type: f.type,
    queue: f.queue_name,
    outcome: f.status,
    error: f.error,
    attempt: f.attempt,
  }));
}

async function recentFailures(projectId) {
  const { rows } = await query(
    `SELECT j.type, q.name AS queue_name, e.status, e.error, e.attempt, e.finished_at
     FROM job_executions e
     JOIN jobs j ON j.id = e.job_id
     JOIN queues q ON q.id = j.queue_id
     WHERE q.project_id = $1
       AND e.status IN ('failed', 'timed_out', 'lost')
       AND e.finished_at > now() - interval '24 hours'
     ORDER BY e.finished_at DESC
     LIMIT 200`,
    [projectId]
  );
  return rows;
}

function heuristicSummary(failures) {
  if (!failures.length) {
    return 'No failed executions in the last 24 hours.';
  }
  const byError = new Map();
  const byQueue = new Map();
  for (const f of failures) {
    const key = `${f.type}: ${f.error || f.status}`;
    byError.set(key, (byError.get(key) || 0) + 1);
    byQueue.set(f.queue_name, (byQueue.get(f.queue_name) || 0) + 1);
  }
  const topErrors = [...byError.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const queues = [...byQueue.entries()].map(([q, n]) => `${q} (${n})`).join(', ');
  return [
    `${failures.length} failed executions in the last 24 hours across queues: ${queues}.`,
    'Most frequent failures:',
    ...topErrors.map(([msg, n]) => `- ${n}x ${msg}`),
  ].join('\n');
}

async function claudeSummary(failures) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Failed job executions from the last 24 hours (JSON):\n${JSON.stringify(failureSample(failures), null, 2)}`,
      },
    ],
  });
  const text = response.content.find((block) => block.type === 'text');
  return text ? text.text : heuristicSummary(failures);
}

async function geminiSummary(failures) {
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            parts: [
              {
                text: `Failed job executions from the last 24 hours (JSON):\n${JSON.stringify(failureSample(failures), null, 2)}`,
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 1024 },
      }),
    }
  );
  if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) throw new Error('Gemini returned no text');
  return text;
}

async function summarizeFailures(projectId) {
  const failures = await recentFailures(projectId);
  const providers = [
    config.anthropicApiKey && { name: 'claude', run: claudeSummary },
    config.geminiApiKey && { name: 'gemini', run: geminiSummary },
  ].filter(Boolean);

  if (failures.length) {
    for (const provider of providers) {
      try {
        return {
          summary: await provider.run(failures),
          source: provider.name,
          failure_count: failures.length,
        };
      } catch {
        // try the next provider, ultimately the heuristic
      }
    }
  }
  return { summary: heuristicSummary(failures), source: 'heuristic', failure_count: failures.length };
}

module.exports = { summarizeFailures };
