export class FinalizationPolicy {
  identityChanged(observed, verified) {
    const observedBase = observed.publicationBaseSha ?? observed.baseSha;
    const verifiedBase = verified.publicationBaseSha ?? verified.baseSha;
    return observed.dirty || observed.headSha !== verified.headSha || observedBase !== verifiedBase;
  }

  publication({ snapshot, enabled, alreadyPublished, alreadySkipped, forceEmpty }) {
    if (!enabled || alreadyPublished || alreadySkipped) return { kind: 'none' };
    const baseSha = snapshot.publicationBaseSha ?? snapshot.baseSha;
    const empty = snapshot.headSha === baseSha && snapshot.changedFiles.length === 0;
    return empty && !forceEmpty
      ? { kind: 'skip', baseSha }
      : { kind: 'publish', baseSha, expectedHeadSha: snapshot.headSha };
  }

  completion({ snapshot, branch, automatic, publication }) {
    const baseSha = snapshot.publicationBaseSha ?? snapshot.baseSha;
    let summary;
    if (publication?.skipped) {
      summary = `Completed and verified ${snapshot.headSha}; publication skipped because there is no project diff.`;
    } else if (automatic) {
      summary = `Completed, sealed candidate ${snapshot.headSha}, and published task branch ${branch}.`;
    } else {
      summary = `Completed and sealed candidate ${snapshot.headSha} on local task branch ${branch}; automatic push is disabled.`;
    }
    return {
      summary,
      baseSha,
      changedFiles: snapshot.changedFiles,
      published: publication?.published === true,
      skipped: publication?.skipped === true,
      reason: publication?.reason ?? null,
    };
  }
}
