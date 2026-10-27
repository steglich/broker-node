// Templates versionados (RN-NOT-G-001/002): `{{variavel}}` ou `{{variavel|filtro}}`, com moeda,
// número e data no locale pt-BR e fuso America/Sao_Paulo. Variável ausente é erro do template.
import { BUSINESS_TIME_ZONE, Instant } from '@broker/domain-kernel';

/** Template com variável ausente, filtro desconhecido ou valor fora do formato: defeito, não dado. */
export class TemplateError extends Error {
  override readonly name = 'TemplateError';
  constructor(
    readonly code:
      'TEMPLATE_VARIABLE_MISSING' | 'TEMPLATE_UNKNOWN_FILTER' | 'TEMPLATE_INVALID_VALUE',
    message: string,
  ) {
    super(message);
  }
}

export type TemplateVars = Readonly<Record<string, string>>;

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Decimal em texto (`1500.5`) → `R$ 1.500,50`, sem passar por ponto flutuante. */
export function formatMoney(value: string): string {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new TemplateError('TEMPLATE_INVALID_VALUE', `valor monetário inválido: ${value}`);
  const cents = ((m[3] ?? '') + '00').slice(0, 2);
  const integer = m[2]!.replace(/^0+(?=\d)/, '');
  const negative = m[1] && /[1-9]/.test(integer + cents);
  return `${negative ? '-' : ''}R$ ${group(integer)},${cents}`;
}

/** Inteiro (quantidade) com separador de milhar: `1000` → `1.000`. */
export function formatInteger(value: string): string {
  if (!/^-?\d+$/.test(value.trim()))
    throw new TemplateError('TEMPLATE_INVALID_VALUE', `inteiro inválido: ${value}`);
  const v = value.trim();
  return v.startsWith('-') ? `-${group(v.slice(1))}` : group(v);
}

const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: BUSINESS_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Instante ISO → `27/10/2026 às 11:30` (horário de São Paulo). */
export function formatDateTime(iso: string): string {
  const parts = Object.fromEntries(
    dateTimeFormat
      .formatToParts(new Date(Instant.parse(iso).epochMillis))
      .map((p) => [p.type, p.value]),
  );
  return `${parts['day']}/${parts['month']}/${parts['year']} às ${parts['hour']}:${parts['minute']}`;
}

/** Data ISO (sem fuso) → `27/10/2026`. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new TemplateError('TEMPLATE_INVALID_VALUE', `data inválida: ${iso}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

const FILTERS: Record<string, (v: string) => string> = {
  money: formatMoney,
  int: formatInteger,
  datetime: formatDateTime,
  date: formatDate,
};

/** CPF com ou sem máscara: nunca sai numa notificação (RN-NOT-G-003). */
const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
export const redactSensitive = (text: string): string => text.replace(CPF, '***.***.***-**');

export function render(template: string, vars: TemplateVars): string {
  const out = template.replace(
    /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*(?:\|\s*([a-z]+)\s*)?\}\}/g,
    (_m, name: string, filter: string | undefined) => {
      const value = vars[name];
      if (value === undefined)
        throw new TemplateError(
          'TEMPLATE_VARIABLE_MISSING',
          `variável ausente no template: ${name}`,
        );
      if (!filter) return value;
      const f = FILTERS[filter];
      if (!f) throw new TemplateError('TEMPLATE_UNKNOWN_FILTER', `filtro desconhecido: ${filter}`);
      return f(value);
    },
  );
  return redactSensitive(out);
}
