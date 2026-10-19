# Fase 0, grupo 3 — Domínio compartilhado

> Tarefas 3.1 a 3.6 de `openspec/changes/implementation-roadmap/tasks.md`. Spec: `specs/domain-primitives/spec.md`.

## Visão geral

Os grupos 1 e 2 prepararam o repositório e o ambiente. O grupo 3 escreve o **primeiro código de negócio**: os tipos que todos os serviços vão usar para falar de dinheiro, preço, quantidade, CPF, identificadores, tempo e calendário.

A ideia central é: **nenhum serviço usa primitivos (`number`, `string`) para conceitos de negócio**. Em vez de `price: number`, usa `Price`. Isso tem dois efeitos:

1. as regras (precisão, arredondamento, validação) ficam num lugar só, e não espalhadas em 25 serviços;
2. um valor inválido não consegue nem existir: a validação acontece na **construção** do objeto.

Esses objetos se chamam **objetos de valor** (_value objects_, do DDD): são imutáveis, comparados pelo conteúdo e não têm identidade própria. Dois `Money("0.30", BRL)` são iguais, assim como duas notas de 10 reais.

Cinco pacotes novos:

| Pacote                  | Conteúdo                                                                               | Tarefa       |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------ |
| `@broker/domain-kernel` | `Money`, `Price`, `Quantity`, `Percentage`, rateio, `TaxId`, `Instant`, `BusinessDate` | 3.1–3.3, 3.5 |
| `@broker/testing`       | PRNG com semente e gerador de CPF                                                      | 3.3          |
| `@broker/ids`           | UUID v7, número de conta, número de nota, protocolo                                    | 3.4          |
| `@broker/clock`         | porta `Clock` e os modos `REAL`, `ACCELERATED`, `VIRTUAL`                              | 3.5          |
| `@broker/calendar`      | funções de calendário e a semente B3 2026–2027                                         | 3.6          |

```
@broker/calendar ──┐
@broker/clock ─────┼──► @broker/domain-kernel ◄── @broker/testing
                   │
@broker/ids  (independente)
```

---

## Como os pacotes se enxergam: a condição `source`

Cada pacote tem um `package.json` com `exports` assim:

```json
"exports": {
  ".": {
    "source": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
}
```

São **exports condicionais**: quem importa `@broker/domain-kernel` recebe um arquivo diferente conforme a "condição" ativa.

- **Em produção** (Node, Docker): nenhuma condição `source` → `dist/index.js`, o código compilado.
- **No `tsc`**: `types` → `dist/index.d.ts`. Por isso o Turbo compila as dependências antes (`dependsOn: ["^build"]`).
- **Nos testes** (Vitest): cada `vitest.config.ts` ativa `source` com `ssr: { resolve: { conditions: ['source'] } }` → importa direto o `src/index.ts`. Assim `pnpm test` roda sem precisar compilar antes, e uma mudança no `domain-kernel` aparece na hora nos testes do `calendar`.

Na primeira tentativa usei `resolve.conditions` e não funcionou: o Vitest roda os testes do lado "servidor" do Vite (SSR), que tem sua própria configuração de resolução. O certo é `ssr.resolve.conditions`.

---

## 3.1 — Dinheiro, preço, quantidade e taxa

### Por que não `number`

```js
0.1 + 0.2; // 0.30000000000000004
```

`number` em JavaScript é **ponto flutuante binário** (IEEE 754). Ele não representa 0,1 com exatidão, do mesmo jeito que 1/3 não tem representação exata em decimal. Num sistema financeiro, um centavo de erro por operação vira diferença de conciliação. O ADR-0004 proíbe ponto flutuante para dinheiro, preço, taxa e quantidade.

A solução é a biblioteca **`decimal.js`**, que faz aritmética em **base 10** com precisão configurável. Em `src/decimal.ts`:

```ts
export const Decimal = DecimalJs.clone({ precision: 34, rounding: DecimalJs.ROUND_HALF_UP });
```

- `clone` cria uma "cópia configurada" da biblioteca, sem alterar a configuração global (outro pacote que use `decimal.js` não é afetado);
- **34 dígitos significativos**: o mesmo do padrão IEEE 754 decimal128, folga de sobra para cálculos intermediários.

### `number` é recusado mesmo em tempo de execução

