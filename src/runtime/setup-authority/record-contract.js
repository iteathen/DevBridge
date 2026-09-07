export function createRecordContract({
  protocol,
  normalizeObject,
  rejectUnknown,
  normalizeIdentifier,
  normalizeTimestamp,
  normalizeRevision,
  normalizeValidation,
  normalizeSnapshot,
} = {}) {
  function normalizeWorking(raw, recordRevision) {
    const value = normalizeObject(raw, 'setup authority working generation');
    rejectUnknown(value, new Set(['operationId', 'baseRevision', 'snapshot', 'validation', 'updatedAt']), 'setup authority working generation');
    const baseRevision = normalizeRevision(value.baseRevision, 'setup authority working baseRevision');
    if (baseRevision > recordRevision) throw new TypeError('setup authority working baseRevision is newer than accepted state');
    return Object.freeze({
      operationId: normalizeIdentifier(value.operationId, 'setup authority operationId'),
      baseRevision,
      snapshot: normalizeSnapshot(value.snapshot),
      validation: normalizeValidation(value.validation),
      updatedAt: normalizeTimestamp(value.updatedAt, 'setup authority working timestamp'),
    });
  }

  function normalizeRecord(raw) {
    const value = normalizeObject(raw, 'setup authority record');
    rejectUnknown(value, new Set(['protocol', 'revision', 'accepted', 'working', 'updatedAt']), 'setup authority record');
    if (value.protocol !== protocol) throw new TypeError('setup authority record protocol is unsupported');
    const revision = normalizeRevision(value.revision, 'setup authority revision');
    const accepted = value.accepted == null ? null : normalizeSnapshot(value.accepted);
    if (revision === 0 && accepted !== null) throw new TypeError('setup authority revision zero cannot have accepted state');
    if (revision > 0 && accepted === null) throw new TypeError('setup authority accepted state is missing for its revision');
    return Object.freeze({
      protocol,
      revision,
      accepted,
      working: value.working == null ? null : normalizeWorking(value.working, revision),
      updatedAt: normalizeTimestamp(value.updatedAt, 'setup authority record timestamp'),
    });
  }

  return Object.freeze({ normalizeRecord });
}
