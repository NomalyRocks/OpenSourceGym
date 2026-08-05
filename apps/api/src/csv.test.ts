import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { csvCell, csvRow } from "./csv.js";

describe("csvCell", () => {
  it('passes simple values through unchanged: "Ayse" -> "Ayse"', () => {
    assert.equal(csvCell("Ayse"), "Ayse");
    assert.equal(csvCell(42), "42");
    assert.equal(csvCell(true), "true");
  });

  it("converts both null and undefined to an empty string", () => {
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined), "");
  });

  it("serializes Date as ISO: new Date('2026-03-01T10:00:00.000Z')", () => {
    assert.equal(
      csvCell(new Date("2026-03-01T10:00:00.000Z")),
      "2026-03-01T10:00:00.000Z",
    );
  });

  it("quotes values containing commas, double quotes, or line breaks", () => {
    assert.equal(csvCell("Ali, Veli"), '"Ali, Veli"');
    assert.equal(csvCell('Ali "Veli"'), '"Ali ""Veli"""');
    assert.equal(csvCell("Ali\nVeli"), '"Ali\nVeli"');
    assert.equal(csvCell("Ali\r\nVeli"), '"Ali\r\nVeli"');
  });

  it("protects against formula injection by prefixing = + - @ with a single quote", () => {
    assert.equal(csvCell("=1+1"), "'=1+1");
    assert.equal(csvCell("+41 555"), "'+41 555");
    assert.equal(csvCell("-5"), "'-5");
    assert.equal(csvCell("@ad"), "'@ad");
  });

  it('handles a value requiring both protection and quoting: =cmd|"x"', () => {
    // Apply formula protection first ('=cmd|"x"), then quoting by doubling each inner ".
    assert.equal(csvCell('=cmd|"x"'), `"'=cmd|""x"""`);
  });
});

describe("csvRow", () => {
  it("joins cells with commas and terminates the row with CRLF", () => {
    assert.equal(csvRow(["a", "b"]), "a,b\r\n");
    assert.equal(
      csvRow(["Ali, Veli", "Yusuf Yilmaz"]),
      '"Ali, Veli",Yusuf Yilmaz\r\n',
    );
  });
});
