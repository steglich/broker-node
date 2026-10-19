# Fase 0, grupo 1 — Monorepo e ferramentas

> Commit: `4612f00`. Tarefas 1.1 a 1.4 de `openspec/changes/implementation-roadmap/tasks.md`.

## Visão geral

O grupo 1 não cria nenhum serviço. Ele monta a base do repositório: como o código fica organizado, como é compilado, como é verificado (lint, formatação) e como é testado. Tudo o que vier depois (Docker, domínio, mensageria, serviços) se apoia nisso.

---

## 1.1 — O monorepo

### O que é um monorepo e por que usar

O projeto terá cerca de 25 serviços (`apps/`) e várias bibliotecas compartilhadas (`packages/`). Existem duas formas de organizar isso:

- **Um repositório por serviço:** cada mudança numa biblioteca compartilhada exige publicar uma versão nova e atualizar todos os repositórios. Num projeto solo de estudo, isso é muito trabalho.
- **Monorepo:** tudo fica num repositório só, e um serviço usa a biblioteca diretamente da pasta ao lado. Contratos e bibliotecas mudam junto com os serviços.

O design (D1) escolheu o monorepo.

### As ferramentas

**pnpm workspaces**: o gerenciador de pacotes. O arquivo `pnpm-workspace.yaml` diz onde estão os pacotes:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'contracts'
  - 'scenarios'
