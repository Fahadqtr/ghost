# Snoonu Merchant Connector — Missing Image Recovery (CH.6B)

A secure, preview-then-confirm workflow that recovers **missing product images**
from the Snoonu Merchant portal into our Catalog. **Image sync only** — no
availability/barcode/AI/missing-product work (later CH.6 phases).

## Portal audit (navigation contract)

Documented human flow (from the supplied screenshots): merchant login →
authenticated home → dismiss any modal/tutorial → open sidebar → **Catalog** →
search/select a listing → inspect listing media. The connector targets **stable**
signals — route patterns, roles/`data-*` attributes, and (preferred) the portal's
own network responses — **not** pixel/coordinate automation. Exact
selectors/endpoints must be confirmed from a live capture during operator setup.

## Mechanism decision (§13)

**API/network-first**: authenticated merchant requests, reading the portal's own
JSON for the listing + original image URL. **Fallback**: browser automation
against stable DOM (`data-*`/role/route). **Never** visual-coordinate automation.
CH.6B ships the contract + the full secure pipeline; the live portal binding is an
injected `SnoonuMerchantSession` provisioned by an operator — the default reports
`session_required`, so nothing runs against an unverified contract.

## Authentication / session (§2, §14)

Credentials/session material live in **server env only** (`SNOONU_MALIKAS_MERCHANT_SESSION`,
`SNOONU_PURE_SEOUL_MERCHANT_SESSION` — isolated per storefront). Never in source,
never in client bundles, never logged. OTP/MFA is surfaced (`otp_required`) and
never bypassed — the operator authenticates interactively and the session resumes.

## Storefront isolation (§3)

Every operation targets exactly `snoonu:malikas` **or** `snoonu:pure_seoul`.
Identity comes from the **CH.5 ECL resolver**; a storefront's SPI is never
cross-used (Malikas SPI ≠ Pure Seoul SPI for the same product).

## Listing lookup + match (§4)

Order: **ECL SPI (for the storefront) → exact SKU → exact barcode**. `MATCHED`
requires SPI + at least one exact SKU/barcode verify. Name matching is
diagnostics/manual-review only and **never** auto-accepts an image write. Every
row carries provenance (storefront, SPI, merchant SKU/barcode/title, internal
product id, confidence).

## Image extraction + safety (§5, §6)

Prefer the portal's original/source image URL. A signed/CDN URL is **downloaded
server-side** and stored as our own permanent copy — Snoonu URLs are never
persisted as the product image. Fetch goes through the repo SSRF guard
(`safeFetchImage`) **restricted to an allow-list of Snoonu hosts**
(`image-host-policy.ts`); the bytes are validated (MIME allow-list, magic-number
sniff, size/dimension bounds, HTML-masquerade rejection) before import. Storage
reuses the existing media pipeline (`storePrimaryProductImage`).

## Preview → apply (§9, §10, §11, §12)

- `scanSnoonuMissingImages(storefront)` — READ-ONLY preview: candidates (no valid
  primary image) classified `MATCHED | NEEDS_REVIEW | NOT_FOUND | SESSION_REQUIRED`
  with a summary. No writes.
- `applySnoonuImageImports(storefront, selectedIds)` — **writer-gated**
  (`requireMalakWriter`, CH.3b). Only selected `MATCHED` rows apply. Idempotent:
  a product that gained a valid primary image since preview is **skipped** (never
  overwrites a new internal image). Per-item result `IMPORTED | SKIPPED |
  NEEDS_REVIEW | FAILED`; one failure never aborts the batch.

## Files

`merchant-contract.ts` · `image-host-policy.ts` · `image-safety.ts` ·
`image-match.ts` · `missing-image-scan.ts` · `import-plan.ts` (all pure) ·
`session.server.ts` · `image-recovery.server.ts` (server).

## Boundaries (CH.6B)

Additive; existing Snoonu XLSX import/export untouched. No availability/barcode/AI
writes, no quantity/inventory changes, no legacy id use/retirement, no automatic
bulk writes without preview + confirmation.

## Exact CH.6C scope

**Availability Sync** — controlled read-then-writeback of availability between the
Availability Engine and each Snoonu storefront (per explicit storefront, preview +
confirm), flipping `supports("availabilitySync")` on. Not implemented here.
