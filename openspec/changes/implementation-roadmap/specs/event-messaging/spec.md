# Spec Delta

## Purpose

Define como os serviços publicam e consomem eventos e comandos de forma confiável: envelope padrão, outbox transacional, inbox idempotente, ordenação por chave de partição, retentativas, DLQ com bloqueio por chave e esquemas versionados.

## ADDED Requirements

### Requirement: Envelope padrão
Toda mensagem SHALL usar o envelope padrão com `eventId` (UUID v7), `eventType`, `eventVersion`, `source`, `environment`, `occurredAt` (tempo do relógio do ambiente), `publishedAt`, `partitionKey`, `correlationId`, `causationId`, `actor`, `traceparent`, `auditable` e `payload` (RN-MSG-B §4, RN-MSG-B-010, RN-MSG-B-011).

#### Scenario: Mensagem sem campo obrigatório
- **WHEN** um consumidor recebe uma mensagem sem `eventId`
- **THEN** a mensagem vai direto para a DLQ como erro permanente

#### Scenario: Rastreabilidade de causa
- **WHEN** um consumidor publica um evento em reação a outro
- **THEN** o `causationId` do novo evento é o `eventId` do evento de origem e o `correlationId` é preservado (INV-07)

### Requirement: Payload sem dados pessoais
Payloads SHALL NOT carregar CPF, endereço ou documentos, só IDs, e SHALL ter no máximo 256 KB; conteúdos maiores vão para o storage e o evento leva a referência (RN-MSG-B-013, RN-MSG-B-014).

#### Scenario: Payload acima do limite
- **WHEN** um produtor tenta publicar um payload de 300 KB
- **THEN** a publicação falha no produtor antes de chegar ao barramento

### Requirement: Outbox transacional
Todo evento de domínio SHALL ser gravado na tabela de outbox na mesma transação que altera o estado e publicado por um relay; publicar fora da transação (dual write) é proibido. O Motor é a única exceção e publica a partir das suas saídas sequenciadas duráveis (ADR-0008, RN-PAD-020, RN-MSG-B-040).

#### Scenario: Falha após o commit
- **WHEN** o processo cai depois do commit e antes da publicação
- **THEN** o relay publica o evento ao reiniciar e nenhum evento é perdido

#### Scenario: Rollback
- **WHEN** a transação do caso de uso é revertida
- **THEN** nenhum evento daquela transação é publicado

### Requirement: Ordem de publicação por chave
O relay SHALL publicar respeitando a ordem de inserção por chave de partição, e o barramento SHALL entregar as mensagens de uma mesma chave na ordem em que foram publicadas (RN-PAD-022, RN-MSG-B-032).

#### Scenario: Eventos da mesma conta
- **WHEN** o ledger publica três eventos para a mesma `account_id`
- **THEN** o consumidor os processa exatamente nessa ordem

### Requirement: Consumo idempotente com inbox
Todo consumidor SHALL registrar o `eventId` processado na inbox, na mesma transação do efeito, e SHALL ignorar eventos já processados. A confirmação ao barramento SHALL ocorrer só depois de persistir o efeito (RN-MSG-B-030, RN-MSG-B-031, RN-PAD-021).

#### Scenario: Evento duplicado
- **WHEN** o relay publica duas vezes o mesmo evento
- **THEN** o consumidor aplica o efeito uma única vez

#### Scenario: Relay morto entre publicar e marcar (ADR-0008)
- **WHEN** o relay é interrompido depois de publicar e antes de marcar o evento como publicado
- **THEN** a republicação não gera efeito duplicado em nenhum consumidor

### Requirement: Tópicos particionados com releitura
O barramento SHALL oferecer tópicos com partições ordenadas por chave, retenção configurável, releitura a partir de offset ou instante e grupos de consumidores com balanceamento de partições. Os tópicos seguem `<ambiente>.<contexto>.<tipo>` e a tabela de referência de chaves e retenções (RN-MSG-B §1, RN-MSG-B-001, RN-MSG-B-002).

#### Scenario: Reconstrução de projeção
- **WHEN** um read model é apagado e o consumidor é reiniciado do offset inicial
- **THEN** o read model é reconstruído com o mesmo estado (RN-PAD-041)

