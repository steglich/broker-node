# Fase 0, grupo 9 — Pipeline de CI

> Tarefas 9.1 a 9.3 de `openspec/changes/implementation-roadmap/tasks.md`. Design: D21. Regras: `broker-docs/docs/08-infraestrutura/02-ci-cd-e-implantacao.md` (RN-CICD §2, RN-CICD-020/021).

## Visão geral

O pipeline é o "portão" de todo PR: só faz merge o que passa em formatação, lint, tipos, testes, contratos, segurança e build do artefato (RN-CICD §2). O grupo 9 monta esse portão no GitHub Actions e acrescenta a convenção de commits que alimenta o versionamento por serviço.

Uma decisão guiou tudo: **o workflow não tem lógica própria**. Cada etapa chama um comando que também roda na máquina:

| Job do CI   | Comando                                                                               | Tarefa   |
| ----------- | ------------------------------------------------------------------------------------- | -------- |
| `quality`   | `pnpm format:check`, `pnpm lint`, `turbo run typecheck --affected`, `pnpm commitlint` | 9.1, 9.3 |
| `test`      | `turbo run test --affected -- --coverage`                                             | 9.1      |
| `contracts` | `pnpm contracts:check --base <base>`, `pnpm scenarios`                                | 9.1      |
| `security`  | `infra/ci/security.sh sast \| sca \| secrets`                                         | 9.2      |
| `image`     | `infra/ci/image.sh <serviço>` (matriz dos serviços afetados)                          | 9.2      |

E `pnpm ci:local` (`infra/ci/local.sh`) roda os cinco jobs na mesma ordem, contra uma base. Assim "passou na minha máquina" e "passou no CI" significam a mesma coisa. Também dá para depurar o pipeline sem fazer push, e foi assim que as verificações deste grupo foram feitas (veja o fim do arquivo).

## 9.1 — Turborepo "afetados"

Num monorepo com ~20 pacotes, rodar tudo em todo PR fica caro rápido. O Turborepo sabe o grafo de dependências do workspace, e `--affected` roda a tarefa só nos pacotes que mudaram **e nos que dependem deles**:

```
mudou packages/service-kit  →  afetados: service-kit, webhooks, simulator-kit,
                                          pix-simulator, kyc-simulator, message-sink, example-service
mudou apps/pix-simulator    →  afetado: pix-simulator
mudou docs/                 →  nenhum pacote (só segurança roda)
```

A "mudança" é a diferença entre `TURBO_SCM_BASE` e `TURBO_SCM_HEAD`. O workflow usa a base do PR em `pull_request` e o commit anterior (`github.event.before`) em `push` na main. Sem isso, num push para a main, a base seria a própria main e nada seria afetado. O `checkout` usa `fetch-depth: 0`, porque o turbo precisa do histórico para comparar.

### Testes por pacote

Para o turbo escolher o que rodar, cada pacote ganhou `"test": "vitest run"`, com a configuração do próprio pacote. O `pnpm test` da raiz continua existindo e roda tudo de uma vez.

A cobertura por pacote vem de `vitest.shared.ts`:

- `domain-kernel` e `calendar` são só domínio: 80% de linhas, funções, ramos e instruções no pacote inteiro;
- nos demais, o mesmo limite vale para qualquer pasta `domain/`, que é onde os serviços da Fase 1 em diante vão pôr as regras.

Para garantir que o limite reprova de verdade, subi o mínimo temporariamente para 100% no `domain-kernel`: o `vitest run --coverage` saiu com código 1 (`Coverage for lines (99.53%) does not meet global threshold (100%)`).

Um detalhe do Vitest: o `defineProject` não aceita `coverage` no tipo, porque num workspace a cobertura é global. Como cada pacote agora também roda sozinho, as configs passaram a usar `defineConfig`. Quando roda pela raiz, a raiz ignora a cobertura dos projetos.

### Integração no runner

Os testes de integração e de componente usam Testcontainers, então o runner do GitHub (que tem Docker) sobe Postgres, RabbitMQ, Valkey, MinIO e Mailpit sozinho, sem `services:` no workflow. O teste é o mesmo nos dois ambientes.

As `inputs` da tarefa `test` no `turbo.json` incluem `infra/postgres/**`, `infra/rabbitmq/**` e o `compose.yml`. Os contêineres de teste usam esses arquivos (o script de init do Postgres, a configuração do RabbitMQ, o bloco do Mailpit), então mexer neles invalida o cache dos testes.

## 9.2 — Segurança e artefato

### As três varreduras

| Ferramenta      | O quê                                                        | Bloqueia                                     |
| --------------- | ------------------------------------------------------------ | -------------------------------------------- |
| **Semgrep**     | SAST: padrões perigosos no código                            | achado `ERROR`                               |
| **osv-scanner** | SCA: vulnerabilidades conhecidas nas dependências (lockfile) | CVSS ≥ 7 (alta/crítica); abaixo disso, aviso |
| **gitleaks**    | segredos commitados                                          | qualquer achado                              |

