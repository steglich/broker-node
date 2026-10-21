import { VirtualClock } from '@broker/clock';
import { BusinessDate, Instant } from '@broker/domain-kernel';

/** Instante padrão dos testes: segunda-feira, 5/1/2026, 10:00 em São Paulo (dia útil, pregão aberto). */
export const DEFAULT_TEST_INSTANT = '2026-01-05T13:00:00Z';

/**
 * Relógio virtual para testes (RN-QA-002, RN-CLK-002): parado até o teste mandar avançar.
 * Aceita um instante ISO (`2026-01-05T13:00:00Z`) ou uma data de negócio com hora local
 * (`{ date: '2026-02-18', time: '13:00' }`, em America/Sao_Paulo).
 */
export function testClock(
  start: string | { date: string; time: string } = DEFAULT_TEST_INSTANT,
): VirtualClock {
  const instant =
    typeof start === 'string'
      ? Instant.parse(start)
      : BusinessDate.parse(start.date).atLocalTime(start.time);
  return new VirtualClock(instant);
}