#### Scenario: Nomenclatura
- **WHEN** o ambiente `sandbox` cria o tópico de eventos do ledger
- **THEN** o nome é `sandbox.ledger.events`

### Requirement: Rejeição de outro ambiente
Consumidores SHALL rejeitar e enviar para a DLQ mensagens com `environment` diferente do seu (RN-MSG-B-012, RN-PAD-080).

#### Scenario: Evento do sandbox em prod
- **WHEN** um consumidor de `prod` recebe uma mensagem com `environment = sandbox`
- **THEN** a mensagem vai para a DLQ sem efeito

### Requirement: Retentativas com backoff
Erros transitórios SHALL ter até 5 tentativas locais com backoff (100 ms a 5 s), depois retentativa atrasada (1 min, 10 min, 1 h) e depois DLQ. Erros permanentes (validação, esquema) SHALL ir direto para a DLQ (RN-MSG-B-033, RN-MSG-B-034).

#### Scenario: Banco indisponível no consumidor
- **WHEN** o efeito falha por indisponibilidade transitória do banco
- **THEN** o consumidor tenta de novo com backoff e só envia para a DLQ depois de esgotar as tentativas atrasadas

### Requirement: Bloqueio por chave em fluxos ordenados
Nos fluxos em que a ordem importa (ledger, custódia, ordens, Motor), uma mensagem enviada para a DLQ SHALL bloquear a sua chave, de modo que as próximas mensagens da mesma chave aguardem, e SHALL gerar alerta crítico. Nos fluxos sem dependência de ordem, a DLQ SHALL NOT bloquear (RN-MSG-B-035).

#### Scenario: Chave bloqueada
- **WHEN** um evento da conta A vai para a DLQ no consumidor de custódia
- **THEN** os eventos seguintes da conta A ficam retidos e os de outras contas continuam sendo processados

#### Scenario: Fluxo de notificações
- **WHEN** um evento de notificação vai para a DLQ
- **THEN** os eventos seguintes do mesmo usuário continuam sendo processados

### Requirement: Ferramenta de DLQ
O sistema SHALL oferecer operações para listar, inspecionar, corrigir/reprocessar e descartar mensagens da DLQ, com justificativa obrigatória e registro de auditoria no descarte (RN-MSG-B-036).

#### Scenario: Reprocessamento desbloqueia a chave
- **WHEN** um operador reprocessa com sucesso a mensagem que bloqueava a chave
- **THEN** as mensagens retidas daquela chave são processadas em ordem

### Requirement: Esquemas versionados
Todo `eventType` SHALL ter esquema versionado num registro compartilhado. Mudanças compatíveis mantêm a versão; mudanças incompatíveis criam `eventVersion + 1` e o produtor publica as duas versões por pelo menos 30 dias. Consumidores SHALL ignorar campos desconhecidos (RN-MSG-B-020..023, RN-BE-081).

#### Scenario: Quebra de compatibilidade no pipeline
- **WHEN** uma mudança remove um campo obrigatório de um esquema sem subir a versão
- **THEN** a verificação de compatibilidade do pipeline falha

#### Scenario: Campo desconhecido
- **WHEN** um consumidor recebe um evento com um campo opcional novo
- **THEN** o evento é processado normalmente

### Requirement: Comandos assíncronos com destinatário único
Comandos assíncronos (por exemplo `engine.commands`) SHALL ter exatamente um serviço consumidor, o dono, e SHALL ser particionados pela chave que garante a ordem do destinatário (RN-MSG-B §2, RN-PAD-050).

#### Scenario: Comandos do Motor
- **WHEN** OMS, FMS e Sessão enviam comandos para o mesmo instrumento
- **THEN** o Motor os recebe numa única sequência ordenada por instrumento

### Requirement: Filas de jobs
Trabalhos assíncronos (por exemplo geração de relatórios) SHALL usar filas de trabalho com entrega pelo menos uma vez, distribuição entre workers e DLQ (RN-MSG-B §1 nota, §2 Job).

#### Scenario: Worker cai no meio do job
- **WHEN** um worker morre processando um job sem confirmar
- **THEN** o job é reentregue a outro worker
