import { BusinessDate } from '@broker/domain-kernel';

/** Soma meses de calendário; o dia passa para o último do mês quando não existe (31/01 + 1 = 28/02). */
export function plusMonths(date: BusinessDate, months: number): BusinessDate {
  const [y, m, d] = date.toString().split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return BusinessDate.parse(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  );
}
