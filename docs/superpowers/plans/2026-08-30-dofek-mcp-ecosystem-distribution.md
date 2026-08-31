# Dofek MCP Ecosystem Distribution Plan

**Goal:** Prepare and submit Dofek's verified remote MCP service to the OpenAI Plugin Directory, Anthropic Connectors Directory, official MCP Registry, and Cursor Marketplace without releasing proprietary product source.

**Architecture:** The already-deployed `https://dofek.fit/api/mcp` service is the sole integration endpoint. Registry metadata and first-party docs describe that remote service. Cursor receives a separate MIT-licensed configuration-only repository; all platform submissions use the same publisher identity, privacy/terms/support links, and synthetic review account.

**Tech Stack:** MCP Registry `server.json`, GitHub, Cursor Agent Plugins, OpenAI Plugin Directory, Anthropic Connectors Directory, Markdown documentation, PNG review assets.

**Spec:** `docs/superpowers/specs/2026-08-30-dofek-mcp-plugin-ecosystems-design.md`

## Global Constraints

- Publish Dofek as operated by Asher Cohen, an individual; do not claim a registered company.
- Use only `https://dofek.fit/api/mcp` as the remote server endpoint.
- The synthetic review account contains no real-person data and has no MFA; never execute local seed scripts against production.
- Dofek's proprietary server, web, mobile, database, and customer-data source never enter the public Cursor repository.
- The Explorer is descriptive, read-only analytics; do not market it as medical advice, diagnosis, or treatment.
- Each directory's final submit/publish control is an external action; confirm the exact payload and account state immediately before it is sent.

---

## Planned file structure

| File | Responsibility |
| --- | --- |
| `packages/web/src/routes/privacy.tsx` | Name the operator and describe MCP-authorized data sharing. |
| `packages/web/src/routes/terms.tsx` | Name the operator, support channel, and service terms. |
| `docs/mcp.md` | User-facing installation and capability guide. |
| `registry/server.json` | Official MCP Registry remote-server metadata. |
| `docs/mcp-directory-submission.md` | Versioned review copy, test prompts, screenshot checklist, and validation evidence. |
| separate `dofek-mcp-plugin` repository | Cursor-compatible MIT configuration plugin only. |

### Task 1: Publish accurate legal and support information

**Files:**
- Modify: `packages/web/src/routes/privacy.tsx`
- Modify: `packages/web/src/routes/terms.tsx`
- Modify: `docs/mcp.md`

**Interfaces:**
- Produces public privacy and terms pages that identify Dofek as operated by Asher Cohen.
- Produces a support link and explanation of OAuth-authorized AI-client data sharing.

- [ ] **Step 1: Draft precise privacy copy**

Add a Dofek MCP section stating: after a user authorizes an AI client through Dofek OAuth, Dofek returns only the results of tools that authorized client requests for that user. State that the AI client may process those results under its own policies, and link to Dofek support. Keep existing health-data retention and security statements intact unless evidence requires correction.

- [ ] **Step 2: Draft matching terms copy**

Replace generic references to “operators” with “Dofek is operated by Asher Cohen.” Add the same public support contact used by the privacy page and state that Dofek provides informational analytics rather than medical diagnosis, treatment, or emergency services.

- [ ] **Step 3: Verify public-page rendering and links**

Run: `pnpm --filter dofek-web build`  
Expected: PASS.

After deployment, open `/privacy`, `/terms`, and `/support` on `https://dofek.fit`; verify publisher name, URLs, and support route appear without exposing authenticated data.

- [ ] **Step 4: Commit**

~~~bash
git add packages/web/src/routes/privacy.tsx packages/web/src/routes/terms.tsx docs/mcp.md
git commit -m "docs: identify Dofek MCP publisher and data sharing"
~~~

### Task 2: Add versioned MCP Registry metadata and review assets

**Files:**
- Create: `registry/dofek/server.json`
- Create: `docs/mcp-directory-submission.md`
- Create: `docs/assets/mcp/` finalized screenshot and logo files

**Interfaces:**
- Produces registry metadata for a remote `https://dofek.fit/api/mcp` server.
- Produces factual review prompts and expected results based only on synthetic account data.

- [ ] **Step 1: Write `registry/dofek/server.json` from the current official schema**

Use the official MCP Registry schema/version current on the publishing date. Its remote transport entry names `https://dofek.fit/api/mcp`, describes OAuth 2.1 authorization, lists Dofek/Asher Cohen attribution and support/privacy/terms URLs, and uses the verified GitHub publisher namespace unless accepted DNS verification offers a better permanent identity. Use the documented registry extension for Apps metadata and validate OAuth protected-resource discovery separately from registry validation. Validate with the official `mcp-publisher` command before committing.

- [ ] **Step 2: Create the submission evidence document**

Include exact title, concise description, category, publisher name, public URLs, six review prompts, expected non-medical result descriptions, scope explanation, and screenshot checklist. Use:

~~~text
Show my HRV and resting-heart-rate trend for the last 14 days.
Open the Dofek Analytics Explorer for my health trends from 2026-08-01 through 2026-08-14.
Summarize my sleep duration and efficiency over the last week.
List my connected Dofek providers and their last successful sync time.
Show my activity volume by type for the last 30 days.
Show my logged protein and fiber totals for the last seven days.
~~~

Expected results must state real synthetic fixture values at capture time, never invented values.

- [ ] **Step 3: Capture truthful product assets**

Use the deployed Explorer and synthetic review account to capture a square transparent-logo PNG and screenshots of OAuth connection, initial Explorer view, metric selection, and source-coverage/missing-data state. Remove all real personal information and retain only finalized submission assets in `docs/assets/mcp/`.

- [ ] **Step 4: Validate and commit**

