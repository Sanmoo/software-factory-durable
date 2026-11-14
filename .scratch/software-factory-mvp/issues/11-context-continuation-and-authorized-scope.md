# 11: Continuar contexto e incorporar apenas mudanças de escopo autorizadas

**What to build:** O operador continua o mesmo Trabalho com contexto suficiente e pode autorizar mudança concreta de pedido. O Builder usa continue ou recuperação explícita, sem incorporar automaticamente futuras edições de Ticket ou documentos.

**Blocked by:** [10: Perguntar ao operador, cessar e retomar pela fila](10-durable-questions-and-queued-resumption.md)

**Status:** resolved

## Acceptance criteria

- [x] Retomada revalida requisitos e usa fila/categoria/posição existentes; sessão compatível recebe resposta/feedback/motivo via continue, não reinicia implement por conveniência.
- [x] Sessão incompatível/perdida é substituída com motivo e contexto recuperável, referenciando Trabalho, pedido, instruções, Git, artefatos e efeitos conhecidos; contexto insuficiente bloqueia em vez de mandar continue vazio.
- [x] Update-scope e resposta correlacionada suficiente autorizam somente mudança concreta; durante atividade ficam para próxima ativação segura, sem escritor paralelo ou injeção que amplie escopo.
- [x] Próxima Execução preserva nova versão completa antes de implementar; versões anteriores não são sobrescritas e edição posterior do link não é gatilho/autorização de mudança ou reparo.
- [x] Fontes preservadas continuam utilizáveis se origem desaparecer; captura incompleta ou fonte necessária privada inacessível gera recuperação/pergunta, sem coletor no controlador nem ampliação de credenciais.
- [x] Instruções aplicáveis por caminho e precedência são preservadas; conflito exige pergunta, e instrução modificada pelo Builder não dispensa política, gates ou limites.
- [x] Provas com agentes e sessões reais cobrem continuação compatível, substituição, captura interrompida e autorização parcial de escopo, distinguindo entrega de contexto de checkpoint/consumo comprovado.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 5.5, 6.1, 6.2, 11.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-07, V-08, V-11 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-14: continuação de sessão compatível com `continue`, substituição explícita quando incompatível ou perdida, mudança de escopo autorizada aplicada só na próxima ativação segura e edição posterior do Ticket sem efeito de autorização. Gate local 934/0; ensaio real com pergunta, resposta, continue e substituição. Evidência: `docs/evidence/11-context-continuation-and-authorized-scope.md`.

## Answer

Resolvido em 2026-11-14: continuação de contexto (continue/replace com razão e contexto recuperável), atualizações de escopo autorizadas sem injeção durante atividade, pack v4 com precedência de instruções e sem ampliar acesso, retomada exigindo o ambiente preservado. Gate local 934/0; ensaio real com pergunta → resposta/edição → continuação compatível → substituição incompatível → consumo confirmado. Evidência: `docs/evidence/11-context-continuation-and-authorized-scope.md`.
