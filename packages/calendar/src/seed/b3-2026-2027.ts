import type { CalendarData } from '../types.js';

/**
 * Semente do calendário B3 de 2026 e 2027 (D15), com os tipos de dia do domínio
 * (Pregão e calendário §3.1). Dias úteis comuns e fins de semana não são listados.
 *
 * Datas móveis a partir da Páscoa (5/4/2026 e 28/3/2027): Carnaval = Páscoa − 48 e − 47,
 * Quarta-feira de Cinzas = − 46, Sexta-feira Santa = − 2, Corpus Christi = + 60.
 * Feriados que caem no fim de semana não aparecem (15/11/2026, 1/5/2027, 20/11/2027, 25/12/2027).
 *
 * A grade horária é a padrão do domínio (§4.1, parametrizável). Ajustes do ano (ex.: horário de
 * verão dos EUA) entram como novas vigências (RN-CAL-003).
 */
export const b3Calendar2026To2027: CalendarData = {
  coverage: { from: '2026-01-01', to: '2027-12-31' },
  days: [
    // 2026
    { date: '2026-01-01', type: 'HOLIDAY', description: 'Confraternização Universal' },
    { date: '2026-02-16', type: 'HOLIDAY', description: 'Carnaval (segunda-feira)' },
    { date: '2026-02-17', type: 'HOLIDAY', description: 'Carnaval (terça-feira)' },
    { date: '2026-02-18', type: 'LATE_OPEN', description: 'Quarta-feira de Cinzas' },
    { date: '2026-04-03', type: 'HOLIDAY', description: 'Sexta-feira Santa' },
    { date: '2026-04-21', type: 'HOLIDAY', description: 'Tiradentes' },
    { date: '2026-05-01', type: 'HOLIDAY', description: 'Dia do Trabalho' },
    { date: '2026-06-04', type: 'HOLIDAY', description: 'Corpus Christi' },
    { date: '2026-09-07', type: 'HOLIDAY', description: 'Independência do Brasil' },
    { date: '2026-10-12', type: 'HOLIDAY', description: 'Nossa Senhora Aparecida' },
    { date: '2026-11-02', type: 'HOLIDAY', description: 'Finados' },
    {
      date: '2026-11-20',
      type: 'HOLIDAY',
      description: 'Dia Nacional de Zumbi e da Consciência Negra',
    },
    { date: '2026-12-24', type: 'NO_TRADING', description: 'Véspera de Natal' },
    { date: '2026-12-25', type: 'HOLIDAY', description: 'Natal' },
    { date: '2026-12-31', type: 'NO_TRADING', description: 'Último dia do ano' },
    // 2027
    { date: '2027-01-01', type: 'HOLIDAY', description: 'Confraternização Universal' },
    { date: '2027-02-08', type: 'HOLIDAY', description: 'Carnaval (segunda-feira)' },
    { date: '2027-02-09', type: 'HOLIDAY', description: 'Carnaval (terça-feira)' },
    { date: '2027-02-10', type: 'LATE_OPEN', description: 'Quarta-feira de Cinzas' },
    { date: '2027-03-26', type: 'HOLIDAY', description: 'Sexta-feira Santa' },
    { date: '2027-04-21', type: 'HOLIDAY', description: 'Tiradentes' },
    { date: '2027-05-27', type: 'HOLIDAY', description: 'Corpus Christi' },
    { date: '2027-09-07', type: 'HOLIDAY', description: 'Independência do Brasil' },
    { date: '2027-10-12', type: 'HOLIDAY', description: 'Nossa Senhora Aparecida' },
    { date: '2027-11-02', type: 'HOLIDAY', description: 'Finados' },
    { date: '2027-11-15', type: 'HOLIDAY', description: 'Proclamação da República' },
    { date: '2027-12-24', type: 'NO_TRADING', description: 'Véspera de Natal' },
    { date: '2027-12-31', type: 'NO_TRADING', description: 'Último dia do ano' },
  ],
  schedules: [
    {
      validFrom: '2026-01-01',
      validTo: null,
      dayType: 'BUSINESS_DAY',
      phases: [
        { phase: 'PRE_TRADING', start: '09:00' },
        { phase: 'PRE_OPENING', start: '09:45' },
        { phase: 'CONTINUOUS', start: '10:00' },
        { phase: 'CLOSING_CALL', start: '16:55' },
        { phase: 'POST_CLOSE', start: '17:00' },
        { phase: 'CLOSED', start: '17:30' },
      ],
    },
    {
      // Quarta-feira de Cinzas: pregão a partir das 13:00 (§3.1), fases anteriores deslocadas.
      validFrom: '2026-01-01',
      validTo: null,
      dayType: 'LATE_OPEN',
      phases: [
        { phase: 'PRE_TRADING', start: '12:00' },
        { phase: 'PRE_OPENING', start: '12:45' },
        { phase: 'CONTINUOUS', start: '13:00' },
        { phase: 'CLOSING_CALL', start: '16:55' },
        { phase: 'POST_CLOSE', start: '17:00' },
        { phase: 'CLOSED', start: '17:30' },
      ],
    },
  ],
};
