# Spec Delta

## Purpose

Define os tipos de domínio compartilhados (dinheiro, preço, quantidade, documentos, datas de negócio, identificadores, relógio e calendário) com regras de precisão e arredondamento determinísticas, para que nenhum serviço use primitivos ou ponto flutuante em valores financeiros.

## ADDED Requirements

### Requirement: Representação decimal de valores financeiros
Dinheiro, preços, taxas e alíquotas SHALL ser representados por decimal de precisão fixa, nunca por ponto flutuante binário. Valores lançados em conta usam 2 casas; preço de negociação usa 2 casas (suporta 4); preço de referência, PM e taxas usam 8 casas; cálculos intermediários usam pelo menos 8 casas e arredondam só no fim (ADR-0004, RN-LED-004, RN-PAD-001).

#### Scenario: Soma sem erro de ponto flutuante
- **WHEN** o sistema soma `Money("0.10", BRL)` e `Money("0.20", BRL)`
- **THEN** o resultado é exatamente `Money("0.30", BRL)`

#### Scenario: Primitivo rejeitado no domínio
- **WHEN** um caso de uso tenta construir um valor monetário a partir de um número de ponto flutuante
- **THEN** a construção é recusada e só a construção a partir de string decimal ou de inteiro na menor unidade é aceita

### Requirement: Moeda explícita
Todo valor monetário SHALL carregar a moeda (ISO 4217), mesmo com uma única moeda (`BRL`). Operações entre moedas diferentes SHALL ser recusadas (ADR-0004, P-01).

#### Scenario: Moedas diferentes
- **WHEN** o sistema tenta somar um valor em `BRL` com um valor em outra moeda
- **THEN** a operação falha com erro de domínio

### Requirement: Modos de arredondamento explícitos
O arredondamento SHALL ser sempre explícito: `HALF_UP` a 2 casas por componente (custos, IR, notas), truncamento para proventos por conta, direção conservadora explícita para ticks do FMS e trailing stop, e rateio pelo maior resto com resíduo para o item de maior valor e desempate determinístico (ADR-0004, RN-FEE-030, RN-FEE-031, RN-CA-022).

#### Scenario: HALF_UP de emolumentos
- **WHEN** os emolumentos calculados são `0.1925`
- **THEN** o valor arredondado é `0.19`

#### Scenario: Rateio com resíduo
- **WHEN** R$ 0,10 é rateado igualmente entre três negócios de notional igual
- **THEN** a soma das partes é exatamente R$ 0,10 e o centavo residual vai para o negócio de menor `trade_id` entre os empatados

#### Scenario: Truncamento de provento
- **WHEN** o provento bruto de uma conta é `12.3456` reais
- **THEN** o valor creditado é `12.34`

### Requirement: Quantidade inteira
Quantidades de ativos SHALL ser inteiros de 64 bits, maiores que zero quando representarem quantidade de ordem (RN-DB modelagem, RN-ORD).

#### Scenario: Quantidade fracionária recusada
- **WHEN** um comando informa quantidade `10.5`
- **THEN** o valor é rejeitado na construção do objeto de valor

### Requirement: CPF validado na construção
O objeto `TaxId` SHALL aceitar só CPFs de 11 dígitos com dígitos verificadores válidos (módulo 11) e SHALL rejeitar sequências repetidas. O valor exibido fora do titular SHALL ser mascarado (`***.456.789-**`) (RN-ONB §4.1, RN-LGPD inventário).

#### Scenario: CPF com dígito inválido
- **WHEN** o sistema constrói um `TaxId` com dígito verificador errado
- **THEN** a construção falha com `TAX_ID_INVALID`

#### Scenario: Sequência repetida
- **WHEN** o sistema constrói um `TaxId` com `11111111111`
- **THEN** a construção falha com `TAX_ID_INVALID`

### Requirement: Identificadores UUID v7
IDs internos SHALL ser UUID versão 7 gerados pela aplicação. IDs sequenciais do banco SHALL NOT ser expostos em APIs. IDs legíveis ao cliente (conta, nota, protocolo) SHALL ter formato próprio além do UUID (RN-PAD-060..062).

#### Scenario: Ordenação temporal
- **WHEN** dois IDs são gerados em sequência pelo mesmo processo
- **THEN** o segundo é maior que o primeiro na ordenação lexicográfica

### Requirement: Relógio injetável
Toda regra temporal SHALL usar a porta de relógio do sistema; código de domínio SHALL NOT ler o relógio da máquina, e uma verificação estática no build SHALL falhar se isso acontecer (RN-CLK-001, ADR-0009, RN-ARQ-011).

#### Scenario: Leitura direta do relógio no domínio
- **WHEN** um arquivo de domínio chama o relógio da máquina diretamente
- **THEN** a verificação estática do pipeline falha apontando o arquivo

#### Scenario: Relógio virtual em teste
- **WHEN** um teste avança o relógio virtual para `2026-10-16T20:00:00Z`
- **THEN** toda regra que pergunta a hora recebe esse instante

### Requirement: Data de negócio no fuso de São Paulo
Datas de negócio SHALL ser datas sem fuso calculadas em `America/Sao_Paulo`; persistência e mensagens SHALL usar UTC com ISO 8601 e sufixo `Z` (P-02).

#### Scenario: Virada de dia em UTC
- **WHEN** o relógio marca `2026-10-17T01:30:00Z`
- **THEN** a data de negócio é `2026-10-16`

### Requirement: Funções de calendário compartilhadas
Todos os serviços SHALL usar as mesmas funções de calendário (`is_business_day`, `next_business_day(d, n)`, `previous_business_day(d, n)`, `business_days_between`, `session_schedule(d)`), alimentadas pelos dados do calendário publicados pelo dono (RN-CAL-002, RN-CAL-003).

#### Scenario: Próximo dia útil com Carnaval (CAL-001)
- **WHEN** o sistema calcula `next_business_day` a partir da sexta-feira anterior ao Carnaval com `n = 1`
- **THEN** o resultado é a quarta-feira de Cinzas, marcada como `LATE_OPEN`

#### Scenario: Fim de ano
- **WHEN** o sistema calcula `next_business_day(2026-12-30, 1)` com 31/12 marcado como `NO_TRADING`
- **THEN** o resultado é o primeiro dia útil de janeiro
