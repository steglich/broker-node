# Spec Delta

## Purpose

Gera os documentos do cliente e os relatórios do backoffice em PDF, CSV e JSON, de forma síncrona ou por jobs assíncronos, com marca de simulação, hash de integridade, versões imutáveis, links assinados e retenção.

## ADDED Requirements

### Requirement: Marca de simulação e integridade
Todo documento SHALL ter "SIMULADO — SEM VALOR LEGAL" no cabeçalho e no rodapé de todas as páginas, um `document_id` único e o hash SHA-256 do conteúdo impresso no rodapé (RN-REL-001, P-10).

#### Scenario: Nota em PDF
- **WHEN** a nota de corretagem é gerada em PDF
- **THEN** cada página traz a marca de simulação, o `document_id` e o hash

### Requirement: Documentos imutáveis e versões
Documentos periódicos (nota, apuração, informe) SHALL ser imutáveis; uma correção SHALL gerar nova versão com `supersedes_document_id` e marcar a anterior como substituída (RN-REL-002).

#### Scenario: Nota retificada
- **WHEN** uma nota `CORRECTION` é gerada
- **THEN** o novo documento aponta para o anterior, que fica marcado como substituído

### Requirement: Jobs assíncronos
Pedidos assíncronos SHALL criar `report_job` (`QUEUED`, `RUNNING`, `READY`, `FAILED`), notificar o cliente ao concluir e entregar por link temporário e assinado (15 min) só ao próprio usuário autenticado, publicando `report.ready` ou `report.failed` (RN-REL-003).

#### Scenario: Extrato longo
- **WHEN** o cliente pede extrato de 12 meses
- **THEN** recebe o id do job, e ao ficar `READY` recebe notificação com link válido por 15 minutos

#### Scenario: Link de outro usuário
- **WHEN** outro usuário tenta abrir o link
- **THEN** o download é recusado

### Requirement: Limites de pedido
Pedidos SHALL ter período máximo de 5 anos e no máximo 5 jobs simultâneos por cliente, além do limite de 10 relatórios por hora na borda (RN-REL-004, RN-API §6).

#### Scenario: Sexto job
- **WHEN** o cliente pede um sexto relatório com cinco em andamento
- **THEN** o pedido é recusado

### Requirement: Formato CSV
CSVs SHALL ser UTF-8 com BOM, separador `;`, decimal com vírgula e datas `dd/mm/aaaa`, com variante técnica via API (separador `,`, ponto decimal e ISO 8601) (RN-REL-005).

#### Scenario: Variante técnica
- **WHEN** a API pede o extrato no formato técnico
- **THEN** o CSV usa vírgula como separador e datas ISO 8601

### Requirement: Catálogo de documentos do cliente
O serviço SHALL gerar nota de corretagem, extratos financeiro e de custódia, posição consolidada, histórico de ordens, rentabilidade, proventos, apuração mensal, DARF, informe de rendimentos, relatório auxiliar do IRPF, comprovantes, contratos de aluguel e termos aceitos, com a periodicidade e o modo de geração definidos (Relatórios §2).

#### Scenario: Comprovante de saque
- **WHEN** um saque é concluído e o cliente pede o comprovante
- **THEN** recebe de forma síncrona um PDF com IDs, data e hora da operação

### Requirement: Read models próprios
Relatórios entre serviços SHALL ser montados a partir de read models alimentados por eventos, nunca por consulta direta a bancos de outros serviços (RN-DB-003, RN-PAD-040).

#### Scenario: Extrato de custódia
- **WHEN** o relatório de custódia é gerado
- **THEN** os dados vêm do read model do serviço de relatórios

### Requirement: Mascaramento e retenção
Os documentos SHALL seguir o mascaramento de dados pessoais (CPF completo só em documentos fiscais do titular), e a retenção SHALL ser de 5 anos após o fim do ano-calendário para documentos fiscais e notas, e de 7 dias para arquivos de extratos sob demanda (RN-REL-006, RN-REL-007).

#### Scenario: Arquivo vencido
- **WHEN** um extrato sob demanda completa 7 dias
- **THEN** o arquivo é apagado e pode ser gerado de novo

### Requirement: Relatórios do backoffice
O serviço SHALL gerar os relatórios de reconciliação diária, movimento financeiro, negociação, risco, FMS, uso da brapi, cadastro e auditoria (Relatórios §4).

#### Scenario: Reconciliação diária
- **WHEN** a rotina de reconciliação termina
- **THEN** o relatório traz o resultado de INV-01 a INV-04 com as diferenças encontradas