O TypeScript já impede `Money.of(0.1, 'BRL')` (o tipo aceita `string | bigint | Decimal`). Mas tipos somem na compilação, e um dado vindo de JSON pode chegar como número. Por isso `toDecimal` também checa em runtime:

```ts
if (typeof value === 'number') {
  throw new DomainError(
    'INVALID_DECIMAL',
    '... não pode ser construído a partir de number (ponto flutuante)',
  );
}
```

E a string precisa casar com `/^-?\d+(\.\d+)?$/`: `"1e3"`, `"1,50"` e `"NaN"` são recusados.

### `Money`

- **Moeda sempre explícita** (`Money.of("0.10", "BRL")`), mesmo havendo uma só. Somar BRL com USD dá `CURRENCY_MISMATCH`.
- **Duas formas de construir**: string decimal (`"0.10"`) ou inteiro na menor unidade (`fromMinor(10n, 'BRL')`, em centavos).
- **Pode ter mais de 2 casas** em cálculos intermediários: emolumentos de 0,005% sobre R$ 3.850,00 dão `0.1925`. O ADR manda calcular com ≥ 8 casas e **arredondar só no fim**.
- `round(mode)` arredonda explicitamente. `toMinor()` (centavos) **exige** que o valor já esteja arredondado; se não estiver, falha com "arredonde antes". Assim é impossível gravar no ledger um valor com 4 casas por esquecimento.
- `toString()` e `toJSON()` produzem **string** (`"3851.15"`), nunca número, como o ADR exige para a API.

### Arredondamento explícito

`src/rounding.ts` define quatro modos e nenhum é implícito:

| Modo       | Regra                         | Uso no domínio                                    |
| ---------- | ----------------------------- | ------------------------------------------------- |
| `HALF_UP`  | meio para cima (0,195 → 0,20) | padrão: custos, IR, notas (RN-FEE-030)            |
| `TRUNCATE` | corta em direção ao zero      | proventos por conta: 12,3456 → 12,34 (RN-CA-022)  |
| `CEIL`     | sempre para cima              | direção conservadora: ticks do FMS, trailing stop |
| `FLOOR`    | sempre para baixo             | idem, no lado oposto                              |

"Explícito" quer dizer que toda chamada informa o modo: `money.round('HALF_UP')`. Ninguém precisa adivinhar qual arredondamento um método usa por baixo.

### `Price`, `Quantity`, `Percentage`

- **`Price`**: até 8 casas (preço de referência, preço médio); `Price.trading()` restringe a 4 casas e > 0 (preço de ordem). `roundToTick('0.01', 'CEIL')` ajusta ao múltiplo do tick com direção explícita.
- **`Quantity`**: `bigint` de 64 bits. `Quantity.of("10.5")` é recusado. Pode ser negativa (posição vendida a descoberto); `Quantity.positive()` é a versão para ordens (> 0). Serializa como string, porque `bigint` não vai para JSON e pode passar de 2^53, o maior inteiro exato de um `number`.
- **`Percentage`**: guarda a **fração** (5% = 0,05) com até 8 casas. `fromPercent("0.005")` = 0,005% = fração 0,00005. `applyTo(money)` aplica sem arredondar.

### Erros de domínio

`src/errors.ts` define `DomainError` com um **código estável** (`TAX_ID_INVALID`, `CURRENCY_MISMATCH`...). A mensagem é para humanos e pode mudar; o código é contrato, e vai virar o campo `code` dos erros RFC 9457 na API.

### Testes de propriedade

Além de exemplos fixos ("0,10 + 0,20 = 0,30"), o grupo usa **fast-check**, que gera centenas de entradas aleatórias e confere uma **propriedade** que precisa valer para todas:

```ts
fc.property(decimalString(8), decimalString(8), (a, b) => {
  const sum = Money.of(a, 'BRL').plus(Money.of(b, 'BRL'));
  expect(scaled(sum, 8)).toBe(scaled(a, 8) + scaled(b, 8));
});
```

A referência (`scaled`) converte a string para inteiro escalado (`"1.5"` com 8 casas → `150000000n`) e soma com `bigint`, que é exato. Se `Money` errar em qualquer caso, o fast-check mostra o **menor contraexemplo** que falha.

Outras propriedades:

- **para qualquer `double`**, `Money.of(n)` lança erro;
- arredondar duas vezes dá o mesmo resultado (determinismo); `FLOOR` ≤ original ≤ `CEIL`.

