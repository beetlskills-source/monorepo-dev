# Tsundoku — Multi-User Shelf, Google Sheets Storage & Ownership Transfer Specification

## 1. Overview & Architecture Principles

Tsundoku evolves from a single-user ISBN scan + online lookup + LLM enrichment flow into a multi-user application deployed on a single Cloudflare Worker origin (`https://tsundoku.singbaobao.com` in production; `http://localhost:8787` in local development).

### Core Architectural Choices
- **Single-Origin Deployment:** Astro SSR and auth/API routes run together inside the `tsundoku` Cloudflare Worker (`@astrojs/cloudflare/entrypoints/server`), sharing `tsundoku.singbaobao.com` so cookies and OAuth callbacks stay first-party.
- **Sovereign Personal Storage + Thin Coordination Index:** Actual book records live in each user's personal Google Sheet (`drive.file` scope). Cloudflare D1 stores identity, session/account records, encrypted per-user Google Sheets refresh tokens, shelf configuration (`shelf_configs`), and ownership transfer audit logs (`ownership_transfers`).
- **Incremental Google OAuth:** Sign-in OAuth requests basic profile/email only. Connecting or provisioning a personal Google Sheet requests incremental `drive.file` consent separately so sign-in remains lightweight and scoped strictly to user-created or user-selected files.
- **Deferred Package Extraction & Hono Layer:** Keep changes focused inside `apps/tsundoku` during the initial phases. Defer extracting shared workspace packages (`@repo/book-schemas`, `@repo/book-shelf`, `packages/platform/auth`, `packages/platform/connectors/google-sheets`) and introducing a standalone Hono backend layer until core end-to-end workflows stabilize, avoiding speculative boundaries early on.

---

## 2. Rollout Phases

### Phase 1 — Auth + D1 Foundation
- Better Auth configured in `apps/tsundoku` backed by Cloudflare D1 (`users`, `accounts`, `sessions`, `verifications`).
- Social OAuth (GitHub, Google, Microsoft with `prompt: "select_account"`) and email/password sign-up/sign-in with verification and password-reset flows via Resend.
- `/login` page and protected `/dashboard` route guarded by middleware and server checks.

### Phase 2 — Profile & Personal Google Sheet Binding
- Profile / shelf settings UI allowing an authenticated user to connect a personal Google Sheet (`drive.file` OAuth flow — the only scope requested) and configure `default_visibility` (`private` | `shared`) and `allow_incoming_transfers` (`boolean`).
- Encrypted refresh token storage in D1; a short-lived access token is minted on demand (`GET /api/sheets/token`) for the Picker and Sheets calls, so the refresh token never leaves the server.
- **One-click "Create New Google Sheet":** `POST https://sheets.googleapis.com/v4/spreadsheets` creates the spreadsheet (default `Books` tab + canonical header row) and binds it immediately, since creating the file under `drive.file` grants the app access to it.
- **"Browse Google Drive" via the Google Picker API:** a `google.picker.ViewId.SPREADSHEETS` modal (public `GOOGLE_PICKER_API_KEY` plus an optional project number for `setAppId`) lets users select an existing sheet without pasting a raw URL; on `Action.PICKED` the app reads the file's tabs via `spreadsheets.get`, defaults to the first tab or lets the user choose, then binds it (`shelf_configs`).
- Clear re-authorization prompting when the stored grant is missing, expired, revoked, or lacks `drive.file` access to a file, instead of a generic "not found" error.
- Updating the scan/save workflow so scanned and enriched books write to the signed-in user's personal Google Sheet rather than ephemeral state.

### Phase 3 — Dashboard Tables (Own + Shared)
- **My Shelf (`OWNER`):** Read rows from the signed-in user's linked Google Sheet (`spreadsheet_id` + `sheet_tab_name`), mapping the canonical columns (`isbn13`, `title`, `authors`, `publisher`, `publishedYear`, `summary`, `source`, `verified`, `enriched`, `confidence`, `visibility`, `ownerEmail`, `addedAt`, `transferredFrom`) into typed items keyed by their 1-based spreadsheet row. Edit the user-editable fields (`title`, `authors`, `publisher`, `publishedYear`, `summary`, and `visibility` between `private`/`shared`) and delete rows.
  - `GET /api/shelves/own` returns the `OwnShelfView` (`empty` / `not_connected` / `unlinked` / `ok` / `error`).
  - `PATCH /api/shelves/own/rows` re-reads the target row and overlays the editable fields (preserving provenance columns), then writes it back.
  - `DELETE /api/shelves/own/rows` removes a row with `spreadsheets.batchUpdate` → `deleteDimension` keyed on the tab's numeric `sheetId`, so remaining row indices stay consistent.
  - The dashboard shows the human-readable sheet title alongside the tab (`"<Sheet Title> (tab: <sheet_tab_name>)"`) while `spreadsheet_id` remains internal, and renders clear empty, unlinked, and re-consent (missing/revoked refresh token) states.
