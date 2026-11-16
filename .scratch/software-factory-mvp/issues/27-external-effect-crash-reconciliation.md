# 27: Reconciliar efeitos externos nos cortes de crash

**What to build:** Quando o controlador ou worker cai perto de uma mutação externa, a instalação recupera o resultado observado sem duplicar PR, pergunta ou limpeza, nem sobrescrever mudança humana. Ambiguidade aparece como bloqueio acionável.

**Blocked by:** [17: Confirmar entrega e limpar somente recursos próprios](17-confirmed-delivery-and-owned-cleanup.md); [21: Preservar mudanças humanas durante atualização da branch](21-human-changes-and-explicit-lease.md); [26: Recuperar Execuções sem adotar sobreviventes](26-execution-recovery-without-survivor-adoption.md)

**Status:** resolved

## Acceptance criteria

- [x] Bateria corta antes/depois de chamada/observação/commit de criação/publicação e conversão de PR, comentário de Pergunta e remoção de recursos próprios, preservando correlações esperadas.
  - Evidência: Pergunta `question-rules` "cut battery" (R), `effects27-crash` "POST landed … killed before the result commit" (S+K, SIGKILL real); publicação `publication-flow` AC6/HIGH 2/"ticket 27 AC2" (S); conversão `readiness-flow` LOW/V-12/MED 2 (S); remoção `delivery-flow` AC5 crash e `github-delivery` DELETE perdido (S, I). Real: cortes A (Pergunta) e B (push) do ensaio `q27-crashfx-v2` (A); conversão e remoção não foram cortadas no real. [evidência](../../../docs/evidence/27-external-effect-crash-reconciliation.md).
- [x] Push/criação direta pelo Builder usa registros normais e descoberta Git/PR após cessação, sem inserir intenção/ACK específico obrigatório por publicação ou transformar Builder em operação replay-safe.
  - Evidência: `publication-flow` "ticket 27 AC2", AC6 (S); real `q27-crashfx-v2` corte B: SIGKILL depois do push observado, Execução reconciliada (`sandbox-stop`), PR #37 vinculado no head verificado, 1 PR próprio, ≤ 1 push do head, leases exatos (`pushCut`, `publicationReconciled`, `publicationLinked`, `singleOwnPullRequest`, `atMostOnePushOfHead`, `explicitLeases`) (A).
- [x] Efeitos do controlador preservam intenção durável e resultado conhecido/indeterminado; perda de transporte não comprova ausência, leitura parcial não autoriza repetir POST.
  - Evidência: `question-flow` "unconfirmed, never reposted" e AC2 ambíguo (S), `question-rules` (R), `github-question-comments` 5xx/4xx (I); real `q27-crashfx-v2` corte A: POST real retornou, morte antes do commit, tentativa `[attempting, discovered]`, 0 reposts, 1 comentário (`questionCut`, `questionDiscovered`, `questionNeverReposted`, `singleQuestionComment`) (A).
- [x] Descoberta usa identidade/autoria/correlação e ref/OID esperado efetivamente preservado, não apenas nome de branch ou primeira lista vazia; múltiplos candidatos exigem intervenção.
  - Evidência: `question-flow` "late listing links it", `question-rules` (múltiplos → `conflict`), `publication-flow` "ticket 27 AC7/AC4" e AC6 múltiplos (S, R); real `q27-crashfx-v2`: Pergunta encontrada por marcador + autoria App com o mesmo id de comentário; PR vinculado por marcador/autor/branch/head verificado (`branchAtVerifiedHead`) (A).
- [ ] Resposta durante boot e ACK perdido de Pergunta recuperam registro/conteúdo integral e aceitam uma resposta; falta de conteúdo não é preenchida por invenção.
  - Parcial na fronteira real: a resposta postada com o controlador parado foi aceita uma vez no boot do `c-publish` (`singleAnswerAccepted`, A). O ACK perdido recuperado de Records só foi provado localmente: `effects27-crash` "lost ACK" (S+K), `effects27-flow` MED 2 (registro parcial → `RECOVERY_BLOCKED`, S), `question-observation` (I), `recoveredQuestionDecision` (R). No v2 a Execução já estava assentada antes do corte A, então a recuperação via Records não foi exercida no real.
- [ ] Cleanup parcial após merge retoma só pendentes com ownership/cessação/evidência revalidados; entrega confirmada não é desfeita nem ausência de recurso presumida por erro.
  - Só local neste ticket: `delivery-flow` AC5/AC6 e `github-delivery` (S, I; ticket 17). O ensaio do 27 não teve merge nem cleanup, então nenhum corte de crash no cleanup foi provado na fronteira real.
- [ ] Push humano concorrente e expectativa perdida impedem nova escrita sem reconciliação concreta; sem recaptura de lease ou repetição cega de comando após crash.
  - Só local para a variante após crash: `publication-flow` "ticket 27 AC7/AC4" (restart, expectativa preservada, diverge, nenhuma escrita nova) e `humanchanges-flow` (S). O lease que falha diante de um push humano tem prova real no ticket 21, mas sem crash; o ensaio do 27 não teve push humano.
- [ ] Provas reais com GitHub/Git/processos e agentes nos cortes pertinentes registram ausência comprovada de duplicatas e efeitos tardios durante cancelamento, distinguindo inconclusivo de aprovado.
  - Parcial: o real `q27-crashfx-v2` (issue #36; GitHub, VM, modelo e SIGKILL de processos reais) provou ausência de duplicatas nos cortes A e B, com veredito `passed`/`failed`/`inconclusive` (`crashfx27-recipe-safety`). Deu 14/14 depois de corrigido o oráculo `questionExecutionSettled` da receita (reavaliação das mesmas evidências). Efeitos tardios durante cancelamento só foram provados localmente (`question-flow` "ticket 27 AC8 + ticket 25", S); a receita não tem corte de cancelamento.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 3.4, 5.2, 5.5, 9.1, 9.3, 10.1, 12.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-12, V-14 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-16 ([evidência](../../../docs/evidence/27-external-effect-crash-reconciliation.md)). Inventário de todos os efeitos externos
(Pergunta, registro/ACK, push/PR do Builder, lease, draft/ready, cleanup, tokens, VM): duas lacunas corrigidas. (1) Uma listagem completa vazia
depois de um POST de Pergunta possivelmente enviado não republica mais: estado `unconfirmed`, nova descoberta a cada ciclo, resposta local.
(2) Um ACK/notificação perdido por crash é recuperado de Records no boot, com a mesma identidade e conteúdo; um registro perdido bloqueia.
Depois da revisão: só um achado positivo muda a recuperação comum; recusas ao vivo são respeitadas; a parada administrativa mantém sua
intenção; um Trabalho cancelado não recebe POST novo, mas efeitos tardios ainda são descobertos. Provas: regras, fluxos S, SIGKILL real local
e o ensaio real `q27-crashfx-v2` (issue #36), aprovado 14/14 depois de corrigido um oráculo da receita (a Execução da Pergunta já estava
assentada ao vivo antes do corte A). Abertos: republicação autorizada de `unconfirmed`; retry de falhas conhecidas da Pergunta (até 5);
conversão draft/ready incerta de um Trabalho cancelado não é redescoberta.

