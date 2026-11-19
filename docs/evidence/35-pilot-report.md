# 35: relatório do piloto 1 (2026-11-18/19)

Pedido e autorização: [35-pilot-authorization-request.md](35-pilot-authorization-request.md). Ticket:
[35](../../.scratch/software-factory-mvp/issues/35-authorized-pilot-and-human-mvp-assessment.md). Evidência bruta (fora do repositório):
`/home/sanmoo/software-factory-test/pl1-pilot-evidence/` (`findings.md`, `watch.log`, `status-final.json`, `usage-final.json`,
`session-tokens-final.txt`, ruleset antes/depois, `upgrade-*-34.6.json`).

## 1. Resumo

O piloto rodou cerca de 11 horas de janela (01:06–12:05 UTC) com 5 Tickets reais em `Sanmoo/java-springboot-event-sourcing`. **Nenhum
Ticket foi entregue e nenhum PR foi publicado.** O #124 chegou mais longe: implementação completa (17 arquivos, commit `d195d34`), gate
completo `./gradlew check acceptanceTest` verde dentro do guest e revisões sem achados, mas a publicação não aconteceu porque o boot seguinte foi
recusado por disco inconsistente. A janela foi encerrada por decisão do operador quando esse defeito passou a bloquear todos os Trabalhos.

O piloto achou 14 problemas reais, nenhum visto na qualificação (que usou Tickets de documentação): falta de runtime do projeto no guest, edit
de arquivo grande fatal (corrigido durante a janela, release `mvp-34.6`), orçamento do Builder e do revisor pequenos para código real, disco
do guest inconsistente após parada, recusas sem retry, medição de consumo incompleta e excesso de Perguntas evitáveis. Viraram os tickets
44–53 (46 já integrado).

## 2. Composição e mudanças durante a janela

| Quando (UTC) | Composição |
| --- | --- |
| 01:06 | `pl1` nova, release `mvp-34.5` (`f3c7cf3`), skills v7, `concurrency` 3, guest 3072 MiB / 2 vCPU / 40 GiB, ruleset sem `update` |
| 07:5x | release `mvp-34.6` (`aaf87a9`: ticket 46 e skills v8) por `upgrade check/apply` com o storage pausado |
| 08:3x | `concurrency` 2, guest 4096 MiB (decisão do operador após a recusa de boot por memória) |
| 09:38 | teto de consumo dobrado pelo operador: 60 M → 120 M tokens |
| 12:05 | encerramento: labels removidos, ruleset restaurado (com `update`), serviço parado, chave da App removida |

## 3. Resultado por Ticket

| Ticket | Ciclos | Até onde foi | Por que parou |
| --- | --- | --- | --- |
| #124 histórico de eventos | 2 | implementação completa, gate verde no guest, Spec `clean` (rebaixado falsamente), proposta final autorizada | boot da Execução de publicação recusado (`START_PRESERVED_DISK_CHECK_REQUIRED`) |
| #125 captura parcial | 2 | decisão do operador (a), commit "Support partial purchase authorization captures", revisão Spec pediu evento V2 e IT de evento legado (aprovado) | idem, disco |
| #126 bloqueio de conta | 3 | implementação completa no 3º ciclo, Standards `clean` | Spec esgotou o orçamento 3 vezes (`REVIEWER_RETRY_LIMIT`); retirado do piloto |
| #127 filtro por status | 1 | admitido, `DEPENDENCY_PENDING` (#126) | retirado com o #126 |
| #128 scripts e README | 1 | admitido, `DEPENDENCY_PENDING` (#124) | o bloqueador não foi entregue |

Os ciclos novos (`cancel` + `new`) foram necessários porque recusas de boot/preparo e a mudança de configuração não têm retry (ticket 50).

## 4. As 13 obrigações dependentes do piloto

