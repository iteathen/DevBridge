export class Redactor {
  readonly #values: readonly string[];
  readonly #roots: readonly string[];

  constructor(values: readonly string[], roots: readonly string[] = []) {
    this.#values = [...new Set(values.filter((value) => value.length >= 4))].sort((a, b) => b.length - a.length);
    this.#roots = [...new Set(roots.filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
  }

  redact(input: string): string {
    let result = input;
    for (const value of this.#values) result = result.split(value).join("[REDACTED]");
    for (const root of this.#roots) result = result.split(root).join("[LOCAL_ROOT]");
    return result;
  }
}
