import { createRevisionedRecordStateStore } from '../../src/state/revisioned-record-state-store.js';

const [action, file, subject, payload] = process.argv.slice(2);

if (action != null) {
  try {
    const store = createRevisionedRecordStateStore(file);
    if (action === 'save') {
      const value = JSON.parse(payload);
      const result = await store.run(subject, (session) => session.save(value));
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (action === 'load') {
      const result = await store.run(subject, (session) => session.load());
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      throw new Error('fixture action is unsupported');
    }
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
