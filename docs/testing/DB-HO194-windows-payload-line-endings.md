# Windows guest payload source portability

Ordinary setup at merged `ae4a71166ab1faa874fa0c3bb8b92096794c2186`
reported an absent Windows construction subject after the v6 image had completed
native qualification. The developer checkout contained CRLF guest helpers;
the installed runner contained LF helpers. All nine files were otherwise
identical. The payload owner hashed source checkout bytes without selecting a
stable target encoding, producing different bootstrap and construction subjects.

[Git's line-ending contract](https://git-scm.com/docs/gitattributes) documents
that checkout bytes can vary with `core.autocrlf`, attributes, and platform.
Payload identity must therefore derive from the emitted guest bytes, independent
of how source text was delivered. This correction stays in the Windows payload
owner; image admission and lifecycle identity checks retain their contracts.

Windows payloads now emit CRLF consistently, preserving existing CRLF payload
generations byte for byte. The owner validates the original read size before
conversion, rejects bare carriage returns, and enforces the file and aggregate
size bounds on emitted bytes. A source change still changes its digest and
generation. Linux retains its existing LF target representation.

Native read-only evidence compared the installed runner's nine normalized files
against the retained construction payload and proved exact size/SHA-256 equality.
The existing setup owner then recognized the completed subject
`subject-001b0a37bf21245e8772709432f2e060` and image
`img-04524f455e9061343aa176837ab84fdd`, generation `windows-production-v6`,
SHA-256 `076890a7d52c6ef9d7d253278ed175ecf0c2b764f8bd1bdb9c268ef74898b81b`.
No image reconstruction, journal change, or admission override was needed.

Local evidence is retained in `ho194-windows-payload-comparison.json` and
`ho194-windows-image-reuse-proof.json`. Regression tests first reproduced the
line-ending mismatch and missing rejection, then passed alongside Windows
setup and profile-source tests (11 tests). Protected activation and the
GitHub-originated Hello World run remain separate acceptance steps.
