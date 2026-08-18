import { createHash } from 'node:crypto';

function utf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateText(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 32))}\n...[truncated by PATCH-POLLER]`;
}

function handoffDigest(value) {
  if (typeof value !== 'string') return null;
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function buildContextCapsule({ task, sequence = 1, prior = null, runtime = {} }) {
  const context = task.envelope.context ?? {};
  const handoff = typeof context.handoff === 'string' ? context.handoff : null;
  return {
    protocol: 'patch-poller/context-v1',
    sequence,
    task: {
      queueRepository: task.queueRepository,
      issueNumber: task.issueNumber,
      revision: task.revision,
      targetRepository: task.envelope.target.repository
    },
    objective: task.envelope.instructions,
    constraints: Array.isArray(context.constraints) ? context.constraints : [],
    priorSummary: context.summary ?? prior?.summary ?? null,
    handoff,
    handoffSha256: handoffDigest(handoff),
    decisions: prior?.decisions ?? [],
    progress: prior?.progress ?? [],
    changedFiles: runtime.changedFiles ?? prior?.changedFiles ?? [],
    tests: runtime.tests ?? prior?.tests ?? [],
    git: runtime.git ?? prior?.git ?? null,
    blockers: runtime.blockers ?? prior?.blockers ?? [],
    nextStep: runtime.nextStep ?? prior?.nextStep ?? null,
    outputTail: runtime.outputTail ?? null,
    provenance: [
      { source: 'github-issue', actorId: task.actorId, issueNumber: task.issueNumber },
      { source: 'local-policy', note: 'capabilities are granted only by local operator configuration' }
    ],
    generatedAt: new Date().toISOString()
  };
}

export function fitContextCapsule(capsule, maxBytes = 48_000) {
  const copy = structuredClone(capsule);
  if (utf8Bytes(copy) <= maxBytes) return copy;

  copy.outputTail = truncateText(copy.outputTail, 4_000);
  copy.objective = truncateText(copy.objective, 16_000);
  copy.priorSummary = truncateText(copy.priorSummary, 4_000);

  for (const key of ['decisions', 'progress', 'changedFiles', 'tests', 'blockers']) {
    if (Array.isArray(copy[key]) && copy[key].length > 20) copy[key] = copy[key].slice(-20);
  }

  while (utf8Bytes(copy) > maxBytes && copy.progress?.length > 1) copy.progress.shift();
  while (utf8Bytes(copy) > maxBytes && copy.decisions?.length > 1) copy.decisions.shift();
  while (utf8Bytes(copy) > maxBytes && copy.tests?.length > 1) copy.tests.shift();
  while (utf8Bytes(copy) > maxBytes && copy.blockers?.length > 1) copy.blockers.shift();
  if (utf8Bytes(copy) > maxBytes) copy.outputTail = null;
  if (utf8Bytes(copy) > maxBytes) copy.priorSummary = truncateText(copy.priorSummary, 1_000);
  if (utf8Bytes(copy) > maxBytes) copy.objective = truncateText(copy.objective, 4_000);
  if (utf8Bytes(copy) > maxBytes) copy.tests = [];
  if (utf8Bytes(copy) > maxBytes) copy.progress = [];
  if (utf8Bytes(copy) > maxBytes) copy.decisions = [];

  copy.compacted = true;
  copy.digest = createHash('sha256').update(JSON.stringify(capsule)).digest('hex');
  return copy;
}
