function stableSubject(value, name) {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw new TypeError(`${name} must be a numeric stable identity`);
  return value;
}

export class RouteAccess {
  #policy;
  #identify;
  #select;
  #list;
  #root;
  #canonicalize;
  #inspect;
  #messages;

  constructor({ policy, identify, select, list, root, canonicalize, inspect, messages }) {
    this.#policy = policy;
    this.#identify = identify;
    this.#select = select;
    this.#list = list;
    this.#root = root;
    this.#canonicalize = canonicalize;
    this.#inspect = inspect;
    this.#messages = { ...messages };
  }

  async resolve(scope) {
    const subject = stableSubject(await this.#identify(structuredClone(scope)), this.#messages.subjectName);
    const route = this.#select(this.#policy, subject);
    const matches = (await this.#list()).filter((entry) => entry.record?.subject === subject && entry.record?.profile === route.profile);
    if (matches.length !== 1) throw new Error(matches.length === 0 ? this.#messages.absent : this.#messages.ambiguous);
    const selected = matches[0];
    if (!selected.observation?.exists || !selected.observation?.owned || !selected.observation?.compatible) {
      throw new Error(selected.observation?.reason ?? this.#messages.unavailable);
    }
    const root = await this.#canonicalize(await this.#root(structuredClone(scope)));
    const info = await this.#inspect(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(this.#messages.invalidRoot);
    return { subject, route, target: selected.record.identity, root };
  }
}