Run official MCP Registry validation, `pnpm lint`, and local image inspection. Then:

~~~bash
git add registry/dofek/server.json docs/mcp-directory-submission.md docs/assets/mcp
git commit -m "docs: add Dofek MCP registry submission assets"
~~~

### Task 3: Create the public Cursor configuration-only plugin repository

**Files (new public repository `Asherlc/dofek-mcp-plugin`):**
- Create: `LICENSE`
- Create: `README.md`
- Create: `plugin.json`
- Create: the current documented Cursor remote-MCP manifest
- Create: `skills/dofek/SKILL.md`

**Interfaces:**
- Produces a Cursor plugin configured for `https://dofek.fit/api/mcp`.
- Produces no local server process, package dependency, proprietary source, or customer fixture.

- [ ] **Step 1: Create the public repository with MIT license**

Create `Asherlc/dofek-mcp-plugin` through GitHub, apply the exact SPDX MIT license text, and set its description to “Remote MCP configuration for Dofek personal health analytics.” Do not create it inside the proprietary Dofek worktree.

- [ ] **Step 2: Add Cursor plugin and remote MCP configuration**

Use Cursor's current official plugin schema. The manifest identifies Dofek, links `https://dofek.fit/privacy`, `https://dofek.fit/terms`, and `https://dofek.fit/support`, and declares the remote Streamable HTTP server URL. It contains no secret, access token, password, or real account identifier.

- [ ] **Step 3: Add concise public documentation and skill guidance**

Explain installation, browser-based OAuth sign-in, read-only analysis capability, and how to disconnect/revoke access. The skill teaches prompts and capability boundaries only; it must not reproduce Dofek implementation details or proprietary instructions.

- [ ] **Step 4: Validate before publication**

Run the current Cursor plugin validation/install path and connect using the synthetic account. Confirm tool discovery and OAuth run remotely, then inspect `git ls-files` to verify the repository contains only configuration, docs, the MIT license, and generic skill material.

- [ ] **Step 5: Commit and push**

~~~bash
git add LICENSE README.md plugin.json mcp.json skills/dofek/SKILL.md
git commit -m "feat: add Dofek remote MCP Cursor plugin"
git push origin main
~~~

### Task 4: Provision a safe review fixture and live compatibility evidence

**Files:**
- Modify: `docs/mcp-directory-submission.md` with non-secret completion evidence only

**Interfaces:**
- Produces a live, no-MFA synthetic review account and a completed compatibility record.

- [ ] **Step 1: Create the review account as a one-time production operator action**

Register a new Dofek user using an account controlled by Asher Cohen, choose a strong unique password stored only in the approved password manager, leave MFA disabled for review, and import only synthetic data. Do not run `pnpm seed`, `pnpm review:seed-clickhouse`, or arbitrary database SQL against production.

- [ ] **Step 2: Verify OAuth and isolation in three clients**

Connect the review account in MCP Inspector, ChatGPT developer mode, and a Claude custom connector. For each, confirm protected-resource discovery, DCR, consent, token exchange, read-only tool list, and fixture-only tool results. Confirm `start_provider_sync` is labeled as an action and does not run during review unless explicitly requested.

- [ ] **Step 3: Record non-secret evidence**

Add connection date, deployed endpoint version, client version, successful prompts, and screenshots to `docs/mcp-directory-submission.md`. Do not commit credentials, tokens, personal email addresses, or fixture record IDs.

- [ ] **Step 4: Commit**

~~~bash
git add docs/mcp-directory-submission.md
git commit -m "docs: record MCP directory compatibility checks"
~~~

### Task 5: Publish in curated directories

**Files:**
- Modify: `docs/mcp-directory-submission.md` with final submission IDs/status links after publication

**Interfaces:**
- Consumes deployed endpoint, validated registry metadata, review assets, synthetic credentials, and verified publisher identity.
- Produces live OpenAI, Anthropic, MCP Registry, and Cursor Marketplace listing submissions.

- [ ] **Step 1: Preflight every portal payload**

Confirm title, description, publisher “Asher Cohen,” endpoint, privacy/terms/support URLs, screenshots, review prompts, scopes, and review credentials. Verify the OpenAI project has required individual verification and permitted data residency; verify Anthropic/Cursor publisher access; verify MCP Registry identity through GitHub or DNS.

- [ ] **Step 2: Request immediate confirmation before final external submit controls**

Show the user a concise portal-by-portal summary and request confirmation directly before clicking OpenAI **Submit for review**, Anthropic **Submit**, MCP Registry **Publish**, and Cursor **Publish**. Do not click a final external action before that confirmation.

- [ ] **Step 3: Submit OpenAI Plugin Directory listing**

Scan `https://dofek.fit/api/mcp` in the OpenAI plugin portal, resolve actionable scanner findings, add Analytics Explorer assets and review credentials, and submit the shared ChatGPT/Codex listing. Record submission ID and status link without credentials.

- [ ] **Step 4: Submit Anthropic Connectors Directory listing**

Use Anthropic's current connector form with Dofek's endpoint, OAuth behavior, publisher identity, health-data disclosure, legal links, and support details. Record its status link.

- [ ] **Step 5: Publish Official MCP Registry record**

Authenticate `mcp-publisher` using the verified identity, publish validated versioned `server.json`, verify resolution to `https://dofek.fit/api/mcp`, and record registry URL/version.

- [ ] **Step 6: Submit Cursor Marketplace plugin**

Use the public MIT repository's validated commit and Cursor marketplace flow. Verify the listing references only the remote endpoint and public Dofek pages; record its URL.

- [ ] **Step 7: Commit non-secret release status**

~~~bash
git add docs/mcp-directory-submission.md
git commit -m "docs: record Dofek MCP directory submissions"
~~~
