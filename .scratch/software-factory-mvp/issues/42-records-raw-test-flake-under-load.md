# 42: Corrigir o flake de `test/records/raw.test.ts` sob carga de VM

**What to build:** `test/records/raw.test.ts` falhou uma vez numa execução da suíte local enquanto VMs dos ensaios pré-piloto do ticket 34
carregavam a máquina, e passou nas demais execuções. Pelas regras de `docs/agents/testing.md`, flake é bug do teste: ou se corrige, ou se
põe em quarentena explícita com este ticket, sem retry. O arquivo tem 5 testes do formato `raw` de Records: bytes e EOF através de páginas, segredos
cortados entre chunks, rotação que invalida capturas ativas, orçamento de entrada e limites de página, cauda codificada de segredo. Nenhum
usa temporizador ou espera explícita. O mais provável é uma dependência de ordem, de I/O ou
de recurso que só aparece sob carga, mas a causa não foi confirmada.

**Blocked by:** —

**Type:** task

**Status:** needs-triage

## Acceptance criteria

- [ ] Reproduzir a falha sob carga, sem sleep, por exemplo com `npm run test:fast -- records/raw` repetido com a máquina carregada,
  e registrar a asserção que falha e a mensagem. O relato original veio do supervisor, sem a saída anexada.
- [ ] Corrigir a causa no teste, ou no produto se ela for real em Records, com um teste vermelho → verde. Não aumentar limites nem
  acrescentar retry.
- [ ] Se a causa não for encontrada, colocar o arquivo em quarentena explícita em `test/tiers.json` com este ticket, sabendo que
  quarentena é não cobertura.
- [ ] `npm run test:ci` verde.

## Referências

- [Registro dos ensaios pré-piloto](../../../docs/evidence/34-prepilot-results.md) (contexto da carga).
- `docs/agents/testing.md` (flake, quarentena, orçamento do runner).
