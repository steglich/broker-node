# Spec Delta

## Purpose

Mantém os livros de ofertas por instrumento e quadro, casa ordens por preço-tempo de forma determinística, conduz leilões e túneis, garante durabilidade por journal e snapshots e publica saídas sequenciadas para os demais serviços.

## ADDED Requirements

### Requirement: Escritor único por livro
Cada livro (instrumento + quadro `MAIN`/`ODD_LOT`) SHALL ser processado por um único fluxo sequencial, com entradas particionadas por `instrument_id`; livros principal e fracionário do mesmo instrumento SHALL compartilhar a partição (RN-ME-001, RN-ME-005, ADR-0005).

#### Scenario: Comandos simultâneos
- **WHEN** duas ordens do mesmo instrumento chegam ao mesmo tempo de origens diferentes
- **THEN** são processadas uma após a outra, na ordem do sequenciador

### Requirement: Determinismo
O resultado SHALL depender só da sequência de entradas e do estado inicial; o tempo SHALL vir carimbado na entrada pelo sequenciador e a aleatoriedade SHALL vir de semente registrada no journal (RN-ME-002, RN-AUC-033).

#### Scenario: Replay idêntico
- **WHEN** a mesma sequência de entradas é processada duas vezes a partir do mesmo estado
- **THEN** as saídas são idênticas, inclusive o instante do encerramento aleatório de leilão

### Requirement: Journal antes do processamento
Toda entrada aceita SHALL receber `input_seq` contínuo por livro e ser gravada de forma durável antes de ser processada; toda saída SHALL receber `engine_seq` contínuo por livro (RN-ME-003, RN-ME-004).

#### Scenario: Queda após gravar
- **WHEN** o processo cai depois de gravar a entrada no journal e antes de processá-la
- **THEN** a entrada é processada na recuperação e nenhuma ordem aceita é perdida (RNF-031)

### Requirement: Prioridade preço-tempo
O livro SHALL ordenar compras por preço decrescente e vendas por preço crescente, com fila FIFO por `priority_seq` em cada nível; reduzir a quantidade mantém a prioridade e aumentar a quantidade, mudar o preço ou recarregar iceberg renova a prioridade. O FMS não tem prioridade especial (RN-ME-010..012, RN-ALT-003).

#### Scenario: Preço-tempo (ME-001)
- **WHEN** há vendas A 100 @ 10,02, B 100 @ 10,01 e C 100 @ 10,01 e chega a compra D 250 @ 10,02
- **THEN** saem os negócios D×B 100 @ 10,01, D×C 100 @ 10,01 e D×A 50 @ 10,02, e A fica com 50 no livro

#### Scenario: Redução mantém prioridade (ME-005)
- **WHEN** uma ordem em repouso reduz a quantidade
- **THEN** ela mantém a posição na fila; se aumentar, vai para o fim

### Requirement: Preço do negócio
O preço do negócio SHALL ser o da ordem em repouso, e uma agressão que atravessa vários níveis SHALL gerar um negócio por par de ordens, cada um com `trade_id` único, instrumento, quadro, preço, quantidade, ordens, contas, lado agressor, `executed_at`, `engine_seq`, `trading_date` e `auction_id` quando houver (RN-ME-020..022, INV-03).

#### Scenario: Agressão em vários níveis (ME-002)
- **WHEN** uma compra agride três níveis de venda
- **THEN** cada negócio tem o preço do respectivo nível em repouso

### Requirement: Ordens a mercado, IOC e FOK
A `MARKET` SHALL parar no preço de proteção e cancelar o restante; `IOC` SHALL cancelar o restante; `FOK` SHALL ser simulada antes e cancelada sem nenhum negócio se não for totalmente executável dentro do limite, dos túneis e do STP (RN-ME-030, Motor §4.1).

#### Scenario: Mercado com proteção (ME-003)
- **WHEN** uma compra `MARKET` com proteção 10,20 encontra vendas até 10,25
- **THEN** executa até 10,20 e o restante é cancelado com `MARKET_NO_LIQUIDITY`

#### Scenario: FOK não executável (ME-004)
- **WHEN** uma `FOK` de 500 encontra só 300 disponíveis dentro do limite
- **THEN** nenhum negócio ocorre e a ordem é cancelada com `FOK_NOT_FILLED`

### Requirement: Prevenção de auto-negociação
Uma ordem SHALL NOT executar contra outra da mesma conta; a política padrão `CANCEL_AGGRESSOR` cancela a agressora no ponto do conflito mantendo o que já executou, com `CANCEL_RESTING` e `CANCEL_BOTH` parametrizáveis. O FMS nunca é self-trade com clientes (RN-SLF-001..003).

#### Scenario: STP padrão (ME-007)
- **WHEN** a compra da conta X agride e o próximo da fila é uma venda da própria conta X
- **THEN** a compra é cancelada nesse ponto com `SELF_TRADE_PREVENTION`

### Requirement: Iceberg no livro
O Motor SHALL expor só a `display_quantity` e, ao consumir a parte aparente, recarregar uma nova parte com nova prioridade de tempo (RN-ICE-001).

#### Scenario: Recarga (ME-006)
- **WHEN** a parte aparente de um iceberg é totalmente executada
- **THEN** uma nova parte aparece no fim da fila daquele preço

