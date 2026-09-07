function sourceFrom(value) {
  const bytes = Buffer.from(value);
  return {
    async read({ offset, limit }) {
      const end = Math.min(bytes.length, offset + limit);
      return { data: bytes.subarray(offset, end), eof: end === bytes.length };
    },
  };
}

function sinkFor(limit) {
  let value = null;
  return {
    port: {
      async write({ data, eof }) {
        if (!eof) throw new Error('buffer sink requires a complete transfer');
        const bytes = Buffer.from(data);
        if (bytes.length > limit) throw new Error('buffer sink exceeded its limit');
        value = bytes;
      },
    },
    value() {
      if (value == null) throw new Error('buffer sink did not receive data');
      return value;
    },
  };
}

function inputFrom(port) {
  let bytes = null;
  return {
    async read({ offset, limit }) {
      if (bytes == null) bytes = Buffer.from(await port.read());
      const end = Math.min(bytes.length, offset + limit);
      return { data: bytes.subarray(offset, end), eof: end === bytes.length };
    },
  };
}

function outputTo(port, limit, messages) {
  const chunks = [];
  let offset = 0;
  return {
    async write(frame) {
      const data = Buffer.from(frame?.data ?? frame);
      if (frame?.offset != null && frame.offset !== offset) throw new Error(messages.offset);
      offset += data.length;
      if (offset > limit) throw new Error(messages.limit);
      chunks.push(data);
      if (frame?.eof !== false) await port.write(Buffer.concat(chunks));
    },
  };
}

export class ByteChannel {
  #target;
  #put;
  #get;
  #limit;
  #messages;

  constructor({ target, put, get, limit, messages = {} }) {
    this.#target = target;
    this.#put = put;
    this.#get = get;
    this.#limit = limit;
    this.#messages = {
      offset: messages.offset ?? 'output transfer offset is not contiguous',
      limit: messages.limit ?? 'output transfer exceeded its limit',
    };
  }

  async write(bytes, destination) {
    const value = Buffer.from(bytes);
    return this.#put(this.#target, sourceFrom(value), destination, { maxBytes: Math.max(1, value.length) });
  }

  async read(source, limit) {
    const sink = sinkFor(limit);
    await this.#get(this.#target, source, sink.port, { maxBytes: limit });
    return sink.value();
  }

  async ingest(port, destination, { maxBytes = this.#limit } = {}) {
    return this.#put(this.#target, inputFrom(port), destination, { maxBytes });
  }

  async stream(source, destination, { maxBytes = this.#limit } = {}) {
    return this.#put(this.#target, source, destination, { maxBytes });
  }

  async emit(source, port, { maxBytes = this.#limit } = {}) {
    return this.#get(this.#target, source, outputTo(port, maxBytes, this.#messages), { maxBytes });
  }
}
