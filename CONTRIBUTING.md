# Contribuindo

## Commits (RN-CICD-021)

[Conventional Commits](https://www.conventionalcommits.org/pt-br/), em português:

```
<tipo>(<escopo>): <descrição no imperativo, sem ponto final>

<corpo opcional, depois de uma linha em branco>

BREAKING CHANGE: <o que quebra, se quebrar>
```

| Tipo                                                        | Quando                    | Versão do pacote           |
| ----------------------------------------------------------- | ------------------------- | -------------------------- |
| `feat`                                                      | funcionalidade nova       | minor                      |
| `fix`                                                       | correção                  | patch                      |
| `perf`                                                      | desempenho                | patch                      |
| `revert`                                                    | reversão                  | patch                      |
| `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style` | o resto                   | nenhuma                    |
| `!` ou `BREAKING CHANGE:`                                   | quebra de compatibilidade | major (minor antes da 1.0) |

O **escopo** é o nome curto do pacote (`pix-simulator`, `service-kit`, `contracts`…), vários separados
por vírgula, ou um destes: `infra`, `ci`, `deps`, `docs`, `estudos`, `openspec`, `repo`, `release`.

Exemplos: `feat(pix-simulator): adiciona devolução parcial`, `fix(service-kit,webhooks): corrige o timeout`.

O hook `commit-msg` (ativado pelo `pnpm install`) recusa mensagens fora da convenção, e o CI confere
os commits de cada PR (`pnpm commitlint --from <base>`).

## Versões e changelog (RN-CICD-020/021)

Cada pacote tem a própria versão semântica, no `package.json`, que o `/info` do serviço expõe junto
com o commit da imagem.

```bash
pnpm release            # plano: quais pacotes sobem e para qual versão
pnpm release --apply    # grava versões e CHANGELOG.md, commita e cria as tags <pacote>@<versão>
git push --follow-tags
```

Entram no changelog de um pacote os commits que tocam a pasta dele desde a última tag.

## Pipeline (RN-CICD §2)

O `.github/workflows/ci.yml` roda, só para o que a mudança afeta (Turborepo): formatação, lint,
typecheck e convenção de commits; testes unitários com cobertura (≥ 80% no domínio), de integração e
de componente (Testcontainers); contratos e compatibilidade de esquemas; golden master; Semgrep,
osv-scanner e gitleaks; e imagem com SBOM (syft) e assinatura keyless (cosign). Para rodar a mesma
coisa na máquina antes de abrir o PR:

```bash
pnpm ci:local            # contra a main; SKIP_IMAGES=1 pula o build das imagens
```
