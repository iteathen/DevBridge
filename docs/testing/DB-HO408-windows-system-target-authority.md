# DB-HO408 — Windows system target authority

## Scope

Issue #408 corrects the Windows accelerator inventory executable-identity boundary found by the post-integration #395 review.

The defect is not that the inventory executes arbitrary argv. Its argv is already fixed and bounded. The defect is that the default Windows target paths were derived from inherited `SystemRoot`, `WINDIR`, `ProgramFiles`, and `ProgramW6432`, so inherited environment data participated in choosing the supposedly fixed host executable/library identity.

## Research and reassessment

Microsoft documents two relevant platform facts:

1. `GetSystemDirectoryW` is the Windows API for retrieving the actual system directory rather than deriving it from a process environment variable.
2. the Win32 `\\?\\GLOBALROOT` namespace reaches the true system Object Manager root rather than a session-dependent Win32 root.

DevBridge has no native/FFI dependency merely for directory discovery. The narrower v1 correction therefore uses the OS-owned `\\?\\GLOBALROOT\\SystemRoot\\System32` namespace directly and keeps the set of allowed targets closed.

Primary references:

- https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
- https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemdirectoryw

## Ownership shape

`src/runtime/windows-system-targets.js` owns the Windows system-location authority stud.

It accepts only three logical identities:

- CUDA driver library;
- NVIDIA observation helper;
- WSL runtime.

Each maps to one fixed leaf below the OS-owned System32 namespace. The resolver:

- reads no inherited Windows root/program location;
- validates the resolved System32 directory;
- requires the target to be a regular non-symlink file;
- resolves the target canonically;
- requires the resolved target parent to equal the resolved System32 directory;
- has no PATH search and no Program Files fallback;
- returns `null` on missing/unverifiable targets rather than widening discovery.

The CUDA inventory adapters retain their existing provider-specific observation semantics, fixed argv, output/timeout bounds, and injectable local resolver port for deterministic tests. Their production default now terminates at the platform-owned system-target stud.

## Falsifiers

Repository tests cover:

- every allowed logical target;
- unsupported logical target rejection;
- canonical escape rejection;
- target symlink substitution rejection;
- non-Windows no-op behavior;
- static proof that Windows accelerator adapters no longer derive executable identity from `process.env`, `ProgramFiles`, `ProgramW6432`, or `WINDIR`;
- a Windows-hosted real `wsl.exe` canary with inherited Windows root/program variables deliberately poisoned.

## Nonclaims

This correction does not qualify CUDA execution, transport/security, WSL as the repository VM boundary, a native CUDA backend, display continuity, cancellation/restart behavior, setup/doctor routing, or physical GPU readiness.

No physical-host mutation is required for this correction.
