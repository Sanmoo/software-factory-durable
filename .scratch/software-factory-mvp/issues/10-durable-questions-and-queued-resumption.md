# 10: Perguntar ao operador, cessar e retomar pela fila

**What to build:** Quando precisa de informação ou aprovação, o Builder publica uma Pergunta recuperável e deixa de ocupar Slot após cessar. Uma resposta autorizada e correlacionada recoloca o mesmo Trabalho na fila sem iniciar agente diretamente.

**Blocked by:** [09: Iniciar Builder com checkout próprio e pedido preservado](09-builder-start-and-preserved-request.md)

**Status:** resolved

## Acceptance criteria

- [x] Worker atribui identidade estável e preserva solicitação/contexto completos antes do envio; Controle confirma Pergunta, impedimento e intenção de publicação no mesmo commit antes do ACK.
- [x] Pergunta vai à issue ou ao PR próprio conforme contexto, com marcador estável e instrução de resposta explícita; após resultado ambíguo busca o comentário antes de republicar, sem usar consulta parcial como ausência.
- [x] Ativação termina sem Promise esperando humano; parada/cessação precedem liberação do Slot, preservando disco, workspace, sessão e pedido.
- [x] Comentário exige prefixo estrito, operador GitHub autorizado, contexto da issue/PR e correlação da Pergunta; CLI confia na conta administradora. Bot, terceiro, prosa e outro Trabalho não concedem poderes.
- [x] Somente primeira resposta válida confirmada duravelmente é aceita; duplicata não substitui, resposta insuficiente pode gerar outra Pergunta e ACK perdido recupera a mesma identidade/conteúdo.
- [x] Resposta remove somente seu impedimento e preserva fila/categoria/posição, limites e suspensão de autorização; não reativa entregue/cancelado nem faz spawn por ACK.
- [x] Testes de persistência e integrações com agente/GitHub/CLI demonstram pergunta, cessação e retorno seguro à fila, incluindo resposta durante indisponibilidade/reinício e conteúdo necessário perdido sem invenção.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 3.4, 5.5, 11.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-11, V-12 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-14: perguntas duráveis ao operador, publicação única por marcador, cessação com liberação do Slot e retirada de credencial, resposta autorizada do GitHub, retomada pela fila com Execution de recuperação. Gate local 859/0; ensaio real (issue #3) com pergunta → resposta → recuperação → nova pergunta. Evidência: `docs/evidence/10-durable-questions-and-queued-resumption.md`.
