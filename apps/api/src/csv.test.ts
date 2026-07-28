import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { csvCell, csvRow } from "./csv.js";

describe("csvCell", () => {
  it('basit değerler değişmeden geçer: "Ayse" -> "Ayse"', () => {
    assert.equal(csvCell("Ayse"), "Ayse");
    assert.equal(csvCell(42), "42");
    assert.equal(csvCell(true), "true");
  });

  it("null ve undefined her ikisi de boş string olur", () => {
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined), "");
  });

  it("Date ISO olarak seri hale gelir: new Date('2026-03-01T10:00:00.000Z')", () => {
    assert.equal(
      csvCell(new Date("2026-03-01T10:00:00.000Z")),
      "2026-03-01T10:00:00.000Z",
    );
  });

  it("virgül, çift tırnak veya satır sonu içeren değer çift tırnaklanır", () => {
    assert.equal(csvCell("Ali, Veli"), '"Ali, Veli"');
    assert.equal(csvCell('Ali "Veli"'), '"Ali ""Veli"""');
    assert.equal(csvCell("Ali\nVeli"), '"Ali\nVeli"');
    assert.equal(csvCell("Ali\r\nVeli"), '"Ali\r\nVeli"');
  });

  it("formül enjeksiyon koruması: başında = + - @ olan değerler başına tek tırnak alır", () => {
    assert.equal(csvCell("=1+1"), "'=1+1");
    assert.equal(csvCell("+41 555"), "'+41 555");
    assert.equal(csvCell("-5"), "'-5");
    assert.equal(csvCell("@ad"), "'@ad");
  });

  it('hem koruma hem tırnak gerektiren değer=cmd|"x"', () => {
    // Önce formül koruması ('=cmd|"x"), sonra tırnaklama: içteki her " ikilenir.
    assert.equal(csvCell('=cmd|"x"'), `"'=cmd|""x"""`);
  });
});

describe("csvRow", () => {
  it("hücreler virgülle bağlanır ve satır CRLF ile sonlandırılır", () => {
    assert.equal(csvRow(["a", "b"]), "a,b\r\n");
    assert.equal(
      csvRow(["Ali, Veli", "Yusuf Yilmaz"]),
      '"Ali, Veli",Yusuf Yilmaz\r\n',
    );
  });
});
