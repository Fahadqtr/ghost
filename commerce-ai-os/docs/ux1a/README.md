# UX.1A — AI Enrichment UX Polish (before / after)

Representative before/after of the AI Enrichment suggestions review surface
(`/v2/operations/ai-enrichment`). The live page is authentication- and
data-gated, so these are rendered from a faithful static mock of the same markup,
classes, and states.

| Before | After |
| --- | --- |
| `before.png` | `after.png` |

**Before** — long suggested values overflow into very tall rows; no bulk toolbar,
no pagination, and no row emphasis.

**After** — sticky bulk toolbar with an always-visible `Selected: X of Y` counter
and three-level select controls (page / all filtered / clear) hosting the existing
Apply/Generate actions; long values clamp to 3 lines with expand/collapse + copy +
full-text tooltip (no data truncation); clearer row accents (green READY, blue
selected, amber/red needs-attention); client-side pagination so a large filtered
set never renders thousands of checkboxes; and a proper empty state.