### Requirement: Validações do Motor
O Motor SHALL rejeitar com `ENGINE_REJECTED` e subcódigo `BOOK_NOT_OPEN`, `PRICE_OUTSIDE_REJECTION_BAND`, `DUPLICATE_ORDER_ID`, `UNKNOWN_ORDER` ou `INVALID_REPLACE` o que depende do estado do livro (Motor §4.3).

#### Scenario: Túnel mudou
- **WHEN** uma ordem validada pelo OMS chega após um leilão mudar o `band_reference_price` e fica fora do túnel
- **THEN** o Motor a rejeita com `PRICE_OUTSIDE_REJECTION_BAND` (ME-011)

### Requirement: Leilão por volatilidade
Quando o próximo negócio do contínuo sairia fora do túnel dinâmico (vs. último preço) ou estático (vs. `band_reference_price`), o Motor SHALL parar a agressora no ponto do disparo, levar o restante ao livro do leilão e publicar `engine.auction_triggered` (RN-AUC-030..032).

#### Scenario: Túnel dinâmico (ME-008)
- **WHEN** uma agressão levaria o preço 4% acima do último negócio com túnel dinâmico de 3%
- **THEN** a execução para antes desse nível e o instrumento entra em `VOLATILITY_AUCTION`

### Requirement: Acúmulo e preço teórico do leilão
Durante o leilão, ordens SHALL entrar sem executar (o livro pode cruzar), `MARKET` SHALL ter prioridade máxima de preço, e o preço teórico SHALL seguir os critérios em ordem: maior executável, menor desequilíbrio, lado do desequilíbrio, proximidade do `band_reference_price` e o mais alto. O Motor SHALL publicar `engine.auction_indicative` a cada mudança (RN-AUC-010..012, RN-AUC-023, Motor §5.2).

#### Scenario: Desempates do preço teórico (ME-009)
- **WHEN** dois preços candidatos têm o mesmo executável e o mesmo desequilíbrio do lado comprador
- **THEN** o preço teórico é o maior deles

### Requirement: Conclusão do leilão
O leilão SHALL executar no preço teórico por prioridade preço-tempo, com todos os negócios ao mesmo preço, mesmo `auction_id` e `aggressor_side = NONE`; sem cruzamento, SHALL terminar sem preço e sem mudar o `band_reference_price`; o restante de `MARKET` SHALL ser cancelado (RN-AUC-020..022, RN-AUC-011, RN-INS-040).

#### Scenario: Leilão sem cruzamento (ME-010)
- **WHEN** o leilão termina com a melhor compra abaixo da melhor venda
- **THEN** não há negócio e o `band_reference_price` não muda

#### Scenario: Encerramento aleatório (ME-013)
- **WHEN** o leilão chega ao fim previsto com `auction_random_end_max` de 30 s
- **THEN** o fim efetivo é um instante dentro de 30 s, reprodutível pela semente do journal

### Requirement: Livro fracionário separado
O fracionário SHALL ter livro próprio, sem casamento com o principal, mas com o mesmo `instrument_id` nas saídas (RN-INS-003).

#### Scenario: Fracionário (ME-014)
- **WHEN** uma compra de 50 entra no `ODD_LOT` com venda de 100 no `MAIN` ao mesmo preço
- **THEN** não há negócio entre os quadros

### Requirement: Snapshots e recuperação
O Motor SHALL tirar snapshot a cada 10.000 entradas ou 5 min, e a recuperação SHALL carregar o último snapshot e reprocessar o journal, regenerando as saídas com os mesmos `engine_seq`, com o instrumento em `HALTED` (`ENGINE_RECOVERY`) até a volta por leilão, em menos de 30 s (RN-REC-001..003, RNF-022).

#### Scenario: Recuperação equivalente (ME-012)
- **WHEN** o Motor reinicia no meio do pregão
- **THEN** o estado do livro e as saídas regeneradas são idênticos aos de antes da queda

### Requirement: Fim do dia e reapresentação
No fim do dia, o Motor SHALL esvaziar as ordens `DAY` e reapresentar as `GTC`/`GTD` no início do pregão seguinte, mantendo a prioridade relativa entre elas (RN-REC-005).

#### Scenario: GTC no dia seguinte
- **WHEN** duas ordens `GTC` ao mesmo preço sobrevivem ao fechamento
- **THEN** no dia seguinte a mais antiga continua à frente da mais nova

### Requirement: Trade bust
O Motor SHALL aceitar o comando de cancelamento de negócio só no mesmo pregão e antes das notas, vindo do backoffice com dupla aprovação, e publicar `engine.trade_busted`; as ordens não voltam ao livro (RN-BST-001..003).

#### Scenario: Bust após as notas
- **WHEN** chega um pedido de bust depois da geração das notas do dia
- **THEN** o comando é rejeitado

### Requirement: Sem API síncrona de negócio
O Motor SHALL receber entradas só pelo tópico de comandos e expor apenas API administrativa (saúde, snapshot, replay) (Catálogo §9).

#### Scenario: Ordem por HTTP
- **WHEN** alguém tenta enviar uma ordem ao Motor por HTTP
- **THEN** não existe rota de negócio para isso
