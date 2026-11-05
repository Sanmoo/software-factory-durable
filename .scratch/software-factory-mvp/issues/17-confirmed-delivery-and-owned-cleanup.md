# 17: Confirmar entrega e limpar somente recursos próprios

**What to build:** Quando uma pessoa faz merge do PR próprio, a Factory confirma a entrega e remove apenas os recursos daquele Trabalho que podem ser limpos com segurança. Cleanup falho continua operável sem desfazer o resultado entregue.

**Blocked by:** [14: Publicar e reconhecer o PR draft próprio](14-direct-draft-publication-and-discovery.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Entrega exige merge confirmado por identidade do PR/ciclo, não fechamento de issue/PR ou texto do Builder; merge durante cancelamento continua sendo entrega e impede novas ações do agente.
- [ ] Cleanup automático só começa após merge e cessação confirmados e preservação da evidência necessária fora do ambiente removido.
- [ ] Plano e intenção/resultado por recurso identificam worktree/checkout, branches local/remota, temporários e ambiente próprios; base, desconhecidos e outros Trabalhos são protegidos, sem Docker global.
- [ ] Branch remota usa concessão de cleanup própria e precondições de ownership/concorrência, sem ampliar token normal de acompanhamento.
- [ ] Resultados distinguem removido, ausência comprovada, falha parcial e indeterminado; consulta falha não comprova ausência, e sucesso de um recurso não encerra os outros.
- [ ] Repetição só seleciona pendentes após revalidação, preservando refs/histórico/reviews/decisões e registros protegidos necessários; não espera retenção de detalhes para limpar recursos entregues.
- [ ] CLI explica entrega e pendências de cleanup separadamente; integração real inclui merge humano autorizado, falha parcial e retry sem atingir recurso alheio.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 8, 12.1, 12.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-04, V-14 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
