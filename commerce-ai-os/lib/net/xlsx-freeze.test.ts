// Freeze-header-row patcher tests.
// node --conditions=react-server --experimental-strip-types --test lib/net/xlsx-freeze.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { buildZip } from "./zip.ts";
import { freezeSheetXml, freezeTopRow, readStoredZip } from "./xlsx-freeze.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

test("freezeSheetXml patches the self-closing sheetView SheetJS emits", () => {
  const out = freezeSheetXml('<sheetViews><sheetView workbookViewId="0"/></sheetViews>');
  assert.match(out, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(out, /<\/sheetView>/);
});

test("freezeSheetXml patches an open/close sheetView pair", () => {
  const out = freezeSheetXml('<sheetView workbookViewId="0"><x/></sheetView>');
  assert.match(out, /<pane /);
  assert.ok(out.indexOf("<pane") < out.indexOf("<x/>"));
});

test("freezeSheetXml is idempotent and leaves unknown XML untouched", () => {
  const already = '<sheetView><pane ySplit="1"/></sheetView>';
  assert.equal(freezeSheetXml(already), already);
  assert.equal(freezeSheetXml("<worksheet/>"), "<worksheet/>");
});

test("readStoredZip round-trips STORE entries in order", () => {
  const zip = buildZip([
    { name: "a.txt", data: enc.encode("AAA") },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode("<sheetView/>") },
  ]);
  const back = readStoredZip(zip);
  assert.ok(back);
  assert.deepEqual(back!.map((e) => e.name), ["a.txt", "xl/worksheets/sheet1.xml"]);
  assert.equal(dec.decode(back![0].data), "AAA");
});

test("readStoredZip refuses bytes that are not a STORE zip", () => {
  assert.equal(readStoredZip(enc.encode("not a zip at all")), null);
});

test("freezeTopRow rewrites every worksheet part and leaves others byte-identical", () => {
  const zip = buildZip([
    { name: "[Content_Types].xml", data: enc.encode("<Types/>") },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode('<sheetViews><sheetView workbookViewId="0"/></sheetViews>') },
    { name: "xl/worksheets/sheet2.xml", data: enc.encode('<sheetViews><sheetView workbookViewId="0"/></sheetViews>') },
    { name: "xl/sharedStrings.xml", data: enc.encode("<sst/>") },
  ]);
  const out = readStoredZip(freezeTopRow(zip))!;
  assert.equal(out.length, 4);
  assert.equal(dec.decode(out[0].data), "<Types/>");
  assert.equal(dec.decode(out[3].data), "<sst/>");
  assert.match(dec.decode(out[1].data), /<pane /);
  assert.match(dec.decode(out[2].data), /<pane /);
});

test("freezeTopRow returns the ORIGINAL bytes when the archive cannot be parsed", () => {
  const junk = enc.encode("PK-but-not-really");
  assert.equal(freezeTopRow(junk), junk);
});

test("freezeTopRow returns the original bytes when there is nothing to patch", () => {
  const zip = buildZip([{ name: "docProps/core.xml", data: enc.encode("<c/>") }]);
  assert.equal(freezeTopRow(zip), zip);
});
