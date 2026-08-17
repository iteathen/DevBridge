#!/usr/bin/env node

import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function collect(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collect(filename));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) result.push(filename);
  }
  return result.sort();
}

const files = collect(path.resolve("dist", "test"));
if (files.length === 0) {
  console.error("No compiled tests were found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
