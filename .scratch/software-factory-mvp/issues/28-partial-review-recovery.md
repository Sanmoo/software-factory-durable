# 28: Recuperar revisão parcial sem perder parecer válido

**What to build:** Falha de um revisor ou perda da notificação não obriga repetir revisão válida da mesma proposta e não produz parecer limpo fictício. O Builder só retoma após encerramento seguro dos revisores e recebe os resultados efetivos.

**Blocked by:** [13: Tratar achados e comprovar gates sobre o conteúdo atual](13-findings-treatment-and-current-content-gates.md); [26: Recuperar Execuções sem adotar sobreviventes](26-execution-recovery-without-survivor-adoption.md)

**Status:** resolved

## Acceptance criteria

- [x] Parecer completo durável com notificação perdida é localizado e incorporado uma vez por rodada/tentativa/papel, sem rerodar se identidade de entrada/contexto corresponder.
- [x] Streaming/arquivo incompleto não vale como parecer; ausência, falha e cancelamento são estados explícitos, não zero achados.
- [x] Um parecer válido é preservado e só o falho é recuperado quando proposta/contexto permanecem iguais; mudança relevante exige novos pareceres atuais dos dois, sem equivalência semântica calculada pelo controlador.
- [x] Recuperação usa limites operacionais já existentes, sem orçamento paralelo de reviews; se Execução foi interrompida, cessa e readmite pela fila sem adotar sobrevivente.
- [x] Builder permanece sem turnos/ferramentas até cessar atividade dos revisores, recebendo pareceres/falhas reais na sessão compatível ou substituta.
- [x] Entrega ao SDK antes de checkpoint perdido não comprova consumo; continuação é reconstruída com resultados preservados e efeitos observados, sem duplicar tratamento/cobrança automaticamente.
- [x] Provas com sessões/agentes/processos reais cobrem um revisor falho, notificação perdida, mudança de entrada e crash no handoff, preservando Slot, identidade e evidência.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 5.6, 6.1, 6.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-08, V-12, V-13 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-15: um parecer válido sobrevive à falha/interrupção do outro revisor; só o falho é re-obtido na mesma rodada, com a
proposta re-observada igual, cessação conhecida, falha transitória, unidade do contador `recoveries` existente (espera persistida 5/15/45 s de
26) e no máximo 2 retries por papel por rodada (`REVIEWER_RETRY_LIMIT`, decisão do operador); notificação perdida é recuperada do registro
completo no Records (`Workers.observeOpinion`), nunca de streaming/parcial; `incomplete` é resultado real; mudança de proposta/contexto exige
novos pareceres dos dois. Composição com 26: reservas de retry liquidadas na reconciliação; a primeira rodada de uma recuperação operacional
leva os pareceres válidos (gravados ou descobertos) da rodada interrompida sobre a mesma proposta/contexto (nunca após parada administrativa);
a sessão substituta recebe o estado de revisão preservado como contexto (entrega ≠ consumo). Gate `npm run test:ci` verde; ensaio real
`q28-partial-v2` no issue #6 com veredito 7/7 (`inspect-2`); o corte no handoff foi provado com processos reais em nível I-local (sem VM/modelo).
Evidência: `docs/evidence/28-partial-review-recovery.md`.
