# Achados da campanha de aceite v2 no Lambda

## A1 (fase 1, 2026-11-21) — doctor acusa lambda:PassNetworkConnector como faltante
- A role de operação tem o statement NetworkConnectors do template (lido por get-role-policy).
- `iam simulate-principal-policy` responde implicitDeny com 0 statements casados para essa ação, em qualquer recurso
  (o padrão do template, um nome concreto, `*`).
- Hipótese: o simulador de políticas não avalia essa ação. A verdade sai do primeiro RunMicrovm real.
- Efeito: `lambda-permission:lambda:PassNetworkConnector` bloqueado no doctor de uma instalação correta (falso positivo, se o boot funcionar).
- Os demais checks do Lambda passaram: perfil, identidade, role, região, role de build, bucket, quota (8 GB), ssh, websocat.
- O template da conta foi aplicado pela primeira vez e criou a stack sem erro (forma 0.5).

## A1 confirmado (23:37 UTC) — falso positivo do doctor
- RunMicrovm funcionou com a mesma role: `lambda:PassNetworkConnector` é concedida de fato. O simulador da AWS não avalia essa ação.
- Correção pendente: o doctor não deve bloquear por uma ação que o simulador não sabe avaliar (marcar `unverified`).

## A2 (23:12 UTC) — RunMicrovm não aceita `--tags`
- Primeiro RunMicrovm real recusado inteiro com erro de uso da CLI; `run-microvm help` não lista `--tags`.
- Efeito: Execução retida com START_MICROVM_START_UNCONFIRMED; detalhe visível só como "usage: aws ..." (diagnóstico fraco: a linha útil do erro não é a primeira).
- Correção: main 9048e072 (release v2-acc-2). A MicroVM não leva tag própria; inventário por tag da imagem e registros de boot. Uso de MicroVM não aparece no filtro por tag da cobrança.
- Recuperação exigiu comando do operador: `factory resume --retry-blocked-start` (um resume operacional consumido). Contraria o princípio de autonomia? Causa era defeito do produto, não condição transitória.

## A3 — upgrade com Execução retida
- `upgrade check` recusa enquanto há Execução não assentada e sem pausa; foi preciso subir o controller antigo, pausar e parar limpo. Funcionou como documentado.

## Formas confirmadas em conta real até aqui
- 0.1 quota lida (8 GB) e `lambda-quota` ok; 0.5 template aplica; 1.1/1.2 pacotes fixados instalam (build em 2 min 12 s); 1.4 tags no create-microvm-image aceitas;
  reuso da imagem por chave após upgrade de release com o mesmo pin; inventário inicial (ListMicrovms) lido.

## Janela 1 encerrada (2026-11-21 ~23:58 UTC) — jornada #133 entregue
- C01: Ticket #133 → implementação → dois reviews (standards, spec) → PR #134 draft aberto pelo Builder no mesmo boot → pronto → merge humano → entrega → cleanup completo. Evidência em w133/.
- G09 (CI): terminatedAt 23:43:24.599Z < slot-released 23:43:28.065Z.
- G32 parcial: factory usage = 348,166 s para o boot af7fcd07, igual a GetMicrovm (startedAt/terminatedAt).
- G27 parcial: imagem do ambiente declarado real construída (2 min 12 s) e reusada pelo boot seguinte sem build novo.
- C12 parcial: bloqueio MERGE_BLOCKED_UPDATE_RESTRICTED explicado no CLI com próximo passo; conversão para pronto só na releitura completa de 10 min após o ajuste do ruleset.
- Consumo: 1 build, 348 MicroVM-segundos, ~0,2 M tokens registrados.
- Formas confirmadas: 1.7 (hook e script de início), 2.3-2.5 (chave do host, ambiente por stdin, clone com token), 3.x (ferramentas por papel em uso real), 4.1 (worker lançado pelo dono em-processo), 4.2 (gh pr create no guest), 4.4 (push no gate de preservação: preservation-accepted ci-wait).
- Controller parado ao fim da janela; nenhuma MicroVM viva; ruleset do repositório real restaurado.

## A4 — repositório de apoio privado não aceita ruleset (plano gratuito do GitHub)
- POST rulesets → 403 "Upgrade to GitHub Pro or make this repository public". Sem proteção de base a publicação é bloqueada (BASE_PROTECTION_NOT_VERIFIED).
- Decisão do Operador pendente: tornar o repositório de apoio público.

## Janela 2 (2026-11-22 00:04–00:40 UTC) — Ticket #1 do repositório de apoio (Trabalho 1707fc5a)
- Declaração com `apk: []` aceita; imagem construída (~2 min).
- Builder corrompeu a cópia do Ticket ao salvar (aspas simples do shell) → handoff recusou HANDOFF_GATE_NOT_DOCUMENTED (correto) → Pergunta publicada. Conduta do modelo.
- G05 (parcial, agente real): preservation-refused question:HEAD_NOT_PUBLISHED → Builder fez push → preservation-accepted → execution-ended question.
- G09 (humana): terminatedAt 00:12:29.820Z < slot-released 00:12:32Z. Artefatos coletados antes do fim (9 arquivos); evidência start/stop coletada.
- C05: resposta por comentário do Operador (00:25:55Z) reconhecida em 00:26:13Z; Trabalho retomou.
- C09/G11(a): commit de terceiro 3662912 na branch durante a espera; a retomada partiu dele (origin.atStart = 3662912) e ele virou o head verificado. Preservado.
- Boots: 346,346 s e 408,478 s.

## A5 — V2-10 NÃO observado: sessão substituída na retomada (SESSION_INCOMPATIBLE)
- Execução de retomada (QUESTION_ANSWERED, boot novo) registrou session.mode=replace, reason=SESSION_INCOMPATIBLE; sessão nova do Builder. Causa em diagnóstico.