---

## 3.2 — Rateio pelo maior resto

### O problema

Os custos de uma nota (ex.: R$ 0,10 de emolumentos) precisam ser divididos entre os negócios do dia, proporcionalmente ao notional, para calcular o preço médio de cada um (RN-FEE-031). Dividir R$ 0,10 por 3 dá 0,0333...: não existe 1/3 de centavo. Se cada um recebe 0,03, somam 0,09 e **some 1 centavo**. A regra é que a soma das partes seja **exatamente** o total.

### O algoritmo (`src/allocation.ts`)

1. Trabalha em centavos inteiros: R$ 0,10 = 10.
2. Calcula a parte exata de cada item: 10 × peso / soma dos pesos = 3,333...
3. Dá a cada um o **piso**: 3, 3, 3 (soma 9).
4. Sobra 10 − 9 = **1 centavo** (o resíduo; no máximo n − 1).
5. Distribui o resíduo, um centavo por item, na ordem:
   - **maior resto** (a parte fracionária que foi cortada);
   - empate → **maior peso** (notional);
   - empate → **menor ID** (UUID v7 lexicográfico = o negócio mais antigo).

No cenário FEE-010 os três têm resto 0,333 e o mesmo notional, então o centavo vai para o menor `trade_id`: 0,04 / 0,03 / 0,03.

### Decisão de interpretação

O ADR diz "método do maior resto, com o resíduo para o item de maior valor"; RN-FEE-031 diz "o resíduo vai para o negócio de maior notional". Elas não dizem como as duas se combinam. A implementação usa o maior resto como critério principal e o maior valor como desempate, o que respeita as duas e é determinístico. Está registrado no mapeamento tecnológico.

### Propriedades testadas

Para totais e listas de pesos aleatórios:

- **Σ partes = total**, sempre;
- toda parte tem no máximo 2 casas;
- **a ordem de entrada não muda o resultado** (a ordenação por ID garante isso).

Valores negativos também funcionam: o algoritmo rateia o valor absoluto e devolve o sinal no fim.

---

## 3.3 — CPF (`TaxId`) e o gerador de testes

### Validação (`src/tax-id.ts`)

Um CPF tem 9 dígitos de base e 2 **dígitos verificadores** (DV), calculados por **módulo 11**:

```
DV1: multiplica os 9 dígitos por 10, 9, 8 ... 2; soma; (soma × 10) mod 11; se 10 → 0
DV2: mesma conta com os 10 primeiros dígitos e pesos 11 ... 2
```

O DV detecta erros de digitação. Mas sequências como `111.111.111-11` **passam** no módulo 11 e não são CPFs reais, então são recusadas à parte. Tudo falha com o código `TAX_ID_INVALID`.

### Privacidade por padrão

O CPF é dado pessoal (LGPD). Fora do próprio titular, é mostrado como `***.456.789-**`. O detalhe importante: **`toString()` e `toJSON()` devolvem a versão mascarada**. Se alguém fizer `logger.info({ cpf })` ou `` `cliente ${cpf}` ``, o CPF não vaza. Para o número completo é preciso pedir explicitamente `cpf.digits` ou `cpf.formatted()`.

### Gerador de CPF (`@broker/testing`)

O simulador de KYC decide o resultado pelo **penúltimo dígito** do CPF (0–6 aprovado, 7 e 8 revisão manual, 9 reprovado). O penúltimo dígito é o **DV1**, que não se escolhe: ele é calculado. O gerador sorteia bases de 9 dígitos até o DV1 cair no valor pedido (em média 10 tentativas).

A aleatoriedade vem de um **PRNG com semente** (`mulberry32`): a mesma semente gera sempre a mesma sequência. Teste reproduzível: se falhar, falha igual na próxima execução.

---

## 3.4 — Identificadores (`@broker/ids`)

### UUID v7

IDs internos são **UUID versão 7** (RN-PAD-060), gerados pela aplicação. A estrutura (RFC 9562):

```
 0190a3c0-1f4b-7abc-9def-0123456789ab
 └─ 48 bits: timestamp em ms ─┘ │└12 bits┘ │ └── 62 bits aleatórios ──┘
                                versão 7    variante (10xx)
```

