# market-data-service

Integração com a brapi dentro do orçamento do plano gratuito, catálogo, histórico diário,
Ibovespa e preço de referência (catálogo de serviços §5, Brapi, RN-BRP/SYN). Rotas em
`contracts/generated/openapi/market-data-service.json`; eventos em `market-data.events`. Os dados
internos (cotação L1, book, negócios e candles a partir do Motor) chegam na Fase 2 (grupo 26).

- **Porta do provedor** (`MarketDataProvider`, Brapi §13): `brapi` (real), `fixture` (respostas
  gravadas em `fixtures/brapi/`, padrão local, RN-BRP-095) e `replay` (reproduz
  `external_quote_history` com `REPLAY_OFFSET_DAYS` de atraso; catálogo e histórico vêm das
  fixtures). Trocar é só `MARKET_DATA_PROVIDER`. A ACL (`adapters/brapi/mapping.ts`) é o único
  lugar com nomes de campo da brapi (RN-BRP-002); corpo fora do esquema é `INVALID_BODY`.
- **Fila única** (`application/queue.ts`, RN-BRP-040..043): no máximo `BRAPI_MAX_CONCURRENCY` (1)
  em andamento, `BRAPI_MIN_INTERVAL_MS` (1 s) entre envios, prioridades P0–P5, coalescência de
  pedidos iguais (pendentes ou em andamento), `Retry-After` do `429` e retentativa de `5xx`/timeout
  (backoff 2 s → 5 min, 4×). Só o líder envia: `LeaderElector` (`brapi-queue`, advisory lock no
  banco do serviço, D14). Disjuntor: abre com 5 falhas seguidas, 2 min, meia-abertura com 1.
- **Orçamento** (`application/budget.ts`, RN-BRP-030..035): leitura do E9 (1×/h no pregão, 6 h
  fora), contador local por envio (inclusive os que falharam com resposta), reserva de 20%
  proporcional e níveis `NORMAL`/`SAVING`/`CRITICAL`/`EXHAUSTED` com
  `market_data.provider_budget_level_changed`. `429` por cota → `EXHAUSTED`, alerta crítico, nenhuma
  cotação e todos os preços defasados. Com fixtures ou replay não há cota: sempre `NORMAL`.
- **Agendamento** (`application/polling.ts`, RN-BRP-050..053): universo + `^BVSP`, só entre o
  contínuo + 5 min (≈ 10:05) e o fim do call; próxima leitura em `quote_time + 30 min + 60–180 s`,
  ou +5 min sem mudança (3×); 60 min em `SAVING`/`CRITICAL`. Nada em fim de semana e feriado.
  Rotina `brapi_close_snapshot` (18:00): leitura pós-fechamento e candle `CLOSE_SNAPSHOT`.
- **Leituras** (`application/quotes.ts`, Brapi §7/§9): toda leitura bem-sucedida em
  `external_quote_history` (append-only, com o destino e o SHA-256 do corpo); fora de ordem é
  descartada; salto > 5% da âncora sem evento corporativo vai para `quote_quarantine` e só entra
  quando a leitura seguinte confirma. A aceita fica em `external_quote`, no Valkey (`md:quote:*`),
  com o corpo bruto no bucket `brapi-raw` (30 dias) e `market_data.external_quote_received`.
  Defasagem: `update_interval + 15 min` no pregão → `market_data.instrument_stale` uma vez.
- **Catálogo e histórico** (`application/catalog.ts`): catálogo do dia às 06:30 (E1, job do
  próprio serviço, uma vez por data) com `market_data.catalog_synced` em lotes de 500, resolução
  dos tickers do universo (E6) com `market_data.symbol_rename_detected` uma vez por troca, histórico
  diário (E3) na entrada do universo e sob demanda, com cache de 24 h.
- **Preço de referência** (`domain/reference-price.ts`, Brapi §8): `âncora × (1 + ruído)`; glide
  linear de 5 min em passos de 15 s; ruído Ornstein-Uhlenbeck limitado a ±0,30%, em ticks de 2–10
  s, só no contínuo, com gerador semeado por `(ambiente, instrument_id, data)`. Override manual
  (`MANUAL`) e ruído desligável por instrumento. Cada valor é um
  `market_data.reference_price_updated` com `origin` e `seq`. Ao subir no meio do dia, o modelo
  avança desde a meia-noite e só publica o último minuto: o estado (e o resto do dia) é o mesmo de
  quem publicou tudo.
- **Segurança do token** (RN-BRP-090..094): `BRAPI_TOKEN_FILE` e `BRAPI_TOKEN_NEXT_FILE` (Docker
  secrets, relidos a cada uso); `401` com o primeiro tenta o segundo e passa a preferi-lo. O log
  tem a URL sem credenciais e a impressão digital do token, nunca o header. `401` definitivo para
  as requisições autenticadas (os tickers de teste seguem) até trocar o token ou liberar.
- **Verificação semanal do esquema** (RN-BRP-100): desligada por padrão
  (`BRAPI_SCHEMA_CHECK_ENABLED`); ligada, toda segunda às 07:00 faz 2 requisições e compara o
  formato com as fixtures; campo sumido ou com outro tipo vira alerta `SCHEMA_DRIFT`.

Na Fase 1 ninguém tem posição (`NoExposureYet`: todo o universo em P1) nem há eventos
corporativos conhecidos (`NoCorporateActionsYet`). A fase do pregão vem da grade do calendário
(cópia local, D15) até o trading-session-service da Fase 2. A cópia inicial dos instrumentos vem
do `reference.events` desde o início do stream (30 dias de retenção).

Fixtures: `origin = recorded` veio da brapi real sem token em 2026-10-27 (PETR4, catálogo,
histórico, resolve e o `401`); `synthetic` segue o mesmo formato onde a gravação exige token ou
um erro que não dá para provocar.

`market_data.reference_price_updated` sai em `market-data.events` (o catálogo de eventos sugere um
tópico próprio, `market-data.reference-prices`): a outbox tem um relay por serviço. Separar é
otimização de volume para a Fase 2, sem mudar o contrato.

## Runbook

| Situação                                 | O que fazer                                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Alerta `UNAUTHORIZED` (401)              | Troque o token em `infra/secrets/brapi/token` (ou ponha o novo em `token_next`) e chame `POST /v1/bo/market-data/provider/auth-block/clear`. |
| Nível `EXHAUSTED`                        | Cota esgotada até o fim da janela (`GET /v1/bo/market-data/provider` → `windowEnd`). O E9 continua a cada 6 h; ao renovar, volta sozinho.    |
| `circuit = OPEN` por muito tempo         | A brapi está fora ou lenta (`5xx`/timeout). As cotações envelhecem e ficam defasadas; nada a fazer além de acompanhar.                       |
| Alerta `QUOTE_QUARANTINED`               | Salto > 5% sem evento corporativo. Se a próxima leitura confirmar, entra com glide; se for evento real, cadastre-o.                          |
| Alerta `SCHEMA_DRIFT` ou `INVALID_BODY`  | O formato da brapi mudou: compare com `fixtures/brapi/`, ajuste `adapters/brapi/mapping.ts` e grave a fixture nova.                          |
| Alerta `DEPRECATION`                     | A rota tem `Sunset`: migre para a rota do `Link` antes da data.                                                                              |
| Testar leilão, stop ou chamada de margem | `POST /v1/bo/market-data/reference-overrides` com o preço e a duração (`origin = MANUAL`).                                                   |
