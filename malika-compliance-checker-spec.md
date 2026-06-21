# Malika's Universe — Compliance Checker (Agent #9)

**Type:** Silent gatekeeper agent (no voice). Sits between the listing Maker and the publish step.
**Job:** Receive a draft listing → run 7 check categories → return a structured verdict → block or allow publish.
**Source of truth:** `malikas-universe-system.skill`. This spec encodes that rulebook into an automated gate.

> ⚠️ FORMAT DECISION REQUIRED BEFORE DEPLOY
> The skill and the owner's preferences define SKU/title format differently.
> This spec defaults to the **skill format** (`BRAND-PRODUCT-VARIANT`, separate EN/AR columns)
> and keeps it **configurable** via the `compliance_rules` table (Section 4) so it can be
> switched to the `MU-[CATEGORY]-[SHORTNAME]-[NUMBER]` format without rebuilding the agent.

---

## 1. Verdict Model

Every check returns one of:

| Severity | Meaning | Effect on publish |
|---|---|---|
| `BLOCK` | Hard violation (compliance/legal/format/price) | **Halt publish.** Log + flag for human. |
| `WARN`  | Quality/completeness issue | **Allow publish**, but log + flag for review. |
| `PASS`  | Check satisfied | No effect |

**Overall verdict logic:**
- Any `BLOCK` present → overall = `BLOCK` (do NOT publish)
- No `BLOCK`, ≥1 `WARN` → overall = `WARN` (publish, flag)
- All `PASS` → overall = `PASS` (publish clean)

---

## 2. The 7 Check Categories

| # | Check | Rule | Severity | Auto-fixable? |
|---|---|---|---|---|
| 1 | Medical claims | No forbidden medical/diagnosis/allergy terms in Description EN or AR | `BLOCK` | No — return to Maker |
| 2 | Image | White background, no text overlay, valid public HTTPS URL, filename matches SKU | `BLOCK` | Partial (filename) |
| 3 | Format | Title EN/AR format valid; SKU format valid; both languages present | `BLOCK` | Partial (casing/spacing) |
| 4 | Price consistency | Price identical across Shopify/Snoonu/Talabat/Rafeeq (unless an intentional discount field is set) | `BLOCK` | No |
| 5 | Category | Main Category is one of the 11 locked categories | `WARN` | Yes → route to `Trending Products` + flag |
| 6 | Required fields | Name EN+AR, Desc EN+AR, Keywords EN+AR (5–10 each), Size, Price, Image URL all non-empty | `WARN` | No |
| 7 | Fabricated data | No invented ingredients, delivery times, stock, or unverifiable claims | `WARN` | No |

### 2.1 Medical-claims term list (starter — store in `compliance_rules`, extensible)

**English (case-insensitive, whole-word):**
`cure, cures, cured, heal, heals, healing, treat, treats, treatment, medical, medical-grade, clinically guaranteed, eliminates acne, removes wrinkles permanently, anti-aging guarantee, FDA, prescription, diagnose, diagnosis, allergy-free, safe for all allergies, hypoallergenic guaranteed, eczema cure, psoriasis cure`

**Arabic:**
`يعالج, علاج, يشفي, يشفى, يداوي, دواء, طبي, طبياً, يقضي على حب الشباب نهائياً, يزيل التجاعيد نهائياً, مضمون طبياً, آمن لجميع أنواع الحساسية, خالٍ من الحساسية, يعالج الإكزيما, يشخّص, تشخيص`

> Note: "clinically proven" / "ثبت سريرياً" is allowed ONLY if it appears verbatim on the product label/packaging. Otherwise → `BLOCK`. Flag for human if uncertain.

### 2.2 Image rules
- Background must be white (`#FFFFFF` ± tolerance). If a white-background classifier isn't wired yet, mark `WARN` and queue for manual check instead of `BLOCK`.
- No text/logo/watermark overlaid on the product image.
- URL must be HTTPS and resolve (HTTP 200).
- Filename should match SKU pattern, lowercased: `mcb-zero-cleanser-200ml.jpg`.

### 2.3 Format rules (configurable)
Default (skill):
- **Title EN:** `[Brand] [Product Name] [Variant/Size]` → e.g. `Medicube Zero Pore Pad 2.0 70 Pads`
- **Title AR:** `[العلامة] [اسم المنتج] [الحجم]` → e.g. `ميديكيوب باد المسام صفر 2.0 70 قطعة`
- **SKU:** `BRAND-PRODUCT-VARIANT`, uppercase, hyphen-separated, no spaces.

