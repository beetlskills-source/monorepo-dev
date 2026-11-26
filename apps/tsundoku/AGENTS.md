# AGENTS.md — `tsundoku`

## Mission
Build and maintain `apps/tsundoku`: a camera-assisted ISBN scanner UI backed by a Cloudflare Worker API route (`POST /api/isbn-lookup`) that resolves authoritative book metadata via a catalog-first pipeline (Open Library primary, Google Books fallback) and optionally enriches metadata (such as a concise summary) via Featherless AI according to `SPEC.md`.

## Source of Truth
- Functional requirements, contracts, and acceptance criteria: `SPEC.md`
- Request/response runtime validation: `@repo/book-schemas` (`packages/domains/books/book-schemas`)
- Do not invent undocumented endpoints, environment variables, or response fields. Update `SPEC.md` and schemas first if a contract changes.

## Pipeline (Catalog-First, Then LLM Enrichment)
`POST /api/isbn-lookup` resolves a book in strict order:
1. **Validate** the ISBN-10 / ISBN-13 (format + check digit) via `@repo/isbn` (`packages/domains/books/isbn`). Invalid input -> `400 INVALID_ISBN`.
2. **Catalog (authoritative)** via `src/lib/catalog.ts`: query Open Library first, then Google Books (`q=isbn:<isbn>`, with optional `GOOGLE_BOOKS_API_KEY`) only when Open Library has no match. Catalog `title` / `authors` are authoritative (`verified: true`, `source` = `openlibrary` | `google-books`). No match anywhere -> `422 BOOK_NOT_FOUND`; every provider failing -> `502 UPSTREAM_ERROR`.
3. **Enrich (best-effort, optional)** via `src/lib/featherless.ts`: when `FEATHERLESS_API_KEY` is configured, use `FEATHERLESS_MODEL` to add a concise `summary` (and optional `topics`) without ever overwriting verified `title` / `authors`. A missing key, a failure, or unusable output degrades gracefully to `enriched: false`; enrichment never fails the lookup.

## Stack & Runtime Constraints
- Monorepo package manager: `pnpm` (never `npm` or `npx` for workspace commands).
- Framework & adapter: Astro with `@astrojs/cloudflare` running on `workerd`.
- Secrets & config: `FEATHERLESS_API_KEY`, `FEATHERLESS_MODEL`, and optional `GOOGLE_BOOKS_API_KEY` must only be read on the server/Worker side (`cloudflare:workers` `env` / runtime context), never exposed to `src/pages/index.astro` or client scripts.
- Catalog-first rule: Catalog sources (`openlibrary`, `google-books`) own verified `title` and `authors`; LLM enrichment must never overwrite verified `title` or `authors`.
- TypeScript: strict mode; no `any` unless justified and isolated at external boundaries.
- Match the Astro + Cloudflare Workers setup, script names, and config conventions in `apps/client-x` (`package.json`, `astro.config.mjs`, `wrangler.jsonc`, `tsconfig.json`).

## Commands (Run From Monorepo Root)
- Typecheck & Astro checks: `pnpm --filter tsundoku astro check`
- Unit / integration tests: `pnpm --filter tsundoku test`
- Build for Cloudflare: `pnpm --filter tsundoku build`
- Local `workerd` runtime test: `pnpm --filter tsundoku local`

## Agent Execution Loop
1. Read `SPEC.md` and the `@repo/book-schemas` package.
2. Make minimal, scoped edits to fulfill one requirement or test case at a time.
3. Run typecheck, unit tests, and `build` after changes; fix failures before moving on.
4. During refactoring, preserve external behavior and contracts unless `SPEC.md` is updated first.
5. Summarize files changed, commands run, and any remaining assumptions or edge cases.

## Non-Goals (Current Scope)
- User authentication, accounts, or persistent database storage.
- Multi-book batch history export or third-party cover image scraping beyond what `SPEC.md` specifies.

## Project Structure
Shared, framework-agnostic domain code lives in workspace packages; app-specific code stays under `apps/tsundoku`.
- `@repo/book-schemas` (`packages/domains/books/book-schemas`) — Zod request/response, catalog, enrichment, and error schemas
- `@repo/isbn` (`packages/domains/books/isbn`) — Pure ISBN normalization, validation, and ISBN-10 to ISBN-13 conversion
- `src/lib/catalog.ts` — Injectable catalog lookup client (Open Library primary, Google Books fallback)
- `src/lib/featherless.ts` — Injectable Featherless AI enrichment client
- `src/lib/scanner.ts` — Modular barcode/ISBN candidate extraction helpers
- `src/pages/index.astro` — Camera + manual ISBN fallback UI
- `src/pages/api/isbn-lookup.ts` — Cloudflare Worker `POST /api/isbn-lookup` route
- `src/test/*.test.ts` — Vitest unit and endpoint tests