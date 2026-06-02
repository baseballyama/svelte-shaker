# Security Policy

## Reporting a vulnerability

**Do not file a public GitHub issue for security bugs.**

Please report security issues privately via [GitHub's Private Vulnerability
Reporting](../../security/advisories/new). The maintainer will acknowledge
within a reasonable timeframe and coordinate a fix and disclosure.

Examples of issues in scope:

- Authentication / authorization bypasses.
- Validation bypasses at any public input boundary that lead to corruption,
  arbitrary code execution, or data exposure.
- Vulnerabilities in this project's bundled / vendored dependencies.
- Supply-chain issues with anything we publish (npm tarball, container
  image, prebuilt binary, etc.).

Out of scope by default:

- Pure denial-of-service from arbitrarily large input (callers are expected
  to bound input themselves).
- Concerns about the project's license itself.
- Issues that already have a public CVE upstream and where this project is
  only transitively affected — please report those upstream first; we will
  bump our pin once they release a fix.

## Supported versions

We patch the most recent minor release line. Pre-1.0, this is the latest
`0.Y.x` release. After 1.0, the latest `X.Y.x` of the current major.

<!-- TEMPLATE: replace this section with the project's actual support
     matrix once it has multiple supported branches. -->
