const OUTPUT_LIMIT = 8_000;
const EDITOR_LIMIT = 20;

export function boundedOutput({ stdout, stderr }) {
  const value = [stdout, stderr].filter(Boolean).join('\n');
  return value.length <= OUTPUT_LIMIT ? value : value.slice(-OUTPUT_LIMIT);
}

export function projectCandidateIdentity(snapshot) {
  if (!snapshot) return null;
  return {
    branch: snapshot.branch,
    baseSha: snapshot.baseSha,
    publicationBaseSha: snapshot.publicationBaseSha ?? snapshot.baseSha,
    headSha: snapshot.headSha,
    dirty: snapshot.dirty,
  };
}

export function projectContentEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  return {
    verified: evidence.verified === true,
    reason: evidence.reason ?? null,
    contentSha256: evidence.contentSha256 ?? null,
    creatorActorId: evidence.creatorActorId ?? null,
    currentEditorActorId: evidence.currentEditorActorId ?? null,
    editorActorIds: Array.isArray(evidence.editorActorIds) ? evidence.editorActorIds.slice(0, EDITOR_LIMIT) : [],
    editCount: Number.isInteger(evidence.editCount) ? evidence.editCount : null,
    redactedEditCount: Number.isInteger(evidence.redactedEditCount) ? evidence.redactedEditCount : null,
    historyComplete: evidence.historyComplete === true,
    lastEditedAt: evidence.lastEditedAt ?? null,
  };
}
