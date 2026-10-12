# Security policy

Security fixes target the latest release. Use Firelab only for projects you own or are authorized to assess.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** option if the maintainer has enabled private vulnerability reporting. If that option is unavailable, open an issue requesting a private contact without publishing exploit details or sensitive data.

Include the affected version, a minimal reproduction using synthetic data, the expected behavior, and the impact. Never send live credentials, service-account keys, or private Firebase records. Maintainers should enable private vulnerability reporting before public release; no response-time guarantee is offered.

## Trust boundaries

Firelab runs in your browser with the credentials you provide. The host and loaded Firebase SDK are trusted code. The app does not protect secrets from a compromised browser, extension, operating system, CDN, or hosting account.

App-managed authentication uses memory persistence. Manual workspace/history saves use unencrypted local storage and preserve project/path metadata. Activity and graph exports may include document values. Treat exports as potentially sensitive.

Production deployment must contain only browser assets and use HTTPS. The Python server is for local development, defaults to loopback, and has no user authentication. The emulator lab is loopback-only and intentionally includes insecure rules and fixed test accounts. Never deploy those fixtures to production.

Write probes require explicit review and use new document IDs with preconditions. They can trigger backend workflows and leave temporary records when deletion fails. Keep and resolve the cleanup report before closing the tab.

## Coverage

Permission results are observations for tested requests, not a security certification. Unknown, untested, and denied are different states. Read the scope limitations in README.md before relying on a scan.
