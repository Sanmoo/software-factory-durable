# 35: solicitação de autorização do piloto (rascunho para o operador)

Ticket: [35](../../.scratch/software-factory-mvp/issues/35-authorized-pilot-and-human-mvp-assessment.md). Qualificação que a
libera: [34-candidate-qualification.md](34-candidate-qualification.md) e
[34-qualification-matrix.json](34-qualification-matrix.json) (99 aprovadas, 0 reprovadas, 0 inconclusivas, 13 dependentes do piloto;
G1–G6 sem bloqueio). Ensaios pré-piloto: [34-prepilot-results.md](34-prepilot-results.md).

**Este documento só pede autorização. Nada foi iniciado:** nenhum Ticket criado, nenhum label aplicado, nenhum controlador iniciado,
nenhuma escrita no GitHub. Cada item da seção 8 precisa de um "sim" explícito do operador antes de qualquer efeito. Um "não" (ou item
sem resposta) bloqueia a parte do piloto que depende dele. Merge, aprovação e avaliação humana nunca são delegados aos agentes.

## 1. Composição

| Campo | Valor |
| --- | --- |
| Release | `mvp-34.5`, construída da ponta limpa da integração (`dirty: false`) pelo R-UPG v5 (`prel34-v5`) |
| Commit | `f3c7cf3041dd01e6136f4b53ec4db4b4e17b809c` (descende do candidato anterior `b30e2bd`) |
| Manifesto / arquivo | `4988db2aa98c3a1dbc6e790628b80afcc9d18d74247d172396bbe035ddd0796e` / `f50795dd18db69aa0670d3861e13f85e74b1d836690eaf0da5554dfc50a32ad7` |
| Contém | tickets 01–33, 36–41, 43; D-07 (`5a026e7`), V-09.f (`f4cb958`), bus do owner (`5ab72fa`), `b4c5443`, `factory-skills-v7` (`82d6faf`), revisão de reconciliação (`6c4a9e0`) |
| Instalação atual | `/home/sanmoo/software-factory-test/pr2`, release selecionada, doctor `release:*` ok (`release:qualification: unverified` é a afirmação do manifesto) |
| Serviço | unit do usuário `software-factory-0cb1d1f488b0.service` (registrada, nunca `enable`), hoje inativa; storage não pausado |
| Pacote do Builder | `factory-skills-v7` 7.0.0; revisores Standards/Spec com o perfil do SDK `factory-development-pi-1.5.2-read-async-bash-lexical-v3` |
| Modelos | Builder, Standards e Spec: `openai/gpt-6-luna` via `factory-oauth` (login do operador); sem retries de provedor/SDK |
| Assets do guest | `assets34` (manifesto `8efa506a…`), perfil `gondolin-qemu-alpine-dev-v1`, Docker 29.5.2 (vfs) |
| Host | Arch Linux, kernel 7.1.9, QEMU 11.1.2, systemd 262, 8 CPUs, 15,7 GiB, KVM |

Prova da composição: [34-r-upg-v5-release.json](34-r-upg-v5-release.json). A revalidação das provas antigas na troca de candidato
(9 sinalizadas: 7 revalidadas por ensaios no código do candidato e 2 mantidas com limite por D-17; nenhum estado alterado) está na seção 2 de [34-candidate-qualification.md](34-candidate-qualification.md).

## 2. O que o piloto fará

**Proposta (o operador ajusta na seção 8):**

- **Raiz.** Opção A: `pr2` como está (release já selecionada, login do modelo já feito; o storage guarda os Trabalhos cancelados e
  entregues da qualificação). Opção B (recomendada): raiz nova `pl1` (38 bytes ou menos) com o mesmo arquivo `mvp-34.5`, `setup --service`,
  `doctor` e um login novo do modelo. Assim as métricas do piloto não se misturam com a qualificação.
