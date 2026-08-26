// RAFEEQ EMAIL DRAFT (PURE) — the ready-to-use "إيميل رفيق" content shown in
// the Malikas UI after a successful generation.
//
// Owner rules baked in:
//   • the draft is built ONLY from the ACTUAL completed package/job metadata
//     passed in — counts and examples are never hardcoded;
//   • it explains the three-sheet workbook, the native option model (repeated
//     rows are ONE product, never separate products), the two pricing modes
//     (uniform vs PRICE ON SELECTION — option_price is a FULL price, never a
//     delta), and the primary-only original-quality image rule;
//   • wording adapts to FULL / NEW-PENDING / CORRECTION contexts;
//   • it exposes NOTHING Rafeeq doesn't need: no internal UUIDs, no variant
//     SKUs/barcodes — only parent SKUs, display names and prices;
//   • building a draft NEVER sends anything and mutates nothing.

export const RAFEEQ_GUIDE_PNG = "Rafeeq-Options-Reading-Guide.png";
/** Default recipient — the owner fills/edits the address in the UI. */
export const RAFEEQ_EMAIL_TO_DEFAULT = "";
/** Email attachments above this size are never attached automatically. */
export const RAFEEQ_EMAIL_MAX_ATTACH_BYTES = 20 * 1024 * 1024;

export interface RafeeqEmailOptionExample {
  parentSku: string;
  title: string;
  /** display name + FULL price per option (uniform examples repeat the price). */
  options: { name: string; price: number | null }[];
}

export interface RafeeqEmailContext {
  mode: "FULL" | "NEW";
  filename: string;
  /** ISO timestamp of the generation. */
  generatedAt: string;
  productCount: number;
  physicalRowCount: number;
  productsWithOptions: number;
  optionCount: number;
  imageCount: number;
  warningCount?: number;
  zipBytes?: number;
  /** CORRECTION/REPLACEMENT context — set when this package replaces one. */
  correction?: { previousFilename: string } | null;
  /** NEW-mode context: what the pending set means right now. */
  newPackage?: { hasSentBaseline: boolean; equalsWholeCatalog: boolean } | null;
  /** real representative examples picked from THIS package (never fixed SKUs). */
  samePriceExample?: RafeeqEmailOptionExample | null;
  differingPriceExample?: RafeeqEmailOptionExample | null;
}

export interface RafeeqEmailDraft {
  to: string;
  subject: string;
  /** English HTML body (self-contained; readable without the PNG). */
  html: string;
  /**
   * MOBILE-SAFE English plain text — the «نسخ للإيميل» copy target and the
   * plain-text MIME alternative for direct sending. Same semantic content as
   * the HTML: NO HTML tags, NO markdown-ish syntax, blank-line spacing that
   * pastes cleanly into Outlook/Titan/Gmail mobile compose windows.
   */
  textEmail: string;
  /** Arabic owner-facing summary (plain text). */
  textAr: string;
  /** attachment checklist (names only — attaching is a human step). */
  attachments: string[];
  /** true ⇒ the ZIP is too large to attach; the note is already in the body. */
  zipTooLargeForEmail: boolean;
}

const esc = (v: string | number | null | undefined): string =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number): string => v.toLocaleString("en-US");
const price = (v: number | null): string => (v === null ? "—" : `${v} QAR`);

function exampleTableSamePrice(ex: RafeeqEmailOptionExample): string {
  const rows = ex.options
    .map((o) => `<tr><td>${esc(ex.parentSku)}</td><td>${esc(ex.title)}</td><td>${esc(o.name)}</td><td>${esc(price(o.price))}</td></tr>`)
    .join("");
  return `
  <h3>Example A — options with the SAME price</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
    <tr><th>Parent SKU</th><th>Product</th><th>Option</th><th>Price</th></tr>${rows}
  </table>
  <p><b>These ${n(ex.options.length)} rows represent ONE product with ${n(ex.options.length)} options — not ${n(ex.options.length)} separate products.</b></p>`;
}

function exampleTableDiffering(ex: RafeeqEmailOptionExample): string {
  const rows = ex.options
    .map((o) => `<tr><td>${esc(ex.parentSku)}</td><td>PRICE ON SELECTION</td><td>${esc(o.name)}</td><td>${esc(price(o.price))}</td></tr>`)
    .join("");
  return `
  <h3>Example B — options with DIFFERENT prices</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
    <tr><th>Parent SKU</th><th>Product Price</th><th>Option</th><th>Option Price</th></tr>${rows}
  </table>
  <p><b><code>option_price</code> is the FULL selling price of that selected option, not an additional charge.</b></p>`;
}

