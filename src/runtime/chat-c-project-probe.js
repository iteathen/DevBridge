import { spawn } from 'node:child_process';
import { access, constants, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveExecutable } from './executable-resolver.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

export const CHAT_C_PROJECT_RELATIVE = 'scratch-projects/hello-telemetry-c-002';

const OUTPUT_LIMIT = 256 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;

const PROJECT_FILES = Object.freeze({
  'CMakeLists.txt': String.raw`cmake_minimum_required(VERSION 3.16)
project(hello_telemetry_c_002 C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_library(telemetry_core
    src/cli.c
    src/generator.c
    src/prng.c
)

target_include_directories(telemetry_core
    PUBLIC
        src
)

add_executable(hello-telemetry src/main.c)
target_link_libraries(hello-telemetry PRIVATE telemetry_core)

add_executable(hello-telemetry-tests tests/test_telemetry.c)
target_link_libraries(hello-telemetry-tests PRIVATE telemetry_core)

enable_testing()
add_test(NAME hello-telemetry-tests COMMAND hello-telemetry-tests)

install(TARGETS hello-telemetry DESTINATION bin)
`,
  'README.md': String.raw`# hello-telemetry-c-002

A small C11 "Hello Telemetry" program authored by the chat-only controller and materialized/tested by PATCH-POLLER without a coding-model invocation.

The executable prints a friendly banner followed by deterministic NDJSON sensor fixtures. Identical seed/count arguments produce byte-for-byte identical output.

## Build

From the repository root:

    cmake -S scratch-projects/hello-telemetry-c-002 -B scratch-projects/hello-telemetry-c-002/build
    cmake --build scratch-projects/hello-telemetry-c-002/build --config Debug
    ctest --test-dir scratch-projects/hello-telemetry-c-002/build --output-on-failure -C Debug

For single-config generators, the executable is normally build/hello-telemetry. For Visual Studio multi-config generators it is normally build/Debug/hello-telemetry.exe.

## Run

    hello-telemetry --count 4 --seed 42

Options:

- --count / -n: 1 through 256 records; default 8
- --seed / -s: unsigned 64-bit integer; default 20260818
- --help / -h: usage, exit 0

Invalid or overflowing numeric input exits 2.

## Output

The banner is followed by one compact JSON object per record. Each record contains:

- seq
- device
- temp_mC
- voltage_mV
- signal_dBm
- status
- zone
- timestamp_ms

Integer milli-units are used deliberately so deterministic output does not depend on floating-point formatting or locale.

For seed 42, the first generated record is fixed by the tests and begins with device flux-191.
`,
  'src/telemetry.h': String.raw`#ifndef HELLO_TELEMETRY_H
#define HELLO_TELEMETRY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define TELEMETRY_MAX_COUNT 256u
#define TELEMETRY_DEFAULT_COUNT 8u
#define TELEMETRY_DEFAULT_SEED UINT64_C(20260818)

typedef enum {
    TELEMETRY_PARSE_OK = 0,
    TELEMETRY_PARSE_HELP = 1,
    TELEMETRY_PARSE_ERROR = 2
} telemetry_parse_result_t;

typedef struct {
    uint32_t count;
    uint64_t seed;
} telemetry_options_t;

typedef struct {
    uint64_t state;
} telemetry_rng_t;

typedef struct {
    uint32_t seq;
    char device[24];
    int32_t temp_mC;
    uint16_t voltage_mV;
    int16_t signal_dBm;
    const char *status;
    const char *zone;
    uint64_t timestamp_ms;
} telemetry_record_t;

telemetry_parse_result_t telemetry_parse_args(
    int argc,
    char **argv,
    telemetry_options_t *out,
    char *error,
    size_t error_capacity
);
void telemetry_print_usage(FILE *stream, const char *program_name);

void telemetry_rng_seed(telemetry_rng_t *rng, uint64_t seed);
uint64_t telemetry_rng_next(telemetry_rng_t *rng);
uint64_t telemetry_rng_range(telemetry_rng_t *rng, uint64_t min_inclusive, uint64_t max_inclusive);

bool telemetry_generate(
    const telemetry_options_t *options,
    telemetry_record_t *records,
    size_t capacity,
    size_t *actual_count
);
bool telemetry_format_record(const telemetry_record_t *record, char *buffer, size_t capacity);
void telemetry_print_banner(FILE *stream, const telemetry_options_t *options);

#endif
`,
  'src/prng.c': String.raw`#include "telemetry.h"

void telemetry_rng_seed(telemetry_rng_t *rng, uint64_t seed) {
    rng->state = seed;
}

uint64_t telemetry_rng_next(telemetry_rng_t *rng) {
    uint64_t z = (rng->state += UINT64_C(0x9E3779B97F4A7C15));
    z = (z ^ (z >> 30)) * UINT64_C(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)) * UINT64_C(0x94D049BB133111EB);
    return z ^ (z >> 31);
}

uint64_t telemetry_rng_range(telemetry_rng_t *rng, uint64_t min_inclusive, uint64_t max_inclusive) {
    if (max_inclusive <= min_inclusive) {
        return min_inclusive;
    }
    const uint64_t span = (max_inclusive - min_inclusive) + UINT64_C(1);
    return min_inclusive + (telemetry_rng_next(rng) % span);
}
`,
  'src/cli.c': String.raw`#include "telemetry.h"

#include <errno.h>
#include <inttypes.h>
#include <stdlib.h>
#include <string.h>

static void set_error(char *error, size_t capacity, const char *message) {
    if (error != NULL && capacity > 0) {
        snprintf(error, capacity, "%s", message);
    }
}

static bool parse_u64_strict(const char *text, uint64_t *out) {
    if (text == NULL || text[0] == '\0' || text[0] == '-' || text[0] == '+') {
        return false;
    }

    errno = 0;
    char *end = NULL;
    const unsigned long long parsed = strtoull(text, &end, 10);
    if (errno == ERANGE || end == text || end == NULL || *end != '\0') {
        return false;
    }
    if (parsed > UINT64_MAX) {
        return false;
    }

    *out = (uint64_t)parsed;
    return true;
}

void telemetry_print_usage(FILE *stream, const char *program_name) {
    fprintf(stream, "Usage: %s [--count N] [--seed S]\n", program_name);
    fprintf(stream, "  --count, -n  records in [1,256] (default 8)\n");
    fprintf(stream, "  --seed,  -s  unsigned 64-bit seed (default 20260818)\n");
    fprintf(stream, "  --help,  -h  show this help\n");
}

telemetry_parse_result_t telemetry_parse_args(
    int argc,
    char **argv,
    telemetry_options_t *out,
    char *error,
    size_t error_capacity
) {
    if (out == NULL) {
        set_error(error, error_capacity, "missing options output");
        return TELEMETRY_PARSE_ERROR;
    }

    out->count = TELEMETRY_DEFAULT_COUNT;
    out->seed = TELEMETRY_DEFAULT_SEED;
    if (error != NULL && error_capacity > 0) {
        error[0] = '\0';
    }

    for (int index = 1; index < argc; ++index) {
        const char *arg = argv[index];
        if (strcmp(arg, "--help") == 0 || strcmp(arg, "-h") == 0) {
            return TELEMETRY_PARSE_HELP;
        }

        if (strcmp(arg, "--count") == 0 || strcmp(arg, "-n") == 0) {
            if (++index >= argc) {
                set_error(error, error_capacity, "missing --count value");
                return TELEMETRY_PARSE_ERROR;
            }
            uint64_t value = 0;
            if (!parse_u64_strict(argv[index], &value) || value < 1 || value > TELEMETRY_MAX_COUNT) {
                set_error(error, error_capacity, "invalid --count value; expected 1..256");
                return TELEMETRY_PARSE_ERROR;
            }
            out->count = (uint32_t)value;
            continue;
        }

        if (strcmp(arg, "--seed") == 0 || strcmp(arg, "-s") == 0) {
            if (++index >= argc) {
                set_error(error, error_capacity, "missing --seed value");
                return TELEMETRY_PARSE_ERROR;
            }
            uint64_t value = 0;
            if (!parse_u64_strict(argv[index], &value)) {
                set_error(error, error_capacity, "invalid --seed value; expected unsigned 64-bit integer");
                return TELEMETRY_PARSE_ERROR;
            }
            out->seed = value;
            continue;
        }

        set_error(error, error_capacity, "unknown argument");
        return TELEMETRY_PARSE_ERROR;
    }

    return TELEMETRY_PARSE_OK;
}
`,
  'src/generator.c': String.raw`#include "telemetry.h"

#include <inttypes.h>
#include <stdio.h>

static const char *const DEVICE_PREFIXES[] = {
    "atlas", "boreal", "comet", "delta", "ember", "flux", "gaia", "helix"
};

static const char *const STATUSES[] = {
    "nominal", "warning", "degraded", "offline"
};

static const char *const ZONES[] = {
    "lab-north", "lab-south", "field-east", "field-west", "bench"
};

bool telemetry_generate(
    const telemetry_options_t *options,
    telemetry_record_t *records,
    size_t capacity,
    size_t *actual_count
) {
    if (actual_count != NULL) {
        *actual_count = 0;
    }
    if (options == NULL || records == NULL || actual_count == NULL || options->count < 1 ||
        options->count > TELEMETRY_MAX_COUNT || capacity < options->count) {
        return false;
    }

    telemetry_rng_t rng;
    telemetry_rng_seed(&rng, options->seed);
    const uint64_t timestamp_base = UINT64_C(1700000000000) +
        ((options->seed % UINT64_C(1000000)) * UINT64_C(1000));

    for (uint32_t index = 0; index < options->count; ++index) {
        telemetry_record_t *record = &records[index];
        record->seq = index + 1;

        const size_t device_index = (size_t)telemetry_rng_range(&rng, 0, 7);
        const unsigned suffix = (unsigned)telemetry_rng_range(&rng, 100, 999);
        snprintf(record->device, sizeof(record->device), "%s-%03u", DEVICE_PREFIXES[device_index], suffix);

        record->temp_mC = (int32_t)telemetry_rng_range(&rng, 0, 55000) - 10000;
        record->voltage_mV = (uint16_t)telemetry_rng_range(&rng, 3000, 4200);
        record->signal_dBm = (int16_t)((int)telemetry_rng_range(&rng, 0, 65) - 95);
        record->status = STATUSES[telemetry_rng_range(&rng, 0, 3)];
        record->zone = ZONES[telemetry_rng_range(&rng, 0, 4)];
        record->timestamp_ms = timestamp_base + ((uint64_t)index * UINT64_C(250));
    }

    *actual_count = options->count;
    return true;
}

bool telemetry_format_record(const telemetry_record_t *record, char *buffer, size_t capacity) {
    if (record == NULL || buffer == NULL || capacity == 0) {
        return false;
    }

    const int written = snprintf(
        buffer,
        capacity,
        "{\"seq\":%u,\"device\":\"%s\",\"temp_mC\":%" PRId32
        ",\"voltage_mV\":%u,\"signal_dBm\":%d,\"status\":\"%s\",\"zone\":\"%s\",\"timestamp_ms\":%" PRIu64 "}\n",
        record->seq,
        record->device,
        record->temp_mC,
        (unsigned)record->voltage_mV,
        (int)record->signal_dBm,
        record->status,
        record->zone,
        record->timestamp_ms
    );
    return written >= 0 && (size_t)written < capacity;
}

void telemetry_print_banner(FILE *stream, const telemetry_options_t *options) {
    fprintf(stream, "+--------------------------------------------------------+\n");
    fprintf(stream, "| HELLO TELEMETRY :: deterministic fixture stream       |\n");
    fprintf(stream, "+--------------------------------------------------------+\n");
    fprintf(stream, "count=%u seed=%" PRIu64 " format=ndjson\n", options->count, options->seed);
}
`,
  'src/main.c': String.raw`#include "telemetry.h"

#include <stdio.h>

int main(int argc, char **argv) {
    telemetry_options_t options;
    char error[160];
    const telemetry_parse_result_t parsed = telemetry_parse_args(argc, argv, &options, error, sizeof(error));

    if (parsed == TELEMETRY_PARSE_HELP) {
        telemetry_print_usage(stdout, argv[0]);
        return 0;
    }
    if (parsed != TELEMETRY_PARSE_OK) {
        fprintf(stderr, "error: %s\n", error[0] != '\0' ? error : "invalid arguments");
        telemetry_print_usage(stderr, argv[0]);
        return 2;
    }

    telemetry_record_t records[TELEMETRY_MAX_COUNT];
    size_t count = 0;
    if (!telemetry_generate(&options, records, TELEMETRY_MAX_COUNT, &count)) {
        fprintf(stderr, "error: generator rejected validated options\n");
        return 3;
    }

    telemetry_print_banner(stdout, &options);
    for (size_t index = 0; index < count; ++index) {
        char line[320];
        if (!telemetry_format_record(&records[index], line, sizeof(line))) {
            fprintf(stderr, "error: record formatting failed at index %zu\n", index);
            return 4;
        }
        fputs(line, stdout);
    }

    return 0;
}
`,
  'tests/test_telemetry.c': String.raw`#include "telemetry.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

static int failures = 0;

static void check(bool condition, const char *message) {
    if (!condition) {
        fprintf(stderr, "FAIL: %s\n", message);
        ++failures;
    }
}

static void test_cli(void) {
    telemetry_options_t options;
    char error[160];

    char *defaults[] = {"hello-telemetry"};
    check(telemetry_parse_args(1, defaults, &options, error, sizeof(error)) == TELEMETRY_PARSE_OK, "default CLI parse");
    check(options.count == TELEMETRY_DEFAULT_COUNT, "default count");
    check(options.seed == TELEMETRY_DEFAULT_SEED, "default seed");

    char *valid[] = {"hello-telemetry", "--count", "4", "--seed", "42"};
    check(telemetry_parse_args(5, valid, &options, error, sizeof(error)) == TELEMETRY_PARSE_OK, "valid CLI parse");
    check(options.count == 4 && options.seed == UINT64_C(42), "valid CLI values");

    char *overflow[] = {"hello-telemetry", "--seed", "18446744073709551616"};
    check(telemetry_parse_args(3, overflow, &options, error, sizeof(error)) == TELEMETRY_PARSE_ERROR, "seed overflow rejected");

    char *too_many[] = {"hello-telemetry", "--count", "257"};
    check(telemetry_parse_args(3, too_many, &options, error, sizeof(error)) == TELEMETRY_PARSE_ERROR, "count upper bound rejected");

    char *help[] = {"hello-telemetry", "--help"};
    check(telemetry_parse_args(2, help, &options, error, sizeof(error)) == TELEMETRY_PARSE_HELP, "help is distinct from error");
}

static void test_generation_and_golden_record(void) {
    const telemetry_options_t options = {4, UINT64_C(42)};
    telemetry_record_t first[4];
    telemetry_record_t second[4];
    size_t first_count = 0;
    size_t second_count = 0;

    check(telemetry_generate(&options, first, 4, &first_count), "first generation");
    check(telemetry_generate(&options, second, 4, &second_count), "second generation");
    check(first_count == 4 && second_count == 4, "generated counts");

    for (size_t index = 0; index < first_count; ++index) {
        char left[320];
        char right[320];
        check(telemetry_format_record(&first[index], left, sizeof(left)), "format first record");
        check(telemetry_format_record(&second[index], right, sizeof(right)), "format second record");
        check(strcmp(left, right) == 0, "formatted records deterministic");
    }

    char golden[320];
    check(telemetry_format_record(&first[0], golden, sizeof(golden)), "format golden record");
    check(
        strcmp(
            golden,
            "{\"seq\":1,\"device\":\"flux-191\",\"temp_mC\":35423,\"voltage_mV\":3980,\"signal_dBm\":-49,\"status\":\"degraded\",\"zone\":\"lab-north\",\"timestamp_ms\":1700000042000}\n"
        ) == 0,
        "seed 42 golden record"
    );

    check(first[0].temp_mC >= -10000 && first[0].temp_mC <= 45000, "temperature bounds");
    check(first[0].voltage_mV >= 3000 && first[0].voltage_mV <= 4200, "voltage bounds");
    check(first[0].signal_dBm >= -95 && first[0].signal_dBm <= -30, "signal bounds");
}

int main(void) {
    test_cli();
    test_generation_and_golden_record();
    printf("hello-telemetry tests: %s\n", failures == 0 ? "OK" : "FAILED");
    return failures == 0 ? 0 : 1;
}
`
});

