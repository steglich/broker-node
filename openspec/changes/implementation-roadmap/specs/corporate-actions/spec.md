# Spec Delta

## Purpose

Captura, valida e aplica proventos em dinheiro e eventos em ações (desdobramento, grupamento, bonificação, conversão), calculando direitos na data-com e coordenando os efeitos em custódia, ledger, ordens, aluguel, preços e IR.

## ADDED Requirements

### Requirement: Fontes e confirmação
Eventos SHALL vir da brapi (quando o plano permitir, pedidos via market-data), do cadastro manual do backoffice ou de comando do sandbox; todo evento capturado automaticamente SHALL entrar como `ANNOUNCED` e exigir confirmação do backoffice; o cadastro manual SHALL exigir dupla aprovação (RN-CA-001, Proventos §2, Backoffice §3).

#### Scenario: Plano sem proventos
- **WHEN** o endpoint de proventos da brapi responde `403`
- **THEN** a captura automática fica desligada e o backoffice usa o cadastro manual (Q-02)

### Requirement: Deduplicação
Eventos SHALL ser deduplicados por `(instrument_id, type, record_date, value/factor)`, e uma mudança externa depois da confirmação SHALL gerar alerta em vez de sobrescrever (RN-CA-002).

#### Scenario: Valor alterado na fonte
- **WHEN** a brapi muda o valor de um dividendo já confirmado
- **THEN** o evento confirmado não muda e o backoffice recebe alerta

### Requirement: Ciclo de vida
O evento SHALL seguir `ANNOUNCED`, `CONFIRMED`, `DISCARDED`, `CANCELED` (antes da data-com), `ENTITLEMENTS_COMPUTED`, `APPLIED_POSITION`, `PROVISIONED`, `PAID` e `COMPLETED`, orquestrado com estado persistido (Proventos §4, RN-PAD §5).

#### Scenario: Cancelamento após a data-com
- **WHEN** alguém tenta cancelar um evento já em `ENTITLEMENTS_COMPUTED`
- **THEN** a transição é recusada

### Requirement: Direitos na data-com
No fim do pregão da data-com, o serviço SHALL registrar por conta a quantidade projetada com direito (inclui compras do dia, exclui vendas do dia), com bruto, IR, líquido, novas ações e fração; posições doadas creditam o doador e debitam o tomador (RN-CA-010..013, RN-BTC-020).

#### Scenario: Compra na data-com
- **WHEN** o cliente compra 100 ações na data-com
- **THEN** ele tem direito ao provento sobre essas 100

### Requirement: Provento em dinheiro
Na data-ex o provento SHALL ser provisionado sem lançamento; na data de pagamento (rotina das 08:30), SHALL publicar `corporate_action.paid` por conta para o ledger lançar D `ISSUER_DISTRIBUTIONS` / C `CUST_CASH` e, se houver IR, C `PAY_IRRF`; com data de pagamento a definir, fica `PROVISIONED` até o backoffice informar (RN-CA-020, RN-CA-021, RN-CA-023).

#### Scenario: JCP (CA-010)
- **WHEN** um JCP de R$ 1,00 por ação é pago a uma conta com 100 ações e IR de 15%
- **THEN** o bruto é R$ 100,00, o IR R$ 15,00 e o crédito líquido R$ 85,00

### Requirement: Arredondamento e regras fiscais de proventos
O bruto por conta SHALL ser `quantidade × valor_por_ação` truncado a centavos, o IR `bruto × alíquota` arredondado a centavos, e a tabela fiscal de proventos SHALL ter vigência e suportar alíquota condicionada a limite por fonte pagadora e mês (RN-CA-022, RN-CA-024).

#### Scenario: Truncamento
- **WHEN** o bruto calculado é R$ 33,3333
- **THEN** o bruto creditado é R$ 33,33

### Requirement: Eventos em ações
Desdobramento SHALL multiplicar a quantidade e dividir o PM pelo fator; grupamento SHALL usar `floor(qtd × fator)` e PM dividido pelo fator; bonificação SHALL criar `floor(qtd × fator)` ações com o custo atribuído e recalcular o PM; conversão SHALL transferir a posição e o custo total para o instrumento destino (RN-CA-030..037).

#### Scenario: Desdobramento e grupamento (CA-001)
- **WHEN** 150 ações a PM R$ 20,00 passam por desdobramento 1:2
- **THEN** a posição fica com 300 ações a PM R$ 10,00

#### Scenario: Bonificação
- **WHEN** 100 ações com custo total R$ 2.000,00 recebem bonificação de 10% com custo atribuído R$ 15,00
- **THEN** a posição fica com 110 ações e PM (2.000 + 150) / 110

### Requirement: Frações
Frações de todas as contas SHALL ser somadas e "vendidas" ao fechamento da data-com, com o valor creditado em até 30 dias como `FRACTION_AUCTION_PROCEEDS`, gerando resultado tributável com custo proporcional (RN-CA-040, RN-IR-013).

#### Scenario: Grupamento com fração
- **WHEN** 105 ações passam por grupamento 10:1
- **THEN** a conta fica com 10 ações e recebe depois o valor da fração de 0,5 ação

### Requirement: Efeitos colaterais da data-ex
Para eventos em ações, o instrumento SHALL ficar `SUSPENDED` do fechamento da data-com até a aplicação; ordens `GTC`/`GTD` SHALL ser canceladas; `previous_close` e `band_reference_price` SHALL ser ajustados pelo fator; contratos de aluguel e o estoque do FMS SHALL ser ajustados; candles não são reescritos. Proventos em dinheiro não ajustam o fechamento por padrão (RN-CA-050..056, RN-INS-021).

#### Scenario: Data-ex de desdobramento
- **WHEN** um desdobramento 1:2 é aplicado com fechamento anterior R$ 40,00
- **THEN** o `previous_close` ajustado é R$ 20,00 e as ordens `GTC` do instrumento são canceladas com `CORPORATE_ACTION`

### Requirement: Direitos de subscrição informativos
Direitos de subscrição SHALL ser só informativos na v1 (aparecem com prazo), com exercício simulado pelo backoffice (RN-CA-060).

#### Scenario: Direito anunciado
- **WHEN** uma subscrição é anunciada para um ativo da carteira
- **THEN** o cliente vê o direito e o prazo, sem opção de negociar o direito

### Requirement: Calendário de proventos do cliente
O cliente SHALL ver proventos futuros dos ativos que possui ou acompanha, com datas e valor estimado, e os recebidos por mês, ativo e tipo, com bruto, IR, líquido e totais anuais (RN-CA-070, RN-CA-071).

#### Scenario: Provento futuro
- **WHEN** um dividendo confirmado é de um ativo da carteira
- **THEN** ele aparece no calendário com o valor estimado para a posição
