# Spec Delta

## Purpose

Opera o aluguel de ativos (BTC): ofertas doadoras, casamento com tomadores, contratos, aluguel automático de posições vendidas, remuneração por dia útil, renovação, devolução e recall, com efeitos em custódia, ledger e risco.

## ADDED Requirements

### Requirement: Ofertas doadoras
O doador SHALL registrar oferta com instrumento, quantidade livre em custódia, taxa mínima anual, prazo máximo e `early_return_allowed`, com assinatura eletrônica, e SHALL poder cancelá-la enquanto não estiver contratada (RN-BTC-001, RN-SIG-002).

#### Scenario: Oferta acima do disponível
- **WHEN** o doador oferta mais ações do que tem livres
- **THEN** a oferta é recusada

### Requirement: Taxas e spread
A taxa de mercado por instrumento (padrão 2% a.a.; FIIs e BDRs não alugáveis por padrão) e o spread da corretora (padrão 30%) SHALL ser parâmetros: o tomador paga `taxa × 1,3`, o doador recebe `taxa` e a diferença vai para `REV_BTC_FEE` (RN-BTC-002).

#### Scenario: Taxa do tomador
- **WHEN** a taxa de mercado é 2% a.a.
- **THEN** o contrato registra 2,6% a.a. para o tomador e 2% a.a. para o doador

### Requirement: Casamento
Um pedido de tomada SHALL ser atendido pelas ofertas com taxa mínima ≤ taxa de mercado, por menor taxa e depois antiguidade, e o restante pelo doador da casa até `btc_house_available_qty` (RN-BTC-003, Risco §7.1).

#### Scenario: Sem ofertas de clientes
- **WHEN** não há ofertas de clientes para o instrumento
- **THEN** o contrato é fechado com o doador da casa, até a disponibilidade

### Requirement: Contrato e movimentos
O contrato SHALL registrar instrumento, quantidade, contas, taxas, preço de referência (fechamento de D−1), início, fim (padrão 30 dias corridos, mínimo 1 dia útil), devolução antecipada e status (`ACTIVE`, `RECALLED`, `RETURNED`, `DEFAULTED`); ao contratar, os ativos SHALL sair da custódia livre do doador e entrar na do tomador, com holds `BTC_LENT` e `BTC_COLLATERAL` no Risco, numa saga orquestrada (RN-BTC-004, RN-BTC-005, RN-PAD §5).

#### Scenario: Contrato aberto
- **WHEN** um contrato de 100 PETR4 é fechado
- **THEN** a custódia do doador mostra 100 doadas, a do tomador 100 tomadas, e `btc.contract_opened` é publicado

### Requirement: Remuneração por dia útil
A remuneração SHALL correr por dia útil com `fator = (1 + taxa_anual)^(1/252) − 1` e `custo_dia = quantidade × preço_referência × fator`, com custo mínimo de R$ 10,00 ao tomador por contrato, e SHALL ser liquidada na devolução ou renovação, em D+1, com IR retido do doador pela tabela regressiva (RN-BTC-010..012, IR §6.1).

#### Scenario: Taxa mínima (BTC-001)
- **WHEN** um contrato curto acumula R$ 3,20 de custo
- **THEN** o tomador paga R$ 10,00 na liquidação

### Requirement: Proventos durante o aluguel
Proventos em dinheiro com data-com durante o contrato SHALL ser reembolsados pelo tomador ao doador (bruto; JCP líquido) e eventos em ações SHALL ajustar a quantidade do contrato pelo fator (RN-BTC-020, RN-BTC-021).

#### Scenario: Desdobramento
- **WHEN** um desdobramento 1:2 é aplicado a um contrato de 100
- **THEN** o contrato passa a 200

### Requirement: Aluguel automático
No fim do pregão, cada posição vendida remanescente SHALL gerar aluguel automático pelo prazo padrão se o cliente aceitou o contrato de BTC; sem aceite ou sem doador, SHALL ser aplicada a recompra compulsória na abertura seguinte (`BTC_UNAVAILABLE`) (RN-BTC-030, RN-BTC-031, RN-SHT-004).

#### Scenario: Short sem aceite de BTC
- **WHEN** uma conta termina o dia vendida sem ter aceito o contrato de BTC
- **THEN** a posição é recomprada compulsoriamente na abertura seguinte

### Requirement: Renovação, devolução e recall
No vencimento, o contrato SHALL ser renovado se o tomador ainda estiver vendido e houver disponibilidade; o tomador SHALL poder devolver antes (remuneração pro rata); o doador SHALL poder pedir recall com prazo de D+3, e a venda de ativo doado SHALL disparar recall automático; o sistema tenta primeiro substituir o doador (RN-BTC-040..043).

#### Scenario: Recall com substituição
- **WHEN** o doador pede recall e existe outra oferta disponível
- **THEN** o contrato é transferido para o novo doador sem exigir recompra do tomador

#### Scenario: Recall sem devolução
- **WHEN** o prazo de D+3 do recall vence sem devolução nem substituição
- **THEN** o contrato fica `DEFAULTED` e o tomador sofre recompra compulsória

### Requirement: Exigência de perfil e termo
Tomar aluguel SHALL exigir perfil `AGGRESSIVE` e contrato de BTC aceito; doar SHALL exigir perfil `MODERATE` ou `AGGRESSIVE` e contrato aceito (RN-SUI-011, Onboarding §6.2, §9).

#### Scenario: Doador conservador
- **WHEN** um cliente `CONSERVATIVE` tenta criar oferta doadora
- **THEN** a oferta é recusada com `SUITABILITY_NOT_ALLOWED`