## A6 — Publicação bloqueada vira beco sem saída mesmo com o commit verificado na origem
- Com o repositório privado, a leitura da proteção da base deu GITHUB_ACCESS_DENIED → publication-blocked VERIFIED_COMMIT_NOT_PUBLISHED_BEFORE_STOP,BASE_PROTECTION_UNKNOWN (falha fechada: correto).
- Mas a descoberta registrou branch present com sha == head verificado. A mensagem diz que o commit "não existe mais"; é falso neste caso.
- Depois de corrigida a causa (repo público + ruleset): `reevaluate-publication` → NOT_REEVALUABLE; `resume` → NOTHING_TO_RESUME. Sem caminho para publicar o que já está revisado e na origem; só refazer o trabalho.
- Contraria o princípio de autonomia: uma leitura incompleta passageira do GitHub durante o boot mata a publicação.

## Janela 3 (release v2-acc-3, 2026-11-22 01:00 UTC) — Ticket #2 do repositório de apoio (Trabalho eae39394)
- Correções A1 (doctor unverified), A3 (linha de erro da CLI), A5 (perfil da sessão) na main 660034aa. doctor sem bloqueios.
- G10 CONFIRMADO: commit → Pergunta → recusa do gate (HEAD_NOT_PUBLISHED) → correção → aceito → espera → resposta → boot novo com
  session.mode=continue/SESSION_COMPATIBLE, mesmo sessionId (01a200c5…), carriedEntries 11; bootNotice com previousBoot, startCommit confirmado,
  restored [spec/v1, instructions/v1], lost=false. Evidência wf2/.
