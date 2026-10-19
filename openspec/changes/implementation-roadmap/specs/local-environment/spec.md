# Spec Delta

## Purpose

Garante que toda a plataforma (infraestrutura, simuladores e microsserviços) suba localmente em contêineres com um único comando, com perfis, sementes e um ambiente sandbox isolado, para estudo e testes.

## ADDED Requirements

### Requirement: Subida com um comando
O ambiente local SHALL subir com um único comando todas as dependências de infraestrutura (banco PostgreSQL, barramento, chave-valor, storage de objetos, caixa de e-mail, observabilidade), os simuladores e um perfil de serviços, tudo em contêineres. Nenhuma dependência SHALL exigir instalação na máquina além do runtime de contêineres e das ferramentas de build (RN-ENV-030, RNF-091).

#### Scenario: Subida do perfil core
- **WHEN** o desenvolvedor executa o comando de subida com o perfil `core` numa máquina limpa
- **THEN** sobem a infraestrutura, os simuladores e os serviços identity, customer, ledger, reference-data, market-data, oms, risk, matching-engine, market-maker, trading-session, scheduler, api-gateway e BFFs
- **AND** todos ficam com `readiness` positivo sem passos manuais

#### Scenario: Subida do perfil full
- **WHEN** o desenvolvedor executa o comando de subida com o perfil `full`
- **THEN** todos os serviços do catálogo sobem, além do perfil `core`

#### Scenario: Subida só da infraestrutura
- **WHEN** o desenvolvedor executa o comando com o perfil `infra`
- **THEN** só as dependências de infraestrutura e os simuladores sobem, permitindo rodar serviços fora do contêiner

### Requirement: Isolamento de dados por serviço
O ambiente local SHALL criar, para cada serviço com banco, um database e uma credencial próprios, e uma credencial de migração separada. Um serviço SHALL NOT conseguir ler ou escrever no database de outro (RN-DB-001, RN-DB-032).

#### Scenario: Acesso cruzado negado
- **WHEN** a credencial do `oms-service` tenta acessar o database do `ledger-service`
- **THEN** o banco recusa a conexão ou a consulta por falta de permissão

#### Scenario: Usuário da aplicação sem DDL
- **WHEN** a credencial de aplicação de um serviço tenta executar `CREATE TABLE`
- **THEN** o banco recusa por falta de privilégio, e só a credencial de migração consegue alterar o esquema

### Requirement: Sementes de dados
O ambiente local SHALL oferecer um comando de sementes que cria usuários de teste (um por cenário de KYC), o universo negociável inicial, histórico de preços por replay e saldos iniciais, de forma idempotente (RN-ENV-031).

#### Scenario: Sementes repetidas
- **WHEN** o comando de sementes é executado duas vezes seguidas
- **THEN** a segunda execução não duplica usuários, instrumentos nem lançamentos

#### Scenario: Usuários por cenário de KYC
- **WHEN** as sementes terminam
- **THEN** existem usuários de teste cujos CPFs válidos têm penúltimo dígito 0–6, 7, 8 e 9, cobrindo aprovação, revisão manual por FACE_MATCH, revisão manual por WATCHLIST e reprovação

### Requirement: Provedor de mercado local sem cota
O ambiente local SHALL usar por padrão o provedor de dados de mercado de replay/fixtures, sem nenhuma requisição à brapi, salvo configuração explícita com token (RN-BRP-095, RN-QA-003).

#### Scenario: Subida padrão sem rede externa
- **WHEN** o ambiente sobe com a configuração padrão
- **THEN** nenhuma requisição é feita para `brapi.dev` e as cotações vêm das fixtures/replay

### Requirement: Ambiente sandbox separado
O sandbox SHALL rodar como uma implantação separada (outro projeto de contêineres) com bancos, barramento, storage e segredos próprios, relógio `ACCELERATED`, calendário sempre útil e preço 100% sintético (RN-PAD-080, RN-ENV-001, RN-SBX-001..004).

#### Scenario: Ambientes sem tráfego cruzado
- **WHEN** o ambiente local `prod` e o sandbox rodam ao mesmo tempo
- **THEN** nenhum evento, banco ou segredo é compartilhado entre eles
- **AND** um evento com `environment` diferente do consumidor vai para a DLQ

### Requirement: Primeiros passos
O repositório SHALL documentar os primeiros passos, do clone ao primeiro negócio, de forma que o fluxo completo leve menos de 15 minutos (RN-ENV-032, RNF-091).

#### Scenario: Do clone ao primeiro negócio
- **WHEN** um desenvolvedor segue o guia de primeiros passos numa máquina com o runtime de contêineres instalado
- **THEN** ele abre conta, deposita via PIX simulado e executa uma compra contra o FMS em menos de 15 minutos