Todas rodam pela **imagem Docker oficial**, com a versão fixada em `infra/ci/tools.env`. Nada precisa estar instalado na máquina, e o CI usa exatamente a mesma versão.

**Semgrep** usa os conjuntos `p/typescript`, `p/nodejs`, `p/expressjs` e `p/secrets`, mais regras próprias em `.semgrep/broker.yml`, que conhecem o projeto:

- `sql.raw()` com valor dinâmico (Kysely sem parâmetro = injeção);
- `client.query(\`...${x}...\`)`;
- `rejectUnauthorized: false`;
- comparação de assinatura com `===` (o motivo do `timingSafeEqual` do grupo 8).

As regras próprias têm teste: `.semgrep/broker.ts` traz casos anotados com `// ruleid:` e `// ok:`, e o `semgrep --test` roda antes da varredura. Uma regra que deixa de pegar o caso dela reprova o pipeline.

**osv-scanner** sai com erro diante de qualquer vulnerabilidade. Como a regra é "bloqueia em críticas/altas", o `infra/ci/osv-gate.mjs` lê o JSON e só reprova CVSS ≥ 7, mostrando o resto como aviso (`::warning::` no GitHub).

**gitleaks** varre só os commits da mudança (`base..HEAD`) no PR, para não reprovar um PR por algo antigo. Sem base, varre o histórico inteiro.

### O que a primeira varredura achou

O osv-scanner encontrou vulnerabilidades reais nas dependências atuais:

| Pacote                            | Problema                                     | CVSS  | Correção                                |
| --------------------------------- | -------------------------------------------- | ----- | --------------------------------------- |
| `body-parser` 2.3.0 (via Express) | DoS com bytes após o JSON                    | 7.5   | atualizado para 2.4.0 (dentro da faixa) |
| `undici` 8.11.2                   | DoS por memória ilimitada / erro não tratado | 7.5   | 8.12.2                                  |
| `fast-uri` 3.1.8 (via Ajv)        | confusão de esquema/host em URIs             | ≤ 6.1 | 3.1.9                                   |

O `undici` 8.11.2 vinha fixo de dentro do `testcontainers`, então `pnpm update` não bastava. A correção foi um `overrides` no `pnpm-workspace.yaml`, com comentário dizendo de onde vem e quando remover. Essa é a vantagem de ter o SCA no portão: a vulnerabilidade aparece no dia em que entra, e não numa auditoria meses depois.

### Imagem, SBOM e assinatura

`infra/ci/image.sh <serviço>` produz o artefato:

1. **build** com o Dockerfile único, gravando versão e commit (veja 9.3);
2. **SBOM** com o syft, em SPDX: a lista de tudo o que está dentro da imagem (447 pacotes no `example-service`). Quando sair uma CVE nova, dá para saber em quais imagens ela está sem reconstruir nada;
3. **push** para o registry;
4. **assinatura** com o cosign, sobre o **digest** (`sha256:…`), não sobre a tag, que é mutável, e um **atestado** com o SBOM anexado à imagem;
5. **verificação** da assinatura e do atestado logo em seguida.

No GitHub, a assinatura é **keyless** (Sigstore). Não existe chave privada guardada: o cosign troca o token OIDC do job por um certificado de vida curta que diz "isto foi assinado pelo workflow de `steglich/broker-node`". A verificação confere essa identidade (`--certificate-identity-regexp`) e o emissor (`token.actions.githubusercontent.com`). Para isso o job pede `id-token: write`. Num PR vindo de fork não há token nem permissão de escrita no GHCR, então só o build e o SBOM rodam.

Localmente não existe identidade OIDC, então o modo `SIGN=key` usa um par de chaves descartável e um registry local (`registry:2`). Um tropeço aqui: no cosign v3, a assinatura com chave **também** é publicada por padrão no log público de transparência (Rekor). A primeira rodada de teste publicou duas entradas lá, com o digest de uma imagem de teste e a chave pública descartável; nenhum dado sensível. O modo `key` passou a usar `--use-signing-config=false --tlog-upload=false`, para o teste local ficar local. No modo keyless, a publicação no Rekor faz parte do mecanismo e continua.

## 9.3 — Commits, changelog e versão

### Conventional Commits

```
feat(pix-simulator): adiciona devolução parcial
fix(service-kit,webhooks)!: troca o header de assinatura
```

O tipo diz o efeito na versão (`feat` → minor, `fix` → patch, `!` → major). O escopo é o nome curto do pacote. A gramática está num lugar só, `infra/ci/conventional.mjs`, usada por:

- `infra/ci/commitlint.mjs`, no hook `commit-msg` (`.githooks/`, ativado pelo `prepare` do `pnpm install` via `core.hooksPath`) e no CI, para os commits do PR;
- `infra/ci/release.mjs`, para versão e changelog.

Como as duas ferramentas usam a mesma gramática, toda mensagem que passa no verificador é interpretada pelo changelog. Não usei o commitlint do npm: seriam duas gramáticas (a dele e a do gerador de changelog) que poderiam divergir.

