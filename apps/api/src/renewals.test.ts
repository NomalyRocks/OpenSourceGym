import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { remainingDays, buildReminderMail } from "./renewals.js";

describe("remainingDays", () => {
  // Istanbul UTC+3: this instant is March 1 at 15:00 local time.
  const now = new Date("2026-03-01T12:00:00.000Z");
  const DAY = 86400000;
  const TZ = "Europe/Istanbul";

  it("expires in 3 days", () => {
    assert.strictEqual(
      remainingDays(new Date(now.getTime() + 3 * DAY), now, TZ),
      3,
    );
  });

  it("expires in 3 days and 5 hours", () => {
    assert.strictEqual(
      remainingDays(new Date(now.getTime() + 3 * DAY + 5 * 3600000), now, TZ),
      3,
    );
  });

  it("counts calendar days: 20 hours later is tomorrow, not today", () => {
    // Flooring the raw 24-hour difference would produce 0 and send the member
    // an incorrect email saying the subscription expires today.
    assert.strictEqual(
      remainingDays(new Date(now.getTime() + 20 * 3600000), now, TZ),
      1,
    );
  });

  it("returns 0 for a subscription ending on the same calendar day", () => {
    assert.strictEqual(
      remainingDays(new Date(now.getTime() + 5 * 3600000), now, TZ),
      0,
    );
  });

  it("returns 0 instead of a negative value for a past expiry", () => {
    assert.strictEqual(
      remainingDays(new Date(now.getTime() - 3 * DAY), now, TZ),
      0,
    );
  });
});

describe("buildReminderMail", () => {
  const now = new Date("2026-03-01T12:00:00.000Z");
  const DAY = 86400000;

  it("includes the gym name, remaining days, and member name", () => {
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

  it('says "today" in the subject for a subscription ending today', () => {
    const todayMail = buildReminderMail({
      gymName: "Demir Spor",
      firstName: "Ayse",
      endsAt: now,
      remainingDays: 0,
    });
    assert.ok(todayMail.subject.includes("bugün sona eriyor"));
    assert.ok(!todayMail.subject.includes("gün sonra"));
  });

  it("formats the date label in the provided time zone", () => {
    // This instant is March 2 in Istanbul (UTC+3), but still March 1 in UTC.
    // If the label does not use the same zone as remainingDays, the email
    // contradicts itself by showing the date one day earlier.
    const endsAt = new Date("2026-03-01T22:00:00.000Z");
    const istanbul = buildReminderMail({
      gymName: "Demir Spor",
      firstName: "Ayse",
      endsAt,
      remainingDays: 1,
      timeZone: "Europe/Istanbul",
    });
    const utc = buildReminderMail({
      gymName: "Demir Spor",
      firstName: "Ayse",
      endsAt,
      remainingDays: 1,
      timeZone: "UTC",
    });
    assert.ok(istanbul.text.includes("2 Mart 2026"));
    assert.ok(utc.text.includes("1 Mart 2026"));
  });

  it("uses only the default greeting when the name is empty", () => {
    const anon = buildReminderMail({
      gymName: "Demir Spor",
      firstName: "",
      endsAt: new Date(now.getTime() + DAY),
      remainingDays: 1,
    });
    assert.ok(anon.text.startsWith("Merhaba,"));
  });
});
