import { Instant } from '@broker/domain-kernel';
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  catalogEntry,
  effectiveChannels,
  silenceable,
  type Channel,
} from '../src/domain/catalog.js';
import {
  insideQuietHours,
  nextAttempt,
  releaseAfterQuietHours,
  RETRY,
} from '../src/domain/delivery.js';
import {
  formatDate,
  formatDateTime,
  formatInteger,
  formatMoney,
  render,
  TemplateError,
} from '../src/domain/template.js';

const at = (iso: string) => Instant.parse(iso);

describe('formatação pt-BR (RN-NOT-G-002)', () => {
  it('moeda sem ponto flutuante: 1500.5 → R$ 1.500,50', () => {
    expect(formatMoney('1500.5')).toBe('R$ 1.500,50');
    expect(formatMoney('0.1')).toBe('R$ 0,10');
    expect(formatMoney('1000000')).toBe('R$ 1.000.000,00');
    expect(formatMoney('-1234.56')).toBe('-R$ 1.234,56');
    expect(formatMoney('-0.00')).toBe('R$ 0,00');
    expect(formatMoney('12345678901234.99')).toBe('R$ 12.345.678.901.234,99');
    expect(() => formatMoney('1,50')).toThrow(TemplateError);
  });

  it('data e hora no fuso de São Paulo; data sem fuso; inteiros com milhar', () => {
    expect(formatDateTime('2026-10-27T14:00:00Z')).toBe('27/10/2026 às 11:00');
    // 02:30 UTC ainda é o dia anterior em São Paulo.
    expect(formatDateTime('2026-10-28T02:30:00Z')).toBe('27/10/2026 às 23:30');
    expect(formatDate('2026-11-26')).toBe('26/11/2026');
    expect(formatInteger('1000')).toBe('1.000');
    expect(formatInteger('300')).toBe('300');
  });

  it('render: variáveis com filtro; ausente é erro; CPF nunca sai (RN-NOT-G-003)', () => {
    expect(
      render('Depósito de {{ amount|money }} em {{at|datetime}}.', {
        amount: '1500.5',
        at: '2026-10-27T14:00:00Z',
      }),
    ).toBe('Depósito de R$ 1.500,50 em 27/10/2026 às 11:00.');
    expect(() => render('{{x}}', {})).toThrow(/variável ausente/);
    expect(() => render('{{x|upper}}', { x: 'a' })).toThrow(/filtro desconhecido/);
    expect(render('Titular {{name}}', { name: 'CPF 123.456.789-09' })).toBe(
      'Titular CPF ***.***.***-**',
    );
    expect(render('{{id}}', { id: '12345678909' })).toBe('***.***.***-**');
  });
});

describe('catálogo (Notificações §3)', () => {
  const none = new Map<string, Map<Channel, boolean>>();

  it('obrigatórias ignoram a preferência; opcionais seguem o gravado ou o padrão', () => {
    const disabled = (code: string) =>
      new Map([
        [
          code,
          new Map<Channel, boolean>([
            ['IN_APP', false],
            ['DESKTOP', false],
          ]),
        ],
      ]);
    const margin = catalogEntry('MARGIN_CALL')!;
    expect(effectiveChannels(margin, disabled('MARGIN_CALL'))).toEqual([
      'IN_APP',
      'PUSH',
      'EMAIL',
      'SMS',
    ]);
    const partial = catalogEntry('ORDER_PARTIALLY_FILLED')!;
    expect(effectiveChannels(partial, none)).toEqual(['IN_APP', 'DESKTOP']);
    expect(effectiveChannels(partial, disabled('ORDER_PARTIALLY_FILLED'))).toEqual([]);
    // DAILY_SUMMARY nasce desligado.
    expect(effectiveChannels(catalogEntry('DAILY_SUMMARY')!, none)).toEqual([]);
  });

  it('RN-NOT-G-006: silêncio só para baixa e média em PUSH/EMAIL; crítica e segurança nunca', () => {
    const deposit = catalogEntry('DEPOSIT_CREDITED')!;
    expect(silenceable(deposit, 'EMAIL')).toBe(true);
    expect(silenceable(deposit, 'PUSH')).toBe(true);
    expect(silenceable(deposit, 'IN_APP')).toBe(false);
    expect(silenceable(catalogEntry('FORCED_LIQUIDATION')!, 'PUSH')).toBe(false);
    expect(silenceable(catalogEntry('WITHDRAWAL_COMPLETED')!, 'EMAIL')).toBe(false);
    expect(silenceable(catalogEntry('SECURITY_NEW_DEVICE')!, 'EMAIL')).toBe(false);
  });

  it('todo código tem canais, texto genérico de push e prioridade válida', () => {
    for (const e of CATALOG.values()) {
      expect(e.channels.length).toBeGreaterThan(0);
      expect(e.hiddenText).not.toMatch(/\d/);
    }
    expect(CATALOG.get('ORDER_PARTIALLY_FILLED')!.group).toEqual({
      by: 'orderId',
      windowMs: 5000,
    });
  });
});

describe('silêncio e retentativa', () => {
  const night = { start: '22:00', end: '07:00' };

  it('janela que atravessa a meia-noite, no horário de São Paulo', () => {
    // 23:30 em SP = 02:30Z do dia seguinte → libera às 07:00 de SP (10:00Z).
    expect(insideQuietHours(at('2026-10-28T02:30:00Z'), night)).toBe(true);
    expect(releaseAfterQuietHours(at('2026-10-28T02:30:00Z'), night).toString()).toBe(
      '2026-10-28T10:00:00.000Z',
    );
    // 06:00 em SP → 07:00 do mesmo dia.
    expect(releaseAfterQuietHours(at('2026-10-28T09:00:00Z'), night).toString()).toBe(
      '2026-10-28T10:00:00.000Z',
    );
    // 12:00 em SP: fora da janela.
    const noon = at('2026-10-28T15:00:00Z');
    expect(releaseAfterQuietHours(noon, night)).toBe(noon);
    expect(releaseAfterQuietHours(noon, null)).toBe(noon);
    // Janela no mesmo dia.
    expect(insideQuietHours(at('2026-10-28T16:00:00Z'), { start: '12:00', end: '14:00' })).toBe(
      true,
    );
  });

  it('backoff exponencial até o teto e nada depois do prazo (RN-NOT-G-007)', () => {
    const now = at('2026-10-27T14:00:00Z');
    const deadline = now.plusMillis(RETRY.EMAIL.windowMs);
    expect(nextAttempt(RETRY.EMAIL, 1, now, deadline)!.toString()).toBe('2026-10-27T14:01:00.000Z');
    expect(nextAttempt(RETRY.EMAIL, 3, now, deadline)!.toString()).toBe('2026-10-27T14:04:00.000Z');
    expect(nextAttempt(RETRY.EMAIL, 20, now, deadline)!.toString()).toBe(
      '2026-10-27T15:00:00.000Z',
    );
    expect(nextAttempt(RETRY.PUSH, 1, now, now.plusMillis(5_000))).toBeNull();
    expect(RETRY.EMAIL.windowMs).toBe(24 * 3_600_000);
    expect(RETRY.PUSH.windowMs).toBe(3_600_000);
  });
});