/**
 * MOBILE-SAFE plain-text body. Same semantic content as the HTML body, but
 * plain text only: no tags, no markdown markers that render broken in mail
 * clients (no *, #, |, backticks), UPPERCASE section headers, "-" bullets and
 * readable blank-line spacing. Everything is derived from the SAME ctx the
 * HTML uses, so both carry identical package facts.
 */
function buildPlainTextEmail(
  ctx: RafeeqEmailContext,
  attachments: readonly string[],
  zipTooLargeForEmail: boolean,
): string {
  const isFull = ctx.mode === "FULL";
  const correction = ctx.correction ?? null;
  const lines: (string | null)[] = [
    "Dear Rafeeq team,",
    "",
    `Please find our ${isFull ? "full catalog" : "new / pending products"} package below.`,
    "",
  ];
  if (correction) {
    lines.push(
      "Please disregard the previous package and use this corrected package instead.",
      `Previous package: ${correction.previousFilename}`,
      "",
    );
  }
  if (isFull) {
    lines.push("This package represents the full current Malikas Universe catalog.", "");
  } else if (ctx.newPackage?.hasSentBaseline) {
    lines.push(
      "This package contains ONLY the products/updates pending since the last package that was explicitly marked SENT — it is an incremental file, not the full catalog.",
      "",
    );
  } else {
    lines.push(
      "Note: no SENT baseline exists yet, so this new-products package effectively equals the whole current catalog. For the first upload we recommend using the FULL catalog package as a complete replacement.",
      "",
    );
  }
  lines.push(
    "PACKAGE SUMMARY",
    "",
    `File: ${ctx.filename}`,
    `Generated: ${ctx.generatedAt}`,
    `Products (product identities): ${n(ctx.productCount)}`,
    `Physical Excel rows: ${n(ctx.physicalRowCount)}`,
    `Products with options: ${n(ctx.productsWithOptions)}`,
    `Options: ${n(ctx.optionCount)}`,
    `Images: ${n(ctx.imageCount)}`,
    typeof ctx.warningCount === "number" ? `Rows flagged for review: ${n(ctx.warningCount)}` : null,
    "",
    `${n(ctx.physicalRowCount)} physical rows does NOT mean ${n(ctx.physicalRowCount)} products. A product with options repeats its row once per option (see below).`,
    "",
    "HOW TO READ THE WORKBOOK (3 SHEETS)",
    "",
    "1. data — the official Rafeeq import sheet on your audited template. Use this sheet for the actual import.",
    "2. Malikas Reference — a human-readable row-level reference for your staff: parent SKU, real barcode, category, image filename, ROW TYPE, TOTAL OPTIONS, option names/prices and notes.",
    "3. Options Overview — contains ONLY the products that have options. Each parent product is shown as ONE block with all of its options underneath.",
    "",
    "HOW OPTIONS WORK",
    "",
    "- One canonical product = one Rafeeq product identity.",
    "- A product with options repeats its parent fields across several physical rows.",
    "- These repeated rows represent ONE product with multiple options — not separate products.",
    "- The parent SKU stays the same across all of its option rows.",
    "- The same parent image is shared by all option rows.",
  );
  if (ctx.samePriceExample) {
    const ex = ctx.samePriceExample;
    lines.push(
      "",
      "EXAMPLE A — OPTIONS WITH THE SAME PRICE",
      "",
      `${ex.parentSku} — ${ex.title}:`,
      ...ex.options.map((o) => `- ${o.name}: ${price(o.price)}`),
      `These ${n(ex.options.length)} rows represent ONE product with ${n(ex.options.length)} options — not ${n(ex.options.length)} separate products.`,
    );
  }
  if (ctx.differingPriceExample) {
    const ex = ctx.differingPriceExample;
    lines.push(
      "",
      "EXAMPLE B — OPTIONS WITH DIFFERENT PRICES",
      "",
      `${ex.parentSku} — ${ex.title} (product price = PRICE ON SELECTION):`,
      ...ex.options.map((o) => `- ${o.name}: ${price(o.price)}`),
      "option_price is the FULL selling price of that selected option, not an additional charge.",
    );
  }
  lines.push(
    "",
    "OPTION PRICING",
    "",
    "- If all options share one price: product_price = that common price and option_price = 0.",
    "- If options have different prices: product_price = PRICE ON SELECTION and option_price = the FULL effective selling price of that option.",
    "- option_price is never a surcharge/delta on top of another price.",
    "",
    "IMAGES",
    "",
    "- Exactly one primary image per parent product; all option rows share it.",
    "- The filename is based on the parent SKU (for example mk175.jpg).",
    "- No gallery images and no option/variant-specific images are included.",
    "- Image bytes are the original canonical source at original quality — never resized, recompressed or re-encoded.",
    "",
    "Attachments:",
    ...attachments.map((a) => `- ${a}`),
  );
  if (zipTooLargeForEmail) {
    lines.push("", "The full catalog package will be shared separately. (The ZIP is too large to attach to email.)");
  }
  lines.push("", "Regards,", "Malikas Universe");
  return lines.filter((l): l is string => l !== null).join("\n");
}

