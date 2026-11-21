# 14: Consumo por boot e por Trabalho; recusa por quota

**What to build:** O Operador vê quanto de MicroVM cada Trabalho consumiu, sem a Factory calcular dólares. Por boot: identidade, motivo, tamanho, início,
fim e segundos, a partir de `GetMicrovm`; builds de imagem por chave. Por Trabalho: MicroVM-segundos acumulados, sem reinício entre boots
ou Execuções. Recusa do serviço por quota ao iniciar é impedimento visível do início.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-30 (execução), V2-32.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 06

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Cada boot tem registrados identidade, motivo, tamanho, início, fim e segundos, com os tempos vindos de `GetMicrovm`.
- [ ] Builds de imagem são registrados por chave de ambiente.
- [ ] O Trabalho acumula MicroVM-segundos por todos os boots e Execuções, sem reinício; o acumulado aparece na observabilidade da CLI junto do consumo existente.
- [ ] Não há valor nem teto em dólares; a documentação diz ao Operador como conferir o custo pela tag da instalação.
- [ ] Recusa do serviço por quota ao iniciar um boot é impedimento visível do início, com a causa, e não consome retomada operacional.
- [ ] Boot cuja observação final não foi possível registra o consumo como desconhecido, nunca como zero.