- **Repositório.** `Sanmoo/java-springboot-event-sourcing` (Java/Spring Boot com Testcontainers; base `main`, ruleset `26435808`).
  Ele tem as ITs que o ticket 24 não fechou (V-06.e). Hoje não há PR aberto e só o issue #1 está aberto; restam branches `factory/*`
  da qualificação (seção 7).
- **Tickets.** De 4 a 6 Tickets **reais** do backlog, escritos pelo operador, julgáveis e com gates reproduzíveis (`./gradlew test` e ITs).
  Cobertura mínima:
  1. três Tickets elegíveis ao mesmo tempo no mesmo repositório (três Builders, dois ou mais no mesmo repo, suítes com containers
     simultâneos);
  2. um Ticket com dependência nativa (`blocked_by`) de outro, liberado só depois da entrega do bloqueador;
  3. um Ticket cujo pedido deixe uma decisão ao operador, para haver Pergunta real;
  4. pelo menos uma revisão humana `CHANGES_REQUESTED` e um `/factory repair` real feitos pelo operador quando a entrega pedir.
- **Escala.** `concurrency` 3. Guest 4096 MiB / 2 vCPU / 40 GiB. Com 15,7 GiB de host, três guests de 4096 MiB deixam pouca folga: a
  Factory recusa o boot quando falta memória (`INSUFFICIENT_MEMORY_FOR_BOOT`, visto no R-GH-ADV-S v1). Alternativa: 3072 MiB por guest
  na janela com três simultâneos. `minFreeSpaceGiB` 4; `correctionLimit` 3; `recoveryLimit` 3; `pollingSeconds` 60.
- **Duração.** Até 3 dias corridos de janela, com o controlador em modo serviço só enquanto o operador estiver disponível para
  responder Perguntas e revisar. Fora disso, `factory pause` e a unit parada.
- **Contas e App.** GitHub do operador `Sanmoo` (id 1881597, único operador da configuração); App `sanmoo-factory` (App 5569788,
  instalação 177599217, sem bypass no ruleset). A chave da App fica em `<raiz>/credentials/app.pem` (0600) só durante a janela e é removida
  ao fim. O login do modelo fica no store `factory-oauth` da raiz e não é copiado.
- **O que a Factory pode escrever.** Pushes com lease só na própria branch `factory/<n>-…`, UM draft PR por Trabalho e a conversão a pronto
  do próprio PR. Também comentários de Pergunta e resposta no issue, reabertura do próprio PR e limpeza da própria branch e do ambiente
  após a entrega. Nunca: merge, aprovação, `--force`, push na base, bypass ou mudança de ruleset.

## 3. As 13 obrigações dependentes do piloto e como o piloto as prova

