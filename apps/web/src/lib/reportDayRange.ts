/** Inclusive ISO range for a report day in the server's IANA time zone. */
export function reportDayRange(
  day: string,
  timeZone: string,
): { from: string; to: string } {
  const nominal = Date.parse(`${day}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const label = (ms: number) => {
    const parts = formatter.formatToParts(ms);
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const boundary = (target: string, center: number) => {
    let low = center - 36 * 3600000;
    let high = center + 36 * 3600000;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (label(middle) < target) low = middle;
      else high = middle;
    }
    return high;
  };
  const next = new Date(nominal + 86400000).toISOString().slice(0, 10);
  return {
    from: new Date(boundary(day, nominal)).toISOString(),
    to: new Date(boundary(next, nominal + 86400000) - 1).toISOString(),
  };
}