---

## 3. Agent System Prompt (Claude API)

```text
You are the COMPLIANCE CHECKER for Malika's Universe Trading, a Qatar beauty/K-beauty retailer.

You are a silent internal gatekeeper. You do NOT write listings and you do NOT talk to customers.
Your ONLY job: receive one product-listing draft and decide whether it is safe to publish.

You receive a JSON draft. You run all 7 checks. You return ONLY a JSON verdict — no prose, no
markdown, no explanation outside the JSON.

RULES YOU ENFORCE (from the system rulebook):
1. MEDICAL CLAIMS (BLOCK): The description (EN or AR) must contain NO medical, diagnostic, curative,
   or allergy-clearance claims. Forbidden terms are provided in `forbidden_terms`. "Clinically proven"
   is allowed ONLY if `on_label_claims` confirms it appears on the packaging.
2. IMAGE (BLOCK): image_url must be HTTPS and present. White background required; no text overlay.
   If you cannot verify the background from metadata, set this check to WARN, not BLOCK.
3. FORMAT (BLOCK): Validate title_en, title_ar, and sku against `format_rules`. Both AR and EN must exist.
4. PRICE CONSISTENCY (BLOCK): price must be identical across all listed platforms unless a
   `discount_price` is explicitly set. Mismatch with no discount field = BLOCK.
5. CATEGORY (WARN): main_category must be one of the 11 locked categories in `valid_categories`.
   If not, recommend routing to "Trending Products".
6. REQUIRED FIELDS (WARN): name_en, name_ar, desc_en, desc_ar, keywords_en (5–10), keywords_ar (5–10),
   size, price, image_url must all be non-empty.
7. FABRICATED DATA (WARN): Flag any ingredient, delivery time, stock figure, or origin claim that is
   not present in the input draft fields (i.e. invented by the Maker).

NEVER invent data. NEVER soften a BLOCK to make a draft pass. If unsure between WARN and BLOCK on a
medical/price/format issue, choose BLOCK and set "needs_human": true.

OUTPUT — return EXACTLY this JSON shape and nothing else:
{
  "sku": "<sku from draft>",
  "overall": "PASS | WARN | BLOCK",
  "publish_allowed": true | false,
  "needs_human": true | false,
  "checks": [
    {"name": "medical_claims", "severity": "PASS|WARN|BLOCK", "detail": "<short reason>", "evidence": "<offending text or null>"},
    {"name": "image", "severity": "...", "detail": "...", "evidence": "..."},
    {"name": "format", "severity": "...", "detail": "...", "evidence": "..."},
    {"name": "price_consistency", "severity": "...", "detail": "...", "evidence": "..."},
    {"name": "category", "severity": "...", "detail": "...", "evidence": "..."},
    {"name": "required_fields", "severity": "...", "detail": "...", "evidence": "..."},
    {"name": "fabricated_data", "severity": "...", "detail": "...", "evidence": "..."}
  ]
}

publish_allowed = false whenever overall = BLOCK. Otherwise true.
```