Como o timestamp vem primeiro, **ordenar os IDs como texto ordena por tempo de criação**. Vantagens:

- índices de banco ficam eficientes (inserções no fim, como num ID sequencial);
- não expõe contagem nem permite enumerar (ao contrário de `1, 2, 3...`, RN-PAD-062);
- dá para gerar sem consultar o banco.

**Monotonicidade:** dois IDs no mesmo milissegundo teriam o mesmo prefixo, e a parte aleatória poderia deixar o segundo "menor". A implementação usa os 12 bits `rand_a` como **contador** dentro do mesmo milissegundo (método 1 da RFC 9562 §6.2). Se o contador estoura (4.096 IDs no mesmo ms) ou o relógio volta, o timestamp avança 1 ms. Resultado: IDs do mesmo gerador são **sempre crescentes**. O teste de propriedade simula relógio parado, andando e voltando.

Foi implementado à mão (~50 linhas) em vez de usar uma biblioteca para poder **injetar** o relógio e a fonte de aleatoriedade: em teste, o mesmo `now` e o mesmo `randomFill` geram o mesmo ID.

### Número de conta `NNNNNNN-D`

7 dígitos sequenciais + DV módulo 11 (RN-ACC-001), com pesos 2 a 9 da direita para a esquerda:

```
1234567 → 7×2 + 6×3 + 5×4 + 4×5 + 3×6 + 2×7 + 1×8 = 112
112 mod 11 = 2  →  DV = 11 − 2 = 9  →  1234567-9
```

**Limitação do módulo 11 descoberta no teste:** quando a conta dá 10 ou 11, o DV vira 0 nos dois casos. Então uma troca de dígito que move a soma de um desses restos para o outro **não é detectada**. A primeira versão do teste afirmava "detecta qualquer troca de um dígito" e o fast-check achou o contraexemplo. O teste foi corrigido para afirmar a garantia real.

### Número da nota e protocolo

O domínio não define o formato desses, então a implementação escolheu (e registrou):

- **nota**: sequencial por conta, exibido com 9 dígitos (`000000042`);
- **protocolo**: `SAQ-20261019-7K3M9Q2X` = prefixo + data + 8 caracteres **Crockford base32** aleatórios. Esse alfabeto omite I, L, O e U, que se confundem com 1, 0 e V quando alguém dita o protocolo ao suporte por telefone.

---

## 3.5 — O relógio (`@broker/clock`)

### Por que o relógio é uma "porta"

Se o código chama `Date.now()` direto, é impossível testar "o que acontece às 16:55, no fechamento do pregão" sem esperar até 16:55. E um replay de um dia passado daria resultados diferentes, porque a hora seria a de hoje.

A solução (RN-CLK-001, ADR-0009) é uma **interface**:

```ts
interface Clock {
  readonly mode: 'REAL' | 'ACCELERATED' | 'VIRTUAL';
  now(): Instant;
  businessDate(): BusinessDate;
}
```

Todo código pergunta a hora ao `Clock` que recebeu (injeção de dependência). Quem decide **qual** relógio é o ambiente:

| Modo          | Classe             | Comportamento                                                        | Uso                   |
| ------------- | ------------------ | -------------------------------------------------------------------- | --------------------- |
| `REAL`        | `RealClock`        | hora da máquina                                                      | "produção" simulada   |
| `ACCELERATED` | `AcceleratedClock` | virtual = início + (real decorrido × `speedFactor`)                  | sandbox: 1 dia em 1 h |
| `VIRTUAL`     | `VirtualClock`     | **parado**; só anda com `advanceTo(t)`. Nunca volta (erro se tentar) | testes e replay       |

É aqui que se fecha o círculo com o grupo 1: o ESLint **proíbe** `Date.now()` no domínio, e este pacote é a alternativa.

`timestamps(clock)` gera os dois carimbos de RN-CLK-004: `occurredAt` (tempo do ambiente, vai no evento) e `wallClockAt` (tempo real da máquina, para os logs técnicos). No sandbox acelerado eles divergem, e os dois são úteis.

### `Instant` e `BusinessDate` (em `domain-kernel`)

O Node 24 ainda não tem a API `Temporal` (a substituta moderna de `Date`). Foram criados dois tipos próprios:

