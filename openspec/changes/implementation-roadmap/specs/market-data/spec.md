# Spec Delta

## Purpose

Integra a brapi dentro do orçamento do plano gratuito, gera o preço de referência (âncora real com deslize e micro-variações sintéticas) e produz os dados de mercado internos (cotação, book, negócios e candles) a partir das saídas do Motor.

## ADDED Requirements

### Requirement: Acesso exclusivo e ACL
Só o `market-data-service` SHALL falar com a brapi, por um adaptador que implementa uma porta genérica de provedor; nomes de campo da brapi SHALL NOT aparecer em eventos, bancos ou APIs internas. Replay, fixtures e sintético SHALL ser adaptadores da mesma porta (RN-BRP-001..003, RNF-072).

#### Scenario: Troca de provedor
- **WHEN** a configuração muda o provedor de `brapi` para `replay`
- **THEN** o serviço funciona sem alteração de código e sem chamadas à brapi

### Requirement: Limites do plano em configuração
Requisições por mês, concorrência, intervalo de atualização, tickers por requisição, histórico e intervalos permitidos SHALL ficar em configuração, nunca fixos no código (RN-BRP-010).

#### Scenario: Mudança de plano
- **WHEN** a configuração passa `monthly_requests` para 150.000
- **THEN** o orçamento diário é recalculado sem novo deploy

### Requirement: Orçamento de requisições
O serviço SHALL calcular o orçamento diário a partir do endpoint de uso (janela, consumo e restante) com reserva de segurança de 20%, manter um contador local corrigido pelo endpoint de uso e operar nos níveis `NORMAL`, `SAVING`, `CRITICAL` e `EXHAUSTED`, publicando `market_data.provider_budget_level_changed` a cada mudança (RN-BRP-030..035, RNF-090).

#### Scenario: Cota esgotada
- **WHEN** a brapi responde `429` por cota esgotada
- **THEN** o nível passa a `EXHAUSTED`, nenhuma requisição de cotação é feita, os preços ficam marcados como defasados e é emitido alerta crítico

### Requirement: Fila única com líder
Todas as requisições SHALL passar por uma única fila lógica por ambiente, com no máximo 1 requisição em andamento, intervalo mínimo de 1 s, prioridades P0 a P5, coalescência de requisições idênticas e um único líder com lease que envia (RN-BRP-040..043, ADR-0007).

#### Scenario: Coalescência
- **WHEN** dez usuários pedem a cotação do mesmo ativo fora do universo ao mesmo tempo
- **THEN** uma única requisição é enviada e todos recebem o mesmo resultado

#### Scenario: Duas instâncias
- **WHEN** duas instâncias do serviço estão no ar
- **THEN** só a que detém o lease envia requisições à brapi

### Requirement: Agendamento adaptativo
A próxima leitura de cada instrumento SHALL ser agendada para `quote_time + update_interval + folga aleatória de 60 a 180 s`; sem mudança de `quote_time`, nova tentativa em +5 min até 3 vezes. Não há requisições de cotação fora do pregão, exceto a leitura pós-fechamento das 18:00 (RN-BRP-050..053).

#### Scenario: Fim de semana
- **WHEN** é sábado
- **THEN** nenhuma requisição de cotação é enviada

### Requirement: Normalização, cache e histórico
Toda leitura bem-sucedida SHALL ser normalizada para `external_quote`, gravada em `external_quote_history` com `fetched_at`, `quote_time` e hash do corpo bruto, e publicada como `market_data.external_quote_received`. Leituras com `quote_time` anterior à última aceita SHALL ser descartadas (RN-BRP-060, RN-BRP-072).

#### Scenario: Leitura fora de ordem
- **WHEN** chega uma leitura com `quote_time` mais antigo que o último aceito
- **THEN** a leitura é descartada sem publicar evento

### Requirement: Quarentena de saltos
Uma leitura com variação acima de `jump_alert_pct` (padrão 5%) em relação à âncora, sem evento corporativo conhecido, SHALL ir para quarentena e alertar o backoffice; duas leituras consecutivas consistentes liberam o novo preço com deslize (RN-BRP-071).

#### Scenario: Salto de 8%
- **WHEN** uma cotação 8% acima da âncora chega sem evento corporativo
- **THEN** a âncora não muda até a confirmação pela leitura seguinte

### Requirement: Disjuntor e preservação de dados
O cliente da brapi SHALL abrir o disjuntor após 5 falhas consecutivas (`5xx`/timeout) por 2 min, com meia-abertura de 1 requisição; uma falha SHALL NOT apagar a última cotação válida (RN-BRP-080, RN-BRP-081).

