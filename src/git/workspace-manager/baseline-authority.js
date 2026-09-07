const SHA_RE = /^[0-9a-f]{40}$/u;

export class BaselineAuthority {
  #run;
  #channels;
  #defaultChannel;
  #errors;

  constructor({ run, channels, defaultChannel, errors }) {
    this.#run = run;
    this.#channels = { ...channels };
    this.#defaultChannel = defaultChannel;
    this.#errors = { ...errors };
  }

  async select(record, requestedChannel) {
    const channel = requestedChannel ?? this.#defaultChannel;
    if (!channel) return { baseRef: record.baseRef, baseSha: record.baseSha, baselineChannel: null };
    const branch = this.#channels[channel];
    if (!branch) throw this.#errors.unauthorized(channel);
    const baseRef = `origin/${branch}`;
    const resolved = await this.#run(['rev-parse', '--verify', `${baseRef}^{commit}`], {
      cwd: record.repoDir,
      allowFailure: true,
    });
    const baseSha = resolved.stdout.trim().toLowerCase();
    if (resolved.exitCode !== 0 || !SHA_RE.test(baseSha)) throw this.#errors.unavailable(channel, record.repository);
    return { baseRef, baseSha, baselineChannel: channel };
  }

  async observe(record, state) {
    const baseRef = state.baseRef;
    if (state.baselineChannel) {
      const branch = this.#channels[state.baselineChannel];
      if (!branch) throw this.#errors.noLongerAuthorized(state.baselineChannel);
      if (baseRef !== `origin/${branch}`) throw this.#errors.channelMismatch();
    }
    if (typeof baseRef !== 'string' || !baseRef.startsWith('origin/')) throw this.#errors.invalidReference();
    const resolved = await this.#run(['rev-parse', '--verify', `${baseRef}^{commit}`], {
      cwd: record.repoDir,
      allowFailure: true,
    });
    const baseSha = resolved.stdout.trim().toLowerCase();
    if (resolved.exitCode !== 0 || !SHA_RE.test(baseSha)) throw this.#errors.persistedUnavailable(baseRef, record.repository);
    return { baseRef, baseSha };
  }
}