| Obrigação | Resultado | Base |
| --- | --- | --- |
| V-02.h | fora do escopo, declarado | nenhum Ticket usou Compose ou `docker build` |
| V-04.P | **provada** | os 5 Tickets entraram pelo label, um Trabalho por Ticket; ciclos novos só por `factory new` explícito |
| V-05.P | parcial | #127/#128 ficaram `DEPENDENCY_PENDING` corretamente; a liberação após entrega não foi observada |
| V-06.e | parcial | suíte real com Testcontainers verde no guest (#124); três suítes simultâneas não ocorreram (capacidade caiu para 2) |
| V-06.g | não provado (risco D-15) | I/O e disco do guest não medidos; o problema de disco do ticket 47 é de consistência, não de capacidade |
| V-07.P | provada | pedido, respostas e instruções preservados por versão (`/artifacts/spec/vN`, `instructions/v1`), inclusive após Pergunta |
| V-08.P | parcial | Spec do #125 achou falhas reais e úteis (evento V2 explícito, IT de evento legado); nenhuma rodada verificada por defeitos do Host (ticket 51) |
| V-09.P | não provado | nenhuma publicação |
| V-10.P | não provado | nenhum PR para `CHANGES_REQUESTED`/`/factory repair` |
| V-11.P | **provada** | 14 Perguntas reais publicadas no issue e respondidas por `/factory answer` do operador; retomadas registradas |
| V-14.P | não provado | nenhuma entrega; nenhum `forget` |
| V-15.P | parcial | tempos e eventos por Trabalho registrados; consumo medido só em parte pelo produto (ticket 49) |
| V-17.P | não provado | nada entregue para avaliação humana |

## 5. Métricas

- **Consumo:** 53,2 M tokens somando as sessões preservadas (deduplicado); `factory usage` registrou 14,3 M porque 20 de 48 atividades ficaram
  `unavailable` (ticket 49). Estimativa do SDK para a parte medida: 1,06 (unidade do catálogo, sem moeda).
- **Perguntas:** 14 (#124: 3, #125: 5, #126: 6); 3 eram decisões do Ticket ou do desenho, 11 vieram de skills, ambiente ou defeitos (ticket 53).
- **Execuções do Builder:** quase todas terminaram por fim de orçamento (60 requisições) em 10–30 minutos, cada uma gastando uma recovery
  (ticket 48); #124 e #125 precisaram de `grant`.
- **Capacidade:** 3 × 3072 MiB não coube no host de 15,7 GiB (boot recusado); 2 × 4096 MiB funcionou.

## 6. Achados e tickets

| Achado (`findings.md`) | Ticket |
| --- | --- |
| 2 guest sem JDK; o gate é do projeto, o ambiente também deveria ser | [44](../../.scratch/software-factory-mvp/issues/44-per-project-guest-environment.md) |
| 4 timeout de bash fatal; recovery sem a causa | [45](../../.scratch/software-factory-mvp/issues/45-recovery-cause-and-build-timeouts.md) |
| 3 edit > 8 KiB fatal | [46](../../.scratch/software-factory-mvp/issues/46-noncritical-tool-refusals.md) (integrado, `mvp-34.6`) |
| 10, 14 disco do guest inconsistente após parada | [47](../../.scratch/software-factory-mvp/issues/47-clean-guest-stop-and-disk-recovery.md) |
| 8 orçamento do Builder | [48](../../.scratch/software-factory-mvp/issues/48-builder-budget-continuation.md) |
| consumo não medido | [49](../../.scratch/software-factory-mvp/issues/49-usage-of-budget-closed-sessions.md) |
| 1, 5, 6 recusas sem retry; config invalida ambientes | [50](../../.scratch/software-factory-mvp/issues/50-operator-retry-of-blocked-start-and-preparation.md) |
| 11, 12 revisão incompleta falsa; orçamento do revisor | [51](../../.scratch/software-factory-mvp/issues/51-review-reads-past-eof-and-reviewer-budget.md) |
| 9, 13 cancelamento de Execução retida; retidas invisíveis | [52](../../.scratch/software-factory-mvp/issues/52-cancel-of-held-execution.md) |
| 7 Perguntas evitáveis | [53](../../.scratch/software-factory-mvp/issues/53-question-cost-from-skills.md) |

## 7. Erros do supervisor (registrados para não repetir)

- O gate dos Tickets incluía "stop if the environment prevents a test from running", o que fez os Builders pararem em vez de instalar o JDK.
- O primeiro observador contava Vagas ocupadas como Builders rodando: o #124 ficou retido de 01:13 a 08:38 sem ser notado, e o consumo
  reportado ao operador (2,3 M) estava muito abaixo do real.
- A mudança de `memoryMiB` foi aplicada sem verificar que invalidaria os ambientes preparados (#125 perdeu o ciclo).
- O primeiro diagnóstico do disco (journal pendente) estava errado; corrigido após teste numa cópia.

## 8. Estado final

- GitHub: nenhum PR aberto, nenhuma branch `factory/*` no remoto, issues #124–#128 abertos e sem label; ruleset `26435808` restaurado
  (`pull_request`, `non_fast_forward`, `deletion`, `update`).
- `pl1`: serviço parado, chave da App removida, login do modelo mantido, Trabalhos e ambientes preservados como evidência (o commit `d195d34`
  do #124 está só no checkout do ambiente).

## 9. Recomendação

Um piloto 2 só vale depois dos tickets 47, 48, 50 e 51, que hoje impedem qualquer entrega de código; 44, 49, 52 e 53 reduzem custo e
intervenção e entram de preferência antes. O mesmo conjunto de Tickets (#124–#128) pode ser reaproveitado.