- **`Instant`**: um momento em UTC, em milissegundos. Só aceita ISO 8601 com `Z` (`2026-10-16T20:00:00Z`): `-03:00` é recusado, porque a regra P-02 é "UTC em todo lugar".
- **`BusinessDate`**: uma **data sem hora e sem fuso** (`2026-10-16`), a "data do pregão". Guardada como número de dias desde 1970-01-01.

### A virada de dia UTC → São Paulo

```
2026-10-17T01:30:00Z  (UTC)   =   2026-10-16 22:30 em São Paulo (UTC−3)
                                   → data de negócio: 2026-10-16
```

Às 22:30 de sexta em São Paulo já é sábado em UTC. Se a data de negócio fosse calculada em UTC, uma ordem dessa hora cairia no dia errado. `BusinessDate.fromInstant` usa `Intl.DateTimeFormat` com `timeZone: 'America/Sao_Paulo'` para obter o dia local correto. O teste cobre 23:59Z, 01:30Z, 02:59:59.999Z e 03:00Z.

O inverso, `atLocalTime('13:00')`, converte "13:00 em São Paulo naquela data" para um `Instant` UTC. Ele não assume UTC−3 fixo: descobre o deslocamento do fuso naquele dia. O Brasil aboliu o horário de verão em 2019, mas o código não depende disso.

---

## 3.6 — Calendário de pregão (`@broker/calendar`)

### O modelo

Só os **dias especiais** são cadastrados. Fim de semana é calculado, e um dia de semana sem cadastro é `BUSINESS_DAY`:

| Tipo           | Negocia?        | Liquida? | Exemplo                        |
| -------------- | --------------- | -------- | ------------------------------ |
| `BUSINESS_DAY` | sim             | sim      | um dia comum                   |
| `LATE_OPEN`    | sim, mais tarde | sim      | Quarta-feira de Cinzas (13:00) |
| `HOLIDAY`      | não             | não      | Natal, Carnaval                |
| `NO_TRADING`   | não             | não      | 24/12 e 31/12                  |
| `WEEKEND`      | não             | não      | sábado e domingo               |

### As cinco funções (RN-CAL-002)

| Função                      | O que responde                                                            |
| --------------------------- | ------------------------------------------------------------------------- |
| `isBusinessDay(d)`          | `BUSINESS_DAY` ou `LATE_OPEN`                                             |
| `nextBusinessDay(d, n)`     | D+n: o n-ésimo dia útil depois de `d` (liquidação D+2 usa isso)           |
| `previousBusinessDay(d, n)` | o n-ésimo dia útil antes                                                  |
| `businessDaysBetween(a, b)` | dias úteis em (a, b]: depois de `a` até `b` inclusive                     |
| `sessionSchedule(d)`        | as fases do pregão do dia, com horário em UTC, ou `null` se não há pregão |

A definição "(a, b]" foi escolhida para valer a identidade `businessDaysBetween(d, nextBusinessDay(d, n)) = n`, testada com fast-check em centenas de datas.

### Vigência da grade horária (RN-CAL-003)

Os horários da B3 mudam durante o ano (ajuste ao horário de verão dos EUA, por exemplo). Por isso cada grade tem `validFrom` e `validTo`, e `sessionSchedule` escolhe a vigente na data. O teste monta três vigências (até 6/3, de 9/3 a 30/10 com contínua às 11:00, e depois de 2/11) e confere que cada data recebe a grade certa.

### Recusar em vez de adivinhar

Fora do período carregado (2026–2027), as funções lançam `CALENDAR_NOT_LOADED`. A alternativa ingênua, tratar todo dia de semana como útil, faria uma liquidação cair num feriado de 2028 não cadastrado. Falhar alto é mais seguro; RN-CAL-001 manda o backoffice ser alertado 60 dias antes do fim.

### A semente B3 2026–2027 e a conferência pela Páscoa

Carnaval, Sexta-feira Santa e Corpus Christi são **feriados móveis**, calculados a partir da Páscoa:

| Feriado                | Data               | 2026     | 2027     |
| ---------------------- | ------------------ | -------- | -------- |
| Páscoa                 | —                  | 05/04    | 28/03    |
| Carnaval (seg e ter)   | Páscoa − 48 e − 47 | 16–17/02 | 08–09/02 |
| Quarta-feira de Cinzas | Páscoa − 46        | 18/02    | 10/02    |
| Sexta-feira Santa      | Páscoa − 2         | 03/04    | 26/03    |
| Corpus Christi         | Páscoa + 60        | 04/06    | 27/05    |