- G05/G09 repetidos com a mesma forma. PR #3 aberto no boot, vinculado, convertido para pronto sem intervenção.
- Em curso: conflito com a base criado por PR do Operador (#4) para CA-04.

## Janela 3 — Ticket #2 (cont.) e Ticket #6
- C04 (conflito): PR do Operador (#4) na base criou conflito com o PR #3; a Factory voltou o PR a draft, abriu correção, rodou reparo em boot novo
  (sessão continue, mesmo sessionId nos 3 boots: 11/11/12 entradas, carried 0/11/22), republicou, pronto; merge; entrega; cleanup. Evidência wf2/.
- Ticket #6 (Trabalho e4e15994), efeito incerto roteirizado (scripts/record-effect.sh cria uma branch effects/* por execução):
  - 01:33:15 chamada Bash iniciada; 01:34:01 branch effects/… na origem; 01:34:14.683 terminate-microvm externo; terminatedAt 01:34:16.913Z.
  - G15: 01:34:29.604 toolResult "Command aborted (effects unknown)"; 01:34:29.606 última entrada da sessão = WORKER_SESSION_CLOSED_BY_HOST, 0 tokens.
    Nenhum pedido de modelo nem chamada depois. boot-ended start->loss 01:34:32; execution-ended SANDBOX_ENVIRONMENT_ENDED. Sessão perdida copiada (wf3/lost-session.jsonl).
  - G16: refs/factory/lost/<trabalho>/<boot> criada em 1d77490 (o commit não publicado); loss-recorded cita a ref.
  - G17: recuperação automática (wait 5s, um recovery consumido), sessão nova 01a200e5; a substituta buscou a ref de marcador, publicou o commit na branch,
    NÃO repetiu o script, e abriu Pergunta citando o boot perdido e o id da chamada registrada pelo Controle, com as opções (A) dar por feito / (B) repetir.
    Contador effects/* = 1.
  - Resposta do Operador: (A). Em curso.
- A7: `factory usage` marca a Execução perdida como SESSION_NOT_RECORDED / measurement unavailable: os tokens do boot perdido não entram no total (total "partial").

## Janela 3 (cont., ~01:45–02:05 UTC)
- Ticket #6 concluído: substituta respondeu à resposta (A), reviews, PR #7, pronto, merge, entrega, cleanup; lost-markers:removed (ref ausente no ls-remote). Contador effects/* = 1 ao fim. G16 e G17 completos.
- G30: doctor com concurrency 3 → blocked lambda-quota "3 x 4096 MiB = 12288 MiB; account quota 8192 MiB" (doctor-concurrency3.json).
- G31: role sem lambda:DeleteMicrovmImageVersion → blocked lambda-permission:lambda:DeleteMicrovmImageVersion com próximo passo (doctor-missing-permission.json); role restaurada pelo template da release e doctor de volta ao normal.
  Desvio: o script da sonda parou antes de restaurar (exit do doctor); restauração feita em seguida, à mão, ~1 min depois. Nenhum Trabalho ativo no intervalo.
- Em curso: Ticket #9 (tarefa longa de 13 passos de ~5 min) com maxBootSeconds=900 e margem 300 para G12/G14/C11.

## Janela 4 (2026-11-22 01:55–02:35 UTC) — troca planejada, Ticket #9 (Trabalho 2e34640c)
- A8 — a troca planejada matava a ativação: aos ~11,5 min (margem a partir de 600 s) a Execução terminou WORKER_SECRET_SYNC_SCHEMA.
  Causa: o receptor de segredos do dono (worker-secret-ipc.ts) compartilha o fio com o lançador e não conhecia o worker-result status `boot-swap`.
  Correção: main 443a5719, release v2-acc-4, com teste. Nenhum teste composto exercitava a troca com o IPC real.
  Consequência observada: gate no fim do boot recusou (WORKSPACE_MODIFIED), boot registrado como perda, ref de marcador criada.
- A9 — Trabalho em limbo depois disso: execução ended/failure, sem recovery-requested, sem impedimento, fila vazia, `resume` → NOTHING_TO_RESUME.
  Nenhum próximo passo visível. Em diagnóstico. Trabalho cancelado pelo Operador da campanha; a ref de marcador permanece (trabalho preservado).
- Ticket #10 criado com o mesmo corpo para repetir a troca na v2-acc-4.

## Janela 4 (cont., 02:29–03:50 UTC) — Ticket #10 (Trabalho 0e0d892b), release v2-acc-4, maxBootSeconds=900 / margem 300
- G12/G10/C11: UMA Execução atravessou 7 boots com 6 trocas planejadas (02:42, 02:53, 03:04, 03:16, 03:27, 03:38), todas com
  boot-swap-due → boot-swap-notice → preservation-accepted planned-swap:<sha> → boot-ended …->planned-swap → boot-swapped em ~70 s.
  Boots (GetMicrovm): 759,8 / 674,7 / 667,3 / 668,3 / 670,8 / 669,0 / 552,9 s; nenhum passou de 900 s. Total 4662,8 s (> 3600 s),
  Execução de 4669 s sem corte por tempo (limits.timeout null). Intervalo sem MicroVM entre boots: ~7 s.
- Sessão: uma única sessão do Builder (01a20116…, mode new, state complete, 76 entradas) do primeiro ao último boot; 1,51 M tokens.
- O aviso de troca sempre chegou no limite entre chamadas (cada passo dura ~5 min; devido aos 600 s, entregue ~35–120 s depois).
  NÃO exercitado: interrupção de chamada longa na metade da margem (nenhuma chamada atravessou os 750 s do boot).
- Consumo por boot em `factory usage` = GetMicrovm, measurement complete (G32).
- Fim: gate do Ticket passou; revisores (spec e standards) apontaram "um commit só / log feito à mão" — falso: há 13 commits, mas o
  handoff de revisão só mostra o patch agregado. O Builder não acolheu os dois achados sem pedir autorização ao Operador →
  REQUIREMENT_NON_ADOPTION_NOT_AUTHORIZED:1/spec/S1 → publicação not-publishable. Trabalho aberto, sem impedimento, sem PR
  (comportamento do MVP; próximo passo visível em show.publication.nextStep). Não é efeito do perfil Lambda.
- A10 (observação): os revisores não veem a lista de commits da branch, só o diff agregado; requisito de processo ("um commit por passo")
  não é verificável por eles. Candidato a ticket (handoff de revisão com o log de commits).
- preservation-refused ci-wait:HEAD_NOT_PUBLISHED seguido de aceito 23 s depois: o gate de preservação recusou e o Builder publicou (G05/G09).
- Destravar exige comando do Operador (update-scope ou resume --new-review-round): PENDENTE de decisão do Operador (não executado pelo agente).
- 03:50 UTC: despacho pausado, controlador parado limpo, 0 MicroVM viva, config restaurada (sem maxBootSeconds/rotationMarginSeconds;
  cópia do ensaio em config-swap-test.json).

## Janela 5 (2026-11-22 04:16 UTC–) — release v2-acc-5 (main 30255948: A9 parte A e A7 corrigidos)
- Ticket fixture #11 (Trabalho 6acadbcb), tarefa de 3 passos lentos, para G20 e C06.
- G20 (V2-21), 04:20:14: kill -KILL no websocat (lado host) da conexão da chamada Bash do passo 101. MicroVM continuou RUNNING.
  Observado: 5 tentativas de reconexão em 57 s, todas sem conseguir encerrar a chamada órfã; 04:21:11 channel.jsonl
  {"kind":"unrecoverable","attempts":5} e efeito "channel-unrecoverable"; execution-ended SANDBOX_CHANNEL_UNRECOVERABLE;
  loss-recorded com ref de marcador; boot-ended start->loss; recovery-requested (wait 5s); boot substituto sozinho, sem impedimento
  (decisão 6 do Operador: caminho de esgotamento CONFIRMADO).
- A11 — o caminho principal do V2-21 FALHOU: com o ambiente vivo, a reconexão não encerrou o órfão nem devolveu "indeterminado".
  O tempo por tentativa (~2 s + 5 s) casa com o laço de 5 s do end-call terminando "call-alive". O canal funcionava (stop.log coletado
  em seguida). O mesmo programa serve à interrupção na metade da margem (V2-13), nunca exercitada em AWS real. Em diagnóstico.
  Falta de observabilidade: channel.jsonl não registra cada tentativa.
- Substituta do #11 (boot 392b9162, recovery 1 consumido): publicou os passos na branch (commits de 102 e 103 vistos às 04:37).
- C06 (CA-06), 04:37:35–04:38:29: kill -KILL em sequência no lançador `factory run`, no supervisor controller.js e no dono owner.js
  (os dois primeiros não derrubam a Factory: o dono segue respondendo `status`). Após o terceiro: CONTROLLER_UNAVAILABLE, worker e ssh
  mortos junto, MicroVM órfã RUNNING. Reinício 04:38:55: 04:39:50 execution-reconciled operational-recovery:CONTROLLER_CRASH
  "cessation confirmed (sandbox-stop)", slot liberado, loss-recorded com ref de marcador em 7b8f161, boot-ended start->loss,
  recovery-requested (wait 15s); nenhuma MicroVM viva na listagem do serviço às 04:40:10. Órfã encerrada pela reconciliação.
- Observação: matar só o lançador ou só o supervisor deixa o dono rodando sem supervisor (não investigado; fora da rubrica).
- Ticket #11, segunda substituta (recovery 2, boot 3b7a28de, 04:40–04:50): retomou dos commits publicados, sem repetir passos feitos,
  revisão limpa, verificado, PR #12, pronto, merge pelo Operador. Três boots, 1875 s medidos (GetMicrovm), measurement complete.
- A7 CONFIRMADO na v2-acc-5: `factory usage` conta as duas Execuções perdidas como partial / SESSION_ENDED_BY_LOSS
  (69.562 e 129.843 tokens), em vez de SESSION_NOT_RECORDED.
- C07 (cancelar com boot ativo), Ticket #13 (Trabalho 93c9b301): cancel 04:56:01.971 → execution-ended WORK_CANCELLED 04:56:03 →
  MicroVM TERMINATED → slot-released e cancellation-ceased 04:56:23. Impedimento WORK_CANCELLED com próximo passo. Sem PR.
- C10 (rótulo removido com boot ativo), Ticket #14 (Trabalho 0ec12177): rótulo removido 05:00:15 → authorization-withdrawn
  LABEL_NOT_PRESENT 05:00:38, impedimento AUTHORIZATION_WITHDRAWN (exige `factory resume`; religar o rótulo não basta). A atividade em
  curso concluiu e publicou o PR #15 em rascunho (comportamento do MVP); nenhuma ativação nova depois.
- A11 diagnosticado (contêiner local com imagem e scripts reais): o órfão é morto, mas vira zumbi sob o PID 1 (hook-agent.py não
  recolhe filhos) e `kill -0` no grupo responde vivo → call-alive em toda tentativa. Correção: vivacidade por /proc/*/stat (estado ≠ Z/X);
  registro de cada tentativa em channel.jsonl. Branch fix/lambda-orphan-call-end; test:ci pendente (cota de /tmp).

## Janela 6 (05:24 UTC–) — release v2-acc-6 (main ff93c0ac: correção do A11)
- C10 fechado: PR #15 ficou rascunho, readiness not-ready(AUTHORIZATION_WITHDRAWN); issue 14 e PR 15 fechados pelo Operador.
- G20 / V2-21 REPETIDO, Ticket #16 (Trabalho 907c00d4): 05:29:55.088 kill -KILL no websocat da chamada do passo 401.
  channel.jsonl: 05:29:57.738 recovery attempt 1, condition active, end-call exited 0 "call-ended"; efeito "orphan-ended" (indeterminado).
  Mesmo boot, mesma MicroVM, ativação seguiu; a sessão recebeu o resultado indeterminado, inspecionou (sem linha, sem commit) e parou
  numa Pergunta (sobre os pushes por passo pedidos no Ticket; conduta do modelo / redação do Ticket). A11 CORRIGIDO e confirmado em AWS real.
- Ticket #16 após a resposta: nova Execução CONTINUOU a mesma sessão (01a201b8, mode continue), fez 401–403, revisão limpa, PR #17,
  merge, entregue. V2-10 de novo confirmado (retomada após Pergunta em boot novo).

## Janela 7 (05:58–06:45 UTC) — v2-acc-6, maxBootSeconds 900 / margem 300, Ticket #18 (Trabalho 8d73bc58), chamada única de 1500 s
- V2-13 (metade da margem): boot 1 no ar ~05:59:30; 06:12:00 boot-swap-due …:call-interrupted (≈750 s); channel.jsonl recovery
  cause interrupt, end-call exited 0 "call-ended", efeito registrado; aviso de troca; gate recusou (branch ainda não publicada), o Builder
  publicou, gate aceito; troca. Boots de 819,6 / 789,0 / 786,3 s (< 900). Mesma sessão (01a201d6) nos três boots.
- V2-14: boots 2 e 3 terminaram por troca planejada sem commit novo (branch parada em 6613af9) → boot-loop-blocked,
  execution-ended NO_PROGRESS_BETWEEN_BOOTS, impedimento com causa provável e `factory resume`; nenhum terceiro boot de repetição; 0 MicroVM.
- Trabalho cancelado e issue fechada pelo Operador da campanha.

## Janela 8 — boot único longo (Ticket #19) e sondas de isolamento

### Boot acima de 1 h (G30 / limite configurável)
- `maxBootSeconds: 4500`. O boot `boot-406e72e0` viveu **4150,3 s** (06:43:08 → 07:52:18 UTC), acima de 3600 s (a sessão do papel de operação dura no máximo 3600 s; o boot atravessou a renovação).
- Troca planejada pedida aos 4050 s (`boot-swap-due` 07:50:46), preservação aceita em 33 s, novo boot em 28 s. Mesma Execução.
- Review r1 no boot seguinte: `standards` e `spec` limpos (07:54:00 e 07:55:00).

### G23 — revisor sem escrita e sem Docker (sonda pelo canal, usuário `reviewer`)
Evidência: `probes/g23-g24-run1.txt` (boot do Builder, 06:44 UTC) e `probes/g23-g24-run2.txt` (boot da review, 07:54 UTC, com os dois revisores em execução).
- `touch /workspace/…`, `touch /workspace/checkout/…` e append em arquivo versionado: `Permission denied` (rc=1). Leitura do arquivo versionado: ok.
- `/var/run/docker.sock` é `root:docker 660`; o revisor não está no grupo; `docker ps` → `permission denied`. Sem `sudo`/`doas`.
- Dois vereditos reais produzidos em MicroVM (acima).

### G24 — credenciais no guest (sonda pelo canal, usuário `builder`)
Evidência: `probes/g23-g24-run2.txt` e `probes/g24-run3.txt`. A primeira tentativa (run1) da varredura foi recusada pelo transporte sem código registrado (provável expiração do token de porta de 10 min durante a varredura lenta de `/var`); refeita com varredura limitada.
- **Arquivos:** nenhuma string com forma de token em /home, /workspace, /tmp, /run, /etc, /opt, /srv, /artifacts, /var (fora de `/var/lib/docker`). Controle positivo: o sentinela plantado em arquivo foi encontrado (run3; no run2 o `grep -I` do busybox invalidou a parte de arquivos).
- **Configuração do Git:** nenhuma chave de credencial/extraheader/insteadOf em system, global ou local; URL do `origin` sem userinfo; sem `.git-credentials`, `.netrc`, `gh`.
- **Linhas de comando:** nenhuma com token.
- **Ambiente de processos — resíduo já aceito (Decisões 9 e 10 do Operador, 2026-11-21; não é achado novo):** o processo `sh` do "marker holder" (pid 278, filho do PID 1, dono `builder`, vivo durante todo o boot) carrega `FACTORY_GIT_TOKEN` no ambiente. `/proc/278/environ` é legível pelo usuário `builder`, que é o usuário do agente Builder. O controle positivo de ambiente (sentinela em `sleep`) também foi encontrado. 9 processos (root) têm ambiente ilegível para o builder.
- **AWS:** nenhuma variável `AWS_*` em processo legível; nenhum arquivo de credencial; `169.254.170.2` inalcançável; o IMDS responde (token de sessão 200) mas só expõe `placement/` e `tags/`; `iam/security-credentials/` e `iam/info` → 404; `user-data` → 404.
- Efeito colateral da sonda: alguns processos `timeout`/`sleep` órfãos sob o PID 1 (zumbis; o PID 1 do guest não os recolhe — observação já registrada).

## Janela 9 (08:00 UTC–) — v2-acc-6, config de campanha
- G27 negativo (V2-28), Ticket #21 (Trabalho 7d781d54): `.factory/environment.yaml` com `jq 0.0.0-r0`. 08:04:57 reserva → 08:05:59
  `execution-held PREPARE_ENVIRONMENT_BASE_PREPARATION_FAILED`, slot liberado, nenhum boot. Impedimento `RECOVERY_BLOCKED` com a causa
  literal do apk (`unable to select packages: jq-1.8.2-r0: breaks: world[jq=0.0.0-r0]`), "nenhuma outra versão instalada" e o comando
  `factory resume … --retry-blocked-start`. Build falho em ~1 min. Evidência: wf12/. Trabalho cancelado; declaração restaurada.
- C02 (dependência nativa), Tickets #24 (A) e #25 (B bloqueado por A; Trabalho 827d6617): B admitido 08:31:39 com impedimento
  `DEPENDENCY_PENDING` (EXTERNAL_BLOCKER_OPEN #24), nenhuma reserva nem MicroVM por ~9 min; PR #26 de A com merge 08:39:44 →
  `dependencies-changed` 08:40:14 → reserva 08:40:21 → boot. Evidência: wf14/show-blocked.json, wf14/history.json.
- C04 (falha de check obrigatório): regra `required_status_checks: factory-gate` adicionada ao ruleset do fixture.
  - PR #27 (Ticket #25): `factory-gate=failure` 08:46:12 → 08:46:49 `checks-evaluated failing REQUIRED_CHECK_FAILED`, `correction-opened`,
    Execução de reparo 08:47:52 (orçamento de correções 1). O Builder de reparo não alterou o check: abriu Pergunta ao Operador.
    Falha repetida no mesmo head: continua 1 `correction-opened`.
  - Ordem (PR #29 do Ticket #28 vs Ticket novo #30), com despacho pausado até os dois estarem observados: unpause 09:01:04 →
    reparo reservado 09:01:44.946; Ticket novo admitido 09:01:58 e reservado 09:02:15.377. Reparo antes do Trabalho novo.
    O merge do PR #27 gerou conflito com a base no PR #29: `repair-consolidated +MERGE_CONFLICT:main` — um único reparo para os dois eventos.
- G11b (histórico reescrito), Trabalho 827d6617 parado em Pergunta: branch reescrita por terceiro (amend + push forçado com lease,
  cda54ec → 8051145). Resposta 08:52:16 → `origin-rewrite-followed`, `execution-released ORIGIN_HISTORY_REWRITTEN`, `recovery-requested`,
  orçamento de recuperações consumido (1), Execução `mode: recovery` em sessão NOVA (arquivo de sessão 08:53:58) com o aviso
  "HISTORY CHANGED … (cda54ec…) is NOT an ancestor of the current tip (8051145…) … The Factory follows the remote". Review r4 limpa,
  PR #27 atualizado, merge. Evidência: wf14/g11b-substitute-session-notice.txt, wf14/show.json (originDivergence).
- G11c, primeira tentativa (Trabalho 8019ed17, Ticket #28, em Pergunta COM PR aberto): apagar a branch fechou o PR #29 no GitHub →
  `pull-request-closed-unmerged`, impedimento `PULL_REQUEST_CLOSED_UNMERGED`; a resposta à Pergunta (comentário de operador) não foi
  ingerida em 10 min (QUESTION_PENDING permaneceu). O próximo passo indicado (`factory reopen`) não pode funcionar com a branch apagada:
  `reopen-attempted known-failure:GITHUB_GRAPHQL_UNPROCESSABLE`, `reopen-not-applied`, e o impedimento continua indicando `reopen`.
  **A12 (observação):** com PR fechado por exclusão da branch, o próximo passo visível leva a um comando que falha; a causa (branch
  ausente) não aparece. Não é o caso (c) da V2-11 (retomada sem PR); repetido abaixo. Trabalho cancelado. Evidência: wf15/.
- G11c (branch ausente), Ticket #32 (Trabalho dd8abb72), parado em Pergunta com branch publicada e sem PR. (De passagem, G05 básico:
  09:28:53 `preservation-refused question:HEAD_NOT_PUBLISHED`, ativação de preservação, 09:29:16 `preservation-accepted`, só então fim.)
  Branch apagada no origin; resposta 09:30:31 → reserva 09:30:34 → `origin-branch-absent-asked`, `execution-released ORIGIN_BRANCH_ABSENT`,
  nenhum boot, Pergunta nova com as duas respostas `restart` | `end`. Respondido `end`. Evidência: wf17/.
- G05, caso das três recusas (V2-06), Ticket #33 (Trabalho 67f6c34e): o Ticket mandava deixar `LOCAL-ONLY.txt` sem commit e recusar a
  preservação. Na 1ª Execução o Builder NÃO criou o arquivo e perguntou ao Operador sobre o conflito com a política da Factory
  (só HEAD_NOT_PUBLISHED, corrigido). Após a resposta confirmando o experimento: 09:38:04, 09:38:22, 09:38:40
  `preservation-refused question:WORKSPACE_UNTRACKED:1 untracked file(s) not ignored` (três no mesmo retorno) → 09:38:43
  `boot-ended start->loss`, `execution-ended PRESERVATION_GATE_REFUSED` → 09:39:04 `loss-recorded` com ref de marcador
  (`refs/factory/lost/67f6c34e…/boot-7148ffa1…`, "not preservation"), `recovery-requested interrupted:PRESERVATION_GATE_REFUSED`.
  A substituta esperou a Pergunta pendente; após a resposta: `budget-reserved recoveries`, 09:41:43 `execution-started`,
  `budget-consumed recoveries` (1/3). `show.execution.mode` exibiu `initial` para a substituta (conferir no fechamento).

## Janela 10 (09:45–09:58 UTC) — correctionLimit 0 no fixture
- C07, limite esgotado, Ticket #34 (Trabalho 86384365): PR #35 publicado; `factory-gate=failure` → 09:54:22 `correction-opened`,
  `budget-exhausted corrections:0/0`; impedimento `CORRECTION_LIMIT_REACHED` ("nothing is retried automatically", `factory grant … --corrections <n>`),
  readiness not-ready com a causa; nenhuma Execução de reparo; branch e PR presentes na origem. Evidência: wf19/.
- Fixture restaurado: ruleset 27817337 de volta ao estado anterior (sem required_status_checks); config de campanha restaurada.

## Janela 11 (09:59 UTC–) — repositório real, v2-acc-6, concurrency 2
Decisão do Operador (2026-11-22): usar as issues #127 e #128 já escritas para a Factory mais 1 Ticket novo de código (#135); merge como no piloto.
- C03: #135 (Trabalho 0da1c800) reservado 10:00:45 e #127 (Trabalho efc54451) 10:00:50; os dois `execution-booted` 10:02:10, MicroVMs
  distintas (startedAt 10:01:01 e 10:01:03 UTC), branches distintas. #128 (Trabalho 9436bb22) rotulado com os 2 Slots ocupados:
  admitido 10:01:40, sem reserva e sem MicroVM enquanto os dois rodam.
- G27 positivo / reuso: os dois Trabalhos usaram a imagem já existente do ambiente declarado (Preparar em ~10 s, nenhum build novo);
  sonda no guest de cada um: `openjdk version "25.0.5.1"`, pacote `openjdk25-jdk-25.0.5.1_p2-r0` = versão declarada.
  Evidência: probes/c08-containers.txt (leituras periódicas, inclui a contagem de containers).
- C08: containers do Testcontainers dentro das MicroVMs durante o gate (`testcontainers/ryuk:0.14.0`, `postgres:18`; leituras 10:18:40 e
  10:24:36 em probes/c08-containers.txt). Gates passaram: #127 `check-and-acceptance: passed`; #128 `ticket-validation: passed`.
- C03 (liberação): #127 liberou o Slot 10:30:09; #128 reservado 10:30:50, boot 10:31:47.
- Resultado dos três Trabalhos (evidência wfr1/, wfr2/, wfr3/, `*-1.json`):
  - **A13 (defeito v2, corrigido em e4ace147, a verificar)** — #128 (9436bb22): PR #137 criado e vinculado, mas 10:41:16
    `publication-blocked UNEXPECTED_REF_CHANGE:refs/heads/factory/135-0da1c800` + `GUEST_EFFECT_OUT_OF_SCOPE`. A ref é a branch própria do
    #135, publicada pelo Builder dele no portão de preservação (recusa HEAD_NOT_PUBLISHED 10:40:44 → aceite 10:41:09; a leitura do #128 foi
    10:41:09.340). A regra do ticket 61 só atribui heads de tentativa de publicação. `factory reevaluate-publication` em v2-acc-6:
    `still-blocked` (11:38:07). Em perfil sem disco persistente, todo push de preservação de um Trabalho bloqueia a publicação de outro
    na mesma janela.
  - **A14 (observação)** — #127 (efc54451): a sessão de publicação criou o PR #136 com o marcador digitado errado em um caractere
    (`…fea09a1a04b8` em vez de `…fea0091a04b8`) → `MARKER_ABSENT` → `UNKNOWN_PULL_REQUEST:136` → `publication-blocked`. A recusa é correta;
    porém o marcador depende de o modelo copiar 36 caracteres, e este bloqueio não tem reavaliação (`NOT_REEVALUABLE`), mesmo que o
    humano corrija o corpo do PR.
  - **A15 (observação)** — #135 (0da1c800): 4 pareceres rebaixados pelo Host a `incomplete` por `REQUIRED_INPUT_NOT_FULLY_READ`
    (r2 standards: arquivo lido com limite 400, 15 linhas restantes não lidas; r3 standards/spec: `sources.json` não relido; r4 spec:
    14 arquivos alterados não relidos). Sessões de revisor em modo `continued`: o modelo não relê o que viu na rodada anterior, mas o
    Host conta leituras por invocação. `incomplete` não tem nova tentativa (só falha tem); resultado `REVIEW_INCOMPLETE`,
    `not-publishable`, Trabalho aberto SEM impedimento e sem comando que inicie nova Execução verificada (`resume --new-review-round`
    recusa com REVIEWER_RETRY_LIMIT_NOT_PENDING). Gate do código passou; branch preservada na origem.
- 11:38 UTC: despacho pausado, controlador parado, zero MicroVMs (pausa da janela para a correção A13).
- X1 parcial (12:1x UTC): 45 MicroVMs, todas TERMINATED, 27 102 s = 7,53 MicroVM-hora (teto 40). Leituras GetMicrovm em probes/x1-microvms-2026-11-22T12.jsonl.

## Janela 11 (cont., 12:41 UTC–) — release v2-acc-7 (main 97d6932d: A13, A14, A6, A9 parte B; test:ci PASS)
Decisão do Operador (2026-11-22): "sim" para A9 parte B, A6 e A14.
- A13 VERIFICADA na conta real: `reevaluate-publication` do #128 → 12:42:00 `publication-reevaluated accepted:linked`, `publication-linked #137`.
- A14 VERIFICADA: 1ª reavaliação do #127 antes de corrigir o corpo → `still-blocked:UNKNOWN_PULL_REQUEST:136`, com o próximo passo novo
  (marcador exato + comando). Após o humano corrigir a linha do marcador do PR #136: 12:42:47 `accepted:linked`, `publication-linked #136`.
- A16 (observação): com os PRs vinculados, prontidão `not-ready MERGE_BLOCKED_UPDATE_RESTRICTED` (regra `update` do ruleset 26435808).
  Removida a regra, a Factory NÃO reavaliou a prontidão em ~3 min (nenhum gatilho); os PRs ficaram em rascunho. O humano marcou
  como pronto (`readiness-human-flag ready-not-placed-by-factory`), aprovou e fez squash merge.
- Entregas: PR #137 merged 12:47:48 → `delivery-confirmed` 12:48:10, limpeza (ambiente, checkout, branch remota removida, marcadores ausentes).
  PR #136 merged 12:49:09 → `delivery-confirmed` 12:49:42, limpeza. Issues #127 e #128 fechadas.
- Ruleset 26435808 restaurado 12:49 e comparado igual ao estado anterior (real-ruleset-before-w11.json × real-ruleset-after-w11a.json).
- #135: `update-scope` (acc-scope-r2-1, sem dispensar achado) → 12:44:40 reservado, 12:45:52 `execution-started` 7a39b2b7 (em curso).
- #135, nova Execução (7a39b2b7): revisão r5 limpa nos dois revisores (nenhum `incomplete`), `review-verified verified`, PR #138 criado
  e vinculado 12:57:20 pela própria Factory (publicação sobre a head preservada 790aade9).
- C04 no repositório real (reparo explícito): `factory repair` (acc-repair-r2-1) com a base movida por #136/#137 → `correction-opened`,
  `repair-revalidated EXPLICIT_REPAIR`, `budget-consumed corrections`, Execução 8bb31d54 (13:00–13:18), publicação da head b214a798
  sobre 790aade9, `correction-closed published`, gate `ticket-validation: passed`.
- Entrega: PR #138 merged 13:20:57 (mesmo procedimento humano) → `delivery-confirmed` 13:21:05, limpeza completa. Issue #135.
- Ruleset 26435808 restaurado e comparado igual (real-ruleset-after-w11b.json). Evidência wfr2/*-2.json.
- Repositório real: Tickets novos criados nesta campanha: #133 e #135 (2 de 4); #127 e #128 rotulados por decisão do Operador.
- X1 parcial (13:32 UTC, `factory usage` da instalação, final-works/usage-all.json): 23 Trabalhos, 101 atividades (93 medidas, 8 indisponíveis),
  29,26 M tokens (19,51 M entrada, 0,14 M saída, 9,60 M cache), estimativa do catálogo do SDK US$ 2,12; builds de ambiente registrados: 3
  (2 `created`, 1 `failed` = o negativo do G27). Evidência final por Trabalho em final-works/ (histórico até 200 entradas, show, usage).
- Rascunhos do fechamento: results-draft.md e assessment-draft.json (31 critérios: 19 approved, 12 inconclusive, 0 rejected; G15 e G17 approved).

## Janela 11 (fim) — Ticket #10 do fixture (Trabalho 0e0d892b), v2-acc-7
- `update-scope` (acc-scope-f5-1) executado pelo agente a pedido explícito do Operador no chat. 13:53 Execução a69c56b8: revisão r4 limpa,
  `review-verified verified`, PR #36 publicado e vinculado 13:57:53 (13 commits). Destrava o que estava pendente desde a janela 4.
- PR nasceu em conflito com a base (docs/SLOW.md, add/add): `readiness not-ready MERGE_CONFLICT` → `correction-opened` AUTOMÁTICO 13:58:05,
  `budget-consumed corrections`. Builder do reparo perguntou como combinar os dois logs (Pergunta 9798bd37); respondido por comentário.
- **A17 (observação)** — reparo de conflito perdido: o Builder fez rebase (história reescrita, HEAD 562dc90), não rodou o gate
  (`not-publishable … GATE_NOT_RUN:ticket-validation-13-steps`), o portão de preservação recusou (`HEAD_NOT_PUBLISHED`: push não
  fast-forward), e o Builder fez `git reset --hard` para a ponta publicada (7b83a36) para satisfazer o portão — descartando o reparo.
  `correction-closed not-publishable`, PR #36 segue em conflito, Trabalho aberto sem impedimento e sem nova correção. 1/3 correções.
  Não repetido (custo); Trabalho cancelado no fechamento, PR #36 não entregue.
- **A6 VERIFICADA na conta real** — Ticket #1 do fixture (Trabalho 1707fc5a), bloqueado desde a janela 2 com
  `VERIFIED_COMMIT_NOT_PUBLISHED_BEFORE_STOP,BASE_PROTECTION_UNKNOWN`: `reevaluate-publication` (acc-reeval-f1-1) → 14:14:33
  `publication-block-lifted`, 14:15:14 `publication-requested remote:36629125…`, Execução só de publicação 14:15:56–14:16:48 (um boot),
  `publication-linked #37`, `readiness ready`, `mark-ready` aplicado pela Factory (draft=false). Merge humano → entrega.

## Fechamento (14:20 UTC–)
- 14:2x: despacho pausado, controlador parado, zero MicroVMs vivas. Estado final: 23 Trabalhos, 13 entregues, 9 cancelados, 1 fechado sem merge, 0 abertos.
- X1 final: 51 MicroVMs, 30 030 s = 8,34 MicroVM-hora; 3 builds; 109 atividades (101 medidas), 32 995 685 tokens; estimativa do catálogo do SDK US$ 2,31
  (probes/x1-microvms-final.jsonl, final-works/usage-all.json). Cobrança da AWS não lida.
- **A18 (defeito, limpeza)** — `factory cleanup-images --yes` (v2-acc-7): `IMAGE_CLEANUP_INCOMPLETE`; as duas imagens removíveis falharam em
  "deleting the image version: ValidationException … This is the last version. Please delete the entire image" (cleanup-images-failed.json).
  O serviço real não apaga a última versão isolada; o falso dos testes modelava o contrário. Fato conferido: `delete-microvm-image` da
  imagem CREATE_FAILED (por ARN) funcionou com a versão presente. Correção ed96011b (cleanup e retry de build falho apagam a imagem inteira).
- A18 VERIFICADA na conta real (release local v2-acc-8, construída da branch `fix/lambda-concurrent-wip-push`, ainda fora da main):
  `cleanup-images --yes` → imagem …e3e1dd21 `removed` (cleanup-images-acc8.json). test:ci da correção: 4 rodadas FAIL por causa ambiental
  (cota do /tmp: "Disk quota exceeded" em test/entrypoints/release-install.test.ts; uma rodada com TMPDIR no /home falhou por
  SANDBOX_RUNTIME_PATH_TOO_LONG). Nenhuma falha no código alterado. Integração na main PENDENTE de uma rodada verde.
- Limpeza de ambientes pela Factory: `factory cancel 0ec12177` (closed-unmerged) + `factory cleanup <work> --select environment --yes`
  nos 9 Trabalhos que seguravam a imagem …700ca8dd: 7 confirmados (cleanup-environments.jsonl).
- **A19 (observação)** — Trabalho cancelado com Pergunta aberta não tem saída: `factory answer` → `not-applied WORK_NOT_OPEN`;
  `cleanup --select environment` → `PROTECTED QUESTION_OPEN`; `forget` → `PROTECTED` + `RESOURCES_PENDING`. Trabalhos 67f6c34e e 8019ed17.
  Consequência: o ambiente deles e a imagem que usam nunca saem pelo produto (`cleanup-images`: `in-use … kept works=2`, cleanup-images-final.json).
- Limpeza na AWS (verificada por leitura depois de cada passo): 0 MicroVM viva; 3 imagens → 0 (1 pela Factory, 2 por `aws delete-microvm-image`:
  a CREATE_FAILED no teste do fato de serviço da A18 e a última por causa da A19); 2 artefatos de build apagados do bucket (0 objetos);
  3 log groups de build ausentes (2 apagados, 1 já ausente).
- GitHub: repositório de apoio `Sanmoo/sfv2acc-fixture` apagado (listas de refs, issues e PRs salvas antes em fixture-*-before-delete.*);
  com ele saem as refs de marcador, branches e issues de teste. Repositório real: sem PR aberto, sem refs da Factory, ruleset 26435808 igual ao anterior;
  a branch `chore/factory-environment` é anterior à campanha (PR #129 de 2026-11-20) e foi deixada.
- Local: worktrees e branches já integrados removidos (boot-swap-secret-channel, lambda-run-microvm-tags, lambda-acceptance-findings-2,
  lambda-orphan-call-end). Fica `.worktrees/lambda-concurrent-wip-push` (A18 pendente).
- NÃO feito pelo agente (sem permissão ou por serem credenciais): apagar a stack `factory-sfv2acc` (roles + bucket vazio), o usuário IAM
  `factory-sfv2acc-operator` e sua chave, os perfis AWS locais `factory-sfv2acc` e `factory-sfv2acc-source`, e `lb1/credentials`.
- Atualização (depois do fechamento, a pedido explícito do Operador no chat): A18 integrada na main (350663ac) após test:ci verde.
  Itens que estavam pendentes do Operador, feitos pelo agente com o perfil AWS de administração que o Operador escolheu: stack
  `factory-sfv2acc` apagada (verificado: stack inexistente, as duas roles `NoSuchEntity`, bucket 404); usuário IAM
  `factory-sfv2acc-operator` apagado com sua chave e a política inline (verificado `NoSuchEntity`); perfis AWS locais
  `factory-sfv2acc` e `factory-sfv2acc-source` removidos; `lb1/credentials` removido sem leitura.