| Obrigação | Nível | Expectativa | Como o piloto prova | Evidência a registrar |
| --- | --- | --- | --- | --- |
| V-02.h | I | API/Compose/build conforme os pilotos | só se um Ticket selecionado usar Compose ou `docker build` (D-04); senão continua fora do escopo suportado, declarado | registro da seleção; se usado, saída do guest e resultado |
| V-04.P | P | entrada real no piloto | os Tickets reais entram pelo label, um Trabalho por Ticket, sem duplicação | `list`/`show` por Trabalho; ausência de segundo Trabalho |
| V-05.P | P | dependência real no piloto | o Ticket bloqueado só é despachado após a entrega do bloqueador | histórico de dependências, horários de elegibilidade e despacho |
| V-06.e | I+A | containers simultâneos das suítes reais sem colisão, as três suítes concluindo | três Builders simultâneos rodam as suítes com Testcontainers no guest. Uma IT que falhar volta ao operador com o motivo (sem bypass de testes, Ryuk ou TLS) | saídas dos gates, ambientes por boot, falhas e causa |
| V-06.g | I | I/O e disco medidos | **não provado: risco conhecido (D-15).** O piloto registra o que existir (memória, CPU, tempos) e marca I/O e disco do guest como não medidos | `usage` e resumos de execução com a lacuna explícita |
| V-07.P | P | pedido real no piloto | pedido e instruções preservados por Execução, inclusive após Pergunta e reparo | `sources.json` por versão; rodadas com uma versão de instruções |
| V-08.P | P | qualidade dos pareceres/validações em tickets reais | Standards e Spec revisam propostas reais; o operador julga se os achados e as validações são úteis | rodadas, achados, tratamentos e verificação; avaliação do operador |
| V-09.P | P | publicação/prontidão em tickets reais | draft verificado, conversão a pronto pela Factory, prontidão bloqueada quando checks ou regras bloqueiam | estado da publicação, leituras de checks e ruleset |
| V-10.P | P | manutenção de PR em tickets reais | `CHANGES_REQUESTED` e `/factory repair` reais tratados no mesmo PR; base que avança tratada sem reparo inútil | correções, reparos, leases e histórico |
| V-11.P | P | interação real com operador | Perguntas reais publicadas no issue e respondidas por comentário do operador | Perguntas e respostas (origem, autor) e retomadas |
| V-14.P | P | cleanup de entrega real | após o merge humano, branch e ambiente próprios removidos; evidências preservadas. Se o operador fizer `forget` de um Trabalho entregue ou cancelado, observar o scrub do SQLite (limite D-17) | `cleanup` por Trabalho; retenção; estado do scrub (`scrubbed`/`pending`) no `status` |
| V-15.P | P | métricas do PRD no piloto | tempos de elegibilidade, início, PR, prontidão e merge separados da espera; intervenções, Perguntas, correções, recoveries, consumo dos três papéis | `status`/`usage`/`history` e o relatório do piloto |
| V-17.P | P | utilidade e qualidade com avaliação humana; CA-08 com suítes reais | o operador registra aderência, qualidade e utilidade de cada entrega e do conjunto | avaliação escrita do operador no relatório do piloto |

Nenhuma dessas obrigações vira aprovada pela execução sozinha. P exige a avaliação humana registrada, e V-06.g segue como risco conhecido.

## 4. Riscos conhecidos

- **D-15, V-06.g: I/O e disco do guest não medidos.** `io.stat` é ilegível na delegação systemd do usuário. O piloto não terá essa
  métrica, e a decisão sobre capacidade fica sem esse dado.
- **Revisor Standards relendo em laço e orçamento (R-GH-ADV v2/v3).** Antes do ticket 43, numa reconciliação, o Standards esgotava as
  24 requisições em toda rodada (`WORKER_INTERRUPTED`). O defeito foi corrigido em `6c4a9e0` (validado em q34-ghadv-v4). Mas o
  orçamento por revisor continua fixo (`reviewer-v1`). Uma proposta grande ou ambígua pode esgotá-lo e terminar `REVIEW_NOT_VERIFIED`
  ou numa Pergunta.
- **Variação do modelo em achados do Spec e tratamentos do Builder (R-CAND v3–v8, R-GH-CHECKS v2–v4).** Achados de requisito julgados nos
  dois sentidos, achados falsos sobre conteúdo já correto (FIX_NOT_REVIEWED, verificação correta) e Builder que não pergunta quando a
  skill manda (R-INSTR v1). No piloto as Perguntas são respondidas de verdade, não por roteiro. O risco vira custo de interação e de
  correções, que as métricas registram.
- **Ticket 42: teste instável `test/records/raw.test.ts` sob carga.** Afeta só a suíte de desenvolvimento (`test:ci`) com VMs no host,
  não o produto em execução. Durante o piloto, nenhum gate de desenvolvimento é rodado no mesmo host sem registrar a carga.
