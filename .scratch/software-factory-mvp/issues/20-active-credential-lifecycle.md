# 20: Renovar e retirar credenciais durante a atividade autorizada

**What to build:** Uma Execução autorizada consegue continuar usando Git/gh além da validade inicial do token, sem reiniciar o Trabalho ou persistir segredos. Ao encerrar, esperar ou cancelar, a Factory retira novas concessões e mostra os limites da revogação.

**Blocked by:** [09: Iniciar Builder com checkout próprio e pedido preservado](09-builder-start-and-preserved-request.md)

**Status:** resolved

## Acceptance criteria

- [x] Renovação usa nova emissão pela projeção estreita de credenciais após revalidar autorização da atividade/repo/finalidade; não é serviço, cofre, ampliação pedida pelo modelo ou método de renovação paralelo.
- [x] Nova concessão é entregue em memória pelo caminho host para ambiente explícito das ferramentas antes de expires_at; comandos novos a recebem, e subprocesso existente conserva ambiente antigo.
- [x] Retirada de elegibilidade para próxima ativação não corta credencial de atividade ainda autorizada; handoff interno não exige rotação por rodada e nunca entrega segredo ao revisor.
- [x] Espera externa/fim/cancelamento retiram novas entregas/renovações e tentam revogar concessões conhecidas; sucesso, falha e impossibilidade comprovada de revogar são distintos.
- [x] Expiração durante comando exige descoberta do efeito antes de repetir, sem replay ou recovery só para renovar; token expirado/revogado não prova cessação.
- [x] Após crash, valor perdido pode permanecer válido externamente até expirar; metadados explicam risco sem recuperar segredo de logs, afirmar revogação falsa ou bloquear toda instalação por esse motivo isolado.
- [x] Segredos não entram em retorno serializável de task, recibo, sessão, prompt, argv ou remoto; integração comprova renovação em execução longa e filtragem com valores sintéticos nos testes de vazamento.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 8, 8.1, 12.2; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-03, V-13 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-14: renovação, retirada e auto-revogação de credenciais durante a atividade, reconciliação após crash; gate local 811/0; ensaio real com 2 renovações entregues, 3 revogações confirmadas pelo GitHub e nenhum token persistido. Evidência: `docs/evidence/20-active-credential-lifecycle.md`.
