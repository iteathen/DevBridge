#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { bootstrap } from './src/bootstrap/secure-bootstrap.mjs';

export * from './src/bootstrap/secure-bootstrap.mjs';

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  bootstrap().then((status) => { process.exitCode = status; }).catch((error) => {
    process.stderr.write(`[devbridge-bootstrap] ${error.message}\n`);
    process.exitCode = 1;
  });
}
