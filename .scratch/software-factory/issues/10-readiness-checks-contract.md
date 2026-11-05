# Definir a avaliação de checks obrigatórios e prontidão do PR

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão Wayfinder de prontidão; branch `software-factory-readiness`, worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-readiness`. Destino de integração: `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`; sem publicação de `main`. Decisão HITL confirmada; branch/worktree de registros históricas, removíveis após integração e validação.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 05, 08

## Question

Qual contrato implementável determina que um PR pode sair de draft e permanecer pronto, considerando regras GitHub, resultados atuais, validações e revisões internas sem declarar verde por ausência de dados?

Usar [Investigar APIs e permissões GitHub para os controles do MVP](05-github-capabilities.md) e o modelo de [Definir estados, filas, persistência e reconciliação dos efeitos](08-state-and-effects-contract.md). Não escolher novamente runtime, armazenamento ou autoridade de publicação.

Definir consultas/fontes e conjunto de regras suportadas (tradicionais, rulesets herdados e tipos desconhecidos), correlação com head/base/merge de teste, contextos e App de origem, paginação/reconsultas, critérios de sucesso/skipped/neutral e distinção entre espera, falha obrigatória que gera reparo e aprovação operacional que bloqueia. Explicitar quando não se consegue determinar o conjunto obrigatório.

Combinar essa evidência com ambas as revisões internas concluídas e válidas para o conteúdo proposto, gates locais efetivamente executados/dispensas permitidas, conflito triestado e bloqueios. Definir invalidação após push/mudança de base/regra e política observável quando um PR antes pronto deixa de cumprir os critérios, sem realizar merge.

Saída: algoritmo/contrato de avaliação, classificação e rastreabilidade ao conteúdo, exemplos adversos e provas necessárias. Não inferir um algoritmo universal a partir da caixa de merge da UI, nem executar provas autenticadas neste ticket.

## References

- [PRD — Software Factory MVP](../prd.md): RF-06–09 e RF-13; RNF-01, RNF-03–04; CA-01, CA-04, CA-06 e CA-12.

## Comments

Histórico cronológico da discussão; propostas intermediárias superadas não são decisões vigentes. A resolução consolidada está em Answer.

- Graduado na revisão da pesquisa GitHub: decisão precisa, não ticket de implementação; nenhuma opção técnica aprovada nesta criação.
- Sessão Wayfinder de prontidão iniciada após conferir o PRD e os Answers dos pré-requisitos. Pesquisa GitHub reutilizada do commit imutável `c4c46ed436570c457e19d5e2a31cb59921b89dcd`, seção 4–5; nenhuma pesquisa relançada ou prova autenticada executada.
- Rodada inicial Q1–Q4 **aprovada pelo operador** com “sim às quatro”:
  - Q1 — Escopo inicial: suportar checks/statuses obrigatórios de proteção tradicional e rulesets ativos/herdados, incluindo origem e strict/loose; requisitos adicionais que não possam ser avaliados com segurança bloqueiam com diagnóstico, sem motor universal de políticas ou dispensa implícita.
  - Q2 — Pronto para revisão humana não significa autorizado a merge: aprovação humana ainda pendente não impede, sozinha, prontidão; reviews internos e gates continuam obrigatórios; `CHANGES_REQUESTED` autorizado continua motivando reparo. Requisitos exclusivos da etapa humana ficam visíveis, sem a fábrica aprovar/enfileirar/realizar merge.
  - Q3 — Seguir a semântica documentada do GitHub para check-runs obrigatórios (`success`, `skipped`, `neutral`), distinguindo resultado concluído de check/workflow ausente; isso não dispensa gate local não executado nem autoriza desconsiderar origem/SHA.
  - Q4 — Separar prontidão interna e flag draft: retirar prontidão interna em perda de evidência; voltar automaticamente a draft por perda confirmada das condições, não por erro transitório de consulta ou cálculo indeterminado. Esses casos ficam observavelmente não confirmados até reavaliação.
- Segunda rodada: **Q5, Q7 e Q8 aprovadas explicitamente** pelo operador; Q7 aprovada após esclarecer falhas opcionais/de commit antigo. A proposta inicial de Q6 abaixo não foi aprovada; a alternativa final com sessões de revisores foi aprovada posteriormente, conforme registro ao final:
  - Q5 — Leituras por `gh api`, REST para identidade/regras/check-runs/statuses e GraphQL apenas onde necessário para as conversões draft/ready; paginação completa, avaliação estruturada com motivos e referências, reconsulta de head/base/requisitos antes da conversão e reconciliação posterior. Mudança durante a coleta descarta a avaliação, sem presumir snapshot atômico ou alargar permissões neste ticket.
  - Q6 — Evidências internas ligadas ao conteúdo integral proposto e ao contexto versionado (especificação/instruções/gates), não apenas à mensagem do agente ou ao SHA. Commit do mesmo conteúdo não invalida sozinho; push/base/contexto alterados suspendem prontidão até reavaliação; reutilizar reviews/gates somente com equivalência determinística demonstrável, senão refazer. Não usar julgamento livre do modelo para declarar mudança irrelevante; formato concreto pertence aos contratos de captura/revisão.
  - Q7 — Check obrigatório atual ausente/pendente é espera sem Slot; `failure` concluído gera reparo; aprovação de workflow/configuração/permissão é bloqueio operacional. Conclusões como `cancelled`, `timed_out`, `stale` ou `action_required` não são automaticamente diagnóstico de defeito: classificar com evidência estruturada; motivo não determinável bloqueia com orientação, sem lançar Builder para tentar adivinhar a causa. Falha opcional/antiga não dispara reparo.
  - Q8 — Draft introduzido pelo controlador pode voltar a ready automaticamente após avaliação nova completa; transição inesperada para draft não atribuível à fábrica é respeitada e pede autorização explícita antes da reconversão. Reconciliação de efeito ambíguo consulta estado e intenção, sem tomar flag ready como prova suficiente ou insistir contra ação humana. Limite: observação por polling não detecta intenção humana sem mudança observável.
- Esclarecimento de Q6 apresentado, pendente de confirmação: revisão de conteúdo ainda não commitado não expira apenas ao commitar os mesmos arquivos; alteração posterior de conteúdo/contexto exige nova evidência aplicável. Reuso só por comparação determinística, sem heurística semântica do modelo nem subsistema genérico de cache. Evidências GitHub são separadas: um check de SHA antigo não satisfaz o SHA atual, mesmo que as revisões internas possam continuar válidas.
- Esclarecimento de Q7 **aprovado pelo operador** com “okay, aprovvado”: opcional é o check que as regras aplicáveis do GitHub não exigem, não o que o Builder decide ignorar (exemplo: benchmark informativo). Antigo é resultado de SHA que não é mais o relevante ao PR (head ou merge de teste aplicável); falha antiga não gera novo reparo e verde antigo não aprova conteúdo novo. Ambos permanecem visíveis no histórico; gates locais exigidos continuam exigidos independentemente da obrigatoriedade no GitHub.
- Detalhamento adicional de Q6, **proposta ainda não aprovada**: simplificar o MVP com invalidação conservadora. Mudança do commit observado da base exige novas revisões Standards e Spec, mesmo sem conflito ou alteração do patch. Não inferir equivalência do contexto a partir de diff idêntico; bibliotecas/interfaces/instruções na base podem ter mudado. Coalescer avanços para a base mais recente antes de iniciar as revisões, sem iniciar Execuções paralelas; avanço durante a revisão impede usar o resultado como evidência atual.
- A exceção de reuso proposta fica restrita à mesma base/contexto de comparação, mesma especificação/instruções e mesmo conteúdo integral capturado; commitar exatamente o conteúdo já revisado não exige nova revisão. Conferir também o ponto de comparação do diff, não somente o tree do head. O fingerprint concreto e a captura sem corrida ficam nos contratos de captura/revisão; se a equivalência não puder ser demonstrada, refazer. Essa regra não autoriza reuso de CI de SHA antigo nem adota cache genérico de testes.
- Contraproposta do operador para Q6: tende a sempre solicitar nova avaliação quando os commits mudam, preservando e retomando o histórico das sessões dos revisores para que avaliem a necessidade de repetir/aprofundar a revisão após rebase, ajuste solicitado etc. É proposta em discussão, não aprovação da equivalência determinística nem da alternativa conservadora anterior.
- **Q6 final aprovada pelo operador com “Sim”**, substituindo as propostas anteriores de equivalência/revisão completa obrigatória: separar disparo determinístico e profundidade de revisão. Mudança observada de head/base ou alteração do conteúdo/contexto fornecido exige novos pareceres de Standards e Spec; o controlador não calcula equivalência semântica para dispensar o disparo. Retomar a sessão compatível própria de cada revisor com referências anterior/atual, alterações e motivos conhecidos, especificação/instruções e achados/tratamentos anteriores. Cada revisor inspeciona o estado atual e escolhe revisão incremental ou reavaliação ampla, mas sempre registra conclusão atual, cobertura, achados e justificativa de manutenção/revisão da conclusão anterior. “Não é necessário repetir integralmente” não significa ausência de parecer novo nem dispensa de cobertura integral do resultado proposto.
- Sessão anterior é contexto, não prova de validade atual. Quando incompatível/indisponível, usar sessão substituta com contexto recuperado e registrar o motivo; sem contexto suficiente, revisão completa ou bloqueio. Preservar handoff já aprovado (Builder inativo, revisores em paralelo sem escrita, mesmo Slot), sem snapshot/commit candidato obrigatório, novo motor ou cache genérico. Checks/gates não podem ser dispensados pela decisão do revisor sobre profundidade. Detalhes do contrato e retenção de sessões seguem nos tickets correspondentes.
- Derivação do algoritmo a partir de Q3/Q5/Q7 e da pesquisa já verificada, sem nova escolha de produto — Correlação de CI: requisito identificado por contexto e origem exigida, avaliado no SHA pertinente (head ou merge de teste atual quando aplicável), com tentativa atual e paginação completa; check-run e commit status homônimos exigidos precisam ambos satisfazer a regra. Resultado de origem/SHA divergente não satisfaz; requisito sem resultado é espera; impossibilidade de determinar a correspondência é indeterminação, nunca verde. Reconsultar referências/requisitos antes e depois da conversão, registrar evidências/motivos e invalidar coleta que mudou.
- Rodada Q9/Q10 originalmente proposta (**substituída pela orientação do operador registrada abaixo**, não aprovada como formulada):
  - Q9 — Reavaliação interna isolada é continuação pela fila normal, preservando admissão, autorização e Slot; coalescer mudanças observadas antes da ativação e não cobrar correção apenas por nova avaliação. Se houver reparo já pendente, incluir os novos pareceres nele, sem ativação paralela ou cobrança por evento. Achados que exijam mudança seguem o tratamento normal de correção e limites, sem disfarçar reparo como revisão. Nenhuma retomada ignora suspensão ou concorrência humana não reconciliada.
  - Q10 — Base atrasada sob regra strict, sem conflito nem falha obrigatória atual, impede prontidão e mostra necessidade de atualização. Não chamar isso de conflito/falha de teste nem criar gatilho automático de rebase adicional silenciosamente; fora de Execução/reparo autorizado em curso, solicitar comando autorizado de correção. Em loose, não bloquear apenas por atraso, mantendo todos os demais gates e reavaliações. O fluxo concreto de atualização/reconciliação segue no contrato de manutenção do PR.
- Orientação explícita do operador em Q9: “Se houver uma mudança de base no PR, não faremos nada, apenas se essa mudança gerou um conflito ou tornou o PR imergeável.” Em Q10, remeteu a essa intenção e pediu aviso se ainda faltasse clareza. Isso substitui a parte de Q6 que disparava reviews apenas por avanço da base e retira a proposta de continuação na fila normal para esse motivo. Avanço isolado da base não dispara Execução, reviews, rebase ou retorno a draft; manter acompanhamento normal e reagir somente a impedimentos efetivos, sem presumir verde após falha de leitura. Mudança dos commits/conteúdo do próprio PR continua exigindo pareceres atualizados nas sessões dos revisores.
- Confirmação final: o operador reiterou que a fábrica não dispara reparo nem revisão se a base mudou mas o PR continua perfeitamente mergeável; Q10 respondida com “sim”. Atualização exigida por regra strict é gatilho automático de reparo, sem comando adicional por ocorrência, sujeito aos limites e às autorizações vigentes. Esperas humanas/operacionais não se tornam defeitos pelo rótulo genérico “não mergeável”. Não existe revisão avulsa disparada por mero avanço da base.
- Resolução HITL consolidada abaixo; Q1–Q5, Q7–Q8 e a alternativa final de Q6 foram confirmadas nas respectivas rodadas. As orientações finais de Q9/Q10 prevalecem sobre a proposta anterior de revisar a cada avanço da base. Somente este ticket não-research foi resolvido nesta sessão.
- Validação documental: `git diff --check`; 22 tickets com status/tipos/labels/Answers consistentes, pré-requisitos resolvidos e grafo sem ciclos;
  204 referências locais verificadas, índice de resolvidos e fronteira conferidos. Probe diagnóstico dos cinco Markdown alterados sem erros/avisos,
  apenas sugestões informativas do corretor em inglês sobre palavras portuguesas. Não são provas de execução do MVP.

## Answer

### Decisão e limites

Adotar avaliação explícita do controlador, separada da flag draft/ready do GitHub e da autorização de merge humano.
Pronto significa preparação da fábrica concluída para o conteúdo proposto, não aprovação humana obtida nem Trabalho entregue.
A fonte documental é [Investigar APIs e permissões GitHub para os controles do MVP](05-github-capabilities.md),
cujo relatório imutável e limites estão no Answer. Nenhuma prova autenticada foi executada nesta decisão.

**Mero avanço da branch-base não dispara Execução, revisão, rebase ou retorno a draft.**
Continuar acompanhando o PR. Reagir a conflito confirmado, falha obrigatória atual ou impedimento efetivo corrigível,
não à simples mudança do SHA da base. Não criar uma fila de reavaliações internas por avanço da base.
Mudança da branch-alvo, alteração humana não reconciliada ou novo escopo não são autorização para adotar outro contexto silenciosamente.

A decisão usa a autoridade e os registros de
[Definir estados, filas, persistência e reconciliação dos efeitos](08-state-and-effects-contract.md).
Não acrescentar segundo motor/banco, publicador mediado, cache semântico de revisões ou requisito de snapshot imutável da worktree.

### Fontes e cobertura suportada

Usar `gh api` como interface, REST para as leituras abaixo e GraphQL para conversões draft/ready quando necessário.
Versão REST explícita/configurada; nenhuma escolha aqui amplia permissões da App.
O [contrato de permissões e verificação da GitHub App](11-github-app-contract.md) concretiza acesso e pré-voo.

| Evidência | Fonte e limite |
| --- | --- |
| Identidade, head/base, estado, draft, merge confirmado e conflito | PR REST; IDs/repositórios/refs devem corresponder ao Trabalho, não só título ou nome de branch |
| Regras de checks tradicionais | Proteção da branch-base; erro/404 sem contexto de acesso suficiente não comprova inexistência de proteção |
| Rulesets ativos aplicáveis | Regras da branch e detalhes necessários, incluindo níveis herdados; acumular requisitos, não escolher só o primeiro ruleset |
| Check-runs | SHA pertinente, identidade/nome/App, estado, conclusão e tentativa; enumerar páginas/suites necessárias |
| Commit statuses | Contexto/origem, SHA e estado atual; o combinado sozinho não descobre todos os requisitos |
| Reviews humanos e demais impedimentos | Acompanhamento correlacionado ao PR; autorização e relevância seguem o contrato de manutenção |
| Reviews internos e gates locais | Registros do controlador vinculados ao resultado proposto, à especificação/instruções e à Execução |

Suportar required status checks tradicionais e de rulesets ativos/herdados, contexto, integração exigida e strict/loose.
Requisitos se acumulam; só declarar conjunto obrigatório vazio quando a leitura completa e autorizada sustentar essa conclusão.
Resultados existentes, rollup e caixa de merge da UI não enumeram requisitos que nunca publicaram resultado.

Não implementar um interpretador universal de regras GitHub.
Requisito relevante não interpretável com segurança, como modalidade de workflow obrigatório ou merge queue sem suporte,
produz diagnóstico de incompatibilidade/indeterminação, nunca dispensa implícita.
Distinguir regras da preparação da fábrica de exigências exclusivas da etapa humana de merge.
Aprovações humanas ainda pendentes ficam visíveis, mas não impedem, sozinhas, prontidão para recebê-las.
A fábrica não aprova workflows/reviews, enfileira para merge ou realiza merge em nome do humano.

### Avaliação correlacionada e auditável

Registrar junto da avaliação: Trabalho/Execução de origem quando aplicável, identidade de repositório/PR,
head/base observados, merge de teste quando relevante, instante, conjunto de requisitos e completude das consultas,
identidade/tentativa/origem/SHA de cada resultado, referências dos pareceres/gates, impedimentos e decisão com motivos.
Esses dados pertencem à prontidão/histórico já previstos, não a uma autoridade paralela.

Procedimento:

1. Conferir ownership e estado do Trabalho/PR. Merge confirmado, cancelamento ou PR fechado seguem suas transições próprias;
   não converter prontidão de PR encerrado nem disparar ação proibida.
2. Capturar head/base/refs e requisitos aplicáveis, completando a paginação e distinguindo ausência comprovada de falha de leitura.
3. Correlacionar cada requisito com resultados atuais. Usar o SHA pertinente conforme a regra/documentação:
   head ou merge de teste atual quando aplicável. Não trocar arbitrariamente por head verde se o resultado exigido é do merge de teste.
   Se não for possível determinar a correspondência, a avaliação é indeterminada.
4. Conferir conteúdo/spec/instruções dos pareceres e gates, conflito triestado e todos os impedimentos vigentes.
5. Produzir motivos independentes por condição. Espera e bloqueio podem coexistir; um motivo não apaga os demais.
   Só declarar pronto se todos os requisitos da preparação estiverem satisfeitos.
6. Antes da conversão, reconsultar identidade/head/base e requisitos. Mudança durante a coleta invalida essa avaliação de CI/regras;
   recalcular com as referências atuais. Isso não dispara revisão interna apenas porque a base avançou.
7. Confirmar intenção durável de conversão, executar fora da transação e reconciliar PR/evidências depois.
   Sem resultado comprovado, não repetir efeito ambíguo nem tomar flag ready como certificado.

Não há snapshot atômico entre banco, GitHub, regras e CI. Registrar a validade observada, não prometer prontidão permanente.
Polling normal permanece configurável com padrão de 60 segundos, backoff/rate limits e reconciliação após restart.
Erro de consulta não significa sucesso, ausência de requisito ou motivo para lançar Builder.

### Checks: satisfação, espera, reparo e bloqueio

Requisito é identificado por contexto e integração exigida, não apenas pelo nome visível.
Se check-run e commit status homônimos forem exigidos, ambos devem satisfazer o requisito.
Resultados de outra origem/SHA não o satisfazem. Selecionar o estado/tentativa atual: verde antigo não encobre rerun pendente ou falho.
Limite/truncamento de API ou tentativas indistinguíveis impede concluir completude; não escolher o resultado mais favorável.

| Observação atual | Consequência |
| --- | --- |
| Check-run obrigatório concluído com `success`, `skipped` ou `neutral` | Satisfaz o requisito GitHub correspondente; não comprova execução de um gate local |
| Commit status obrigatório `success` | Satisfaz o status correspondente; não aplicar conclusões de check-run a outra API |
| Obrigatório ausente, queued, in progress ou status pending | Espera por CI, sem Slot; não presumir falha nem sucesso |
| Obrigatório atual concluído como `failure` ou status `failure` | Motivo de reparo, sujeito a autorização, consolidação e limites |
| `cancelled`, `timed_out`, `stale`, `action_required`, erro ou outra conclusão não satisfatória | Examinar evidência estruturada; defeito confirmado segue reparo, causa operacional segue bloqueio; causa incerta não lança Builder por adivinhação |
| Aprovação de workflow, permissão/configuração ou requisito não interpretável | Bloqueio com motivo e ação necessária, sem conceder poder extra ao worker |
| Falha de check opcional no GitHub | Visível, mas não dispara reparo automaticamente; gate local exigido continua obrigatório |
| Falha de SHA que deixou de ser pertinente | Histórico, não novo reparo; verde desse SHA também não aprova conteúdo novo |
| Consulta parcial/falha, origem incerta ou conjunto obrigatório desconhecido | Prontidão não confirmada; recuperar a leitura ou reportar bloqueio, nunca declarar verde |

Não transformar check sem publicação em falha de código. Também não declarar gate local executado só porque um check foi skipped.
Dispensa humana local exige registro explícito e não contorna check obrigatório GitHub.

### Revisões internas: continuidade sem revisão por avanço da base

Preservar o histórico próprio de Standards e Spec e preferir retomar cada sessão compatível nas novas rodadas do fluxo de implementação/reparo.
Fornecer referências anterior/atual, mudanças e motivos conhecidos, especificação/instruções versionadas e achados/tratamentos anteriores.
O resumo do Builder não substitui inspecionar o resultado atual, incluindo alterações não commitadas e arquivos novos.

Cada revisor decide a profundidade necessária: pode justificar a manutenção de conclusões após reorganização de commits,
examinar incrementalmente mudanças e seus efeitos ou refazer análise ampla quando necessário.
**Sempre emitir parecer atualizado**, com cobertura/conclusão, achados e justificativa para manter ou alterar a análise anterior.
Revisão incremental não significa olhar só o último evento e esquecer o restante do resultado proposto ou achados ainda relevantes.

O controlador exige evidências atuais de ambos antes de restaurar prontidão após mudança do resultado no fluxo autorizado.
Não delega autorização, Slot, limites ou validade de CI aos revisores, nem calcula equivalência semântica para dispensá-los.
Falta/falha de revisor não equivale a revisão limpa; ausência de Spec/instruções necessárias não autoriza omitir análise.
O Builder registra tratamento dos achados: corrigido ou não acolhido com justificativa.

Se sessão anterior estiver incompatível/indisponível, usar substituta com contexto recuperável e registrar a razão;
se insuficiente, revisão completa com as fontes necessárias ou bloqueio, nunca aprovação por ausência de memória.
Manter handoff aprovado: Builder inativo, dois workers em paralelo, mesma VM/workspace, sem escrita e dentro do mesmo Slot.
Não exigir commit candidato, snapshot próprio ou worktree limpa para revisar, nem nova plataforma de subagentes.

**Não existe um watcher de avanço da base que lance revisores.**
Avanço da base sem impedimento efetivo não invalida sozinho os pareceres nem obriga a aprofundá-los.
Se for necessário reparar o PR, as alterações dessa Execução passam pelo fluxo de nova avaliação dos revisores.
Mudanças humanas desconhecidas continuam sujeitas à reconciliação autorizada, não são adoção automática nem licença para escrever.
O contrato concreto dos pareceres e sessões está em
[Definir o pacote de skills e o contrato verificável de revisão e validação](17-skills-and-review-contract.md#answer).
A resolução posterior explicita a exceção ao ato de commit para conteúdo idêntico já revisado e a recuperação de falha parcial;
aplicar essas condições, sem estendê-las a equivalência semântica ou dispensar checks do SHA pertinente.

### Base, conflito e gatilhos de manutenção

| Observação | Ação |
| --- | --- |
| Base avançou; PR continua apto sem impedimento efetivo | Só acompanhar; não executar, revisar, rebasear ou converter a draft pelo mero avanço |
| Conflito de conteúdo confirmado | Reparo automático, sujeito a elegibilidade, limites e propriedade |
| Regra strict exige atualização e essa exigência efetivamente impede merge | Reparo automático para incorporar base, sem comando adicional por ocorrência |
| Branch atrasada em regra loose, sem outro impedimento | Atraso sozinho não bloqueia e não gera manutenção |
| `mergeable` desconhecido/cálculo em andamento | Reconsultar e mostrar indeterminação; não é conflito confirmado nem sucesso |
| Aprovação humana pendente, CI pendente, permissão/configuração | Etapa humana, espera ou bloqueio correspondente; não usar “não mergeável” como gatilho genérico |

Confirmar a exigência strict e o atraso correspondente; um estado agregado `BLOCKED`/`BEHIND` isolado não prova a causa.
A atualização strict é a extensão de gatilho expressamente aprovada em Q10 e alinhada a RF-09 do PRD.
Seguir rebase por padrão salvo política do repositório, branch própria, lease com expectativa preservada e nenhuma reescrita da base.
Gatilhos consolidados da mesma correção não criam outro escritor nem cobram evento individual;
respeitar categoria prioritária de reparo, contadores e suspensões já definidos, sem teto ou retry extra inventado aqui.

### Prontidão, draft e reconciliação

Pronto exige ambos os pareceres aplicáveis, tratamento registrado dos achados, gates locais atendidos/dispensados legitimamente,
checks GitHub satisfeitos, ausência confirmada de conflito e nenhum impedimento da preparação.
Autorização/dependências, pergunta, limite, propriedade incerta ou concorrência não reconciliada não desaparecem por CI verde.
Aprovações humanas exigidas para merge continuam visíveis como etapa seguinte, não como aprovação emitida pela fábrica.

- Perda confirmada das condições: retirar prontidão e converter a draft. Registrar motivo; não confundir invalidação com entrega/cancelamento.
- Falha transitória de leitura ou cálculo desconhecido: retirar confirmação interna, preservar a flag até evidência suficiente e reconsultar;
  não alternar draft/ready a cada falha de rede.
- Restaurar ready automaticamente após avaliação completa se a fábrica colocou o PR em draft por suas próprias condições.
- Transição inesperada para draft não atribuível à fábrica: respeitar e pedir autorização antes de reconverter, sem disputar a flag com humano.
- Ready observado sem evidências suficientes não certifica prontidão; perda confirmada segue a política de draft, incerteza segue reconciliação.
- Intenção confirmada → chamada → observação → confirmação durável também vale para draft/ready.
  Após crash/timeout descobrir estado e reavaliar antes de repetir; cancelamento impede nova chamada, não desfaz a já enviada.

Retorno a draft não é cancelamento nem cleanup. A restauração não zera contadores ou renova autorização.
O polling não detecta intenção humana que não produziu mudança observável; não prometer identificação perfeita de toda intervenção.

### Casos adversos e provas posteriores

| Caso a demonstrar | Resultado exigido |
| --- | --- |
| Resultado verde só no SHA anterior ou App divergente | Atual não satisfeito; nenhum verde emprestado |
| Contexto requerido nunca publicado ou rerun pendente após verde | Espera, sem reparo por ausência e sem prontidão falsa |
| Check-run skipped/neutral, mas gate local não executado | GitHub pode estar satisfeito; gate local continua pendente sem dispensa explícita |
| Check e status homônimos, só um verde | Não pronto até ambos satisfazerem a exigência |
| Proteção tradicional + rulesets herdados, requisito novo ou página incompleta | Acumular requisitos; leitura incompleta/desconhecida nunca vira conjunto vazio |
| Head/regra/base muda durante coleta ou conversão | Invalidar avaliação externa e reconciliar; não acionar reviewers só por avanço da base |
| Base avança repetidamente, PR continua apto | Zero Execuções/reviews/rebases/drafts causados apenas pelo avanço |
| Conflito ou atraso strict efetivamente impede merge | Um reparo consolidado e limitado, sem comando adicional por ocorrência |
| Aprovação de workflow/review humano pendente ou mergeability desconhecida | Classificação própria, sem reparo genérico para “destravar merge” |
| Reparo muda commits e há sessões anteriores | Ambos emitem novos pareceres, incremental ou amplo justificado, sem escrita do revisor |
| Sessão perdida/revisor falha/Spec ausente | Recuperar/substituir ou bloquear, nunca usar ausência como revisão limpa |
| CI opcional falha ou evento antigo reaparece | Não criar reparo automático apenas por esse evento |
| PR antes pronto falha, consulta falha ou humano muda draft | Distinguir perda confirmada, incerteza e intervenção humana conforme a política |
| Crash após conversão, cancelamento concorrente ou resposta API perdida | Descobrir efeito e revalidar sem chamadas cegas ou prontidão baseada apenas na flag |

Na implementação, testar o avaliador com respostas simuladas, paginação pequena, reordenação/duplicação de resultados,
falhas entre páginas e mudanças entre leituras, sem precisar executar modelo para provar as regras de controle.
Depois, provar APIs/permissões, regras e efeitos reais em repositórios de teste/pilotos autorizados,
com evidência de head/merge de teste, strict/loose, draft/ready e sessões/revisões reais.
Documentação, simulação e demonstração real são evidências distintas; esta sessão não executou essas provas nem aceitou o MVP.

Cobertura: RF-06–09, RF-13, RNF-01/03/04 e CA-01/04/06/12; conferir dependências/elegibilidade com CA-02/10.
Os custos/limites de revisões incrementais e repetidas e as particularidades de cada configuração GitHub precisam da validação posterior.

Encaminhamentos, sem resolver outros tickets nesta sessão:

- [Definir o contrato de permissões e verificação da GitHub App](11-github-app-contract.md): leituras e conversões restritas, ausência versus acesso negado.
- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md): recibos/pareceres/intenção de conversão atuais.
- [Definir a captura versionada da especificação e das instruções](16-specification-snapshot-contract.md): referências usadas nas avaliações.
- [Definir o pacote de skills e o contrato verificável de revisão e validação](17-skills-and-review-contract.md): sessões próprias e pareceres incrementais explícitos.
- [Definir o fluxo de manutenção e reconciliação autorizada do PR](20-pr-maintenance-contract.md): gatilhos consolidados, strict, lease e intervenções humanas.
- [Definir observabilidade, proteção de segredos e retenção dos artefatos](22-observability-retention-contract.md): motivos/evidências e contexto de sessões necessário à retomada.
