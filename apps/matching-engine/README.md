# matching-engine

Motor de negociação (catálogo de serviços §9, Motor §2–§10, ADR-0005, D12): livros em memória,
matching preço-tempo, túneis, leilões, journal, snapshots e recuperação.

Não tem API de negócio. Ordem só entra pelo tópico `engine.commands`; as saídas vão para
`engine.events`. Livro para consulta é com o Market Data.

## Como funciona

```
engine.commands ─► sequenciador da partição ─► engine_journal ─► InstrumentEngine ─► engine_output ─► relay ─► engine.events
                   (carimba seq, tempo, semente)  (group commit)    (em memória, puro)                 (dedicado)
```

- **`src/domain/`**: o Motor em si. `InstrumentEngine.process(entrada)` é função pura da entrada e do
  estado (RN-ME-002): sem relógio, sem acaso, sem I/O. É o que os cenários `scenarios/me/` exercitam.
- **`src/application/partition.ts`**: o sequenciador. Um laço por partição, então um livro nunca é
  tocado em paralelo (RN-ME-001).
- **`src/adapters/`**: Postgres, relay e HTTP.

Uma partição só começa a ler depois de **ganhar o lease** (`engine-partition-N`) e de **recuperar os
livros**. O SAC do broker continua ligado, mas é o lease que decide o dono: assim o broker e o banco
não têm como discordar. Se um líder antigo ainda escrever, ele colide na chave
`(instrument_id, input_seq)` do journal, derruba a própria partição e volta a disputar.

## Decisões de implementação

Pontos que o domínio deixa em aberto ou que divergem do texto. Revise estes antes de mudar o Motor.

