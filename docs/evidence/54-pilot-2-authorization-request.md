# 54: solicitação de autorização do piloto 2 (rascunho para o operador)

Ticket: [54](../../.scratch/software-factory-mvp/issues/54-pilot-2.md). Piloto anterior: [35-pilot-report.md](35-pilot-report.md)
(nenhuma entrega; bloqueadores corrigidos nos tickets 44, 47, 48, 50, 51 e 53, todos resolvidos só com testes offline).

**Estado em 2026-11-19:** nada foi instalado, nenhum Ticket foi editado, nenhum label aplicado, nenhum controlador iniciado e nenhuma escrita
no GitHub. Cada item da seção 8 precisa de um "sim" explícito do operador antes de qualquer efeito; um "não" (ou item sem resposta) bloqueia
a parte do piloto que depende dele. Merge, aprovação e avaliação humana nunca são delegados aos agentes.

## 1. Composição

| Campo | Valor |
| --- | --- |
| Release | `mvp-54.0`, construída da ponta limpa da integração (`dirty: false`) |
| Commit | `8f963bbc6cf09ecb965726239f3dbe3272b4c80f` (tickets 44, 46–48, 50, 51, 53 sobre `mvp-34.6`) |
| Manifesto / arquivo | `a42170e807f1561b1981f0ea8b50410c84c512dcbe31d03ee1dc624b2f8e3df3` / `613d1d832430d1f542e238b472c47652c6bc428038eab1ef5af6bc7999778afb` |
| Build | `/home/sanmoo/software-factory-test/y5/prel54-v1/build` (saída em `build-stdout.txt`) |
| Assets do guest | `assets35` (manifesto `72e00546…`): `assets34` com o rootfs ext4 **journalado** (ticket 47); só `rootfs` mudou |
| Pacote do Builder | `factory-skills-v10` (seams nomeados pelo Ticket aprovados, respostas nunca repetidas, ambiente declarado pronto) |
| Orçamentos | Builder 150 requisições / 300 ferramentas / 60 min por requisição; 5 continuações por Trabalho; revisor 48 / 160 / 30 min |
| Modelos | Builder, Standards e Spec: `openai/gpt-6-luna` via `factory-oauth` (login do operador) |
| Host | Arch Linux, 8 CPUs, 15,7 GiB, KVM |

## 2. O que o piloto fará

- **Raiz.** Raiz nova `pl2` (`/home/sanmoo/software-factory-test/pl2`) com o arquivo `mvp-54.0`, `setup`, `setup --service`, `doctor` e um
  `factory login` novo pelo operador. Ambientes da `pl1` não sobem com o pin novo dos assets; a `pl1` fica parada como evidência do piloto 1.
- **Repositório.** `Sanmoo/java-springboot-event-sourcing`, base `main`, ruleset `26435808`. Hoje: issues #124–#128 abertos e sem label,
  nenhum PR aberto, nenhuma branch `factory/*`, nenhum `.factory/`.
- **Ambiente declarado (ticket 44).** Antes da janela, o supervisor abre um PR que adiciona `.factory/environment.yaml` e o operador faz o
  merge. Conteúdo proposto ([44-java-springboot-environment.yaml](44-java-springboot-environment.yaml)):
  `apk: openjdk25-jdk=25.0.5.1_p2-r0` (Alpine v3.23, versão lida em 2026-11-19). Sem imagens pré-baixadas (o Testcontainers usa tags).
  Se a versão sair do mirror antes da janela, o arquivo é atualizado no mesmo PR.