### 3.1 Example API request (actual JSON, not placeholder)

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "system": "<<the system prompt above>>",
  "messages": [
    {
      "role": "user",
      "content": "{\"draft\": {\"sku\": \"MCB-ZERO-PORE-PAD-70\", \"title_en\": \"Medicube Zero Pore Pad 2.0 70 Pads\", \"title_ar\": \"ميديكيوب باد المسام صفر 2.0 70 قطعة\", \"name_en\": \"Zero Pore Pad 2.0\", \"name_ar\": \"باد المسام صفر 2.0\", \"main_category\": \"Korean Skincare\", \"desc_en\": \"Daily exfoliating pads that visibly refine the look of pores.\", \"desc_ar\": \"باد تقشير يومي ينعّم مظهر المسام.\", \"keywords_en\": \"pore pad, exfoliating, toner pad, medicube, korean skincare, bha, daily care\", \"keywords_ar\": \"باد مسام, تقشير, تونر باد, ميديكيوب, العناية الكورية, عناية يومية\", \"size\": \"70 Pads\", \"price\": 89, \"discount_price\": null, \"platform_prices\": {\"shopify\": 89, \"snoonu\": 89, \"talabat\": 89, \"rafeeq\": 89}, \"image_url\": \"https://cdn.example.com/mcb-zero-pore-pad-70.jpg\"}, \"config\": {\"valid_categories\": [\"Korean Skincare\",\"Makeup\",\"Hair Care\",\"Body Care\",\"Perfumes\",\"Beauty Tools\",\"Bags & Accessories\",\"Gifts & Sets\",\"Kids & Toys\",\"Thai Products\",\"Trending Products\"], \"forbidden_terms\": [\"cure\",\"treats\",\"heals\",\"medical\",\"يعالج\",\"يشفي\",\"طبي\"], \"on_label_claims\": []}}"
    }
  ]
}
```

### 3.2 Example verdict (BLOCK case — medical claim + price mismatch)

```json
{
  "sku": "ANU-PDH-TONER-250",
  "overall": "BLOCK",
  "publish_allowed": false,
  "needs_human": true,
  "checks": [
    {"name": "medical_claims", "severity": "BLOCK", "detail": "Curative claim in desc_ar", "evidence": "يعالج حب الشباب نهائياً"},
    {"name": "image", "severity": "PASS", "detail": "Valid HTTPS image", "evidence": null},
    {"name": "format", "severity": "PASS", "detail": "Title + SKU valid", "evidence": null},
    {"name": "price_consistency", "severity": "BLOCK", "detail": "Talabat 95 vs others 89, no discount set", "evidence": "talabat=95"},
    {"name": "category", "severity": "PASS", "detail": "Korean Skincare valid", "evidence": null},
    {"name": "required_fields", "severity": "PASS", "detail": "All present", "evidence": null},
    {"name": "fabricated_data", "severity": "PASS", "detail": "No invented data", "evidence": null}
  ]
}
```

---

## 4. Supabase Tables

### 4.1 `compliance_rules` (config — edit rules without redeploying the agent)

```sql
create table if not exists compliance_rules (
  id            bigint generated always as identity primary key,
  rule_key      text not null unique,          -- e.g. 'forbidden_terms', 'format_rules', 'valid_categories'
  rule_value    jsonb not null,
  active        boolean not null default true,
  updated_at    timestamptz not null default now()
);

-- seed examples
insert into compliance_rules (rule_key, rule_value) values
('valid_categories', '["Korean Skincare","Makeup","Hair Care","Body Care","Perfumes","Beauty Tools","Bags & Accessories","Gifts & Sets","Kids & Toys","Thai Products","Trending Products"]'),
('forbidden_terms_en', '["cure","cures","heal","heals","treat","treats","treatment","medical","clinically guaranteed","eliminates acne","removes wrinkles permanently","fda","prescription","diagnose","allergy-free"]'),
('forbidden_terms_ar', '["يعالج","علاج","يشفي","يشفى","يداوي","طبي","يقضي على حب الشباب نهائياً","يزيل التجاعيد نهائياً","مضمون طبياً","آمن لجميع أنواع الحساسية","يعالج الإكزيما","تشخيص"]'),
('format_rules', '{"sku_pattern":"^[A-Z]{2,4}(-[A-Z0-9]+)+$","require_ar":true,"require_en":true,"keywords_min":5,"keywords_max":10}')
on conflict (rule_key) do nothing;
```

### 4.2 `compliance_log` (audit trail of every check run)

```sql
create table if not exists compliance_log (
  id              bigint generated always as identity primary key,
  product_sku     text not null,
  draft_id        bigint references ai_drafts(id),     -- link to existing failed/draft table
  checker_version text not null default 'v1',
  run_at          timestamptz not null default now(),
  overall         text not null check (overall in ('PASS','WARN','BLOCK')),
  publish_allowed boolean not null,
  needs_human     boolean not null default false,
  failed_checks   jsonb not null default '[]',         -- array of {name, severity, detail, evidence}
  reviewed_by     text,                                -- set when a human clears a BLOCK/WARN
  reviewed_at     timestamptz,
  published_after boolean not null default false,      -- set true once actually pushed live
  notes           text
);

create index if not exists idx_compliance_log_sku on compliance_log (product_sku);
create index if not exists idx_compliance_log_blocked on compliance_log (overall) where overall = 'BLOCK';
```

---

## 5. Integration Flow (Maker → Checker → Publish gate)

```
[Maker agent writes draft]
        │
        ▼
