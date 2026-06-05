# Security Policy

## Supported Versions

Org Brain is pre-1.0. Security fixes are tracked for the current `0.x` release line.

## Reporting a Vulnerability

Please do not open public issues for vulnerabilities. Report security concerns privately to the project maintainers. Include:

- affected component or command
- reproduction steps
- expected and actual behavior
- any relevant logs with secrets removed

## Secrets and Tenant Data

Never include these in issues, pull requests, benchmark files, or examples:

- API keys, Cloudflare tokens, service tokens, client secrets, or cookies
- customer, tenant, or organization exports
- production D1/R2 identifiers tied to the official managed service
- private MCP credentials

Use `.env.example` and `.dev.vars.example` for configuration shape only.

## Self-hosting Notes

Self-hosters are responsible for their own Cloudflare account security, access controls, backups, logging, and tenant policies. The managed SaaS offering provides those operations as a paid service.
