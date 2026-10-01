import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../公文OCR建檔工具.html", import.meta.url), "utf8");
const start = html.indexOf("const IS_INTERNAL_MEMO_RE");
const end = html.indexOf("// --- pipeline", start);
assert.ok(start >= 0 && end > start, "parser source block must remain discoverable");

const context = {};
vm.runInNewContext(
  `${html.slice(start, end)}\n` +
  "globalThis.__parser = { cleanOcrText, parseFields, extractMetadata, reconcileMetadataWithFilename, stripLeadingOcrNoise, detectDocumentSegments, pageHasDocumentHeader, applySegmentConsensus };",
  context,
);

const { extractMetadata, reconcileMetadataWithFilename, stripLeadingOcrNoise, detectDocumentSegments, applySegmentConsensus } = context.__parser;

test("keeps the existing clean-label format working", () => {
  const text = `
米花市政府教育局 函
受文者：米花市立南湖國民中學
發文日期：中華民國115年3月28日
發文字號：花教字第11500010010號
速別：普通件
附件：如說明
主旨：請辦理教育訓練，請查照。
說明：依據相關規定辦理。
正本：米花市立南湖國民中學`;

  const meta = extractMetadata(text, "米花市政府教育局 函", []);
  assert.equal(meta.agency, "米花市政府教育局");
  assert.equal(meta.recipient, "米花市立南湖國民中學");
  assert.equal(meta.docNumber, "花教字第11500010010號");
  assert.equal(meta.subject, "請辦理教育訓練，請查照。");
  assert.equal(meta.explanation, "依據相關規定辦理。");
});

test("accepts short non-CJK OCR noise before known labels", () => {
  assert.equal(stripLeadingOcrNoise(":受文者：臺東縣消防局"), "受文者：臺東縣消防局");
  assert.equal(stripLeadingOcrNoise("‧主旨：測試"), "主旨：測試");
  assert.equal(stripLeadingOcrNoise("3附件：如文"), "附件：如文");
  assert.equal(stripLeadingOcrNoise("一、附件內容如下"), "一、附件內容如下");
});

test("stops a long field at a noisy copy-recipient footer", () => {
  const text = `主旨：測試\n說明：內容\n共。正本:某機關\n副本:承辦單位`;
  const meta = extractMetadata(text, "", []);
  assert.equal(meta.explanation, "內容");
});

test("recognizes short CJK binding noise and common label misreads", () => {
  const text = `農。連別:普通件\n由主旨:測試內容\n說明:說明內容`;
  const meta = extractMetadata(text, "", []);
  assert.equal(meta.speed, "普通件");
  assert.equal(meta.subject, "測試內容");
});

test("keeps valid letterheads that use other government agency suffixes", () => {
  const text = `行政院 函\n發文字號：院臺字第1150000001號\n主旨：測試公文。`;
  const meta = extractMetadata(text, "行政院 函", []);
  assert.equal(meta.agency, "行政院");
});

test("extracts an agency despite OCR punctuation before the document type", () => {
  const text = `臺中市政府地政局”函\n受文者：地球公民基金會\n發文日期：中華民國110年5月5日\n發文字號：中市地編字第1100017003號\n主旨：測試。`;
  const meta = extractMetadata(text, "地址：40342臺中市西區", []);
  assert.equal(meta.agency, "臺中市政府地政局");
});

test("splits a registry bundle only when several strong document starts exist", () => {
  const cover = (number, date) => `
臺中市政府地政局函
受文者：地球公民基金會
發文日期：中華民國${date}
發文字號：中市地編字第${number}號
主旨：測試。`;
  const stamp = "本案依分層負責規定授權主管科長決行";
  const pages = [
    cover("1100017003", "110年5月5日"), stamp,
    cover("1100028101", "110年7月14日"), "第2頁，共2頁",
    cover("1090035773", "109年9月15日"), stamp,
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(detectDocumentSegments(pages))),
    [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(detectDocumentSegments(pages.slice(0, 4)))),
    [{ start: 0, end: 3 }],
  );
});

test("fills a missing agency only from a clear bundle majority", () => {
  const records = [
    { meta: { agency: "臺中市政府地政局" } },
    { meta: { agency: "臺中市政府地政局" } },
    { meta: { agency: "臺中市政府地政局" } },
    { meta: { agency: "臺中市政府" } },
    { meta: { agency: "" } },
  ];
  applySegmentConsensus(records);
  assert.equal(records[4].meta.agency, "臺中市政府地政局");
  assert.equal(records[3].meta.agency, "臺中市政府");
});

test("falls back to the copy recipient when OCR destroys the recipient label", () => {
  const text = `
令文者(存查
發文日期:中華民國115年6月12日
發文字號:花教字第11500012250號
主旨:會議紀錄
正本: (存查)`;
  const meta = extractMetadata(text, "米花市政府教育局 會議紀錄", []);
  assert.equal(meta.recipient, "(存查)");
});

test("uses an explicit reporting unit when the letterhead OCR is unusable", () => {
  const text = `
RIETHBARAT &
受文者:米花市政府教育局
發文字號:梅紋字第11500120010號
主旨:測試
填報單位:米花市梅由區公所填報日期:民國115年3月21日`;
  const meta = extractMetadata(text, "RIETHBARAT &", []);
  assert.equal(meta.agency, "米花市梅由區公所");
});

test("trusts an exact document-number filename only when its digits agree", () => {
  const corrected = reconcileMetadataWithFilename(
    { docNumber: "梅紋字第11500120010號" },
    "梅嶺字第11500120010號.pdf",
  );
  assert.equal(corrected.docNumber, "梅嶺字第11500120010號");

  const conflicting = reconcileMetadataWithFilename(
    { docNumber: "梅紋字第11500120011號" },
    "梅嶺字第11500120010號.pdf",
  );
  assert.equal(conflicting.docNumber, "梅紋字第11500120011號");
});

test("parses the noisy OCR-only Taitung layout without trusting the text layer", () => {
  const text = `
檔號:
-保存年限:
臺東縣政府函
.地址: 95001臺東市中山路276號過
承辦人:約聘人員HRE
:受文者:臺東縣消防局
:發文日期:中華民國115年9月29日
發文字號:府國資字第1150219578號
.速別:普通件
密等及解密條件或保密期限:
3附件:如文(376540000A_1150219578 ATTACHL. pdf ~
i 376540000A_1150219578 ATTACH2. png)
‧主旨:函轉數位發展部辦理115年「資料通識講座課程」,請依
業務需求自行報名參加,請查照。
:說明:
:一、依據數位發展部115年9月24日來函辦理。
正本:臺東縣各機關
\0PAGE\0
:各處
該。 #k相府國際李展及計畫處(瘡訊發展科)|條全全`;

  const meta = extractMetadata(
    text,
    ".地址: 95001臺東市中山路276號過",
    [".地址: 95001臺東市中山路276號過", "該。 #k相府國際李展及計畫處(瘡訊發展科)|條全全"],
  );

  assert.equal(meta.agency, "臺東縣政府");
  assert.equal(meta.recipient, "臺東縣消防局");
  assert.equal(meta.docNumber, "府國資字第1150219578號");
  assert.equal(meta.docDate, "中華民國115年9月29日");
  assert.equal(meta.speed, "普通件");
  assert.match(meta.attachment, /ATTACHL\. pdf/);
  assert.match(meta.attachment, /ATTACH2\. png/);
  assert.equal(meta.subject, "函轉數位發展部辦理115年「資料通識講座課程」,請依 業務需求自行報名參加,請查照。");
  assert.equal(meta.explanation, ":一、依據數位發展部115年9月24日來函辦理。");
});