[Compliance Checker runs 7 checks]
        │
        ├── overall = BLOCK ──► write compliance_log (publish_allowed=false, needs_human=true)
        │                       ► STOP. Notify human (#ESCALATE). Do NOT push to any platform.
        │                       ► Return draft to Maker only after human clears or fixes.
        │
        ├── overall = WARN ───► write compliance_log (publish_allowed=true)
        │                       ► Publish to platforms. Flag row for end-of-day review.
        │
        └── overall = PASS ───► write compliance_log (publish_allowed=true)
                                ► Publish to platforms. Set published_after=true on success.
```

**Gate rule (enforce in code, not just prompt):**
The publish function must read the latest `compliance_log` row for the SKU and refuse to run if
`publish_allowed = false`. Never rely on the agent's good behavior alone — enforce at the DB/publish layer.

### 5.1 n8n node mapping (if running via n8n)

| Step | n8n node |
|---|---|
| Trigger on new draft | `Supabase Trigger` (or `Schedule` polling `ai_drafts`) |
| Load config rules | `Supabase` → Get rows from `compliance_rules` |
| Run checker | `HTTP Request` → Anthropic Messages API (system prompt §3) |
| Parse verdict | `Code` node → JSON.parse, branch on `overall` |
| Branch | `Switch` node (PASS / WARN / BLOCK) |
| Log result | `Supabase` → Insert into `compliance_log` |
| Block path | `Slack`/`WhatsApp` notify with `#ESCALATE` + No-Op (stop) |
| Publish path | `HTTP Request` → Shopify/Snoonu/Talabat/Rafeeq APIs |

---

## 6. Testing Checklist

Run these sample drafts before going live:

- [ ] Clean draft (all fields valid) → expect `PASS`, publish_allowed=true
- [ ] Draft with `يعالج` in desc_ar → expect `BLOCK` (medical), needs_human=true
- [ ] Draft with "cures acne" in desc_en → expect `BLOCK` (medical)
- [ ] Draft with Talabat price ≠ others, no discount → expect `BLOCK` (price)
- [ ] Draft with Talabat price ≠ others, discount_price set → expect `PASS` on price
- [ ] Draft missing title_ar → expect `BLOCK` (format)
- [ ] Draft with SKU `mcb zero pad` (spaces/lowercase) → expect `BLOCK` (format)
- [ ] Draft with main_category "Skincare" (not in list) → expect `WARN`, recommend Trending
- [ ] Draft with only 3 keywords_en → expect `WARN` (required_fields)
- [ ] Draft with invented "ships in 2 hours" not in source → expect `WARN` (fabricated)
- [ ] Draft with http:// (not https) image → expect `BLOCK` (image)
- [ ] Verify publish function refuses when latest log row publish_allowed=false

---

## 7. Error Handling

| Failure | Fallback |
|---|---|
| Agent returns non-JSON / malformed | Treat as `BLOCK`, needs_human=true, log raw output in notes. Never publish on parse failure. |
| Anthropic API timeout / 5xx | Retry x2 with backoff. If still failing, `BLOCK` + queue for retry. Do not publish. |
| Image URL unreachable (timeout) | Image check = `WARN` (not BLOCK) + flag, unless URL is non-HTTPS (then BLOCK). |
| `compliance_rules` empty/unreadable | Halt — refuse to run checks without rules. Alert human. Fail closed, never open. |
| White-background classifier not wired | Image background → `WARN` + manual queue instead of false `BLOCK`. |
| Supabase insert fails | Retry; if still failing, hold publish and alert. Verdict must be logged before publish. |

**Principle: fail closed.** Any uncertainty or system error defaults to "do not publish."

---

## 8. Final Implementation Checklist

- [ ] Confirm format decision (skill `BRAND-PRODUCT-VARIANT` vs `MU-` format) and set `format_rules`
- [ ] Create `compliance_rules` table + seed rows
- [ ] Create `compliance_log` table + indexes
- [ ] Add Compliance Checker system prompt to the agent config (Agent #9, silent)
- [ ] Wire Maker → Checker call in the pipeline
- [ ] Enforce publish gate at the publish-function level (read `publish_allowed`)
- [ ] Add `#ESCALATE` notification on BLOCK
- [ ] Run all 12 test cases in Section 6
- [ ] Confirm fail-closed behavior on API/parse/DB errors
- [ ] Go live on a 5-product sample batch before full rollout
