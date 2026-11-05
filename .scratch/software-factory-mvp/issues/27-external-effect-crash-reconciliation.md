# 27: Reconciliar efeitos externos nos cortes de crash

**What to build:** Quando o controlador ou worker cai perto de uma mutação externa, a instalação recupera o resultado observado sem duplicar PR, pergunta ou limpeza, nem sobrescrever mudança humana. Ambiguidade aparece como bloqueio acionável.

**Blocked by:** [17: Confirmar entrega e limpar somente recursos próprios](17-confirmed-delivery-and-owned-cleanup.md); [21: Preservar mudanças humanas durante atualização da branch](21-human-changes-and-explicit-lease.md); [26: Recuperar Execuções sem adotar sobreviventes](26-execution-recovery-without-survivor-adoption.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Bateria corta antes/depois de chamada/observação/commit de criação/publicação e conversão de PR, comentário de Pergunta e remoção de recursos próprios, preservando correlações esperadas.
- [ ] Push/criação direta pelo Builder usa registros normais e descoberta Git/PR após cessação, sem inserir intenção/ACK específico obrigatório por publicação ou transformar Builder em operação replay-safe.
- [ ] Efeitos do controlador preservam intenção durável e resultado conhecido/indeterminado; perda de transporte não comprova ausência, leitura parcial não autoriza repetir POST.
- [ ] Descoberta usa identidade/autoria/correlação e ref/OID esperado efetivamente preservado, não apenas nome de branch ou primeira lista vazia; múltiplos candidatos exigem intervenção.
- [ ] Resposta durante boot e ACK perdido de Pergunta recuperam registro/conteúdo integral e aceitam uma resposta; falta de conteúdo não é preenchida por invenção.
- [ ] Cleanup parcial após merge retoma só pendentes com ownership/cessação/evidência revalidados; entrega confirmada não é desfeita nem ausência de recurso presumida por erro.
- [ ] Push humano concorrente e expectativa perdida impedem nova escrita sem reconciliação concreta; sem recaptura de lease ou repetição cega de comando após crash.
- [ ] Provas reais com GitHub/Git/processos e agentes nos cortes pertinentes registram ausência comprovada de duplicatas e efeitos tardios durante cancelamento, distinguindo inconclusivo de aprovado.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 3.4, 5.2, 5.5, 9.1, 9.3, 10.1, 12.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-12, V-14 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