### Semver por serviço

Cada pacote tem a sua linha de versões, com tags `<pacote>@<versão>` (ex.: `pix-simulator@0.2.0`). O `pnpm release`:

1. acha a última tag do pacote;
2. pega os commits que tocam a **pasta do pacote** desde a tag;
3. decide o incremento: quebra → major (minor antes da 1.0), `feat` → minor, `fix`/`perf` → patch, o resto → nenhum;
4. com `--apply`, grava o `package.json`, acrescenta a seção no `CHANGELOG.md` do pacote, commita (`chore(release): ...`) e cria as tags.

Os commits antigos ("Fase 0, grupo N: ...") não seguem a convenção e não geram versão. A primeira versão de cada pacote sai no primeiro `feat`/`fix` depois deste grupo.

Uma premissa a registrar: uma mudança em `packages/service-kit` sobe a versão do `service-kit`, mas não a do `pix-simulator`, que usa o kit. A imagem do `pix-simulator` muda, mas a versão não. É o **commit** no `/info` que diferencia as duas imagens. Propagar o incremento para os dependentes é possível, mas deixaria o changelog de cada serviço cheio de "dependência atualizada".

### `/info`: versão e commit

- **Versão**: o `SERVICE_VERSION` agora tem como padrão a versão do `package.json` do diretório atual. Na imagem, isso é `/app/package.json`, que o `pnpm deploy` copia. O `compose.yml` deixou de fixar `SERVICE_VERSION: 0.0.1`.
- **Commit**: o Dockerfile recebe `GIT_COMMIT` como build arg e o grava em `ENV GIT_COMMIT`. O `pnpm env:up` exporta o HEAD, com `-dirty` se houver mudança não commitada, e o `image.sh` passa o SHA.
- Os dois também viram rótulos OCI da imagem (`org.opencontainers.image.version` e `.revision`), visíveis com `docker inspect`.

```bash
$ curl https://example.broker.localhost/info
{"service":"example-service","version":"0.0.0","commit":"979b44c…-dirty","environment":"local",…}
```

## Verificação local, sem PR

A tarefa pede "um PR de teste passando e outro reprovado por lint" e "um segredo de teste commitado reprova o pipeline". A verificação foi feita **localmente**, por escolha do dono: nenhuma branch nem PR foi para o GitHub. Num clone descartável, a `main` recebeu este grupo num commit `ci:`, e o `pnpm ci:local main` rodou em três branches:

| Branch       | Mudança                                                       | Resultado                                                  |
| ------------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| `pr-ok`      | comentário em `apps/pix-simulator` (`docs(pix-simulator): …`) | ✓ os cinco jobs; testes e imagem **só** do `pix-simulator` |
| `pr-lint`    | variável não usada (`feat(pix-simulator): …`)                 | ✗ `quality`: `@typescript-eslint/no-unused-vars`           |
| `pr-segredo` | token `ghp_…` falso em `docs/teste-segredo.md`                | ✗ `security`: gitleaks `generic-api-key` (valor mascarado) |

Também no clone: o hook recusou `Fase 0, grupo 9: pipeline`, e o `pnpm release` na `pr-lint` planejou `pix-simulator: 0.0.0 → 0.1.0 (minor)`.

O workflow em si foi validado com o **actionlint** (sintaxe, expressões `${{ }}` e shellcheck dos `run:`), e os scripts passaram no shellcheck. O que **não** foi exercitado é a execução no GitHub. Lá, as partes que só existem no runner são o login no GHCR, o token OIDC e a assinatura keyless. Elas ficam para o primeiro PR real.

### O pipeline local pegou dois erros antes do GitHub

- O teste novo do `packageVersion` estava fora da formatação: `prettier --check` reprovou na primeira rodada.
- `pnpm contracts:check --base X` chega ao script como `-- --base X`, e o `parseArgs` tratava o `--` como argumento posicional. O job `contracts` falharia em todo PR. O `check.ts` agora ignora o separador.

## Mudanças fora das tarefas

- `README.md` da raiz reformatado (só o alinhamento das tabelas): estava fora do Prettier desde antes e reprovaria todo PR no `format:check`.
- `body-parser`, `fast-uri` e `undici` atualizados por causa do SCA, como descrito acima.
- `.gitignore` ganhou `.claude/worktrees/`, das sessões paralelas do Claude Code.
- `globalSetup` duplicado no `vitest.config.ts` do `messaging` removido.

## Para experimentar

```bash
pnpm ci:local                       # o pipeline inteiro contra a main
SKIP_IMAGES=1 pnpm ci:local         # sem build de imagem
infra/ci/security.sh sca            # só o osv-scanner
infra/ci/image.sh pix-simulator     # imagem + SBOM em out/sbom/pix-simulator.spdx.json
git commit -m "teste"               # o hook recusa; tente "chore: teste"
pnpm release                        # plano de versões
```
