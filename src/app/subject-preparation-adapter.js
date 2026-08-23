const SUBJECT = /^subject-[a-f0-9]{32}$/u;

function requireSubjectWork(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('subject preparation work must be an object');
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== 'subject') throw new TypeError('subject preparation work must contain only subject');
  if (typeof raw.subject !== 'string' || !SUBJECT.test(raw.subject)) throw new TypeError('subject preparation subject is invalid');
  return raw.subject;
}

function requireIdentityResult(raw, subject, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.identity !== subject) throw new Error(`${name} identity changed`);
  return raw;
}

export function createSubjectPreparationAdapter({ resolve, apply } = {}) {
  if (typeof resolve !== 'function') throw new TypeError('subject preparation resolver must be a function');
  if (typeof apply !== 'function') throw new TypeError('subject preparation effect must be a function');

  return Object.freeze({
    async prepare(rawWork) {
      const subject = requireSubjectWork(rawWork);
      const request = requireIdentityResult(await resolve(subject), subject, 'subject preparation resolution');
      return requireIdentityResult(await apply(request), subject, 'subject preparation');
    },
  });
}