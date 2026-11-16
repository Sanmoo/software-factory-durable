# 34: Qualificar a composição candidata contra a matriz de aceite

**What to build:** O responsável consegue decidir se uma composição candidata tem evidência suficiente para avançar ao piloto, consultando cobertura rastreável e lacunas reais. Este ticket consolida e verifica aplicabilidade das provas já produzidas, não esconde implementação ou hardening genérico.

**Blocked by:** [18: Demonstrar a primeira jornada integrada completa](18-first-integrated-delivery-journey.md); [20: Renovar e retirar credenciais durante a atividade autorizada](20-active-credential-lifecycle.md); [24: Executar três Builders com FIFO e isolamento comprovados](24-three-builders-fifo-and-isolation.md); [27: Reconciliar efeitos externos nos cortes de crash](27-external-effect-crash-reconciliation.md); [29: Inspecionar toda a cadeia e o consumo pela CLI](29-correlated-cli-observability-and-usage.md); [31: Excluir histórico conservando memória mínima dos ciclos](31-history-erasure-and-minimal-cycle-memory.md); [33: Atualizar com compatibilidade verificada e migração recuperável](33-compatible-upgrades-and-recoverable-migration.md)

**Status:** resolved

## Acceptance criteria

- [x] Identifica release/commit, integridades, host, configuração efetiva e perfis/modelos correspondentes; prova histórica só é reaproveitada com entradas/contexto relevantes compatíveis, sem usar build verde como estado externo atual.
- [x] Relaciona obrigações e subcasos V-01–V-16 a RF-01–14, RNF-01–05 e CA-01–12, com expectativa/observado, nível fiel S/I/A conforme matriz, comandos, correlações e evidências acessíveis filtradas.
- [x] Confere evidências reais de exclusividade/FULL, SDK/filtragem, KVM/FUSE/Docker/TLS/cessação, dependências declaradas, três Builders, lease/reparos, cortes de crash/limites, operação/retenção e atualização, sem exigir modelos em toda permutação.
- [x] Classifica cada obrigação como aprovada, reprovada, inconclusiva ou ainda dependente do piloto P; esse último estado não dispensa obrigação nem se converte em aceite antecipado do MVP.
- [x] Ausência/inconclusivo de obrigação pré-piloto bloqueia o gate correspondente e recebe encaminhamento específico de implementação/revalidação; lacuna de desenho volta ao operador com dependência explícita.
- [x] Reexecuções necessárias usam grupos pertinentes com autorização própria, sem nova engine de impacto/cache, bateria monolítica obrigatória a cada edição ou repetição automática de testes independentes.
- [x] Relatório explicita escopo suportado de GitHub/perfil, capacidade medida, limitações aceitas e métricas disponíveis sem inventar SLA/custo-alvo; aprovação documental não se apresenta como funcionamento.
- [x] Resultado libera no máximo preparação/solicitação de autorização do piloto; não seleciona ou acessa recursos reais automaticamente, não certifica barreiras de merge/CI nem declara utilidade humana.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 13, 14; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-01, V-02, V-03, V-04, V-05, V-06, V-07, V-08, V-09, V-10, V-11, V-12, V-13, V-14, V-15, V-16 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-16 como qualificação documental do candidato `integration/software-factory-mvp` @ `b30e2bd` (tickets 01–33, 36–40;
29 integrado em `0d343d6`; 41 como capacidade extra fora da spec). Relatório:
[docs/evidence/34-candidate-qualification.md](../../../docs/evidence/34-candidate-qualification.md); matriz:
[docs/evidence/34-qualification-matrix.json](../../../docs/evidence/34-qualification-matrix.json), mantida honesta por
`test/architecture/qualification-matrix.test.ts` (V-01–V-17 e os 31 RF/RNF/CA do plano, níveis por cenário, rastreio requisito↔cenário,
estados permitidos, evidência existente e nível real exigido para aprovar, agregados pelo pior estado, gate e encaminhamento para cada
obrigação aberta).

- 112 obrigações: 66 aprovadas, 0 reprovadas, 36 inconclusivas, 10 dependentes do piloto. Todos os RF/RNF/CA ficam inconclusivos,
  exceto RF-08 e CA-01, que dependem do piloto. Gates: G1/G2 sem bloqueio; G3 (V-06.h, V-15.c), G4 (30 obrigações) e G5 (4)
  bloqueados.
- Nenhum ensaio real rodou sobre o candidato, e a combinação 23+24+29(+41) só tem prova S (V-06.h → R-CAND). Cada prova histórica tem
  registrados o commit e a razão de reaproveitamento (encadeada).
- Decisões do operador pendentes: D-01–D-08 (24 AC5/CA-08, escopo de dependências, repos diferentes em paralelo, Compose/build, 11
  decisão 3, disco após morte do proprietário, VACUUM, rate limit real).
- Reexecuções, cada uma com autorização própria e nenhuma executada: R-CAND, R-REL, R-GH-CHECKS, R-GH-ADV, R-GH-DEP, R-LONG, R-CRASH-A,
  R-HOSTFAULT, R-24DIAG, R-THREE, R-INSPECT, R-DOCKER-EXT.
- O resultado libera no máximo a preparação da solicitação de autorização do piloto (35). Não aprova o MVP, não seleciona recursos e não
  certifica as barreiras do time.
