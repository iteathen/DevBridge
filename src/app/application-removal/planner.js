import { createHash } from 'node:crypto';
import {
  APPLICATION_REMOVAL_PROTOCOL,
  normalizeRemovalSnapshot,
  removalMode,
} from './contract.js';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function allowedScope(scope, mode) {
  return mode === 'purge' || scope === 'payload';
}

function baseReasons(item, snapshot, mode, complete) {
  const reasons = [];
  if (!complete) reasons.push('coverage-incomplete');
  if (snapshot.mutationActive) reasons.push('mutation-active');
  if (item.provenance === 'foreign') reasons.push('foreign');
  if (!allowedScope(item.scope, mode)) reasons.push('outside-mode');
  if (item.protections.length > 0) reasons.push('protected');
  if (item.references.some((identity) => snapshot.protectedReferences.includes(identity))) reasons.push('referenced');
  return reasons;
}

function selectItems(snapshot, mode, complete) {
  const reasons = new Map(snapshot.items.map((item) => [item.identity, baseReasons(item, snapshot, mode, complete)]));
  const selected = new Set(snapshot.items.filter((item) => reasons.get(item.identity).length === 0).map((item) => item.identity));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of snapshot.items) {
      if (!selected.has(item.identity)) continue;
      if (item.after.some((identity) => !selected.has(identity))) {
        selected.delete(item.identity);
        reasons.get(item.identity).push('dependency-preserved');
        changed = true;
      }
    }
  }
  return { selected, reasons };
}

function orderedItems(items, selected) {
  const byIdentity = new Map(items.map((item) => [item.identity, item]));
  const remaining = new Set(selected);
  const ordered = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((identity) => byIdentity.get(identity).after.every((dependency) => !remaining.has(dependency)))
      .sort((left, right) => left.localeCompare(right));
    if (ready.length === 0) throw new TypeError('removal item dependency graph contains a cycle');
    for (const identity of ready) {
      ordered.push(byIdentity.get(identity));
      remaining.delete(identity);
    }
  }
  return Object.freeze(ordered);
}

function planItem(item, reasons = []) {
  return Object.freeze({
    identity: item.identity,
    scope: item.scope,
    provenance: item.provenance,
    reasons: Object.freeze([...reasons].sort((left, right) => left.localeCompare(right))),
    effectCount: item.effects.length,
    estimatedBytes: item.effects.reduce((total, effect) => total + effect.bytes, 0),
  });
}

export function createRemovalPlan(rawSnapshot, rawMode) {
  const snapshot = normalizeRemovalSnapshot(rawSnapshot);
  const mode = removalMode(rawMode);
  const complete = snapshot.coverage.includes(mode);
  const { selected, reasons } = selectItems(snapshot, mode, complete);
  const ordered = orderedItems(snapshot.items, selected);
  const chosen = Object.freeze(ordered.map((item) => planItem(item)));
  const preserved = Object.freeze(snapshot.items
    .filter((item) => !selected.has(item.identity))
    .map((item) => planItem(item, reasons.get(item.identity)))
    .sort((left, right) => left.identity.localeCompare(right.identity)));
  const effects = Object.freeze(ordered.flatMap((item) => item.effects.map((effect) => Object.freeze({
    item: item.identity,
    identity: effect.identity,
    bytes: effect.bytes,
    terminal: effect.terminal,
  }))));
  const authority = Object.freeze({
    protocol: APPLICATION_REMOVAL_PROTOCOL,
    mode,
    generation: snapshot.generation,
    coverage: snapshot.coverage,
    mutationActive: snapshot.mutationActive,
    protectedReferences: snapshot.protectedReferences,
    items: snapshot.items,
  });
  return Object.freeze({
    authority,
    digest: sha256(authority),
    complete,
    ready: complete && !snapshot.mutationActive,
    selected: chosen,
    preserved,
    effects,
  });
}

export function publicRemovalPlan(plan) {
  return Object.freeze({
    protocol: APPLICATION_REMOVAL_PROTOCOL,
    mode: plan.authority.mode,
    generation: plan.authority.generation,
    digest: plan.digest,
    complete: plan.complete,
    ready: plan.ready,
    selected: plan.selected,
    preserved: plan.preserved,
    effectCount: plan.effects.length,
    estimatedBytes: plan.effects.reduce((total, effect) => total + effect.bytes, 0),
  });
}
