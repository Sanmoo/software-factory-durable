# 52: Cancelar uma Execução retida termina sem esperar o reinício do controlador

**What to build:** no piloto 35, cancelar Trabalhos cuja Execução estava retida (`held`: #125 em `PREPARE_ENVIRONMENT_CONFIGURATION_MISMATCH`
às 08:38 UTC; #126 em `START_PRESERVED_DISK_CHECK_REQUIRED` às 09:5x e em `REVIEWER_RETRY_LIMIT` às 11:38) deixou o cancelamento em `stopping`:
a Vaga continuou ocupada e, no caso do `REVIEWER_RETRY_LIMIT`, a VM do Builder suspenso continuou ligada. Só o reinício do controlador fez a
cessação. Reiniciar com outro Trabalho rodando para a VM dele de forma abrupta (ticket 47), então o supervisor teve de esperar o fim da
Execução vizinha para reiniciar, e o #124 ficou sem Vaga para publicar.

Além disso, o primeiro observador do supervisor contava Vagas ocupadas como "Builder rodando": uma Execução retida ocupa a Vaga sem rodar
(o #124 ficou retido por falta de memória de 01:13 a 08:38 sem ninguém perceber). `status` e `list` não destacam Execuções retidas.

**Blocked by:** —

**Type:** task

**Status:** migrado para [#18](https://github.com/Sanmoo/software-factory-durable/issues/18) em 2026-11-22; a issue é a versão canônica.
## Acceptance criteria

- [ ] `cancel` de um Trabalho com Execução retida para o boot/worker próprios (com a parada limpa do ticket 47), confirma a cessação e libera a
  Vaga no controlador em execução, sem reinício.
- [ ] `status` mostra quantas Execuções estão retidas, com código e desde quando, separadas das que estão rodando; `list` marca a Execução retida.
- [ ] Teste de fluxo S para cancelamento de cada estado retido do piloto.

## Comments

- Evidência: `pl1-pilot-evidence/findings.md` itens 9 e 13.
- Relacionados: [47](47-clean-guest-stop-and-disk-recovery.md), [51](51-review-reads-past-eof-and-reviewer-budget.md).
