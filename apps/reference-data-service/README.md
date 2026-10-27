# reference-data-service

Instrumentos, universo negociável, regras de negociação com vigência, histórico de tickers,
calendário e grade horária (catálogo de serviços §4, Ativos, Pregão §3). Rotas em
`contracts/generated/openapi/reference-data-service.json`; eventos em `reference.events`.

- **Instrumentos** (`instrument`): padrão de cadastro por tipo (`instrument_type_default`, Ativos
  §2.2, editável em `/v1/bo/instrument-type-defaults`), sobrescritas por instrumento e fracionário
  derivado (`symbol + "F"` só com `lot_size > 1`, coluna gerada). Novos tickers chegam por
  `market_data.catalog_synced` com `tradable = false` e `source = BRAPI`; quem sai da fonte é
  deslistado (ou vira tarefa, se ainda está no universo). Cada mudança publica
  `instrument.created`/`instrument.updated` com o estado completo.
- **Busca** (`/v1/instruments/search`, `/v1/instruments/by-symbol/{ticker}`): `PETR4F` resolve
  PETR4 no livro `ODD_LOT`; ticker antigo devolve o atual com o aviso "Ticker alterado de X para Y
  em dd/mm/aaaa"; `…F` de lote 1 não resolve (RN-INS-006).
- **Status** (Ativos §5): `PENDING` até a primeira cotação, `ACTIVE`, `SUSPENDED`, `DELISTED`
  (final). `market_data.instrument_stale` guarda desde quando falta cotação; com 2 dias úteis
  (`MAX_QUOTE_STALENESS_BUSINESS_DAYS`), suspende com `STALE_REFERENCE_PRICE`.
- **Universo negociável** (`/v1/bo/universe/requests`): `BO_MARKET` propõe, `BO_ADMIN` aprova.
  Recusa o 21º (`MAX_TRADABLE_INSTRUMENTS`, padrão 20) e a retirada com ordens abertas; as duas
  regras são conferidas ao propor e de novo ao aprovar. A inclusão deixa `PENDING` e publica
  `instrument.tradability_changed`.
- **Dupla aprovação local** (`change_request`, `/v1/bo/change-requests`): `PENDING` →
  `APPROVED` (executa na mesma transação) | `REJECTED` | `EXPIRED` (24 h) | `CANCELED` |
  `STALE` (o recurso mudou, ou a execução recusou por regra). O maker nunca decide. Na Fase 3 o
  approval-service assume e o serviço só executa ao consumir `approval.request_approved`.
- **Renomeação** (RN-INS-030..033): `market_data.symbol_rename_detected` abre tarefa
  (`/v1/bo/tasks`); confirmar renomeia mantendo o `instrument_id`, grava
  `instrument_symbol_history` e publica `instrument.symbol_changed`. Razão ≠ 1 é evento
  corporativo e não renomeia.
- **Regras de negociação** (`instrument_trading_rules`): vigência `[valid_from, valid_to)`, global
  (todos os campos) + sobrescrita por instrumento (só os campos dela), sem sobreposição. A
  proposta passa por aprovação; a execução publica `instrument.trading_rules_changed`. Vigentes em
  `/v1/trading-rules/effective?instrumentId=&at=`.
- **Calendário** (`trading_calendar`, um registro por dia; `session_schedule` com vigência):
  semente B3 2026–2027; funções de RN-CAL-002 em `/v1/calendar/*`. Mudanças (dias especiais,
  extensão do período, nova grade) passam por aprovação e publicam `calendar.updated` /
  `session_schedule.updated` com o calendário completo, para a cópia local dos consumidores (D15).
  No sandbox, `CALENDAR_ALL_DAYS_BUSINESS=true` trata todo dia como útil (RN-SBX-002), inclusive
  nos dados publicados.
- **Rotina `reference_daily`** (22:30): alerta faltando 60 dias para o fim do calendário carregado
  (tarefa `CALENDAR_COVERAGE_ENDING`, uma por fim de período) e suspensão por defasagem.

Na Fase 1 não há OMS: as ordens abertas vêm de `NoOpenOrdersYet` (zero). A volta de `PENDING` ou
da suspensão por defasagem para `ACTIVE` é o caso de uso `onQuoteReceived`, chamado pelo
consumidor de `market_data.external_quote_received` (leitura não defasada de um instrumento).

Ticker: o radical aceita dígito (`B3SA3`, sugerido em RN-INS-012), embora a tabela de Ativos §2.1
diga "4–6 letras"; vale o ticker real da B3.

## Runbook

| Situação                                            | O que fazer                                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Aprovação devolve `REQUEST_STALE`                   | O recurso mudou (ou o universo encheu, ou surgiram ordens abertas). Veja `decisionReason` em `/v1/bo/change-requests` e proponha de novo. |
| Tarefa `CALENDAR_COVERAGE_ENDING` aberta            | Carregue o próximo ano: `POST /v1/bo/calendar/requests` com `extendTo` e os feriados, e aprove com outro usuário.                         |
| Funções de calendário com `CALENDAR_NOT_LOADED`     | A data está fora do período carregado (`GET /v1/calendar` → `coverage`).                                                                  |
| Tarefa `TRADABLE_REMOVED_FROM_CATALOG`              | O ticker sumiu da brapi mas está no universo: proponha a retirada (exige não ter ordens abertas).                                         |
| Instrumento `SUSPENDED` por `STALE_REFERENCE_PRICE` | Volta sozinho com a próxima cotação válida; se a fonte parou, retire do universo.                                                         |
