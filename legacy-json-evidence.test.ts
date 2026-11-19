import { expect, test } from "bun:test";
import { compareLegacyJsonEvidence, legacyEvidenceDigest, parseLegacyJsonEvidence } from "./legacy-json-evidence.ts";

const compare = (old: string, source: string) => compareLegacyJsonEvidence(parseLegacyJsonEvidence(old), parseLegacyJsonEvidence(source));

test("保精度复核将旧 stage_name 的大整数舍入与普通内容差异区分", () => {
  const source = '{"level":[{"stage_name":1358289180218405445}]}';
  const old = '{"level":[{"stage_name":1358289180218405400}]}';
  expect(compare(old, source)).toEqual({ status: "legacy-integer-rounding", differenceCount: 1, roundingCount: 1, differences: [{
    path: "/level/0/stage_name", kind: "legacy-integer-rounding", oldNumber: "1358289180218405400", sourceNumber: "1358289180218405445",
  }] });
  expect(compare(old.replace("stage_name", "id"), source.replace("stage_name", "id")).status).toBe("different");
  expect(compare(old.replace("5400", "5500"), source).status).toBe("different");
  expect(legacyEvidenceDigest(parseLegacyJsonEvidence(old))).not.toBe(legacyEvidenceDigest(parseLegacyJsonEvidence(source)));
});

test("精确十进制允许等值写法，但不会把字符串、数组重排或溢出值认作相等", () => {
  expect(compare('{"a":1.250,"b":10e-1,"c":-0,"d":1e1024}', '{"d":10e1023,"c":0,"b":1,"a":125e-2}').status).toBe("exact");
  expect(compare('1e1024', '1e1025').status).toBe("different");
  expect(compare('{"a":"1","b":[1,2]}', '{"a":1,"b":[2,1]}')).toMatchObject({ status: "different", differenceCount: 3 });
  expect(compare('{"__proto__":1,"a/b~c":0}', '{"__proto__":2,"a/b~c":1}').differences.map(({ path }) => path))
    .toEqual(["/__proto__", "/a~1b~0c"]);
});
