import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { remainingDays, buildReminderMail } from "./renewals.js";

describe("remainingDays", () => {
  const now = new Date("2026-03-01T12:00:00.000Z");
  const DAY = 86400000;

  it("3 gün sonra sona eriyor", () => {
    assert.strictEqual(
      remainingDays(new Date(now.getTime() + 3 * DAY), now),
      3,
    );
  });

  it("3 gün + 5 saat sonra sona eriyor", () => {
    assert.strictEqual(
      remainingDays(new Date(now.getTime() + 3 * DAY + 5 * 3600000), now),
      3,
    );
  });

  it("bugün biten abonelik 0 gün gösterir", () => {
    assert.strictEqual(
      remainingDays(new Date(now.getTime() + 20 * 3600000), now),
      0,
    );
  });

  it("geçmiş bitiş negatif değil 0 döner", () => {
    assert.strictEqual(
      remainingDays(new Date(now.getTime() - 3600000), now),
      0,
    );
  });
});

describe("buildReminderMail", () => {
  const now = new Date("2026-03-01T12:00:00.000Z");
  const DAY = 86400000;

  it("salon adını, kalan günü ve üyenin adını içerir", () => {
    const mail = buildReminderMail({
      gymName: "Demir Spor",
      firstName: "Ayse",
      endsAt: new Date(now.getTime() + 3 * DAY),
      remainingDays: 3,
    });
    assert.ok(mail.subject.includes("Demir Spor"));
    assert.ok(mail.subject.includes("3 gün sonra sona eriyor"));
    assert.ok(mail.text.startsWith("Merhaba Ayse,"));
  });

  it('bugün biten abonelikte konu satırı "bugün" der', () => {
    const todayMail = buildReminderMail({
      gymName: "Demir Spor",
      firstName: "Ayse",
      endsAt: now,
      remainingDays: 0,
    });
    assert.ok(todayMail.subject.includes("bugün sona eriyor"));
    assert.ok(!todayMail.subject.includes("gün sonra"));
  });

  it("ad boşsa selamlama tek başına Merhaba olur", () => {
    const anon = buildReminderMail({
      gymName: "Demir Spor",
      firstName: "",
      endsAt: new Date(now.getTime() + DAY),
      remainingDays: 1,
    });
    assert.ok(anon.text.startsWith("Merhaba,"));
  });
});