- **Shared Shelves (`VIEWER`, read-only):** Query D1 for other users' `shelf_configs` where `spreadsheet_id IS NOT NULL`, `sheet_visibility = 'shared'` (Phase 6 — the dedicated sheet-level flag, independent of `default_visibility`), and a refresh token exists. Each shared sheet is fetched on the server using its owner's decrypted token (with on-demand token refresh); rows explicitly marked `private` are filtered out.
  - `GET /api/shelves/shared` returns the read-only shared views; each shelf is isolated so one owner's revoked/invalid token surfaces as a single error card without failing `/dashboard`.
  - Reads are cached in KV (`SHELF_CACHE`, 60s TTL) when the binding is present, with a safe no-KV fallback when it is unbound.
  - A shelf selector in `/dashboard` switches between My Shelf and each shared shelf. No edit, delete, or transfer surface is exposed for shared shelves in either the UI or the endpoints.
  - **Phase 5 Group Alignment:** In Phase 5, shared-shelf discovery, row visibility, and aggregation are extended by the three-level visibility model (group membership → sheet-level `shared`/`private` → row/item-level group targeting across zero, one, or multiple groups), aggregating eligible shared items across all active groups with a multi-select group filter.

### Phase 4 — Ownership Transfer
- **Target-Owner Selector & Eligibility:** Populate the target-owner selector from eligible recipients (`allow_incoming_transfers = true` and a configured Google Sheet). In Phase 5, eligibility is further scoped to active members who share at least one group with the sender.
- **Two-Step Append-Then-Remove Workflow:**
  1. Verify caller ownership of the source item/row and verify target-owner eligibility (linked sheet, incoming transfer flag, and group overlap once Phase 5 is active).
  2. Append the item (recording `transferredFrom` and the new `ownerEmail`) to the recipient's Google Sheet.
  3. Remove or mark the item (`TRANSFERRED`) in the sender's Google Sheet only after step 2 succeeds so a failed append never silently drops a book.
  4. Write an audit record to D1 `ownership_transfers` capturing transfer details and outcome.
  

### Phase 5 — Groups & Scoped Sharing / Transfers
- Add user-created groups with privacy-preserving onboarding (exact-email in-app invitation acceptance panel and/or expiring invite codes without public user directories). 
- Scope shared-shelf visibility and ownership-transfer target selection to active members of the same group, backed by D1 tables for groups, memberships, and invitations.

5. **Phase 5 — Groups, Token Invitations & Three-Level Visibility / Transfers:**
   - **Group Creation & Invite Tokens (No Public Directory):** Any authenticated user can create a named group and becomes its `admin`. Each group has an active invite token/link targeting `https://tsundoku.singbaobao.com` (e.g., `?invite=<token>`). The admin can regenerate the token at any time, immediately invalidating prior tokens for new join attempts while keeping existing members active. No public user or group directory is exposed.
   - **Token Preservation Across Sign-In:** Opening an invite link while signed out preserves the token across authentication redirects (OAuth or email login) and presents the invitation once authenticated.
   - **Invitation States (`Accept`, `Ignore`, `Remove`):**
     - **Accept:** Adds the signed-in user as an `active` group member and marks the invitation `accepted`.
     - **Ignore:** Marks the invitation `ignored` so it is hidden from active/unread prompts without joining the group, while remaining accessible if the user views ignored invites before token rotation.
     - **Remove:** Marks the invitation `removed` and clears it from the user's invitation list; reusing the same token after removal is rejected unless a new token is issued or the admin re-invites.
   - **Three-Level Visibility Model (Membership -> Sheet -> Row/Item):**
     - **Group Membership:** Sharing and ownership transfers apply only among `active` members of a group.
     - **Sheet Level:** A member's linked Google Sheet is either `private` (not shown to other group members as a shared shelf) or `shared` (shown as a shared shelf to group members, even when zero rows are visible to the viewer).
     - **Row / Item Level:** Row visibility applies only when the owner's Google Sheet is `shared`, and can be associated with zero, one, or multiple groups. A row is visible to a viewer only when the owner's sheet is `shared` and the row's target groups intersect with a group shared by both the owner and the viewer (with the viewer still being an `active` member).
   - **Shared Shelves Aggregation & Multi-Group Filter:** Shared Shelves aggregate eligible shared books across all of the signed-in user's active groups and provide a group filter supporting multiple group selection.
   - **Group-Scoped Ownership Transfers:** Ownership transfer targets (Phase 4) are restricted to `active` members who share at least one group with the sender and have a valid linked shelf with incoming transfers enabled; transfers continue to write a D1 audit record.
   - **Server-Side Enforcement:** Group membership, sheet visibility, and row-level group matching are enforced on the server when reading shared shelves or executing transfers, while honoring owner Google Sheet token health.

