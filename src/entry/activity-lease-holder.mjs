#!/usr/bin/env node
import { activityLeaseHolderReadyLine } from '../runtime/activity-lease-protocol.js';

if (process.argv.length !== 2) {
  process.exitCode = 64;
} else {
  let invalid = false;
  process.stdin.on('data', () => {
    invalid = true;
    process.exitCode = 64;
    process.stdin.destroy();
  });
  process.stdin.on('error', () => {
    process.exitCode = 1;
  });
  process.stdin.on('end', () => {
    if (!invalid) process.exitCode = 0;
  });
  process.stdout.write(activityLeaseHolderReadyLine(), (error) => {
    if (error) process.exitCode = 1;
    else process.stdin.resume();
  });
}
