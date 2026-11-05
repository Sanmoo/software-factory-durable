# 34: Qualificar a composição candidata contra a matriz de aceite

**What to build:** O responsável consegue decidir se uma composição candidata tem evidência suficiente para avançar ao piloto, consultando cobertura rastreável e lacunas reais. Este ticket consolida e verifica aplicabilidade das provas já produzidas, não esconde implementação ou hardening genérico.

**Blocked by:** [18: Demonstrar a primeira jornada integrada completa](18-first-integrated-delivery-journey.md); [20: Renovar e retirar credenciais durante a atividade autorizada](20-active-credential-lifecycle.md); [24: Executar três Builders com FIFO e isolamento comprovados](24-three-builders-fifo-and-isolation.md); [27: Reconciliar efeitos externos nos cortes de crash](27-external-effect-crash-reconciliation.md); [29: Inspecionar toda a cadeia e o consumo pela CLI](29-correlated-cli-observability-and-usage.md); [31: Excluir histórico conservando memória mínima dos ciclos](31-history-erasure-and-minimal-cycle-memory.md); [33: Atualizar com compatibilidade verificada e migração recuperável](33-compatible-upgrades-and-recoverable-migration.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Identifica release/commit, integridades, host, configuração efetiva e perfis/modelos correspondentes; prova histórica só é reaproveitada com entradas/contexto relevantes compatíveis, sem usar build verde como estado externo atual.
- [ ] Relaciona obrigações e subcasos V-01–V-16 a RF-01–14, RNF-01–05 e CA-01–12, com expectativa/observado, nível fiel S/I/A conforme matriz, comandos, correlações e evidências acessíveis filtradas.
- [ ] Confere evidências reais de exclusividade/FULL, SDK/filtragem, KVM/FUSE/Docker/TLS/cessação, dependências declaradas, três Builders, lease/reparos, cortes de crash/limites, operação/retenção e atualização, sem exigir modelos em toda permutação.
- [ ] Classifica cada obrigação como aprovada, reprovada, inconclusiva ou ainda dependente do piloto P; esse último estado não dispensa obrigação nem se converte em aceite antecipado do MVP.
- [ ] Ausência/inconclusivo de obrigação pré-piloto bloqueia o gate correspondente e recebe encaminhamento específico de implementação/revalidação; lacuna de desenho volta ao operador com dependência explícita.
- [ ] Reexecuções necessárias usam grupos pertinentes com autorização própria, sem nova engine de impacto/cache, bateria monolítica obrigatória a cada edição ou repetição automática de testes independentes.
- [ ] Relatório explicita escopo suportado de GitHub/perfil, capacidade medida, limitações aceitas e métricas disponíveis sem inventar SLA/custo-alvo; aprovação documental não se apresenta como funcionamento.
- [ ] Resultado libera no máximo preparação/solicitação de autorização do piloto; não seleciona ou acessa recursos reais automaticamente, não certifica barreiras de merge/CI nem declara utilidade humana.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 13, 14; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-01, V-02, V-03, V-04, V-05, V-06, V-07, V-08, V-09, V-10, V-11, V-12, V-13, V-14, V-15, V-16 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
