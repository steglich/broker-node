# scheduler-service

Rotinas do dia de negócio e relógio do ambiente (catálogo de serviços §21, Pregão §2 e §8).
Líder único com réplica em espera (RN-ENV-021).

- **Rotinas** (`routine_definition`, semeadas da tabela do Pregão §8): cada uma tem dono, horário
  (fixo em BRT ou relativo a uma fase da grade do calendário), dias aplicáveis e dependências do
  mesmo dia. O agendador publica `routine.triggered` em `<ambiente>.scheduler.events` e espera
  `routine.completed`/`routine.failed` do dono, no tópico do dono (`ROUTINE_RESULT_CONTEXTS`).
- **Idempotência** (RN-ROT-001): `routine_execution` tem PK `(routine_name, business_date)`; a
  execução e o evento vão juntos na transação da outbox. O dono da rotina também deve tratar
  `(routineName, businessDate)` como chave: um re-disparo de rotina `FAILED` traz `executionId` novo.
- **Catch-up** (RN-ROT-003): uma data só começa quando todas as rotinas da anterior foram disparadas.
- **Relógio** (`CLOCK_MODE`): `REAL`; `ACCELERATED` (`CLOCK_START`, `CLOCK_SPEED_FACTOR`), com
  `clock.ticked` a cada minuto virtual; `VIRTUAL`, parado até `POST /v1/clock/advance`. O tempo
  virtual fica gravado em `clock_state` e sobrevive a reinício e troca de líder.

API (`contracts/generated/openapi/scheduler-service.json`): `GET /v1/clock`, `GET /v1/routines`,
`GET /v1/routine-executions?from&to` e, com `ADMIN_API_ENABLED=true`, `POST /v1/clock/advance`,
`POST /v1/routine-executions/{rotina}/{data}/retry` e `.../result`.

## Runbook

| Situação                    | O que fazer                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rotina `FAILED`             | Corrija a causa no serviço dono e `POST /v1/routine-executions/<rotina>/<data>/retry`. As dependentes esperam até lá.                            |
| Rotina presa em `TRIGGERED` | O dono não respondeu. Veja o consumidor dele; se a rotina rodou, registre à mão com `POST .../result` `{"executionId", "status": "COMPLETED"}`.  |
| Dia seguinte não começa     | Alguma rotina do dia anterior ainda espera dependência (catch-up em ordem). `GET /v1/routine-executions?from=<D>&to=<D>` mostra qual.            |
| Qual instância é a líder?   | `GET /v1/clock` → `leader`. Se o líder cair, a réplica assume no próximo heartbeat e retoma o relógio gravado.                                   |
| Trocar o modo do relógio    | Um ambiente não mistura modos (RN-CLK-003): o serviço recusa subir com modo diferente do gravado. Recrie o ambiente (`pnpm env:down --volumes`). |
| Sandbox acelerado           | `CLOCK_MODE=ACCELERATED CLOCK_START=2026-03-02T11:00:00Z CLOCK_SPEED_FACTOR=24 pnpm env:up core` (1 dia útil ≈ 1 hora).                          |
