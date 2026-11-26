# AGENTS.md — Monorepo Rules

## Workspace Architecture
- Package manager: `pnpm` (`pnpm-workspace.yaml` defines `apps/*` and `packages/*`). Never use `npm` or `npx` to install packages or run workspace scripts.
- Task runner: Turborepo (`turbo.json` defines `dev`, `local`, `build`, `check`, `test` task pipelines).
- Reference implementation: `apps/client-x` is the canonical template for Astro + Cloudflare Workers (`@astrojs/cloudflare`, `wrangler.jsonc`, `package.json` scripts, and `tsconfig.json`).
- Shared packages live under `packages/<group>/<name>` with the `@repo/*` scope and export TypeScript source directly (`"exports": { ".": "./src/index.ts" }`). Current domain packages: `@repo/isbn` (`packages/domains/books/isbn`, framework-free ISBN validation/conversion) and `@repo/book-schemas` (`packages/domains/books/book-schemas`, Zod request/response and domain schemas, which reuse `@repo/isbn`).

## Guardrails
- Do not modify root `package.json`, `pnpm-workspace.yaml`, or `turbo.json` unless explicitly instructed.
- New apps go under `apps/<app-name>` and must follow `apps/client-x/package.json` script naming (`dev`, `local`, `build`, `check`, `test`) so Turborepo tasks orchestrate cleanly.
- Install dependencies scoped to the target package: `pnpm --filter <app-name> add <pkg>`.