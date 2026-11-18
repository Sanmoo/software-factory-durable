# 35: Executar o piloto autorizado e obter avaliação humana do MVP

**What to build:** Com autorização específica, a Factory processa o menor conjunto suficiente de tickets reais para avaliar utilidade e qualidade do MVP. O operador julga as propostas e entregas, com evidência integral e métricas que incluem bloqueios e intervenções, não apenas PRs abertos.

**Blocked by:** [34: Qualificar a composição candidata contra a matriz de aceite](34-candidate-qualification-and-acceptance-coverage.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Antes de executar, operador aprova máquina/conta/storage/preparo, repos/issues/PRs/branches/workflows/relações, App/instalações/operadores, modelos/custos, injeção de falhas/cleanup e quem revisa/faz merge humano.
- [ ] Seleção por cobertura usa repositórios confiáveis com instruções/gates reproduzíveis e tickets julgáveis, sem quota arbitrária de repos/tickets/entregas ou acesso antecipado a recursos pela mera aprovação do backlog.
- [ ] Percursos reais demonstram dependência nativa, pedido preservado, implementação, dois reviews, validações, interação/pergunta quando necessária, draft/prontidão, manutenção, merge humano e cleanup.
- [ ] Suites reais dos pilotos criam containers simultâneos sem colisão, bypass de testes/Ryuk/TLS ou limpeza alheia; evidência de três Builders, dois no mesmo repo, é aplicável à composição declarada.
- [ ] Dados privados inacessíveis, incompatibilidade musl/portas/volumes e defeitos não são resolvidos por fallback ou reescrita silenciosa; bloqueios/adequações e impacto na seleção/cobertura voltam ao operador.
- [ ] Registra tempos de elegibilidade/início/PR/prontidão/merge separados de espera, intervenções/Perguntas/correções/recoveries, resultados/motivos, Slots/filas, consumo incluindo revisores, duplicações e cleanup falho.
- [ ] Operador registra avaliação explícita da aderência, qualidade e utilidade; merge e aprovação humana não são realizados pelos agentes nem inferidos de checks ou PR aberto.
- [ ] Aceite do MVP só é registrado com todos os RF/RNF/CA e contratos cobertos no nível fiel, incluindo V-17/P e obrigações técnicas prévias, sem dispensar falha obrigatória por métrica boa ou apagar resultados sem entrega.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 13.2, 13.3, 14, 15; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-05, V-06, V-07, V-08, V-09, V-10, V-11, V-14, V-15, V-17 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Comments

- 2026-11-18 (supervisor): rascunho da solicitação de autorização do piloto em
  [docs/evidence/35-pilot-authorization-request.md](../../../docs/evidence/35-pilot-authorization-request.md): composição `mvp-34.5`
  (`f3c7cf3`, selecionada em `pr2`), o que o piloto fará, as 13 obrigações dependentes do piloto, riscos conhecidos, regras de parada,
  reversão e a lista de autorizações (sim/não por item). Nada foi iniciado; aguarda as respostas do operador.
