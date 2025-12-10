// src/pages/reports/helpers/datePresets.ts

export type DateRange = { from: string; to: string };

function toSqlDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function presetToday(): DateRange {
  const now = new Date();
  return { from: toSqlDate(now), to: toSqlDate(now) };
}

export function presetYesterday(): DateRange {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return { from: toSqlDate(d), to: toSqlDate(d) };
}

export function presetCurrentWeek(): DateRange {
  const now = new Date();
  const day = now.getDay() === 0 ? 7 : now.getDay(); // Sunday fix
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day - 1));

  return {
    from: toSqlDate(monday),
    to: toSqlDate(now),
  };
}

export function presetPrevWeek(): DateRange {
  const now = new Date();
  const day = now.getDay() === 0 ? 7 : now.getDay();

  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() - (day - 1));

  const prevMonday = new Date(thisMonday);
  prevMonday.setDate(prevMonday.getDate() - 7);

  const prevSunday = new Date(thisMonday);
  prevSunday.setDate(prevSunday.getDate() - 1);

  return {
    from: toSqlDate(prevMonday),
    to: toSqlDate(prevSunday),
  };
}

export function presetCurrentMonth(): DateRange {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    from: toSqlDate(first),
    to: toSqlDate(now),
  };
}