```

Toda pasta dentro de `apps/` ou `packages/` que tiver um `package.json` vira um pacote do workspace. Para um pacote usar outro, a dependência é declarada como `"@broker/tsconfig": "workspace:*"`, que significa "use a versão que está aqui no repositório".

O pnpm também é **estrito**: um pacote só enxerga as dependências que declarou no próprio `package.json`. Isso apareceu na prática. Primeiro instalei os plugins do ESLint na raiz e depois precisei movê-los para dentro de `packages/eslint-config`, porque é esse pacote que os importa. O npm deixaria passar, e é assim que surgem dependências "fantasmas" que quebram em produção.

**Turborepo** (`turbo.json`): o orquestrador de tarefas. Com 25 serviços, rodar `build` em todos a cada mudança seria lento. O Turbo:

- entende o grafo de dependências: `"dependsOn": ["^build"]` quer dizer "antes de compilar um pacote, compile as dependências dele";
- guarda resultados em cache: se nada mudou num pacote, ele não recompila;
- roda só o que foi afetado por uma mudança (o CI vai usar isso no grupo 9).

No grupo 1, `pnpm turbo run build` dizia "No tasks were executed", e esse era o resultado esperado: ainda não existia nenhum pacote com script `build`.

**Fixação do Node 24**:

- `.nvmrc` contém `24`. Se você rodar `nvm use` na pasta, o nvm troca para o Node 24.
- `"engines": { "node": ">=24 <25" }` no `package.json` documenta a versão exigida.
- `"packageManager": "pnpm@12.14.0"` faz o corepack (que vem com o Node) usar exatamente essa versão do pnpm. O pnpm não estava instalado; foi ativado com `corepack enable`.

### As pastas

| Pasta        | Para que serve                                                       |
| ------------ | -------------------------------------------------------------------- |
| `apps/`      | um diretório por serviço implantável (identity, ledger, OMS, motor…) |
| `packages/`  | bibliotecas compartilhadas (`domain-kernel`, `clock`, `messaging`…)  |
| `contracts/` | esquemas de eventos e OpenAPI, a "fonte da verdade" das interfaces   |
| `scenarios/` | cenários golden master em YAML (`ME-*`, `FEE-*`, `CAL-*`…)           |
| `infra/`     | Docker Compose, Dockerfile, Traefik, init do Postgres                |
| `docs/`      | documentação da implementação e ADRs                                 |
| `estudos/`   | anotações de estudo (como este arquivo)                              |

As pastas ainda vazias têm um `.gitkeep`, porque o git não versiona pastas vazias.

### Scripts da raiz

```
pnpm build          → turbo run build
pnpm typecheck      → turbo run typecheck
pnpm lint           → eslint .
pnpm format         → prettier --write .
pnpm format:check   → prettier --check .
pnpm test           → vitest run
pnpm test:coverage  → vitest run --coverage
```

---

## 1.2 — TypeScript e ESLint compartilhados

### `packages/tsconfig`

A ideia é ter uma configuração de TypeScript só, que todo serviço herda com `"extends": "@broker/tsconfig/library.json"`. Sem isso, cada serviço teria um `tsconfig.json` ligeiramente diferente.

Em `packages/tsconfig/base.json`, as opções mais importantes são:

| Opção                               | O que faz                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `strict: true`                      | liga todas as verificações rígidas (null checks, `any` implícito proibido etc.) |
| `noUncheckedIndexedAccess`          | `array[0]` tem tipo `T \| undefined`, o que obriga a tratar o caso vazio        |
| `exactOptionalPropertyTypes`        | `{ x?: number }` não aceita `x: undefined` explícito; é mais preciso            |
| `module/moduleResolution: NodeNext` | ESM nativo do Node; imports precisam de extensão (`'./foo.js'`)                 |
| `verbatimModuleSyntax`              | obriga `import type` para tipos e deixa claro o que some na compilação          |
| `noImplicitOverride`                | métodos sobrescritos precisam da palavra `override`                             |

Num sistema financeiro, essas checagens pegam erros que causariam valores errados (um `undefined` virando `NaN` numa soma, por exemplo).

`library.json` estende o base para pacotes que geram `dist/` com arquivos `.d.ts` (tipos para quem importar). `${configDir}` é um recurso recente do TS: o caminho é resolvido a partir de quem herda a configuração, e não a partir do pacote tsconfig.

**Por que TypeScript 6 e não 7:** o TS 7 (a versão reescrita em Go) já existe, mas o `typescript-eslint` só aceita até o 6.0.x.

### `packages/eslint-config` — o mais interessante para estudo

Arquivo: `packages/eslint-config/index.js`.

Usa o formato **flat config** (o padrão do ESLint 9+): um array de objetos de configuração aplicados em ordem.

#### Camadas da configuração

1. `js.configs.recommended`: regras básicas de JavaScript.
2. `tseslint.configs.recommended`: regras para TypeScript.
3. As regras de arquitetura (abaixo).
4. `eslint-config-prettier` (por último): desliga regras de estilo que brigariam com o Prettier.

#### Regra 1: arquitetura hexagonal (`import/no-restricted-paths`)

O design (D3) diz que cada serviço segue:

```
src/
  domain/        ← regras de negócio puras
  application/   ← casos de uso (orquestram o domínio via portas)
  adapters/      ← banco, HTTP, RabbitMQ (o "mundo externo")
  config/
