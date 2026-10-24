# broker-node

Implementação base, em **Node.js + TypeScript**, de um **Home Broker simulado** do mercado à vista da B3 (ações, units, FIIs, ETFs e BDRs), feita para estudo. As regras de negócio vêm de [`broker-docs`](broker-docs/README.md), uma especificação agnóstica de tecnologia; este repositório é uma das implementações dela.

> **Simulação**: nenhum dinheiro real, nenhuma conexão com a B3 ou com bancos. Todo documento gerado pelo sistema leva a marca "SIMULADO — SEM VALOR LEGAL".

> **Status**: Fase 0 (fundações) concluída: monorepo, infraestrutura em Docker, bibliotecas de plataforma, mensageria, simuladores PIX/KYC/SMS e CI. O plano completo está em [`openspec/changes/implementation-roadmap`](openspec/changes/implementation-roadmap/).

**Para rodar localmente, comece por [`docs/primeiros-passos.md`](docs/primeiros-passos.md).**

## O que será construído

Uma corretora fictícia com arquitetura de **microsserviços orientados a eventos**, cobrindo todo o backend:

- **Conta e acesso**: cadastro, KYC simulado, suitability, login com MFA e assinatura eletrônica.
- **Dinheiro**: ledger de partidas dobradas, depósito e saque via PIX simulado, liquidação D+2.
- **Mercado**: cotações da [brapi](https://brapi.dev) (plano gratuito, com controle de cota), preço de referência com micro-variações, candles e book.
- **Negociação**: OMS com ordens a mercado, limitadas, stop, trailing, OCO e bracket; motor de matching determinístico com leilões; formador de mercado simulado para garantir liquidez.
- **Risco**: poder de compra, day trade, margem, venda a descoberto, chamada de margem e zeragem compulsória.
- **Pós-negociação**: nota de corretagem, custos B3 parametrizáveis, custódia, preço médio, rentabilidade, aluguel de ativos (BTC), proventos e eventos corporativos.
- **Imposto de renda**: apuração mensal, compensação de prejuízos, DARF simulado e relatório anual.
- **Suporte**: notificações, alertas de preço, watchlists, relatórios em PDF/CSV, backoffice com dupla aprovação e auditoria encadeada por hash.
- **Borda**: API Gateway, BFFs por canal e gateway de tempo real (WebSocket).

O **frontend** (web, mobile, desktop e UI do backoffice) não faz parte deste repositório.

## Stack

| Camada              | Tecnologia                                                             |
| ------------------- | ---------------------------------------------------------------------- |
| Linguagem / runtime | TypeScript (strict) em Node.js 24                                      |
| HTTP                | Express 5                                                              |
| Banco               | PostgreSQL 17 (um database e um usuário por serviço)                   |
| Mensageria          | RabbitMQ 4 (super streams para eventos, quorum queues para jobs e DLQ) |
| Cache               | Valkey                                                                 |
| Storage de objetos  | MinIO                                                                  |
| E-mail de teste     | Mailpit                                                                |
| Observabilidade     | OpenTelemetry + Grafana (Tempo, Loki, Prometheus)                      |
| Borda TLS           | Traefik                                                                |
| Monorepo            | pnpm workspaces + Turborepo                                            |
| Testes              | Vitest, fast-check, Testcontainers, k6                                 |

Toda a infraestrutura roda em **Docker**. Detalhes e justificativas em [`design.md`](openspec/changes/implementation-roadmap/design.md).

## Roadmap

| Fase | Entrega                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Fundações: monorepo, Docker, bibliotecas compartilhadas, mensageria, simuladores PIX/KYC/e-mail, CI                                    |
| 1    | Conta, dinheiro e preços: identidade, onboarding, ledger, dados de referência, market data, agendador, notificações, gateway e BFF web |
| 2    | Negociação básica: sessão, motor de matching, formador de mercado, risco à vista, OMS, tempo real                                      |
| 3    | Pós-negociação e carteira: clearing, custódia, alertas, relatórios, aprovações e BFF backoffice                                        |
| 4    | Ordens avançadas, proventos e IR                                                                                                       |
| 5    | Alavancagem, venda a descoberto e aluguel (BTC)                                                                                        |
| 6    | Backend dos canais mobile e desktop                                                                                                    |
| 7    | Endurecimento: sandbox, replay, LGPD, carga, caos e segurança                                                                          |

Tarefas detalhadas em [`tasks.md`](openspec/changes/implementation-roadmap/tasks.md).

## Estrutura

```
apps/        um diretório por microsserviço, simulador, gateway e BFF
packages/    bibliotecas compartilhadas (domínio, relógio, calendário, mensageria, persistência, testes)
contracts/   esquemas de eventos (AsyncAPI) e APIs (OpenAPI) versionados
scenarios/   cenários golden master independentes de tecnologia
infra/       Docker Compose, Dockerfile, configuração de infraestrutura
docs/        mapeamento tecnológico, primeiros passos, ADRs
```

## Como contribuir com o plano

O projeto usa [OpenSpec](https://github.com/Fission-AI/OpenSpec) para planejar mudanças. Cada fase vira uma change própria antes de ser implementada.

```bash
openspec list
```

## Licença

Distribuído sob a [GNU Affero General Public License v3.0](LICENSE).
