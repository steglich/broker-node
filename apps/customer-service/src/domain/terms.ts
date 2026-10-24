export type TermsMoment = 'ONBOARDING' | 'DAY_TRADE' | 'SECURITIES_LENDING' | 'OPTIONAL';

/** Termos iniciais (Contas §9). O texto completo é do jurídico; aqui, um resumo versionado. */
export const DEFAULT_TERMS: readonly {
  code: string;
  title: string;
  content: string;
  mandatory: boolean;
  moment: TermsMoment;
}[] = [
  {
    code: 'TERMS_OF_USE',
    title: 'Termos de uso',
    content: 'Termos de uso da plataforma, versão 1.',
    mandatory: true,
    moment: 'ONBOARDING',
  },
  {
    code: 'PRIVACY_POLICY',
    title: 'Política de privacidade',
    content: 'Política de privacidade, versão 1.',
    mandatory: true,
    moment: 'ONBOARDING',
  },
  {
    code: 'INTERMEDIATION_AGREEMENT',
    title: 'Contrato de intermediação',
    content: 'Contrato de intermediação, versão 1.',
    mandatory: true,
    moment: 'ONBOARDING',
  },
  {
    code: 'EQUITY_RISK_DISCLOSURE',
    title: 'Ciência de risco de renda variável',
    content: 'Termo de ciência de risco de renda variável, versão 1.',
    mandatory: true,
    moment: 'ONBOARDING',
  },
  {
    code: 'DAY_TRADE_LEVERAGE',
    title: 'Day trade e alavancagem',
    content: 'Termo de day trade e alavancagem, versão 1.',
    mandatory: true,
    moment: 'DAY_TRADE',
  },
  {
    code: 'SECURITIES_LENDING',
    title: 'Contrato de aluguel de ativos',
    content: 'Contrato de aluguel de ativos (BTC), versão 1.',
    mandatory: true,
    moment: 'SECURITIES_LENDING',
  },
  {
    code: 'MARKETING_CONSENT',
    title: 'Consentimento de marketing',
    content: 'Consentimento para comunicações de marketing, versão 1.',
    mandatory: false,
    moment: 'OPTIONAL',
  },
];