```

A regra de ouro é que **as dependências apontam para dentro**. O domínio não conhece banco, HTTP nem fila. Isso permite testar o domínio sem infraestrutura e trocar um adaptador (RabbitMQ por Kafka, por exemplo) sem mexer nas regras de negócio.

Essa regra pode ficar só documentada, mas aí cedo ou tarde alguém vai importar o banco dentro do domínio "só dessa vez". Por isso ela é aplicada pelo lint:

```js
zones: [
  { target: '**/domain/**', from: ['**/adapters/**', '**/config/**', '**/application/**'] },
  { target: '**/application/**', from: ['**/adapters/**'] },
];
```

Arquivos em `domain/` não podem importar de `adapters/`, `config/` nem `application/`, e `application/` não pode importar de `adapters/`.

Usamos o `eslint-plugin-import-x`, um fork moderno do `eslint-plugin-import` (o clássico não suporta ESLint 10). Ele foi registrado com o nome `import` para manter o nome de regra que a tarefa pedia.

**Problema encontrado no caminho:** na primeira execução essa regra **não disparou**. O código importa `'../adapters/db.js'`, mas o arquivo real é `db.ts` (é assim que funciona ESM com TypeScript: você escreve `.js` e o TS resolve para `.ts`). O plugin não conseguia resolver o caminho e por isso não sabia que o import vinha de `adapters/`. A solução foi adicionar o `eslint-import-resolver-typescript`, que entende essa convenção.

#### Regra 2: bibliotecas de infraestrutura (`no-restricted-imports`)

A regra 1 cobre pastas. Esta cobre pacotes npm: dentro de `domain/` é proibido importar `pg`, `express`, `kysely`, `amqplib`, `pino`, `@opentelemetry/*`, `node:fs`, `node:http` etc. A lista fica em `INFRA_MODULES`, exportada para poder crescer.

#### Regra 3: determinismo (`no-restricted-syntax`)

Esta é específica do domínio de corretora. O design exige **determinismo e reprodutibilidade**: o motor de negociação, recebendo a mesma sequência de entradas, precisa produzir exatamente as mesmas saídas. É isso que permite:

- **testes golden master**: um cenário YAML sempre dá o mesmo resultado;
- **recuperação do motor**: reprocessar o journal regera os mesmos eventos;
- **relógio virtual**: nos testes você "avança" o tempo para 17h e testa o fechamento do pregão sem esperar.

Três coisas quebram o determinismo:

- `Date.now()`: cada execução dá um valor diferente;
- `new Date()` sem argumento: idem;
- `Math.random()`: aleatório, sem semente.

A regra usa **seletores de AST** (a árvore sintática que o ESLint analisa):

```js
"CallExpression[callee.object.name='Date'][callee.property.name='now']"; // Date.now()
"NewExpression[callee.name='Date'][arguments.length=0]"; // new Date()
"MemberExpression[object.name='Math'][property.name='random']"; // Math.random
```

Repare em `arguments.length=0`: `new Date('2026-01-02T00:00:00Z')` continua permitido, porque é determinístico (sempre a mesma data). No lugar dessas chamadas, o domínio vai receber uma **porta `Clock`** (grupo 3, `packages/clock`), que em teste é controlada por você.

#### Como foi verificado

Um arquivo que viola tudo de propósito, `packages/eslint-config/test/fixtures/domain/violations.ts`:

```ts
import { db } from '../adapters/db.js'; // linha 2 → hexagonal
export const now = Date.now(); // linha 4 → determinismo
export const today = new Date(); // linha 5 → determinismo
export const noise = Math.random(); // linha 6 → determinismo
export const ok = new Date('2026-01-02T00:00:00Z'); // linha 7 → PERMITIDO
import 'pg'; // linha 8 → infraestrutura
```

E um teste, `packages/eslint-config/test/rules.test.ts`, que roda o ESLint por API sobre esse arquivo e confere que os erros saem **exatamente** nas linhas 2, 4, 5, 6 e 8, e nada na 7. Isso tem duas vantagens:

- se alguém quebrar a configuração do lint no futuro, o teste falha;
- ele também prova que a linha 7 não gera falso positivo.

No `eslint.config.js` da raiz, essa pasta de fixtures é ignorada; sem isso, `pnpm lint` falharia sempre.

#### Prettier

`.prettierrc.json`: aspas simples, vírgula final e 100 colunas. `.prettierignore` exclui o lockfile, `broker-docs`, `openspec` e as pastas de ferramentas de IA.

---

## 1.3 — Vitest

Arquivo: `vitest.config.ts`.

**Por que Vitest:** é rápido, entende TypeScript e ESM sem configuração extra e tem API compatível com Jest.

**Projetos:** cada pacote ou serviço tem o próprio `vitest.config.ts` (com `defineProject` e um `name`), e a raiz junta todos:

```ts
projects: [
  'packages/*/vitest.config.ts',
  'apps/*/vitest.config.ts',
  'contracts/*/vitest.config.ts',
];
```

Assim, `pnpm test` na raiz roda tudo, e os resultados e a cobertura aparecem separados por pacote. Um ajuste no caminho: o primeiro rascunho tinha `contracts/vitest.config.ts` como caminho fixo, e o Vitest dá erro se um caminho fixo não existe. Troquei por um glob, que tolera não encontrar nada.

**Cobertura com limite no domínio:**

```ts
thresholds: { '**/domain/**': { lines: 80, functions: 80, branches: 80, statements: 80 } }
```

`pnpm test:coverage` falha se o código de `domain/` tiver menos de 80% de cobertura. O limite vale só para o domínio porque é ali que estão as regras de negócio (cálculo de taxas, matching, risco). Adaptadores são testados por integração (Testcontainers), que é outro tipo de teste.

No grupo 1, a cobertura aparecia "Unknown% (0/0)" porque ainda não existia código em `src/`. Isso muda no grupo 3.

O teste de exemplo é o próprio teste de lint da 1.2. O nome dele cita `RN-BE-001/ADR-0009`, seguindo a regra de que todo teste de regra cita o ID (RN-QA-001).

---

## 1.4 — Mapeamento tecnológico

Arquivo: `docs/mapeamento-tecnologico.md`.

**Por que existe:** o `broker-docs` é **agnóstico de tecnologia**. Ele fala em "barramento de eventos", "registro de esquemas" e "cofre de segredos", nunca em "RabbitMQ" ou "Vault". A regra **RN-BE-082** exige que cada implementação diga qual tecnologia realiza cada conceito. Isso faz do documento uma ponte: ao ler uma regra no broker-docs, você sabe onde ela vive no código.

**Estrutura:** tabelas por área (plataforma, mensageria, dados, segurança, observabilidade, testes/CI), cada linha com o conceito, a tecnologia e a decisão do design que justifica (D1–D22). Por exemplo:

- barramento → RabbitMQ 4 com super streams (D6);
- registro de esquemas → `contracts/` com TypeBox → JSON Schema/AsyncAPI (D8);
- cofre → Docker secrets (D18).

A seção **"Conflitos e simplificações"** registra onde a implementação simplifica algo em relação ao ideal, por exemplo Docker secrets no lugar de um cofre real, ou uma instância Postgres para todos os serviços. Isso evita que a simplificação seja confundida com a regra.

**Regra para o futuro:** cada serviço novo acrescenta ali as tecnologias que usar.

---

## Fluxo do OpenSpec

O OpenSpec controla o progresso:

- `openspec instructions apply` devolve a lista de tarefas com arquivo e linha;
- ao terminar cada tarefa, `- [ ]` vira `- [x]` em `tasks.md`;
- o CLI é consultado de novo para confirmar o progresso (4/185 ao fim do grupo 1).

---

## Problemas no caminho

1. **Um comando travou:** um `cat >` solto ficou esperando entrada do teclado. O processo foi encerrado e a verificação refeita.
2. **O `.gitignore` foi alterado sem querer:** `dist` e `.turbo` foram acrescentados (mas já existiam), e ao remover a duplicata a linha `broker-docs` também saiu. O sinal foi o `broker-docs` aparecer como untracked no `git status`. O arquivo original foi restaurado com `git checkout`.
3. **Build script bloqueado:** o pnpm 12 bloqueia scripts de instalação por segurança (ataques à cadeia de suprimentos). O `unrs-resolver` pediu um script, mas já vem compilado, então foi desligado com `allowBuilds: unrs-resolver: false` no `pnpm-workspace.yaml`.

---

## Para experimentar

Ver a regra de determinismo pegando um erro: crie `apps/teste/src/domain/x.ts` com `export const t = Date.now();` e rode:

```bash
pnpm lint
```

Rodar os testes:

```bash
pnpm test
```

Ver o Turbo sem nada para compilar (enquanto não houver pacotes com `build`):

```bash
pnpm turbo run build
```

O próximo grupo (2) sobe infraestrutura real em Docker: Postgres, RabbitMQ, Valkey, MinIO e Traefik.