| Tema                          | Decisão                                                                                                                              | Por quê                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input_seq`                   | Contínuo **por instrumento**, não por quadro. `engine_seq` é por livro (quadro), como pede RN-ME-004.                                | `MAIN` e `ODD_LOT` compartilham fluxo e estado (RN-ME-005); `PhaseChange` afeta os dois.                                                              |
| Leilão do instrumento         | A fase é do instrumento: se um quadro entra em leilão, o outro também. Cada um apura o próprio preço; só o `MAIN` move a referência. | A sessão só acompanha leilão do `MAIN`. Uma agressão no fracionário que para no túnel abre o leilão com a saída `engine.auction_triggered` no `MAIN`. |
| Níveis de preço               | Array ordenado com o melhor no fim, não árvore (D12).                                                                                | Com dezenas de níveis, ganha da árvore e não aloca nó por nível.                                                                                      |
| Preço                         | Inteiro de 8 casas, não centavos (D12).                                                                                              | O contrato `SessionPrice` admite até 8 casas.                                                                                                         |
| STP do FMS                    | Mesma conta nunca negocia consigo, FMS incluído. O pseudocódigo de Motor §4.1 isenta o FMS.                                          | A spec diz "SHALL NOT executar contra outra da mesma conta"; negócio do FMS consigo seria volume falso. Com clientes nunca há conflito (RN-SLF-003).  |
| STP no leilão                 | Sem agressora; vale como agressora a que chegou depois.                                                                              | RN-SLF-001 descreve só o contínuo.                                                                                                                    |
| `IOC` que dispara leilão      | Abre o leilão e cancela o restante com `IOC_REMAINDER`.                                                                              | RN-AUC-012 não aceita `IOC` em leilão.                                                                                                                |
| Reapresentação de `GTC`/`GTD` | Ao entrar em `PRE_OPENING`, `CONTINUOUS` ou outro leilão, antes das ordens agendadas. Quem vence `GTD` é o OMS.                      | RN-REC-005, RN-SES-003.                                                                                                                               |
| `expectedVersion`             | Versão **no Motor**: 1 ao entrar, +1 a cada alteração aceita; volta em `engine.order_replaced`.                                      | O Motor não conhece a versão do agregado do OMS, que precisa guardar esta à parte (grupo 25).                                                         |
| Corte do trade bust           | O Motor vê `routine.triggered` de `brokerage_notes` e põe um `engine.notes_cutoff` por instrumento no próprio tópico de comandos.    | Assim o corte é sequenciado com os pedidos de bust.                                                                                                   |
| Recuperação fora do pregão    | `CLOSED`, `PRE_TRADING`, `POST_CLOSE` e `AFTER_MARKET` não suspendem nem avisam a sessão.                                            | Não há livro ao vivo a proteger.                                                                                                                      |
| Eventos de recuperação        | `book_recovering` e `book_recovered` saem juntos, depois do replay, pela outbox.                                                     | Ficam fora de `engine_seq` para as saídas regeneradas serem idênticas. O leitor só começa depois do replay, então nada é processado no meio.          |

**Limites conhecidos**

- A conclusão com `priceLimit` (RN-AUC-003) pode deixar o livro cruzado, se o preço trazido para o
  túnel não esgotar o lado contrário. O próximo agressor resolve; ninguém executa fora de preço-tempo.
- `seen` e os negócios do dia ficam no estado e no snapshot, e só são limpos no `CLOSED`. O tamanho do
  snapshot cresce com o volume do dia.
- `engine_instrument.partition` guarda a partição em que o instrumento nasceu. Mudar o número de
  partições de `engine.commands` exige migrar os livros: o instrumento passaria a chegar em outra
  partição, que não o recupera, e colidiria no journal.
- O journal e `engine_output` ainda não têm rotina de retenção (grupo 44). O replay administrativo
  parte do início do journal e depende disso.

## Desempenho (RNF-002)

`pnpm --filter @broker/matching-engine bench [entradas]`. Só `InstrumentEngine.process`, sem journal e
sem barramento (D12): 25% de cancelamentos, o resto entre ordens em repouso e agressões.

Linha de base em 2026-11-01, Node 24.16 em WSL2, 950 mil entradas medidas, 3 execuções:

| Métrica                       | Meta       | Medido        |
| ----------------------------- | ---------- | ------------- |
| Latência p50                  |            | 1,3 µs        |
| Latência p99                  | < 1 ms     | 7,1–7,4 µs    |
| Latência p99,9                |            | 23–30 µs      |
| Latência máxima (pausa de GC) |            | 14–139 ms     |
| Vazão por livro               | ≥ 10 mil/s | 475–508 mil/s |

A vazão **de ponta a ponta** é limitada pelo journal, não pelo matching, e ainda não foi medida: fica
para os perfis de carga (grupo 46).

## Runbook

**Livro suspenso com `ENGINE_RECOVERY`.** É o esperado depois de um reinício no meio do pregão. A
sessão retoma por leilão sozinha. O log traz `engine.partition_recovered` com instrumentos, entradas
reprocessadas e duração. A meta é < 30 s (RNF-022).

**`engine.partition_fatal` no log.** A partição caiu e, depois de 1 s, volta a disputar o lease e se
recupera do journal. Uma vez é tolerável (ex.: troca de líder). Em repetição, olhe o erro: uma entrada que o domínio não processa
derruba a recuperação também, e a partição fica parada até corrigir o código.

**Suspeita de divergência.** Rode o replay, que só lê e compara o journal com as saídas gravadas:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" http://matching-engine:8080/v1/admin/engine/books/<instrumentId>/replay
```

**Comando recusado por formato.** Vai para `dead_letter` com `consumer = 'engine.sequencer'`. Comando
inválido não entra no journal, então não trava a partição.

**Rotas administrativas** (`BO_MARKET`, `BO_ADMIN`): `GET /v1/admin/engine/books`,
`POST /v1/admin/engine/books/:id/snapshot` e `POST /v1/admin/engine/books/:id/replay`.

## Configuração

| Variável                     | Padrão | Regra      |
| ---------------------------- | ------ | ---------- |
| `SNAPSHOT_EVERY_INPUTS`      | 10000  | RN-REC-001 |
| `SNAPSHOT_INTERVAL_S`        | 300    | RN-REC-001 |
| `CLOCK_MODE` / `CLOCK_START` | `REAL` | RN-CLK-*   |

As demais são as padrão do service-kit, do banco, do RabbitMQ e da autenticação (`src/main.ts`).

## Testes

```bash
pnpm --filter @broker/matching-engine test   # domínio + integração (Postgres e RabbitMQ em contêiner)
pnpm scenarios ME                            # golden masters ME-*
```
