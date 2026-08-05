/** The week starts on Monday—the convention of the app's primary locale (`tr`). */
export const WEEK_START = 1;

export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface WeekDay {
  date: Date;
  key: string;
}

/** Splits the Monday-based week containing the reference date into seven days. */
export function buildWeek(reference: Date): WeekDay[] {
  const diff = (reference.getDay() - WEEK_START + 7) % 7;
  const monday = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate() - diff,
  );
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(
      monday.getFullYear(),
      monday.getMonth(),
      monday.getDate() + index,
    );
    return { date, key: dayKey(date) };
  });
}
