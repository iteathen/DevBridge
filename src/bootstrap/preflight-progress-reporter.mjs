// A projection of Node's public TestsStream, not a test/result interpreter.
// Never forward test names, paths, stdout, diagnostics, or assertion payloads.
// TAP remains the separate captured failure-evidence channel.
export default async function* preflightProgress(source) {
  const maximumMarks = 16 * 1024;
  let marks = 0;
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    if (marks === maximumMarks) {
      yield '\n[preflight progress display capped; tests continue within original deadline]\n';
      marks += 1;
    }
    if (marks > maximumMarks) continue;
    marks += 1;
    yield `${event.type === 'test:pass' ? '.' : 'X'}${marks % 20 === 0 ? '\n' : ''}`;
  }
  if (marks % 20 !== 0 && marks <= maximumMarks) yield '\n';
}
