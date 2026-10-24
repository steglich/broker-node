# Fase 1, grupo 11 — scheduler-service

> Tarefas 11.1 a 11.3 de `openspec/changes/implementation-roadmap/tasks.md`. Spec: `specs/routine-scheduling/spec.md`. Regras: `broker-docs/docs/01-dominio/05-pregao-e-calendario.md` (RN-CLK-001..004, §8 e RN-ROT-001..003), catálogo de serviços §21, ADR-0009. Design: D14 e D15.

## Visão geral

É o primeiro serviço de domínio do projeto, e o primeiro a usar a Fase 0 inteira: service kit, outbox, consumidor com inbox, contratos, calendário, relógio e eleição de líder. Ele tem dois papéis:

1. **Despertador do dia de negócio.** Dispara cada rotina da tabela do Pregão §8 (liquidação, fases do pregão, fim das ordens do dia, notas, reconciliações...) na hora certa, só nos dias certos, uma vez por data, respeitando dependências e recuperando o que atrasou.
2. **Dono do tempo do ambiente.** No sandbox e no replay, o "agora" do ambiente é decidido por ele e publicado como `clock.ticked`.

O agendador **não executa** as rotinas: ele só avisa (`routine.triggered`) e espera a resposta do dono (`routine.completed`/`routine.failed`). A liquidação é do clearing, o fim das ordens é do OMS. Por isso o agendador não conhece nenhuma regra de negócio dessas rotinas.

```
scheduler ──routine.triggered──▶ <env>.scheduler.events ──▶ clearing (settlement)
    ▲                                                            │
    └──────routine.completed── <env>.clearing.events ◀───────────┘
```

O `routine.completed` volta pelo **tópico do dono**, e não pelo do agendador. Cada tópico tem um único produtor (RN-MSG-B §2), então o agendador consome uma lista de tópicos (`ROUTINE_RESULT_CONTEXTS`). O contrato do evento declara `context: '*'`, e o AsyncAPI gerado mostra o canal `{environment}.{context}.events`. Para isso, os contratos do grupo 7 ganharam o campo `context`: o primeiro segmento do `eventType` (`routine`) não é o tópico (`scheduler`).

## Arquitetura hexagonal na prática

É o primeiro serviço com as três camadas que o ESLint do grupo 1 exige:

| Camada         | Arquivos                                                        | Pode importar         |
| -------------- | --------------------------------------------------------------- | --------------------- |
| `domain/`      | `routines.ts` (regras), `catalog.ts` (tabela §8)                | só calendário e tipos |
| `application/` | `scheduler.ts`, `environment-clock.ts`, `runner.ts`, `ports.ts` | domínio e portas      |
| `adapters/`    | `postgres-store.ts`, `http.ts`                                  | tudo                  |
| raiz           | `app.ts` (composição), `main.ts`                                | tudo                  |

O domínio é uma função pura, `decide()`: recebe as definições, o calendário, o instante, o cursor e as execuções, e devolve o que disparar, o que espera e o próximo cursor. Sem banco, relógio da máquina ou aleatoriedade (o ESLint proíbe `Date.now` em `domain/`). Por isso os testes do domínio rodam em milissegundos com o calendário B3 de verdade. Quando o código saiu do papel, os 11 testes de domínio passaram de primeira.

## 11.1 — Disparo e idempotência

### Quando uma rotina roda

Uma rotina tem horário **fixo** (`{ at: '08:00' }`, em São Paulo) ou **relativo à grade do pregão** (`{ phase: 'PRE_TRADING' }`, opcionalmente com `offsetMinutes`). A forma relativa importa nos dias especiais. Na Quarta-feira de Cinzas (`LATE_OPEN`) o pregão abre às 13:00, e o `PRE_TRADING` é às 12:00, não às 09:00. Como a hora vem do `sessionSchedule` do calendário, a tabela de rotinas não muda. O "fechamento do day trade alavancado, 30 min antes do fim" virou `{ phase: 'CLOSING_CALL', offsetMinutes: -30 }`.

Os dias: `TRADING` (dia com pregão e liquidação) ou `FIRST_BUSINESS_DAY_OF_MONTH` (taxa de custódia e IR do mês anterior). O primeiro dia útil é calculado olhando os dias do próprio mês, e não "a véspera útil é de outro mês". Em 02/01/2026, a véspera útil (30/12/2025) está fora do calendário carregado, e o calendário recusa responder em vez de supor (RN-CAL-001).

### A chave de idempotência

`routine_execution` tem chave primária `(routine_name, business_date)`, que é literalmente a RN-ROT-001. O passo de disparo faz, numa transação:

```sql
SELECT cursor FROM scheduler_state WHERE id = 1 FOR UPDATE;      -- serializa os passos
INSERT INTO routine_execution (...) ON CONFLICT DO NOTHING;      -- a idempotência
INSERT INTO outbox_event (... routine.triggered ...);            -- só se o INSERT acima inseriu
```

O teste "disparo duplicado" roda **dois agendadores ao mesmo tempo** sobre o mesmo banco. É o caso real do failover, em que o líder antigo ainda não percebeu que perdeu o lease (o "limite conhecido" do `LeaderElector`, grupo 4). Saem 3 execuções e 3 eventos, não 6: a trava do cursor faz o segundo passo esperar o primeiro e enxergar o que ele gravou.

O dono da rotina também precisa ser idempotente pela mesma chave. Um re-disparo de rotina `FAILED` traz um `executionId` **novo** (e `attempt: 2`), e uma resposta que chega com o `executionId` antigo é ignorada (`STALE`).

## 11.2 — Dependências e catch-up

### Dependência é do mesmo dia

