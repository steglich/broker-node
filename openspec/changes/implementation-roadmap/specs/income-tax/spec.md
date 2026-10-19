# Spec Delta

## Purpose

Apura mensalmente o imposto sobre ganhos em renda variável por categoria, controla prejuízos e IRRF a compensar, gera DARF simulado e consolida o relatório anual de auxílio à declaração, com regras fiscais parametrizadas por vigência.

## ADDED Requirements

### Requirement: Regras fiscais com vigência
Alíquotas, limites de isenção, matriz de compensação, valor mínimo do DARF, multa, juros e tabela regressiva de aluguel SHALL ficar em `tax_rules` com vigência, alteradas só com dupla aprovação de `BO_ADMIN` (P-06, RN-IR-001, Backoffice §3).

#### Scenario: Mudança de alíquota
- **WHEN** uma nova alíquota passa a valer em 1º de janeiro
- **THEN** meses anteriores continuam apurados com a alíquota antiga

### Requirement: Registro de resultados realizados
O serviço SHALL registrar resultados realizados por categoria (`COMMON_STOCKS`, `COMMON_ETF`, `COMMON_BDR`, `DAY_TRADE`, `REIT`) a partir de `custody.position_changed`, `clearing.daytrade_classified`, `clearing.note_generated`, frações e proventos, rastreáveis até a nota e o negócio, publicando `tax.realized_result_recorded` (IR §2, §3).

#### Scenario: Venda de FII
- **WHEN** uma venda swing de FII realiza lucro
- **THEN** o resultado é registrado na categoria `REIT`

### Requirement: Isenção de ações
Quando as vendas swing de ações e units no mês forem ≤ R$ 20.000,00, o ganho de `COMMON_STOCKS` SHALL ser isento e registrado como rendimento isento; o prejuízo de mês isento continua compensável (IR §4, RN-IR-011).

#### Scenario: Mês isento com prejuízo em ETF (IR-001)
- **WHEN** no mês a conta vende R$ 15.000,00 em ações com lucro de R$ 1.000,00 e tem prejuízo de R$ 300,00 em ETF
- **THEN** o lucro de ações é isento e o prejuízo de R$ 300,00 vai para o acumulado do grupo `COMMON`

### Requirement: Compensação de prejuízos
Prejuízos SHALL ser acumulados por grupo (`COMMON`, `DAY_TRADE`, `REIT`) sem prescrição e compensados conforme a matriz parametrizável (padrão: só dentro do grupo), aplicando a compensação proporcionalmente às bases positivas das categorias (RN-IR-001, RN-IR-002, RN-IR-010).

#### Scenario: Compensação por grupo (IR-002)
- **WHEN** a conta tem R$ 1.000,00 de prejuízo acumulado em `DAY_TRADE` e lucro de R$ 1.500,00 em day trade no mês
- **THEN** a base de day trade do mês é R$ 500,00 e o acumulado zera

### Requirement: IRRF dedutível
O IRRF swing e de day trade SHALL ser deduzido do imposto do grupo correspondente e o saldo não usado SHALL passar aos meses seguintes do mesmo ano-calendário, aparecendo no relatório anual ao fim do ano (RN-IR-012).

#### Scenario: Saldo de IRRF (IR-004)
- **WHEN** o IRRF do mês é maior que o imposto devido do grupo
- **THEN** o imposto do mês é zero e a sobra fica para os meses seguintes do mesmo ano

### Requirement: Apuração mensal
A apuração SHALL rodar no primeiro dia útil do mês seguinte, por conta, e publicar `tax.monthly_assessment_completed`; o cliente SHALL ter prévia do mês corrente em tempo real; o resultado de venda a descoberto é apurado no mês da recompra (IR §4, RN-IR-014).

#### Scenario: Short recomprado no mês seguinte
- **WHEN** a venda a descoberto ocorre em março e a recompra em abril
- **THEN** o resultado entra na apuração de abril

### Requirement: DARF simulado
O DARF SHALL ter código 6015, período de apuração, vencimento no último dia útil do mês seguinte, valor principal, multa (0,33% ao dia até 20%), juros (padrão 1% a.m. após o vencimento), código de barras fictício e marca d'água; valores abaixo de R$ 10,00 SHALL ser acumulados até atingir o mínimo (RN-DARF-001..004).

#### Scenario: Abaixo do mínimo (IR-003)
- **WHEN** o imposto do mês é R$ 7,00
- **THEN** o DARF fica `ACCUMULATED` e o valor é somado ao do mês seguinte

#### Scenario: DARF em atraso
- **WHEN** o cliente gera um DARF 10 dias após o vencimento
- **THEN** a multa é 3,3% do principal e o DARF é recalculado na geração

### Requirement: Pagamento e estados do DARF
O cliente SHALL poder marcar o DARF como pago com débito do saldo (D `CUST_CASH` / C `PAY_TAX_DARF`, com assinatura) ou declarar pagamento externo, com estados `GENERATED`, `PAID`, `OVERDUE`, `ACCUMULATED` e `CANCELED` (RN-DARF-005, RN-DARF-006).

#### Scenario: Pagar com saldo
- **WHEN** o cliente paga o DARF com saldo
- **THEN** `tax.darf_paid` é publicado e o ledger lança o débito `SETTLED`

### Requirement: Retificação
A mudança de um mês já apurado SHALL gerar nova versão da apuração e cancelar o DARF anterior não pago, ou gerar DARF complementar ou crédito informativo se já pago (RN-DARF-007).

#### Scenario: Correção de nota
- **WHEN** uma nota de retificação muda o resultado de um mês apurado com DARF não pago
- **THEN** a apuração ganha nova versão, o DARF antigo fica `CANCELED` e um novo é gerado

### Requirement: Rendimentos e relatório anual
O serviço SHALL registrar proventos e remuneração de aluguel (tabela regressiva) e gerar, a partir de fevereiro do ano seguinte, o relatório anual com bens e direitos em 31/12, rendimentos isentos, tributação exclusiva, renda variável mês a mês e informe de rendimentos, exportável em PDF e CSV/JSON, publicando `tax.annual_report_available` (IR §6, RN-ANU-001..006).

#### Scenario: Bens e direitos
- **WHEN** o relatório anual é gerado
- **THEN** cada posição em 31/12 aparece com quantidade e custo de aquisição (PM × quantidade)