- **Tickets.** Reusar #124–#128 do piloto 1. O supervisor edita os corpos para tirar todo detalhe de ambiente do gate: fica só
  `cd /workspace/checkout && ./gradlew check acceptanceTest`, sem "if the environment prevents a test from running, stop and say why"
  (critério 44 #8). Cobertura:
  1. três elegíveis ao mesmo tempo (#124, #125, #127) com `concurrency` 3;
  2. dependência nativa: #128 `blocked_by` #124 (como no fim do piloto 1);
  3. #126 entra depois de uma entrega, para o reviewer ter mudança média (ticket 51);
  4. pelo menos uma revisão humana `CHANGES_REQUESTED` e um `/factory repair` pelo operador quando a entrega pedir.
- **Escala.** `concurrency` 3 com guest 4096 MiB / 2 vCPU / 40 GiB. Três guests de 4096 MiB não cabem juntos com folga em 15,7 GiB: o
  terceiro boot é recusado por memória e, com o ticket 50, deve voltar à fila sozinho e subir quando outro terminar. Isso é a prova do
  critério (50) do ticket 54.
- **Fase de orçamento curto (provas 47 e 48).** Fim de orçamento no meio do Gradle não é garantido com 150 requisições. Proposta: começar
  com `builderBudget: {requests: 40}` no repositório até haver **um** fim de orçamento com progresso, com continuação no mesmo ambiente sem
  `START_PRESERVED_DISK_CHECK_REQUIRED` (prova 47 + 48). Depois, voltar ao valor da release com `factory pause`, troca do `config.yaml` e
  reinício do controlador (que também exercita a parada limpa do ticket 47).
- **Escritas da Factory.** As do piloto 1: branch própria com lease, um draft PR por Trabalho, pronto do próprio PR, comentários de
  Pergunta/estado, reabertura e limpeza própria.

## 3. O que será provado (critérios do ticket 54)

| Critério | Como |
| --- | --- |
| (44) JDK 25 pronto, mesmo ambiente nos Trabalhos seguintes, Testcontainers/Ryuk | primeiro boot de cada Trabalho; manifesto do disco base; `./gradlew check` verde no guest |
| (47) Gradle interrompido + boot seguinte no mesmo ambiente sem disco inconsistente | fase de orçamento curto; `guest-stop.json` `clean` |
| (48) Ticket de código médio entregue sem `grant` | qualquer entrega da janela |
| (50) recusa de memória volta à fila sozinha; recusa não transitória retomada pelo operador | `concurrency` 3; a segunda parte só se ocorrer naturalmente (sem injeção) |
| (51) Spec e Standards verificados num Ticket médio | revisões de #125/#126 |
| (53) Perguntas por Ticket por origem (Ticket, skill, ambiente, produto) | contagem no relatório |
| Os nove pontos de VM real do ticket 44 | VM de preparo, egress restrito, `apk add`, reuso do disco base etc. |

## 4. Acompanhamento

O supervisor roda o watcher do piloto 1 adaptado para `pl2` (estado por Trabalho, soma de tokens pelas sessões preservadas, pausa automática
no teto, alertas de memória/disco), registra achados em `pl2-pilot-evidence/findings.md` e avisa o operador a cada Pergunta, PR pronto e
impedimento.

## 5. Regras de parada

**Parada global** (`factory pause`, o supervisor avisa): teto de tokens atingido; disco do host abaixo do piso; estado inconsistente sem causa
conhecida; defeito da Factory que impeça qualquer Trabalho de avançar (como o disco no piloto 1).

**Parada por Ticket** (o operador decide): limites de correção, recovery ou continuação atingidos; publicação `not-publishable`/`blocked`;
Pergunta sem resposta; gate falhando no guest sem causa clara.

**Nunca automático:** retry, bypass de gate ou teste, reescrita silenciosa do Ticket, fallback de modelo ou de ambiente.

## 6. Reversão

- **Trabalho:** `factory cancel <work>`; PR próprio fechado sem merge pelo operador.
- **Controlador:** `factory pause` e `systemctl --user stop`; chave da App removida da raiz.
- **Entrega ruim já mergeada:** PR de revert pelo operador.
- **Raiz:** `pl2` pode ser removida inteira ao fim, depois de copiar as evidências.
- **Ambiente declarado:** o `.factory/environment.yaml` fica no repositório (é a regra para todo repositório a partir do ticket 44).

## 7. O que o operador precisa fazer

- **Antes:** responder a seção 8; `factory login` na `pl2`; merge do PR do `.factory/environment.yaml`; conferir os corpos editados dos Tickets.
- **Durante:** aplicar `ready-for-agent`; responder Perguntas (`/factory answer`); revisar e pedir `/factory repair` quando quiser; merge
  humano de cada PR pronto.
- **Depois:** avaliação de cada entrega e do conjunto; decidir limpeza de `pl1`/`pl2`.

## 8. Autorizações solicitadas (marcar sim ou não em cada item)

Recomendação do supervisor: **sim** em todos, exceto 11b e 11c (alternativas ao 11a).

| # | Autorização | Sim | Não |
| --- | --- | --- | --- |
| 1 | Usar a release `mvp-54.0` (`8f963bb`, assets35) como composição do piloto 2 | [ ] | [ ] |
| 2 | Criar a raiz `pl2` com `mvp-54.0`, `setup --service`, `doctor` e login novo do modelo pelo operador; `pl1` fica parada | [ ] | [ ] |
| 3 | Repositório `Sanmoo/java-springboot-event-sourcing`, base `main`, App `sanmoo-factory` | [ ] | [ ] |
| 4 | Supervisor abre o PR do `.factory/environment.yaml` (JDK 25); merge pelo operador | [ ] | [ ] |
| 5 | Supervisor edita os corpos de #124–#128 para deixar só o comando do projeto como gate | [ ] | [ ] |
| 6 | `concurrency` 3 com guest 4096 MiB / 2 vCPU / 40 GiB (terceiro boot espera memória pelo ticket 50) | [ ] | [ ] |
| 7 | Fase de orçamento curto (`builderBudget.requests` 40) até uma continuação no mesmo ambiente; depois volta a 150 com reinício | [ ] | [ ] |
| 8 | Janela de até 2 dias corridos, serviço ativo só com o operador disponível | [ ] | [ ] |
| 9 | Chave da App em `pl2/credentials/app.pem` (0600) durante a janela, removida ao fim | [ ] | [ ] |
| 10 | Modelo `openai/gpt-6-luna` nos três papéis via `factory-oauth`, teto de **120 M tokens** (soma das sessões preservadas) | [ ] | [ ] |
| 11a | Ruleset `26435808`: remover `update` durante a janela e restaurar ao fim | [ ] | [ ] |
| 11b | Ruleset: relaxar só em volta de cada merge humano | [ ] | [ ] |
| 11c | Ruleset: manter como está | [ ] | [ ] |
| 12 | Merge e aprovação só pelo operador (nunca pelos agentes nem pelo supervisor) | [ ] | [ ] |
| 13 | Supervisor responde em nome do operador só Perguntas cuja resposta já está no Ticket ou numa decisão registrada; as demais vão ao operador | [ ] | [ ] |
| 14 | Nenhuma injeção de falha além da fase de orçamento curto (sem SIGKILL, congelamento, disco cheio ou relógio) | [ ] | [ ] |
| 15 | Limpeza pela Factory da própria branch e do próprio ambiente após cada entrega; retenção padrão de 30 dias | [ ] | [ ] |
| 16 | Regras de parada da seção 5 e reversão da seção 6 | [ ] | [ ] |
| 17 | Registro de métricas, Perguntas por origem e avaliação humana no relatório do piloto 2 | [ ] | [ ] |