- **Limites das decisões D-09…D-17:**
  - D-09: V-08.g aprovada por evidência; o veredito automático leu uma view podada.
  - D-10: a resposta durante o boot não foi observada pela granularidade da receita.
  - D-11: V-10.g aceita com "merge dentro da correção e nenhuma publicação depois".
  - D-12: V-04.e aprovada; o verificador da receita era estrito demais.
  - D-13: credencial expirada registrada `already-invalid` só depois do `expiresAt`.
  - D-14: ajuste de hora provado só em S; duração após crash só em I-local.
  - D-15: V-06.g é risco do piloto.
  - D-16: V-07.f provada pelo caminho de recusa (`GATE_NOT_RUN`), não pelo da Pergunta; a recusa de uma dispensa que cite o próprio `AGENTS.md` só está provada no código.
  - D-17: V-14.d e V-14.e mantidas com limite: o scrub do SQLite após `forget` (`5a026e7`, também chamado pela varredura de retenção) tem prova só S/I-local no candidato (ci-d07); nenhum ensaio real em `f3c7cf3`. Se o piloto fizer `forget` ou passar por uma varredura com Trabalho esquecido, registrar o resultado do scrub (`status`: memória mínima `scrubbed`/`pending`).
- **Memória do host com três guests.** Há risco de recusa de boot ou de ITs lentas. O motivo é registrado e o operador reduz a
  capacidade ou a memória do guest.
- **Custos do modelo.** O R-INSPECT mediu ~1,5 M tokens do Builder num Ticket pequeno de documentação. Tickets de código devem custar
  várias vezes isso. O consumo é medido pelos três papéis e não tem teto automático além dos orçamentos por Execução.

## 5. Regras de parada

**Parada imediata do piloto** (`factory pause`, unit parada, motivo registrado), em qualquer um destes casos:

- qualquer escrita fora do permitido na seção 2 (merge ou aprovação pela Factory, push na base ou em branch alheia, `--force`, mudança de
  ruleset);
- segredo (token, chave) em saída, PR, comentário ou arquivo de observação;
- limpeza de recurso que não é da Factory;
- disco do host abaixo do piso;
- estado inconsistente sem causa conhecida (Execução retida com motivo desconhecido, cessação não confirmada que se repete);
- consumo acima do teto aprovado na seção 8.

**Parada por Ticket** (o operador decide continuar, cancelar ou ajustar): limites de correção ou recovery atingidos; publicação
`not-publishable` ou `blocked`; Pergunta sem resposta dentro da janela; IT falhando no guest sem causa clara (vai para o relatório como
V-06.e).

**Nunca automático:** retry, bypass de gate ou de teste, reescrita silenciosa do Ticket, fallback para outro modelo.

## 6. Reversão

- **Trabalho:** `factory cancel <work>` (a cessação é confirmada pelo produto); o PR próprio é fechado sem merge pelo operador e a branch
  fica como evidência até o operador decidir a limpeza.
- **Controlador:** `factory pause` e `systemctl --user stop software-factory-<hash>.service`; a chave da App é removida da raiz.
- **Entrega ruim já mergeada:** o operador abre um PR de revert, que é um passo humano normal e nunca da Factory.
- **Release:** se um defeito da release impedir o piloto, `upgrade rollback` para `mvp-34.4` (mesmo formato de storage), seguido de
  `doctor`. Só com autorização própria e registrando o motivo.
- **Raiz nova (opção B):** pode ser removida inteira ao fim, depois de copiar as evidências; `pr2` não é tocado.

## 7. O que o operador precisa fazer ou autorizar

- **Antes:**
  - escolher a raiz (A ou B); para B, instalar `mvp-34.5`, `setup --service` e fazer `factory login` (interativo);
  - aprovar a configuração (seção 2);
  - decidir o que fazer com as 26 branches `factory/*` que sobraram da qualificação (lido em 2026-11-18: nenhum PR aberto, só o issue #1
    aberto, sem `ci/`);
  - escrever os Tickets reais.
