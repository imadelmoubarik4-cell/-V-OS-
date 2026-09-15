# Coding Standards

- Prefer small deterministic functions with no hidden network or database writes.
- Normalize for matching, but preserve the original source spelling.
- Treat null as unknown; do not replace it with zero or an invented default.
- Record source file, page, row, confidence, and review issues for imported data.
- Use parameterized database clients and reviewed migrations.
- Enable row-level security, revoke anonymous access, and grant only required operations.
- Add regression tests for every alias, parsing edge case, and duplicate rule.
- Keep secrets, source documents, costs, and current stock data out of Git.
