# scenarios

Cenários de referência (golden master) da estratégia de testes (§3): arquivos YAML com entradas
e saídas esperadas, **independentes de tecnologia**. Qualquer implementação do broker, em qualquer
linguagem, deve passar neles.

```
scenarios/<domínio>/<ID>.yaml   # ex.: fee/FEE-010.yaml, cal/CAL-001.yaml
```

## Formato

```yaml
cenario: FEE-010 rateio com resíduo de centavos # ID + descrição; o prefixo (FEE) escolhe o domínio
regras: [RN-FEE-031] # opcional: regras cobertas (RN-QA-001)
semente: 42 # opcional (padrão 1): semente do PRNG
relogio: '2026-01-05T13:00:00Z' # opcional: início do relógio virtual
entradas: { ... } # livre, definido pelo adaptador do domínio
saidas_esperadas: { ... } # comparadas por igualdade exata
```

- Decimais e datas vão **entre aspas** (`"0.10"`, `"2026-02-18"`): YAML leria `0.10` como número
  binário (ADR-0004).
- Uma rejeição do domínio é uma saída: `saidas_esperadas: { erro: INVALID_ALLOCATION }`.
- Chaves desconhecidas no topo do arquivo são erro (pega erro de digitação como `entrada:`).

## Rodar

```bash
pnpm scenarios            # todos
pnpm scenarios FEE CAL-001  # por prefixo ou ID
```

Os cenários também rodam no `pnpm test` (projeto `scenarios`). Um cenário que falha mostra o
caminho de cada diferença:

```
✗ FEE-901 rateio com resultado esperado errado  (FEE-901.yaml)
  partes.b
    esperado: "0.04"
    obtido:   "0.03"
```

## Domínio novo

Escreva um adaptador em `src/adapters/<domínio>.ts` (entradas → chamadas ao domínio puro →
saídas no formato do YAML) e registre o prefixo em `src/adapters/index.ts`. O adaptador recebe
`ctx.clock` (relógio virtual) e `ctx.random` (PRNG semeado); nunca lê o relógio ou o acaso da máquina.
