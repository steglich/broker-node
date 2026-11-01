# trading-session-service

Controla o dia de negociação: fases do mercado e de cada instrumento, leilões programados,
suspensões, circuit breaker e preço de fechamento (catálogo de serviços §6, Pregão §4–§9). Líder
único com réplica em espera: só o líder roda o laço de prazos e o relay da outbox.

API em `contracts/generated/openapi/trading-session-service.json`; eventos em `session.events`;
comandos ao Motor em `engine.commands`.

- **Fases em dois níveis** (RN-SES-001): `market_phase_state` e a fase própria em
  `instrument_phase_state` (`null` segue o mercado). A efetiva é a mais restritiva, pela ordem de
  `domain/phases.ts`. `scheduled_phase` guarda a fase da grade, que anda mesmo com o mercado suspenso.
- **Grade** (Pregão §4.1, §8): as rotinas `calendar_check`, `pre_trading`, `pre_opening`, `continuous`,
  `closing_call`, `post_close` e `session_close` movem o mercado e respondem `routine.completed`
  (`session_routine` é a idempotência, RN-ROT-001). `session_close` é nova: a tabela do Pregão §8 põe o
  `CLOSED` na Sessão, mas não havia rotina dela.
- **Motor** (RN-SES-002): a chave de `engine.commands` é o `instrument_id`, então uma mudança de
  mercado vira um `PhaseChange` por instrumento, só para quem a fase efetiva muda (`engine_phase`).
  `session.phase_changed` sai uma vez com `scope = MARKET` e por instrumento só para quem tem fase
  própria. A referência dos túneis vai por `BandUpdate` às 07:00, ao mudar regra e ao entrar no universo.
- **Leilões** (RN-AUC-001..003): cada instrumento tem o seu (`auction`), com id, tipo, início, fim
  previsto e efetivo. Quem encerra é a sessão: no fim previsto compara o último
  `engine.auction_indicative` com o túnel estático. Dentro, manda a fase seguinte com
  `concludesAuctionId`, e o Motor conclui na janela aleatória (semente em `randomSeed`). Fora, prorroga
  2 min (`volatilityAuctionExtensionS`), no máximo 3 vezes, e aí segue `AUCTION_EXTENSION_POLICY`:
  `CONCLUDE_AT_BAND` (manda `priceLimit`) ou `KEEP_OPEN` (fica `HELD`). Os dois alertam.
- **Call prorrogada**: o mercado fica em `CLOSING_CALL` e a rotina `post_close` fica pendente até a
  última call terminar, o que segura `eod_orders` e as notas (RN-ROT-002). Quem já concluiu vai antes a
  `POST_CLOSE`, pela fase própria.
- **Suspensões** (Pregão §5): `halt`, por instrumento ou mercado, uma ativa por escopo e motivo. A
  retomada é por leilão de 5 min (15 min no circuit breaker), e fora de pregão só volta a seguir o
  mercado. `cancelAllOnHalt` vai em `session.halt_started` para o OMS cancelar. As origens: backoffice,
  `instrument.status_changed` (defasagem, evento corporativo), `engine.book_recovering`/`recovered` e a
  vigilância do Market Data (`MARKET_DATA_OUTAGE_MINUTES`, 0 desliga).
- **Circuit breaker** (RN-CB-*): lê o Ibovespa de `market_data.external_quote_received`. Níveis em
  sequência, um de cada por pregão, só em contínuo, e o nível 3 vai até o `post_close`. O bloqueio da
  última meia hora vale só para o disparo automático: o manual é decisão explícita do backoffice.
- **Fechamento** (RN-FCH-*): no `session_close`, com a precedência de RN-FCH-001; vira
  `previous_close` e `band_reference_price`. A divergência é conferida ao fechar e de novo a cada
  leitura externa do dia, como a das 18:00 (`session_alert`, um por instrumento e dia).
- **Dupla aprovação local** (`session_change_request`, Backoffice §3–§4): suspender e retomar o mercado
  e disparar o circuit breaker passam por `BO_MARKET` → `BO_ADMIN`. Suspender instrumento é imediato. Na
  Fase 3 a decisão vem de `approval.request_approved`.

## Premissas registradas

- O catálogo só lista `engine.auction_triggered`/`completed` para a sessão, mas RN-AUC-003 precisa do
  preço teórico e RN-FCH-001 do último negócio: ela também consome `engine.auction_indicative` e
  `engine.trade_executed`.
- O catálogo não tem evento para a recuperação do livro (RN-REC-003): os contratos
  `engine.book_recovering`/`engine.book_recovered` são novos, e o Motor os publica no grupo 22.
- `PhaseChange` ganhou `auctionId`, `auctionType`, `concludesAuctionId` e `priceLimit` além do catálogo.
  O Motor (grupo 22) precisa concluir o leilão ao receber `concludesAuctionId`, não sozinho no fim
  previsto: é o que evita a corrida com a prorrogação.
- Sem fechamento interno, o primeiro `previousClose` externo é a semente da referência dos túneis.
- Negócio cancelado (`engine.trade_busted`) ainda não refaz o último negócio do fechamento: o catálogo
  não lista a sessão como consumidora, e só guardamos o último preço.
- Um instrumento que só negociou em leilão de abertura fecha no `previous_close`: RN-FCH-001 fala em
  "último negócio da negociação contínua".
- O serviço ainda não publica alerta em evento: os alertas ficam em `session_alert` e no log.

## Runbook

| Situação                                       | O que fazer                                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alerta `AUCTION_EXTENSIONS_EXHAUSTED`          | Com `KEEP_OPEN`, o leilão fica `HELD`: conclua com `POST /v1/bo/session/auctions/<id>/conclude`. Uma call `HELD` segura o `post_close`.                                               |
| Rotina `post_close` presa em `TRIGGERED`       | Há call aberta ou `HELD`. Veja `GET /v1/market/session` e conclua o leilão.                                                                                                           |
| Mercado `HALTED` com `MARKET_DATA_UNAVAILABLE` | Sem eventos do Market Data há mais de N minutos. Volta sozinho, por leilão, com o próximo evento. Se o Market Data estiver saudável e sem ruído sintético, aumente o limite ou use 0. |
| `HALT_NOT_RESUMABLE` ao retomar                | A suspensão vem de uma causa externa (defasagem, evento corporativo, `ENGINE_RECOVERY`) e termina quando ela acaba.                                                                   |
| Alerta `CLOSE_DIVERGENCE`                      | Fechamento interno diverge do externo em mais de 5%: pode ser o FMS mal calibrado (RN-FCH-003).                                                                                       |
| Solicitação `STALE`                            | O mercado mudou desde a proposta (RN-MC-BO-003). Veja `decisionReason` e proponha de novo.                                                                                            |
