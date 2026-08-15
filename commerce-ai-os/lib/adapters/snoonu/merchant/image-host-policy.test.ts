// CH.6B — image host allow-list tests.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/image-host-policy.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedSnoonuImageUrl } from "./image-host-policy.ts";

test("allows https Snoonu hosts and their subdomains", () => {
  assert.equal(isAllowedSnoonuImageUrl("https://cdn.snoonu.com/img/a.jpg"), true);
  assert.equal(isAllowedSnoonuImageUrl("https://media.snoonu.com/x.png"), true);
  assert.equal(isAllowedSnoonuImageUrl("https://sub.storage.snoonu.com/y.webp"), true);
  assert.equal(isAllowedSnoonuImageUrl("https://snoonu.com/z.jpg"), true);
});

test("rejects non-Snoonu hosts, http, IPs, and junk (no arbitrary URL fetch / SSRF)", () => {
  assert.equal(isAllowedSnoonuImageUrl("https://evil.example.com/a.jpg"), false);
  assert.equal(isAllowedSnoonuImageUrl("http://cdn.snoonu.com/a.jpg"), false); // not https
  assert.equal(isAllowedSnoonuImageUrl("https://169.254.169.254/latest/meta-data"), false); // metadata IP
  assert.equal(isAllowedSnoonuImageUrl("https://snoonu.com.evil.com/a.jpg"), false); // suffix spoof
  assert.equal(isAllowedSnoonuImageUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedSnoonuImageUrl(""), false);
  assert.equal(isAllowedSnoonuImageUrl(null), false);
  assert.equal(isAllowedSnoonuImageUrl("not a url"), false);
});
