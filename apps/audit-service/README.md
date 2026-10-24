# audit-service

Trilha de auditoria imutável e verificável (catálogo de serviços §20, Segurança de aplicação §3).

- **Captura** (RN-AUD-BO-001): consome os tópicos de `AUDIT_SOURCE_CONTEXTS` e grava todo evento
  `auditable` e todo `audit.*` dos BFFs. Os eventos `audit.*` trazem no payload `actorRoles`,
  `resourceType`, `resourceId`, `before`, `after`, `justification`, `approvalRequestId`, `ip` e
  `userAgent`. Nos outros eventos, o recurso é o agregado (`partitionKey`) e o `after` é o payload.
- **Mascaramento** (RN-AUD-003): dado pessoal e segredo em `before`/`after` viram `***`;
  `changed_fields` diz o que mudou, calculado antes de mascarar.
- **Append-only encadeado** (RN-AUD-001/004): `audit_record` tem `seq` contínuo e
  `hash = SHA-256(prev_hash || JSON canônico do registro)`. O `audit_app` não tem UPDATE/DELETE, e um
  gatilho recusa a mutação até para o dono da tabela.
- **Rotina diária** `audit_chain_verify` (23:30, dias de pregão): o agendador dispara, o serviço
  recalcula a cadeia inteira, confere a última âncora e grava o hash do último registro em
  `audit-anchors/<ambiente>/<data>.json` (MinIO com object lock COMPLIANCE e PUT condicional).
  Responde `routine.completed` ou `routine.failed` em `<ambiente>.audit.events`. Uma quebra gera o
  log `audit.critical_alert` (nível `fatal`, `severity: critical`).
- **Consulta** (RN-AUD-005): `GET /v1/audit-records?from&to&actorId&action&resourceType&resourceId`,
  só para `BO_AUDITOR` e `BO_ADMIN`. A própria consulta vira o registro `audit.records_queried`.

## Runbook

| Situação                              | O que fazer                                                                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit.critical_alert` `CHAIN_BROKEN` | Alguém mexeu direto no banco. `audit_verification.broken` diz o primeiro `seq` quebrado. Não corrija a linha: preserve o banco, compare com o backup e com as âncoras do bucket e abra um incidente. |
| `ANCHOR_MISMATCH`                     | A trilha não bate com a âncora imutável: ela foi regravada desde aquela data. Mesmo procedimento acima; a âncora do bucket é a referência.                                                           |
| Rotina `audit_chain_verify` `FAILED`  | Veja o motivo em `routine.failed`/`audit_verification`. Depois de tratar a causa, re-dispare pelo agendador (`POST .../retry`).                                                                      |
| Auditar um novo contexto              | Acrescente o contexto a `AUDIT_SOURCE_CONTEXTS`. O consumidor `audit.trail.<contexto>` começa do início do tópico (`first`); o `event_id` único evita duplicata.                                     |
