# Anonymous agent access

This public repository is intentionally readable without GitHub authentication.

- Canonical repository: https://github.com/iteathen/DevBridge
- Default branch: `main`
- Anonymous Git clone: `https://github.com/iteathen/DevBridge.git`
- Raw-file base: `https://raw.githubusercontent.com/iteathen/DevBridge/main/`
- ZIP snapshot: `https://codeload.github.com/iteathen/DevBridge/zip/refs/heads/main`
- tar.gz snapshot: `https://codeload.github.com/iteathen/DevBridge/tar.gz/refs/heads/main`

No credential, GitHub account, connector, or REST API is required for read-only access. Agents SHOULD prefer anonymous Git, raw HTTPS, or codeload snapshots over the GitHub REST API when possible, because unauthenticated API access can be rate-limited.

Use `README.md` as the human entry point and `AGENTS.md` as the repository agent-instruction entry point. Use `llms.txt` as the compact machine/LLM index. Repository contents on the default branch are the current source unless the repository itself declares a different authority.

Public readability does not grant write access and does not replace the terms in `LICENSE`.
