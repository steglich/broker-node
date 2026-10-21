# ADR-0001 (implementação) — RabbitMQ streams com `rabbitmq-stream-js-client`

- **Status**: Aceito
- **Data**: 2026-10-19
- **Contexto do design**: D6 (`openspec/changes/implementation-roadmap/design.md`), risco "maturidade do cliente JS de RabbitMQ Streams".
- **Evidência**: `packages/messaging/test/spike/rabbitmq-streams.spike.test.ts` (Testcontainers, RabbitMQ 4.3.6, cliente 1.1.0). Rodou 3 vezes seguidas sem falha.

## Pergunta

O cliente `rabbitmq-stream-js-client` aguenta o que o D6 exige: super stream particionado, publicação por chave, Single Active Consumer (SAC) com várias instâncias, failover retomando do offset gravado no banco do serviço, e releitura por offset?

## Resultado

| Verificação                                                           | Resultado                                                 |
| --------------------------------------------------------------------- | --------------------------------------------------------- |
| Super stream com 3 partições (`createSuperStream`, `partitionsQuery`) | OK                                                        |
| Publicação por chave com confirmação do broker                        | OK, mas **sem** o `SuperStreamPublisher` (ver achado 1)   |
| Ordem por chave com duas instâncias (20 chaves × 5 mensagens)         | OK, nenhuma inversão                                      |
| Distribuição das partições entre as instâncias do grupo               | OK, o broker reparte as 3 partições entre as 2 instâncias |
| Failover: a instância A cai, B assume as partições de A               | OK                                                        |
| Retomada do offset salvo (callback `consumerUpdateListener`)          | OK, sem perda e sem duplicata                             |
| Releitura desde o início e a partir de um offset                      | OK                                                        |
| Deduplicação no broker (`publisherRef` + `publishingId`)              | OK, o reenvio do mesmo `publishingId` é descartado        |

**Decisão**: manter RabbitMQ streams e `rabbitmq-stream-js-client` 1.1.0, atrás das portas de `@broker/messaging`, com os contornos abaixo. Não é preciso trocar para Redpanda/Kafka.

## Achados e contornos

1. **`SuperStreamPublisher` não expõe confirmações.** Ele encapsula um publisher por partição mas não repassa o evento `publish_confirm`. O relay da outbox precisa da confirmação antes de marcar `published_at` (D7). **Contorno**: o adaptador roteia sozinho (`murmur3_32(chave) mod partições`, semente 104729, o mesmo algoritmo `hash` dos clientes oficiais) e usa um `Publisher` por partição, esperando o `publish_confirm` de cada `publishingId`.

2. **`declareSuperStreamConsumer` não aceita `consumerUpdateListener`.** Ele liga o SAC, mas, quando uma instância vira a ativa de uma partição, retoma do offset passado na criação, não do offset salvo no banco. **Contorno**: o adaptador declara um consumidor SAC por partição com `declareConsumer`, passando o callback (que lê `consumer_offset` no banco) e o nome do super stream no terceiro parâmetro, para o broker ligar a propriedade `super-stream` e distribuir as partições entre as instâncias. Esse terceiro parâmetro é de uso interno da biblioteca: fica encapsulado num único ponto do adaptador e coberto por teste.

3. **Fechar o último consumidor de uma conexão quebra o próximo `declareConsumer` no mesmo cliente.** O socket é encerrado, mas o pool de conexões ainda o reaproveita (`This socket has been ended by the other party`). **Contorno**: o adaptador não fecha e redeclara consumidores no mesmo cliente; para recomeçar, fecha o cliente inteiro e cria outro.

4. **Entregas de chunks diferentes podem se sobrepor.** Dentro de um chunk, o cliente espera o handler de cada mensagem; mas o callback de entrega não é serializado entre chunks. **Contorno**: o consumidor do adaptador mantém uma fila serial por partição, garantindo processamento em série por chave (RN-MSG-B-032) independentemente do cliente.

5. **Endereço anunciado.** O broker anuncia o hostname interno (`rabbitmq`), que não resolve de fora do Docker. **Contorno**: `addressResolver` habilitado com o endpoint configurado (`rabbitmq:5552` dentro da rede Docker, `localhost:5552` para serviços rodando no host com o perfil `infra`). Com um nó só, o resolver conecta de primeira.

6. **Deduplicação no broker como defesa extra, não como garantia.** O broker guarda o maior `publishingId` por `publisherRef` e descarta reenvios. O relay usa o `seq` da outbox como `publishingId`, o que elimina a maior parte das duplicatas quando o relay cai entre publicar e marcar. A garantia de efeito único continua sendo a inbox do consumidor (RN-MSG-B-030), porque a deduplicação no broker tem um risco: se o banco do serviço for restaurado de um backup e o `seq` voltar para trás, o broker descartaria mensagens novas como se fossem duplicatas. Por isso o `publisherRef` inclui uma época configurável que deve mudar após uma restauração.

## Consequências

- `@broker/messaging` tem um adaptador de streams próprio (roteamento, publishers por partição com confirmação, consumidores SAC por partição), em vez de usar as classes de super stream da biblioteca.
- Os achados 2 e 3 dependem de comportamento interno do cliente 1.1.0. Uma atualização da biblioteca precisa rodar o spike e os testes do adaptador antes de entrar.
- Se algum contorno deixar de funcionar, a troca de transporte (ex.: Redpanda) fica restrita ao adaptador, sem mexer nos serviços (D6).