#### Scenario: brapi fora
- **WHEN** a brapi responde `503` cinco vezes seguidas
- **THEN** o disjuntor abre e a última cotação válida continua valendo, marcada como defasada quando for o caso

### Requirement: Segurança do token
O token SHALL vir do cofre de segredos, nunca aparecer em logs, eventos ou erros, e o serviço SHALL suportar dois tokens válidos durante a rotação (RN-BRP-090..094).

#### Scenario: Log de requisição
- **WHEN** uma requisição à brapi é registrada no log
- **THEN** a URL aparece sem credenciais e sem o header `Authorization`

### Requirement: Preço de referência
O preço de referência SHALL ser `âncora × (1 + ruído)`: a âncora desliza linearmente para o novo preço real (padrão 5 min em passos de 15 s) e o ruído segue um processo com reversão à média limitado a ±0,30%, gerado só em `CONTINUOUS`, com semente `(environment, instrument_id, trading_date)`. Cada atualização publica `market_data.reference_price_updated` com `origin` (Brapi §8, RN-SYN-001..004).

#### Scenario: Reprodutibilidade
- **WHEN** o mesmo dia é reprocessado com a mesma semente e as mesmas âncoras
- **THEN** a sequência de preços de referência é idêntica

#### Scenario: Mercado fechado
- **WHEN** a fase é `CLOSED`
- **THEN** a referência é o último fechamento, sem ruído

### Requirement: Modelo sintético do sandbox e override manual
No sandbox, a referência SHALL ser 100% sintética (GBM com cenários `SIDEWAYS`, `BULL`, `BEAR`, `HIGH_VOLATILITY`, `CRASH`) com semente registrada; o backoffice e o sandbox SHALL poder fixar a referência por um período (`origin = MANUAL`) (RN-SYN-005, RN-SYN-006, RN-SBX-003).

#### Scenario: Override manual
- **WHEN** o backoffice fixa a referência de PETR4 em R$ 30,00 por 10 minutos
- **THEN** os eventos de referência desse período têm `origin = MANUAL` e valor 30,00

### Requirement: Dados internos a partir do Motor
O serviço SHALL construir, a partir das saídas do Motor, a cotação L1 interna, o book L2 (até 10 níveis) e L3 anônimo, os negócios (`trade_tick`) e o estado do pregão, publicando `market_data.quote_updated`, `market_data.book_updated` e `market_data.trade_printed` (Ativos §8.2).

#### Scenario: Negócio executado
- **WHEN** o Motor publica `engine.trade_executed` no livro principal
- **THEN** são publicados `market_data.trade_printed` e a cotação L1 atualizada com o novo `last_price`

### Requirement: Candles internos
Candles de 1m a 60m SHALL ser construídos só com negócios internos, sem candles vazios; candles diários SHALL vir da brapi antes da entrada no universo e do interno depois, indicando a fonte; correções de negócio SHALL recalcular os candles afetados e publicar `market_data.candle_corrected`; a série ajustada por eventos corporativos SHALL ser calculada na leitura (`adjusted=true|false`) (RN-MD-010..013, RN-CA-054).

#### Scenario: Intervalo sem negócio
- **WHEN** não há negócio entre 10:05 e 10:06
- **THEN** não existe candle de 1m para esse intervalo

#### Scenario: Trade bust
- **WHEN** chega `engine.trade_busted`
- **THEN** os candles afetados são recalculados e `market_data.candle_corrected` é publicado

### Requirement: Valorização de posições
O preço de valorização SHALL seguir a precedência `last_price` interno do dia, depois `close_price` interno do último pregão, depois `reference_price` externo (RN-MD-002).

#### Scenario: Instrumento fora do universo
- **WHEN** uma posição é de um instrumento sem negócios internos
- **THEN** a valorização usa o preço externo de referência

### Requirement: Índices só externos
Índices como o Ibovespa SHALL ser exibidos só pela fonte externa e o Ibovespa externo SHALL ser publicado para uso pelo circuit breaker (RN-MD-020, RN-MD-021).

#### Scenario: Leitura do Ibovespa
- **WHEN** uma leitura de `^BVSP` é concluída
- **THEN** `market_data.external_quote_received` é publicado com o índice

### Requirement: Defasagem
Durante o pregão, uma cotação SHALL ser considerada defasada quando `agora − quote_time > update_interval + 15 min`, e SHALL ser publicado `market_data.instrument_stale` para os consumidores (RN-BRP-070).

#### Scenario: Cotação de 50 minutos
- **WHEN** a última cotação de um instrumento tem 50 minutos durante o pregão
- **THEN** o instrumento é marcado como defasado
