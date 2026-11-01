# risk-service

O Risco à vista (Risco §2–§4, §11, ADR-0003): o ponto único de serialização do consumo de saldo e de
ativos. Decide ordens e saques com uma projeção local em memória, sem chamadas síncronas, e é o único
que cria holds. Ativo/passivo: a instância eleita carrega a projeção, consome os eventos e decide; a
outra fica sem `readiness`. Day trade alavancado, margem, short, chamada de margem e zeragem são do
grupo 39.

API em `contracts/generated/openapi/risk-service.json`; eventos em `risk.events`.

- **Projeção** (`domain/projection.ts`, D13): `P2` e demais saldos do ledger, `U` dos negócios do Motor,
  holds, posições, ordens abertas e preços. Cada evento relê a conta do banco na transação do
  consumidor e grava o resultado junto com o offset. Se o commit falhar, a nova tentativa parte do
  que foi gravado, não da memória, e nada conta duas vezes.
- **`U` e `P2`** (ADR-0003): o `trade_id` casa o negócio com o lançamento, em qualquer ordem. O principal
  sai de `U` e entra em `P2` no próprio `ledger.journal_posted`, porque esperar o `balance_changed`
  deixaria o poder de compra alto no intervalo. Os custos estimados ficam em `U` até o lançamento da nota.
- **Holds** (`domain/holds.ts`, RN-HLD-*): a execução reduz o hold em `engine.trade_executed`, junto com
  `U`, e não em `order.filled`, que viria de outro tópico e abriria uma janela com o poder de compra
  alto. O valor restante sai sempre do original, pela proporção. Execução e cancelamento são
  comutativos: cada um tira a sua quantidade.
- **Órfãos** (RN-HLD-007): a cada 5 minutos, os holds `ACTIVE` com referência terminal há mais de 1
  minuto são liberados com alerta crítico no log (`risk.orphan_hold_released`).
- **Pré-trade** (`domain/pretrade.ts`, Risco §11): puro. A resposta traz `classification` e `figures`, e
  repetir o `requestId` devolve a mesma decisão. A alteração olha só a diferença (RN-ALT-004).
- **Saques** (Contratos §10.2): `CreateHold` usa o `requestId` como `hold_id`, então o ledger consegue
  liberar mesmo sem ter recebido a resposta. O sacável é o do Financeiro §4 com `P2 + U` no lugar de `P2`.
- **Serialização** (`application/memory.ts`, RN-RSK-001): uma fila por conta. Quem decide pega a conexão
  **antes** de entrar na fila e faz o commit ainda na vez dela, para que a vez nunca espere o pool. Os
  eventos pegam a linha da conta antes da fila, e numa ordem fixa quando são duas contas.
- **Liderança** (D14): cada eleição sobe a época em `risk_leader`. Toda decisão confere a época na
  própria transação, então um líder antigo não grava depois de perder a eleição.
- **Recuperação** (Cache e retenção §2, RNF-022): carrega o banco, retoma os consumidores dos offsets
  salvos e só abre depois de alcançar o último chunk de cada partição visto ao assumir. Até lá,
  `/health/ready` responde `503` e os RPCs `503 RISK_UNAVAILABLE` (fail closed, RN-RSK-002).

## Desempenho do pré-trade (RNF-003)

`pnpm --filter @broker/risk-service bench [ordens] [simultâneas]`. Mede por HTTP local, com o hold e a
outbox gravados num PostgreSQL em Docker. O cliente roda no mesmo processo Node que o serviço e disputa
a mesma thread, então a saturação é pessimista. i7-14700K, WSL2, 500 contas, 10 mil ordens:

| Simultâneas | Ordens/s | p50     | p99     | p99,9   | p99 < 10 ms |
| ----------- | -------- | ------- | ------- | ------- | ----------- |
| 1           | 266      | 3,5 ms  | 6,3 ms  | 8,7 ms  | sim         |
| 4           | 740      | 5,0 ms  | 9,2 ms  | 16,8 ms | sim         |
| 8           | 854      | 8,7 ms  | 15,5 ms | 35,4 ms | não         |
| 16          | 943      | 16,4 ms | 22,6 ms | 29,1 ms | não         |

**A meta só vale abaixo da saturação**, por volta de 740 ordens/s nesta montagem. O limite é uma thread
Node mais 11 idas ao banco por ordem. O timeout do OMS (200 ms) fica folgado em todos os casos. Se o p99
não fechar sob a carga da Fase 7, os primeiros passos são juntar as consultas numa ida só e separar o
cliente do bench em outro processo, antes de rever o RPC (D11).

## Premissas registradas

- **Snapshot a cada evento**: D13 fala em snapshot periódico. Com a inbox gravada na transação do offset,
  reprocessar desde um snapshot antigo seria recusado como duplicata. Por isso a projeção vai ao banco a
  cada evento, na mesma transação do offset, que é o que "snapshot + offsets" precisa garantir.
- **Posições só dos negócios**: `custody.position_changed` entra na tarefa 30.5, com a custódia. Até lá,
  `Q_disp` conta o que foi negociado neste ambiente.
- **Saldo sem status**: conta sem `account.opened` não opera (`ACCOUNT_NOT_ACTIVE`). `RESTRICTED` só vende
  o que tem (Contas §7.2).
- **Código do limite de ordens**: Ordens §12 não traz um código para `max_open_orders`. O adotado é
  `OPEN_ORDERS_LIMIT_EXCEEDED`.
- **Carência dos órfãos**: 1 minuto depois de a referência terminar, porque a última execução pode estar a
  caminho em outro tópico. RN-HLD-007 não cita prazo.
- **Custos**: tabela de referência de Custos §3 em `domain/costs.ts`, até o `fee_schedule` (tarefa 29.2). A
  liquidação usa a alíquota de swing mesmo em day trade: a classificação final só sai no fechamento, e a
  de swing é a maior (RN-RSK-004).
- **Nota no ledger**: um journal `FEES` zera os custos estimados dos negócios até a `bookingDate`. Falta
  conferir contra o ledger de verdade na Fase 3 (tarefas 15/29), que ainda não lança notas.
- **`TRIGGER` e OCO**: fora do contrato do pré-trade até a Fase 4 (tarefas 35.1 e 35.3).
- **`GET /v1/me/risk/summary`** (Contratos): não está no grupo 24; entra com a margem (grupo 39) ou as rotas
  do `bff-web` (tarefa 28.1).