A semente é uma lista escrita à mão, e uma data errada passaria despercebida. Por isso o teste **calcula a Páscoa** (algoritmo de Meeus/Jones/Butcher) e confere que cada feriado móvel da semente bate com o cálculo. Também confere que todo feriado fixo em dia de semana está cadastrado. Feriados em fim de semana (15/11/2026, 1/5/2027...) não aparecem, porque já não são dias úteis.

### CAL-001

| Cenário                                   | Resultado                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| sexta antes do Carnaval (13/02/2026), D+1 | **18/02**, Quarta de Cinzas, `LATE_OPEN` (pula sáb, dom, seg e ter)          |
| véspera de Corpus Christi (03/06), D+1    | **05/06** (pula a quinta)                                                    |
| 30/12/2026, D+1                           | **04/01/2027**: 31/12 `NO_TRADING`, 1/1 feriado (sexta), 2–3/1 fim de semana |

---

## Ajustes na plataforma

- **Regras de determinismo nos pacotes de domínio puro.** A regra do ESLint (proibir `Date.now`, `new Date()`, `Math.random`) valia só para pastas `domain/`. `domain-kernel` e `calendar` são domínio puro mas não têm essa pasta, então foram incluídos explicitamente. Conferido com um arquivo temporário com `Date.now()`, que foi bloqueado.
  - Note que `new Date(ms)` **com** argumento continua permitido: ele é determinístico. Por isso `Instant.toString()` pode usar `new Date(this.epochMillis).toISOString()`.
- **Cobertura mínima de 80%** também para esses dois pacotes. Na primeira execução o `domain-kernel` ficou em **76% de funções** e o `pnpm test:coverage` falhou, que é exatamente o objetivo do limite. Foram adicionados testes de comparação, sinal e serialização (o que um serviço vai usar de fato), e a cobertura subiu para 98%.

---

## Problemas no caminho

1. **`node` e `pnpm` não encontrados** num shell novo: o nvm não estava carregado. Resolvido prefixando o `PATH` com `~/.nvm/versions/node/v24.16.0/bin`.
2. **Import do `decimal.js`**: `import DecimalJs from 'decimal.js'` não tinha `clone` nos tipos; o pacote expõe a classe como export nomeado (`import { Decimal } from 'decimal.js'`).
3. **Precedência de operador**: `-10n ** 9n` é erro de sintaxe em JavaScript (o `-` unário antes de `**` é ambíguo). Escreve-se `-(10n ** 9n)`.
4. **Condição `source` nos testes**: `resolve.conditions` não bastou; precisou ser `ssr.resolve.conditions`.
5. **Testes errados, não o código** (três casos):
   - DV esperado da conta `1234567` calculado errado à mão (4 em vez de 9);
   - a propriedade "o módulo 11 detecta qualquer troca de dígito" é falsa (colisão 10/11 → 0);
   - um caso de rateio dizia testar "maior valor" mas testava "menor ID"; virou três cenários separados.

   Lição: quando um teste falha, a primeira pergunta é **quem está errado**, o código ou o teste.

---

## Pendência conhecida

Os arquivos de teste não passam por typecheck: o Vitest só transpila (remove os tipos sem conferir), e o `tsc` de cada pacote só olha `src/`. Um erro de tipo num teste não é pego hoje. Dá para resolver depois com um passo de typecheck que inclua `test/`.

---

## Para experimentar

Rodar todos os testes unitários (não precisa de Docker):

```bash
pnpm test
```

Rodar só um pacote:

```bash
pnpm exec vitest run --project calendar
```

Ver a cobertura e o limite de 80% em ação:

```bash
pnpm test:coverage
```

Ver o fast-check achando um contraexemplo: em `packages/domain-kernel/src/allocation.ts`, troque `residual -= 1n` por `residual -= 2n` e rode `pnpm exec vitest run --project domain-kernel`. A propriedade Σ partes = total falha e mostra o menor caso.

Ver a regra de determinismo: crie `packages/domain-kernel/src/x.ts` com `export const t = Math.random();` e rode `pnpm lint`.

O próximo grupo (4) é a persistência: Kysely + `pg`, migrações, tabelas append-only, criptografia de campo e eleição de líder.