function appendBounded(current, chunk, maxBytes = OUTPUT_LIMIT) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length <= maxBytes ? combined : combined.subarray(combined.length - maxBytes);
}

async function runProcess(executable, args, { cwd, env, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const child = spawn(executable, args, containedSpawnOptions({ cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }));
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
  let timedOut = false;
  let termination = null;
  const timer = setTimeout(() => {
    timedOut = true;
    termination = terminateProcessTree(child);
  }, timeoutMs);
  timer.unref?.();
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (termination) await termination;
    return {
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8')
    };
  } finally {
    clearTimeout(timer);
  }
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function executable(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function scrub(text, roots) {
  let value = String(text || '');
  for (const root of roots.filter(Boolean).sort((a, b) => String(b).length - String(a).length)) {
    value = value.split(String(root)).join('<local-path>');
    value = value.split(String(root).replace(/\\/g, '/')).join('<local-path>');
  }
  return value.slice(-6000);
}

function evidence(name, observed, roots, extra = {}) {
  return {
    name,
    exitCode: observed.exitCode,
    timedOut: observed.timedOut,
    stdout: scrub(observed.stdout, roots),
    stderr: scrub(observed.stderr, roots),
    ...extra
  };
}

async function resolveCTest(cmake, env) {
  try {
    return await resolveExecutable(process.platform === 'win32' ? 'ctest.exe' : 'ctest', env);
  } catch {
    const sibling = path.join(path.dirname(cmake), process.platform === 'win32' ? 'ctest.exe' : 'ctest');
    return executable(sibling);
  }
}

async function materializeProject(projectDir) {
  await rm(projectDir, { recursive: true, force: true });
  for (const [relative, content] of Object.entries(PROJECT_FILES)) {
    const destination = path.join(projectDir, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { encoding: 'utf8', mode: 0o600 });
  }
}

export async function runChatCProjectProbe({ projectRoot, env = process.env } = {}) {
  const root = path.resolve(projectRoot);
  const projectDir = path.join(root, CHAT_C_PROJECT_RELATIVE);
  const buildDir = path.join(projectDir, 'build');
  const roots = [root, projectDir, buildDir];
  const tests = [];

  try {
    await materializeProject(projectDir);
    tests.push({ name: 'materialize', status: 'pass', files: Object.keys(PROJECT_FILES).sort() });

    let cmake;
    try {
      cmake = await resolveExecutable(process.platform === 'win32' ? 'cmake.exe' : 'cmake', env);
    } catch {
      return {
        protocol: 'patch-poller/result-v1',
        status: 'failed',
        summary: 'Chat-authored C project was materialized, but the fixed PATCH-POLLER verifier could not find CMake.',
        progress: ['Project source was created without invoking any coding model.'],
        tests: [...tests, { name: 'cmake-discovery', available: false }],
        nextStep: null,
        blocker: 'cmake-unavailable'
      };
    }
    roots.push(cmake, path.dirname(cmake));
    const ctest = await resolveCTest(cmake, env);
    if (!ctest) {
      return {
        protocol: 'patch-poller/result-v1',
        status: 'failed',
        summary: 'CMake was found, but the associated CTest executable was unavailable.',
        progress: [],
        tests: [...tests, { name: 'ctest-discovery', available: false }],
        nextStep: null,
        blocker: 'ctest-unavailable'
      };
    }
    roots.push(ctest, path.dirname(ctest));

    let observed = await runProcess(cmake, ['-S', projectDir, '-B', buildDir], { cwd: root, env });
    tests.push(evidence('cmake-configure', observed, roots));
    if (observed.exitCode !== 0 || observed.timedOut) throw new Error('CMake configure failed');

    observed = await runProcess(cmake, ['--build', buildDir, '--config', 'Debug'], { cwd: root, env });
    tests.push(evidence('cmake-build', observed, roots));
    if (observed.exitCode !== 0 || observed.timedOut) throw new Error('CMake build failed');

    observed = await runProcess(ctest, ['--test-dir', buildDir, '--output-on-failure', '-C', 'Debug'], { cwd: root, env });
    tests.push(evidence('ctest', observed, roots));
    if (observed.exitCode !== 0 || observed.timedOut || !/100% tests passed|Test #1:.*Passed/iu.test(observed.stdout)) {
      throw new Error('CTest did not report a passing C test suite');
    }

    const executablePath = process.platform === 'win32'
      ? path.join(buildDir, 'Debug', 'hello-telemetry.exe')
      : path.join(buildDir, 'hello-telemetry');
    if (!await executable(executablePath)) throw new Error('built hello-telemetry executable was not found');
    roots.push(executablePath);

    const sampleArgs = ['--count', '4', '--seed', '42'];
    const first = await runProcess(executablePath, sampleArgs, { cwd: projectDir, env });
    const second = await runProcess(executablePath, sampleArgs, { cwd: projectDir, env });
    const deterministic = first.exitCode === 0 && second.exitCode === 0 && first.stdout === second.stdout && first.stderr === second.stderr;
    const goldenObserved = first.stdout.includes('"device":"flux-191"') && first.stdout.includes('"timestamp_ms":1700000042000');
    tests.push(evidence('sample-run-first', first, roots, { deterministicPeerMatch: deterministic, goldenObserved }));
    tests.push(evidence('sample-run-second', second, roots, { deterministicPeerMatch: deterministic }));
    if (!deterministic || !goldenObserved || !first.stdout.includes('HELLO TELEMETRY :: deterministic fixture stream')) {
      throw new Error('sample executions were not byte-deterministic or did not contain the expected golden data');
    }

    const overflow = await runProcess(executablePath, ['--seed', '18446744073709551616'], { cwd: projectDir, env });
    const overflowRejected = overflow.exitCode === 2 && /invalid --seed value/iu.test(overflow.stderr);
    tests.push(evidence('seed-overflow-rejected', overflow, roots, { overflowRejected }));
    if (!overflowRejected) throw new Error('overflowing uint64 seed was not rejected with exit 2');

    const unknown = await runProcess(executablePath, ['--bogus'], { cwd: projectDir, env });
    const unknownRejected = unknown.exitCode === 2 && /unknown argument/iu.test(unknown.stderr);
    tests.push(evidence('unknown-argument-rejected', unknown, roots, { unknownRejected }));
    if (!unknownRejected) throw new Error('unknown CLI argument was not rejected with useful diagnostics');

    const help = await runProcess(executablePath, ['--help'], { cwd: projectDir, env });
    const helpOk = help.exitCode === 0 && /Usage:/u.test(help.stdout);
    tests.push(evidence('help', help, roots, { helpOk }));
    if (!helpOk) throw new Error('--help did not exit 0 with usage output');

    await rm(buildDir, { recursive: true, force: true });
    const buildRemoved = !await exists(buildDir);
    tests.push({ name: 'cleanup', status: buildRemoved ? 'pass' : 'fail', buildArtifactsRemoved: buildRemoved });
    if (!buildRemoved) throw new Error('generated build directory remained after verification');

    return {
      protocol: 'patch-poller/result-v1',
      status: 'complete',
      summary: 'Chat-only controller project materialized and verified: CMake build, C tests, deterministic native output, golden record, CLI overflow/error handling, and cleanup all passed without a coding model.',
      progress: [
        `Created ${Object.keys(PROJECT_FILES).length} source/project files under ${CHAT_C_PROJECT_RELATIVE}.`,
        'Repeated seed/count runs were byte-for-byte identical.',
        'Generated build artifacts were removed before PATCH-POLLER candidate sealing.'
      ],
      tests,
      nextStep: null,
      blocker: null
    };
  } catch (error) {
    return {
      protocol: 'patch-poller/result-v1',
      status: 'failed',
      summary: `Chat-authored C project verification failed: ${String(error?.message || error).slice(0, 1000)}`,
      progress: [],
      tests,
      nextStep: null,
      blocker: 'chat-c-project-verification'
    };
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
}