---

## 3. Data Model

### Cloudflare D1 Tables
- **`shelf_configs`**
  - `user_id` (PK, FK -> `users.id`)
  - `spreadsheet_id` (text, nullable until connected/created)
  - `sheet_tab_name` (text, default `'Books'`)
  - `default_visibility` (text: `'private'` | `'shared'`, default `'private'`) — starting `visibility` for newly scanned books only.
  - `sheet_visibility` (text: `'private'` | `'shared'`, default `'private'`) — Phase 6 Level 2; whether the whole sheet is published to co-members, decoupled from `default_visibility`.
  - `allow_incoming_transfers` (integer/boolean, default `0`)
  - `google_refresh_token_encrypted` (text, nullable)
  - `updated_at` (integer/ISO timestamp)
- **`ownership_transfers`**
  - `id` (PK)
  - `from_user_id` (text, index)
  - `to_user_id` (text, index)
  - `isbn13` (text, index)
  - `status` (text: `'pending'` | `'completed'` | `'failed'`)
  - `error_message` (text, nullable)
  - `created_at` (integer/ISO timestamp)
  - `completed_at` (integer/ISO timestamp, nullable)
- **`groups`** (Phase 5)
  - `id` (PK)
  - `name` (text)
  - `admin_user_id` (text, index, FK -> `user.id`)
  - `invite_token` (text, unique) — the active invite token
  - `invite_token_updated_at` (ISO timestamp) — bumped on regeneration so every previously shared link stops matching
  - `created_at`, `updated_at` (ISO timestamps)
- **`group_memberships`** (Phase 5, PK `group_id` + `user_id`)
  - `group_id` (text, FK -> `groups.id`)
  - `user_id` (text, FK -> `user.id`)
  - `role` (text: `'admin'` | `'member'`, default `'member'`)
  - `status` (text: `'active'` | `'left'` | `'removed'`, default `'active'`)
  - `joined_at`, `updated_at` (ISO timestamps)
- **`group_invitations`** (Phase 5, per-user invitation inbox)
  - `id` (PK)
  - `group_id` (text, FK -> `groups.id`)
  - `user_id` (text, FK -> `user.id`)
  - `token_used` (text, index) — the invite token this invitation was created from
  - `status` (text: `'pending'` | `'accepted'` | `'ignored'` | `'removed'`, default `'pending'`)
  - `created_at`, `updated_at` (ISO timestamps)

### Personal Google Sheet Columns
`isbn13`, `title`, `authors`, `publisher`, `publishedYear`, `summary`, `source`, `verified`, `enriched`, `confidence`, `visibility`, `ownerEmail`, `addedAt`, `transferredFrom`, `groups`

> Row-level multi-group targeting (Phase 5) is persisted in the canonical `groups` column as a comma-separated list of group ids. Zero ids means the row is not shown in any group feed; D1 stores only membership and invitation state, never the row's target list.

---

## 4. Security & Operational Requirements
- `trustedOrigins` in Better Auth must include `http://localhost:8787`, `http://127.0.0.1:8787`, and `https://tsundoku.singbaobao.com`.
- Never log raw OAuth tokens, refresh tokens, or encryption keys.
- Encrypt Google refresh tokens at rest before writing to D1 using a dedicated Worker secret encryption key.
- Only a short-lived access token is ever exposed to the browser (`GET /api/sheets/token`, served `no-store`); the refresh token stays encrypted at rest and is never sent to the client.
- `GOOGLE_PICKER_API_KEY` and `GOOGLE_CLOUD_PROJECT_NUMBER` are public values rendered into `/settings` for the browser Picker — restrict the key by HTTP referrer in the Google Cloud console rather than treating it as a Worker secret.
- Shared-shelf reads never expose another user's credentials to the browser: the owner's refresh token is decrypted server-side and only the mapped rows are returned. The optional `SHELF_CACHE` KV binding (60s TTL) caches those reads; when it is unbound the dashboard degrades to live reads without error.
- Handle Google Sheets API rate limits and transient network errors cleanly with explicit user-facing status feedback.