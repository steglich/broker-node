# Spec Delta

## Purpose

Entrega aos canais, por conexão persistente, cotações, book, negócios, estado de ordens, saldos, posições, risco e notificações em tempo real, com snapshots, sequência, conflação e autorização por assinatura.

## ADDED Requirements

### Requirement: Autenticação da conexão
A conexão SHALL ser autenticada pela primeira mensagem `auth` com o access token, nunca pela URL. Sem `auth` válido em 5 s, a conexão SHALL ser fechada (RN-RT-001, RN-RT-002).

#### Scenario: Conexão sem auth
- **WHEN** o cliente abre a conexão e não envia `auth` em 5 s
- **THEN** o servidor encerra a conexão

### Requirement: Renovação do token
O servidor SHALL enviar `auth_expiring` 60 s antes da expiração do token e SHALL encerrar com `AUTH_EXPIRED` se o cliente não renovar (RN-RT-003).

#### Scenario: Token não renovado
- **WHEN** o token expira sem novo `auth`
- **THEN** a conexão é encerrada com o código `AUTH_EXPIRED`

### Requirement: Heartbeat
O servidor SHALL enviar `ping` a cada 15 s e encerrar a conexão sem `pong` em 45 s (RN-RT-004).

#### Scenario: Cliente sem resposta
- **WHEN** o cliente não responde a nenhum `ping` por 45 s
- **THEN** a conexão é encerrada

### Requirement: Envelope com sequência por chave
Toda mensagem SHALL usar o envelope `type`, `channel`, `key`, `seq`, `snapshot`, `ts`, `data`, com `seq` contínuo por (canal, chave). Uma lacuna SHALL ser resolvida por `resync` com novo snapshot (RN-RT §3, RN-RT-010).

#### Scenario: Lacuna de sequência
- **WHEN** o cliente recebe `seq` 10 e depois 12 numa chave
- **THEN** ele pede `resync` e recebe um snapshot com `snapshot = true`

### Requirement: Snapshots na assinatura
Ao assinar uma chave, o cliente SHALL receber imediatamente o snapshot do último estado, servido de cache do gateway, sem consulta aos serviços (RN-RT-005, RN-RT-030).

#### Scenario: Assinatura de cotação
- **WHEN** o cliente assina `quotes:PETR4`
- **THEN** recebe primeiro o snapshot da cotação e depois as atualizações

### Requirement: Autorização por canal
Canais privados (`orders`, `fills`, `balances`, `positions`, `risk`, `notifications`, `alerts`) SHALL usar a chave derivada do token (`key = "me"`), e o cliente SHALL NOT informar a conta. `book_l3` SHALL ser exclusivo do canal desktop e `bo_ops` dos papéis de backoffice (RN-RT §4, RN-RT-020).

#### Scenario: Assinatura de conta alheia
- **WHEN** o cliente tenta assinar `orders` com a conta de outra pessoa
- **THEN** recebe `error` e a assinatura não é criada

#### Scenario: book_l3 no canal web
- **WHEN** um cliente do canal web assina `book_l3`
- **THEN** recebe `error` de autorização

### Requirement: Conflação em canais de mercado
Canais de mercado SHALL priorizar atualidade com conflação e throttle (quotes e book até 4 msg/s por chave, trades em lote a cada 250 ms, candles 1 msg/s, leilão 1 msg/s, book_l3 10 msg/s). Canais privados `orders` e `fills` SHALL entregar todas as transições, em ordem (RN-RT §4, RN-RT-021).

#### Scenario: Rajada de cotações
- **WHEN** chegam 20 atualizações de `PETR4` em 1 s
- **THEN** o cliente recebe no máximo 4 mensagens, a última com o estado mais recente

#### Scenario: Transições de ordem
- **WHEN** uma ordem passa por `NEW`, `PARTIALLY_FILLED` e `FILLED` em 100 ms
- **THEN** o cliente recebe as três transições, em ordem

### Requirement: Backpressure
Com o buffer de uma conexão cheio, o gateway SHALL descartar mensagens de mercado em favor do estado mais recente e, nos canais privados, SHALL enviar `resync_required` (RN-RT-032).

#### Scenario: Cliente lento em canal privado
- **WHEN** o buffer da conexão enche com mensagens de `orders`
- **THEN** o cliente recebe `resync_required` e recarrega o estado por HTTP

### Requirement: Limites por conexão
O gateway SHALL limitar a 200 assinaturas por conexão e 3 conexões simultâneas por usuário por canal (RN-RT-006).

#### Scenario: Quarta conexão
- **WHEN** o mesmo usuário abre a quarta conexão no canal web
- **THEN** a conexão é recusada com erro de limite

### Requirement: Encerramento por bloqueio
Quando a conta passa para `BLOCKED`, as conexões de tempo real do usuário SHALL ser encerradas (RN-AUTH-014).

#### Scenario: Conta bloqueada
- **WHEN** o gateway recebe `account.status_changed` para `BLOCKED`
- **THEN** as conexões daquele usuário são encerradas

### Requirement: Métricas do tempo real
O gateway SHALL publicar conexões ativas, assinaturas por canal, mensagens por segundo, latência barramento→cliente (p50/p99), descartes por conflação e reconexões (RN-RT-033).

#### Scenario: Consulta de métricas
- **WHEN** a métrica de latência é consultada durante carga
- **THEN** ela mostra p50 e p99 da entrega barramento→cliente