/** Build the complete draft from actual package metadata. Pure — never sends. */
export function buildRafeeqEmailDraft(ctx: RafeeqEmailContext): RafeeqEmailDraft {
  const isFull = ctx.mode === "FULL";
  const correction = ctx.correction ?? null;
  const zipTooLargeForEmail = (ctx.zipBytes ?? Number.MAX_SAFE_INTEGER) > RAFEEQ_EMAIL_MAX_ATTACH_BYTES;

  const subjectBase = isFull
    ? `Malikas Universe — Full Catalog Package (${n(ctx.productCount)} products) — ${ctx.filename}`
    : `Malikas Universe — New / Pending Products Package (${n(ctx.productCount)} products) — ${ctx.filename}`;
  const subject = correction ? `CORRECTED PACKAGE — ${subjectBase}` : subjectBase;

  const attachments = [
    "rafeeq_catalog.xlsx",
    ...(isFull ? [RAFEEQ_GUIDE_PNG] : []),
    zipTooLargeForEmail ? `${ctx.filename} (shared separately — too large for email)` : ctx.filename,
  ];

  const correctionHtml = correction
    ? `<p style="color:#b00020"><b>Please disregard the previous package and use this corrected package instead.</b><br/>
       Previous package: <code>${esc(correction.previousFilename)}</code></p>`
    : "";

  const newExplainer = !isFull
    ? ctx.newPackage?.hasSentBaseline
      ? `<p>This package contains ONLY the products/updates pending since the last package that was explicitly marked <b>SENT</b> — it is an incremental file, not the full catalog.</p>`
      : `<p><b>Note:</b> no SENT baseline exists yet, so this "new products" package effectively equals the whole current catalog${
          ctx.newPackage?.equalsWholeCatalog ? "" : " (or close to it)"
        }. For the first upload we recommend using the FULL catalog package as a complete replacement.</p>`
    : "";

  const fullStatement = isFull
    ? `<p><b>This package represents the full current Malikas Universe catalog.</b></p>`
    : "";

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#111111;max-width:640px;margin:0 auto;padding:0 8px">
  <p>Dear Rafeeq team,</p>
  <p>Please find our ${isFull ? "full catalog" : "new / pending products"} package below.</p>
  ${correctionHtml}
  ${fullStatement}
  ${newExplainer}

  <h2>Package summary</h2>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
    <tr><th align="left">File</th><td><code>${esc(ctx.filename)}</code></td></tr>
    <tr><th align="left">Generated</th><td>${esc(ctx.generatedAt)}</td></tr>
    <tr><th align="left">Products (product identities)</th><td><b>${n(ctx.productCount)}</b></td></tr>
    <tr><th align="left">Physical Excel rows</th><td><b>${n(ctx.physicalRowCount)}</b></td></tr>
    <tr><th align="left">Products with options</th><td>${n(ctx.productsWithOptions)}</td></tr>
    <tr><th align="left">Options</th><td>${n(ctx.optionCount)}</td></tr>
    <tr><th align="left">Images</th><td>${n(ctx.imageCount)}</td></tr>${
      typeof ctx.warningCount === "number" ? `\n    <tr><th align="left">Rows flagged for review</th><td>${n(ctx.warningCount)}</td></tr>` : ""
    }
  </table>
  <p><b>${n(ctx.physicalRowCount)} physical rows does NOT mean ${n(ctx.physicalRowCount)} products.</b>
  A product with options repeats its row once per option (see below).</p>

  <h2>How to read the workbook (3 sheets)</h2>
  <ol>
    <li><b>data</b> — the official Rafeeq import sheet on your audited template. <b>Use this sheet for the actual import.</b></li>
    <li><b>Malikas Reference</b> — a human-readable row-level reference for your staff: parent SKU, real barcode, category,
        image filename, ROW TYPE (e.g. "OPTION 2 OF 4"), TOTAL OPTIONS, option names/prices and notes.</li>
    <li><b>Options Overview</b> — contains ONLY the products that have options. Each parent product is shown as ONE block
        with all of its options underneath, so option relationships are easy to see at a glance.</li>
  </ol>

  <h2>How options work (please read)</h2>
  <ul>
    <li>One canonical product = <b>one</b> Rafeeq product identity.</li>
    <li>A product with options repeats its parent fields across several physical rows.</li>
    <li><b>These repeated rows represent ONE product with multiple options — not separate products.</b></li>
    <li>Each repeated row represents one option of the SAME parent product.</li>
    <li>The parent SKU stays the same across all of its option rows.</li>
    <li>The same parent image is shared by all option rows.</li>
    <li>The option-specific fields are: <code>group_name_english</code>, <code>group_name_arabic</code>,
        <code>option_name_english</code>, <code>option_name_arabic</code>, <code>option_price</code>,
        <code>option_sort_order</code>.</li>
  </ul>
  ${ctx.samePriceExample ? exampleTableSamePrice(ctx.samePriceExample) : ""}
  ${ctx.differingPriceExample ? exampleTableDiffering(ctx.differingPriceExample) : ""}

  <h2>Option pricing</h2>
  <ul>
    <li>If all options share one price: <code>product_price</code> = that common price and <code>option_price</code> = 0.</li>
    <li>If options have different prices: <code>product_price</code> = <code>PRICE ON SELECTION</code> and
        <code>option_price</code> = the FULL effective selling price of that option.</li>
    <li><code>option_price</code> is never a surcharge/delta on top of another price.</li>
  </ul>

  <h2>Images</h2>
  <ul>
    <li>Exactly one primary image per parent product; all option rows share it.</li>
    <li>The filename is based on the parent SKU (for example <code>mk175.jpg</code>).</li>
    <li>No gallery images and no option/variant-specific images are included.</li>
    <li>Image bytes are the original canonical source at original quality — the export never resizes,
        recompresses or re-encodes them.</li>
  </ul>

  ${isFull ? `<p>The attached <code>${RAFEEQ_GUIDE_PNG}</code> shows the option structure visually (one product → parent SKU → option group → options). The explanations above stand on their own if the image is not displayed.</p>` : ""}
  ${zipTooLargeForEmail ? `<p><b>The full catalog package will be shared separately.</b> (The ZIP is too large to attach to email.)</p>` : ""}

  <p>Thank you,<br/>Malikas Universe</p>
</div>`.trim();

  const textAr = [
    correction ? `⚠️ حزمة مصحّحة — الرجاء تجاهل الحزمة السابقة (${correction.previousFilename}) واستخدام هذه الحزمة بدلاً منها.` : null,
    isFull ? "هذه الحزمة تمثّل كتالوج ملكة يونيفرس الكامل الحالي." : (ctx.newPackage?.hasSentBaseline
      ? "هذه الحزمة تحتوي فقط على المنتجات/التحديثات المعلّقة منذ آخر حزمة عُلّمت «تم الإرسال»."
      : "لا يوجد خطّ أساس مُرسَل بعد — ملف «الجديد» يعادل عملياً الكتالوج كاملاً؛ يُنصح باستخدام الحزمة الكاملة للرفع الأول."),
    `الملف: ${ctx.filename}`,
    `تاريخ التوليد: ${ctx.generatedAt}`,
    `المنتجات (هويات): ${n(ctx.productCount)}`,
    `صفوف الملف الفعلية: ${n(ctx.physicalRowCount)} — ${n(ctx.physicalRowCount)} صفاً لا تعني ${n(ctx.physicalRowCount)} منتجاً`,
    `منتجات بخيارات: ${n(ctx.productsWithOptions)} · خيارات: ${n(ctx.optionCount)} · صور: ${n(ctx.imageCount)}`,
    "الصفوف المكرّرة لمنتج واحد تمثّل خياراته — ليست منتجات منفصلة. سعر الخيار هو السعر الكامل للبيع، وليس فرقاً إضافياً.",
    "صورة واحدة أصلية لكل منتج (باسم SKU الأب) — بدون صور معرض أو صور خيارات، وبدون أي ضغط أو تصغير.",
    `المرفقات: ${attachments.join(" · ")}`,
    zipTooLargeForEmail ? "ملف ZIP كبير — سيُشارَك بشكل منفصل (لا يُرفَق بالإيميل)." : null,
  ].filter((l): l is string => l !== null).join("\n");

  const textEmail = buildPlainTextEmail(ctx, attachments, zipTooLargeForEmail);
  return { to: RAFEEQ_EMAIL_TO_DEFAULT, subject, html, textEmail, textAr, attachments, zipTooLargeForEmail };
}