`dependsOn: ['post_close', 'eod_orders']` quer dizer "a de hoje". O `decide()` dispara as vencidas em ordem de horário, **pula** as que esperam dependência e segue com as independentes. Às 19:00, os juros de saldo devedor não esperam o fechamento do mercado, mas as notas de corretagem esperam.

Quando chega um `routine.completed`, o agendador grava a conclusão e dá um passo **logo em seguida**, sem esperar o próximo ciclo: é o "disparada logo após" da spec.

### Catch-up em ordem de datas

O cursor (`scheduler_state.cursor`) é a primeira data com rotina por disparar. A regra: **uma data só começa quando todas as rotinas da anterior foram disparadas**.

```
fora o dia 03/03 inteiro; volta em 04/03 às 08:30
→ dispara as 17 rotinas de 03/03 (marcadas catchUp), em ordem, esperando as dependências
→ só então calendar_check, settlement, corporate_actions de 04/03
```

Por que "disparadas" e não "concluídas"? Exigir todas as concluídas travaria o dia seguinte por qualquer rotina sem resposta, inclusive as que não têm dependentes. Exigir só "disparadas" garante a ordem do que importa: o `eod_orders` de 03/03, que cancela as ordens `DAY` daquele dia (o cenário da spec), sai antes de qualquer rotina de 04/03. E como ele depende do `post_close` de 03/03, toda essa cadeia de D vem antes de D+1.

## 11.3 — O relógio do ambiente

### Três modos, um só por ambiente

| Modo          | `now()`                                        | `clock.ticked`                |
| ------------- | ---------------------------------------------- | ----------------------------- |
| `REAL`        | tempo da máquina                               | não publica                   |
| `ACCELERATED` | `âncora + (real − realNaÂncora) × speedFactor` | a cada minuto virtual         |
| `VIRTUAL`     | parado; só anda com `advance_to(t)`            | a cada parada do `advance_to` |

O tempo virtual fica gravado em `clock_state` a cada tick. Sem isso, reiniciar um sandbox acelerado faria o tempo voltar ao `CLOCK_START`, e um dia já vivido seria vivido de novo. Subir com um modo diferente do gravado é recusado (RN-CLK-003: um ambiente não mistura modos).

O tick acelerado é o **minuto atual**, não todos os minutos perdidos. Se o processo dormiu por uma hora virtual, sai um tick só. Os serviços querem saber que horas são, não reviver cada minuto.

### `advance_to` sem pular rotina

Um `advance_to` de dias poderia simplesmente mudar o relógio. Mas o catch-up então dispararia tudo como "atrasado" e no instante errado (o `occurredAt` seria o do destino). Em vez disso, o salto **para em cada horário de rotina do caminho**:

```
advance_to(08:45) a partir das 06:00
  → 07:00  tick, calendar_check
  → 08:00  tick, settlement
  → 08:30  tick, corporate_actions_ex_date
  → 08:45  tick, securities_lending_renewal
```

Cada parada publica um `clock.ticked` e dá um passo. Um replay em `VIRTUAL` dispara as rotinas na mesma ordem e com o mesmo tempo que um dia real.

### Os outros serviços seguem o tempo

O `TickedClock` (`@broker/clock`) é o relógio dos demais serviços num ambiente virtual: o tempo é o do último `clock.ticked`, e um tick repetido ou fora de ordem (entrega pelo menos uma vez) nunca faz o tempo voltar.

### Liderança e failover

Só o líder (`LeaderElector`, advisory lock) dá passos, publica o relógio e roda o relay da outbox. A réplica serve as leituras e responde `503 NOT_LEADER` ao `advance_to`.

No failover, a réplica **recarrega o relógio gravado** antes do primeiro passo. O relógio dela parou no instante em que ela subiu, e o líder anterior pode ter andado horas virtuais desde então. O teste simula a queda do líder com `pg_terminate_backend` na conexão que segura o lock, como num `kill -9`. Ele verifica três coisas: a réplica assume, continua das 08:15 (o tempo do líder morto) e nenhuma rotina sai duas vezes.

## O que ficou de fora

- **`calendar.updated`**: o calendário é a semente B3 2026–2027 do grupo 3. O consumo do evento entra quando existir o `reference-data-service`, que o publica.
- **Autorização das rotas de admin**: `advance_to`, re-disparo e resultado manual existem só com `ADMIN_API_ENABLED=true`. Quando o identity-service existir, elas passam a exigir papel de backoffice.
- **Rotinas sem dono no ar**: no ambiente local de hoje, nenhum serviço responde às rotinas. O agendador dispara as independentes e as dependentes esperam, como deveria acontecer.

## Problemas no caminho

- **Relógio parado na réplica**: a primeira versão carregava o relógio virtual só ao subir. Ao virar líder, a réplica partiria de um tempo velho. Agora o `elected()` recarrega `clock_state`.
- **Tick contado antes do commit**: a marcação "tick publicado" acontecia dentro da transação. Se ela falhasse, aquele minuto nunca seria publicado. Agora a marcação vem depois do commit.
- **`prefer-const` no app**: o publisher precisa do relógio, que é carregado pelo store, que precisa do publisher. O ciclo foi resolvido com uma referência explícita (`clockRef`), em vez de um `let` atribuído depois.

## Para experimentar

```bash
pnpm env:up core
curl --cacert infra/certs/ca/rootCA.pem https://scheduler.broker.localhost/v1/clock
curl --cacert infra/certs/ca/rootCA.pem https://scheduler.broker.localhost/v1/routines

# sandbox: 1 dia útil em ~1 hora real (recrie o ambiente para trocar o modo)
pnpm env:down --volumes
CLOCK_MODE=ACCELERATED CLOCK_START=2026-03-02T09:00:00Z CLOCK_SPEED_FACTOR=24 pnpm env:up core
```