- **Durante:**
  - aplicar o label `ready-for-agent` em cada Ticket;
  - responder Perguntas por comentário `/factory answer <id> <texto>`;
  - revisar (approve / request changes) e comentar `/factory repair` quando quiser;
  - fazer o merge humano de cada PR pronto.
- **Ruleset `26435808`.** Hoje exige PR com 1 aprovação e tem a regra `update`, que bloqueia o merge do PR próprio (o R-CAND removia
  `update` só em volta do merge). É preciso escolher entre:
  - (a) remover `update` durante a janela;
  - (b) relaxar só em volta de cada merge (passo do operador);
  - (c) manter, e a Factory reportará `MERGE_BLOCKED_UPDATE_RESTRICTED`.
- **Depois:** escrever a avaliação de cada entrega e do conjunto (V-17.P); decidir a limpeza e a retenção; remover a chave da App da raiz.

## 8. Autorizações solicitadas (marcar sim ou não em cada item)

| # | Autorização | Sim | Não |
| --- | --- | --- | --- |
| 1 | Usar a release `mvp-34.5` (`f3c7cf3`) como composição do piloto | [ ] | [ ] |
| 2a | Raiz A: usar `pr2` como está | [ ] | [ ] |
| 2b | Raiz B: criar `pl1` com o arquivo `mvp-34.5`, `setup --service`, `doctor` e um login novo do modelo pelo operador | [ ] | [ ] |
| 3 | Repositório `Sanmoo/java-springboot-event-sourcing`, base `main`, com a App `sanmoo-factory` (instalação 177599217) | [ ] | [ ] |
| 4 | Remoção prévia, pelo operador, das 26 branches `factory/*` da qualificação (ou mantê-las; a Factory nunca as toca) | [ ] | [ ] |
| 5 | De 4 a 6 Tickets reais escritos pelo operador, com a cobertura mínima da seção 2 | [ ] | [ ] |
| 6 | `concurrency` 3 com guest 4096 MiB / 2 vCPU / 40 GiB | [ ] | [ ] |
| 6b | Alternativa: guest 3072 MiB na janela com três simultâneos | [ ] | [ ] |
| 7 | Janela de até 3 dias corridos, serviço ativo só com o operador disponível | [ ] | [ ] |
| 8 | Chave da App em `<raiz>/credentials/app.pem` (0600) durante a janela, removida ao fim | [ ] | [ ] |
| 9 | Modelo `openai/gpt-6-luna` nos três papéis via `factory-oauth`, com teto de consumo de ____ tokens (o operador define) | [ ] | [ ] |
| 10 | Escritas da Factory listadas na seção 2 (branch própria com lease, UM draft PR, pronto do próprio PR, comentários, reabertura, limpeza própria) | [ ] | [ ] |
| 11a | Ruleset `26435808`: remover `update` durante a janela e restaurar ao fim | [ ] | [ ] |
| 11b | Ruleset: relaxar só em volta de cada merge humano | [ ] | [ ] |
| 11c | Ruleset: manter como está (merges bloqueados pela regra `update`) | [ ] | [ ] |
| 12 | Merge e aprovação só pelo operador (nunca pelos agentes) | [ ] | [ ] |
| 13 | Nenhuma injeção de falha no piloto (sem SIGKILL, congelamento, disco cheio ou relógio) | [ ] | [ ] |
| 14 | Limpeza pela Factory da própria branch e do próprio ambiente após cada entrega; retenção padrão de 30 dias | [ ] | [ ] |
| 15 | V-02.h: executar R-DOCKER-EXT só se um Ticket selecionado usar Compose ou `docker build` | [ ] | [ ] |
| 16 | Regras de parada da seção 5 | [ ] | [ ] |
| 17 | Reversão da seção 6, inclusive `upgrade rollback` para `mvp-34.4` se necessário | [ ] | [ ] |
| 18 | Registro de métricas (V-15.P) e da avaliação humana (V-17.P) no relatório do piloto | [ ] | [ ] |
