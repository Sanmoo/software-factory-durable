# Aceite da v2 no perfil Lambda — resultados

Campanha de 2026-11-21 e 2026-11-22. Ticket 16 (Aceite da v2 no perfil Lambda). Rubrica v1 aprovada pelo Operador
(31 critérios; o hash do arquivo confere com o registro de aprovação). Registro corrido da campanha:
`lambda-acceptance-findings.md`; passos humanos: `lambda-acceptance-human-steps.log`; avaliação por critério:
`lambda-acceptance-assessment.json`.

Como ler os vereditos. A rubrica só admite três valores: `approved`, `rejected` e `inconclusive`. Para não esconder
a diferença entre "vimos uma parte" e "não tentamos", cada `inconclusive` leva um qualificador: **parcial** (parte da
condição foi observada; a tabela diz o que falta) ou **não coberto** (nada foi observado). Nenhum veredito foi
promovido sem evidência: quando a testemunha pedida pela rubrica não foi vista por inteiro, o critério está como
`inconclusive`.

Escopo: só o perfil testado (release construída da `main`, adapter Lambda MicroVMs em us-east-1, ARM64, concurrency 2,
`openai/gpt-6-luna` nos três papéis, repositório real `Sanmoo/java-springboot-event-sourcing` e repositório de apoio
`Sanmoo/sfv2acc-fixture`). Não é homologação de produção. Os caminhos de evidência são relativos ao diretório local
da campanha; `final-works/<trabalho>.*` são as exportações finais (histórico completo, `show` e `usage`) dos 23 Trabalhos.

## 1. Resumo em 10 linhas

1. **Obrigatórios: os dois estão `approved`** — G15 (nada roda depois da cessação) e G17 (a substituta conclui, publica, não repete o efeito incerto e pergunta). Nenhum obrigatório pendente. As ressalvas de evidência dos dois estão na tabela.
2. Placar dos 31 critérios: **21 `approved`**, **10 `inconclusive`** (9 parciais, 1 não coberto), **0 `rejected`**. A limpeza (X2) ficou parcial: restam quatro itens que dependem do Operador.
3. Provado na conta real: jornada completa de um Ticket até o merge humano e a limpeza (C01); dois Builders simultâneos com Testcontainers, cada um na sua MicroVM (C03, C08); dependência nativa (C02); reparos por conflito e por check obrigatório (C04); commit humano preservado até o PR (C09).
4. Provado também: troca planejada de boot sob margem, interrupção de chamada longa na metade da margem, boot único de 4150 s, Execução de 4669 s sem corte por tempo (G12, C11); mesma sessão depois da troca (G10); dois boots sem commit geram Bloqueio (G14).
5. Provado nos casos de perda: MicroVM morta por fora, controller morto com `SIGKILL`, canal derrubado e três recusas do gate — em todos a Factory registrou a perda, criou a ref de marcador e iniciou a substituta sozinha (G05, G16, G17, G20, C06).
6. Isolamento: revisor não escreve no workspace nem alcança o Docker; nenhum token em arquivo ou linha de comando; nenhuma credencial AWS no guest (G23, G24). Resíduo conhecido e já aceito pelo Operador: o token fica no ambiente do processo residente do marcador.
7. **Contratuais não aprovados (8, todos parciais):** C05, C07, C10, C12, G11, G30, G32, X2. Auxiliares não aprovados: X0 (parcial) e G30b (não tentado). O que falta em cada um está na coluna "O que falta".
8. A campanha achou defeitos reais do produto: doze achados resolvidos e verificados na conta real (A1–A8, A9 parte A, A11, A13, A14; o A4 por decisão do Operador, sem mudança no produto). A `main` está nas quatro correções A13, A14, A6 e A9 parte B (release v2-acc-7); a A9 parte B tem só teste automatizado, **não** foi exercitada na conta. A correção A18 (limpeza de imagens) foi verificada na conta com uma release local, mas **ainda não está na `main`**.
9. Viram tickets: A10, A12, A15, A16, A17, A19 e quatro candidatos de acompanhamento (rascunhos em `tickets/`). Estado final: 23 Trabalhos, 13 entregues, 9 cancelados, 1 fechado sem merge, nenhum aberto.
10. Custo final dentro dos tetos: 51 MicroVMs = 8,34 MicroVM-horas (teto 40), 3 builds de imagem (teto 30), 33,0 M tokens (teto 150 M), estimativa do catálogo do SDK US$ 2,31. A cobrança da AWS não foi lida.

## 2. Tabela por critério

Legenda de "Tipo": C = contratual, A = auxiliar, **OBR** = obrigatório.
"só no registro corrido" significa que não há arquivo de evidência que confirme aquela parte; vale a palavra de `lambda-acceptance-findings.md`.

### Perfil e critérios do MVP (CA-01 a CA-12)

| Critério | Tipo | Veredito | O que foi observado | O que falta | Evidência |
| --- | --- | --- | --- | --- | --- |
| X0-perfil | A | `inconclusive` (parcial) | Ficaram registrados: o SHA e o identificador de cada release (v2-acc-1 a v2-acc-7), Node 24.21.0, o modelo por papel, a região, a quota e o limite de boot lidos pelo `doctor`. | Versões e caminhos de `aws-cli`, `ssh` e `websocat` não estão gravados (o `doctor` só diz que os executáveis rodam). O `doctor` gravado antes do primeiro boot é anterior às credenciais (3 checks bloqueados). As saídas brutas do `doctor` contêm o identificador da conta `<conta>` e por isso não entram no conjunto publicado. | `release-v2-acc-*/build-report.json`, `doctor-1.json`, `final-works/doctor-final.raw.json`, `config-campaign.json` |
| C01-jornada | C | `approved` | Ticket #133 do repositório real: implementação, dois reviews de papéis distintos (`standards` e `spec`, limpos), PR #134 publicado pelo Builder no mesmo boot com a ponta igual ao commit verificado, conversão para pronto, merge humano, entrega confirmada, limpeza com branch remota removida e marcadores ausentes; MicroVM em `TERMINATED`. | Nada. O merge "pela conta do Operador" consta do registro de passos humanos. | `final-works/a23f433b-2e61-4e36-a1cc-770757201a19.history.json`, `w133/microvm-boot2.json`, `lambda-acceptance-human-steps.log` |
| C02-dependencia | C | `approved` | Ticket #25 bloqueado pelo #24: admitido com Bloqueio `DEPENDENCY_PENDING`, nenhuma reserva nem boot por cerca de 9 minutos; 30 s depois do merge do PR do #24 a dependência passou a satisfeita e só então houve reserva e boot. | Não há uma listagem de MicroVMs separada daquele intervalo; a ausência de boot vem do histórico do Trabalho. | `wf14/show-blocked.json`, `final-works/827d6617-c521-48cd-84ab-8b14e151204a.history.json` |
| C03-concorrencia | C | `approved` | Tickets #135 e #127 reservados com 5 s de diferença, MicroVMs distintas iniciadas às 10:01:01 e 10:01:03 UTC e vivas ao mesmo tempo (2428 s e 1743 s), branches distintas. O terceiro (#128) foi admitido às 10:01:40 e só reservou às 10:30:50, depois que o #127 liberou o Slot. Pico de 2 MicroVMs simultâneas em toda a campanha. | Nada (três Builders está fora da rubrica). | `final-works/efc54451-96d5-4fce-9fda-fea0091a04b8.history.json`, `final-works/0da1c800-8766-4317-a68d-caf10257e6df.history.json`, `final-works/9436bb22-344b-4a10-be99-7f68e28a8f2e.history.json`, `probes/x1-microvms-final.jsonl` |
| C04-reparos | C | `approved` | Conflito com a base: o PR #3 voltou a rascunho, a Factory abriu uma correção, rodou o reparo em boot novo e republicou. Check obrigatório `factory-gate` em falha no PR #27: uma única correção aberta, mesmo com a falha publicada duas vezes no mesmo commit. Ordem: com o despacho pausado e liberado depois, o reparo do PR #29 foi reservado às 09:01:44.946 e o Ticket novo (#30) às 09:02:15.377; conflito e check viraram um único reparo (`repair-consolidated`). No repositório real, reparo explícito do #135 depois de a base se mover. | Nada. Na primeira tentativa o Ticket novo (#28) foi reservado 6 s antes de a falha do check ser avaliada, por isso a ordem foi repetida de forma controlada. | `final-works/eae39394-2a5b-420e-ae90-8467be93b052.history.json`, `final-works/827d6617-c521-48cd-84ab-8b14e151204a.history.json`, `final-works/8019ed17-3e55-45d0-b77f-552b0d9f5b07.history.json`, `final-works/c475093e-dc80-4200-b927-935304599b70.history.json`, `final-works/0da1c800-8766-4317-a68d-caf10257e6df.history.json` |
| C05-pergunta | C | `inconclusive` (parcial) | Em oito Trabalhos a Pergunta foi publicada no Ticket, o Slot foi liberado e a resposta do Operador retomou o mesmo Trabalho (por comentário e, uma vez, pelo CLI local). | Não há evidência de **outro Trabalho iniciado durante a espera**, que a testemunha pede: conferidos os 23 históricos finais, nenhuma Execução de outro Trabalho foi reservada dentro da janela de uma Pergunta aberta. | `final-works/1707fc5a-e888-4503-b48a-1b48ba3b8288.history.json`, `final-works/eae39394-2a5b-420e-ae90-8467be93b052.history.json`, `final-works/e4e15994-9f85-4768-9df9-b6fa8152dfeb.history.json`, `final-works/907c00d4-05cd-409d-8526-f73ca52999cc.history.json`, `final-works/dd8abb72-db36-479a-ae6a-3c42eda41d81.history.json`, `final-works/67f6c34e-f14e-4c99-a5b3-66e700aade5e.history.json` |
| C06-crash | C | `approved` | `SIGKILL` no processo dono do controller com um Builder ativo. No reinício: `execution-reconciled … CONTROLLER_CRASH; cessation confirmed`, Slot liberado, perda registrada com ref de marcador, substituta iniciada pela fila com um orçamento de recuperação consumido; ela retomou dos commits publicados. Um único PR (#12), entregue; nenhuma Pergunta no histórico. | Nada. A órfã foi localizada pelos registros de boot, não por tag própria (ver A2). | `final-works/6acadbcb-ebb0-4653-bfd6-885d0affbbfa.history.json`, `final-works/6acadbcb-ebb0-4653-bfd6-885d0affbbfa.usage.json`, `lambda-acceptance-human-steps.log` |
| C07-cancelamento-limites | C | `inconclusive` (parcial) | Cancelamento com boot ativo: `WORK_CANCELLED` em 1 s, Slot liberado e cessação registrada 21 s depois, Bloqueio `WORK_CANCELLED` com próximo passo, MicroVM em `TERMINATED`. Orçamento mínimo (`correctionLimit` 0): `budget-exhausted corrections:0/0`, Bloqueio `CORRECTION_LIMIT_REACHED` com o comando `factory grant`, branch e PR #35 presentes na origem. | No caso do cancelamento não há evidência de que a **branch de trabalho ficou na origem**: a branch não existia na origem no início do boot e não houve portão de preservação nem listagem de refs depois do cancelamento. | `final-works/93c9b301-3120-4a88-bf0f-8e1e8382b6ae.history.json`, `final-works/93c9b301-3120-4a88-bf0f-8e1e8382b6ae.show.json`, `final-works/86384365-0849-4f6c-9303-525a97f3fb63.history.json`, `wf19/show.json` |
| C08-containers | C | `approved` | Nos dois Trabalhos simultâneos do repositório real apareceram containers do Testcontainers dentro de cada MicroVM (`testcontainers/ryuk`, `postgres:18`) e os gates passaram: `check-and-acceptance` no #127 e `ticket-validation` no #135. | O gate do #135 tem outro nome; não há arquivo que confirme que ele roda exatamente `./gradlew check acceptanceTest`. | `probes/c08-containers.txt`, `final-works/efc54451-96d5-4fce-9fda-fea0091a04b8.show.json`, `wfr2/show-1.json` |
| C09-mudanca-humana | C | `approved` | Commit de terceiro (`3662912`) empurrado na branch durante a espera da Pergunta: a retomada partiu dele, ele virou o commit verificado e, depois da reavaliação da publicação, é a ponta do PR #37, mesclado e entregue. Não foi sobrescrito. | Nada. **Mudou em relação ao rascunho** (era parcial): faltava o commit no histórico de um PR, e esse Trabalho só ganhou PR com a verificação do A6. | `final-works/1707fc5a-e888-4503-b48a-1b48ba3b8288.history.json`, `wf1/show-blocked.json`, `lambda-acceptance-human-steps.log` |
| C10-elegibilidade | C | `inconclusive` (parcial) | Rótulo retirado com boot ativo: `authorization-withdrawn LABEL_NOT_PRESENT` em 23 s, Bloqueio `AUTHORIZATION_WITHDRAWN`; a atividade em curso terminou e publicou o PR #15 em rascunho; nenhuma ativação nova. Depois de o Ticket e o PR serem fechados, o histórico segue por quase duas horas de polling sem nenhuma Execução nova. Um só Trabalho por Ticket nos 23 históricos. | Não foi exercitado o rótulo retirado de um Ticket **na fila** (antes de qualquer boot), como a testemunha pede. | `final-works/0ec12177-5ce6-41c3-ac35-483b4c00a1da.history.json`, `final-works/0ec12177-5ce6-41c3-ac35-483b4c00a1da.show.json` |
| C11-tempo | C | `approved` | Uma única Execução de 4669 s atravessou seis trocas planejadas sem corte por tempo (`timeout` sem valor configurado); soma dos boots 4662,8 s. Slot liberado em todas as esperas humanas. | Nada. | `wf5/history.json`, `wf5/usage.json`, `wf5/show.json` |
| C12-cli | C | `inconclusive` (parcial) | A maioria dos Bloqueios apareceu no CLI com código, causa e próximo passo, nunca como sucesso: falha de build com a mensagem do `apk`, falta de progresso entre boots, limite de correções, dependência pendente, autorização retirada, cancelamento, merge bloqueado pelo ruleset. | Houve casos em que o CLI não ajudou: Trabalho parado sem Bloqueio nem próximo passo (A9, corrigido depois); PR fechado por exclusão da branch com próximo passo que leva a um comando que falha e sem mostrar a causa (A12, aberto); Trabalho aberto sem Bloqueio depois de revisão `incomplete` (A15) e depois de um reparo perdido (A17). Mantido como parcial: a evidência nova não muda o quadro. | `wf12/show.json`, `wf10/show.json`, `wf19/show.json`, `wf14/show-blocked.json`, `wf4/show-stuck.json`, `final-works/8019ed17-3e55-45d0-b77f-552b0d9f5b07.show.json`, `final-works/0e0d892b-d452-4c98-9e96-7694d1a57f40.history.json` |

### Gates da v2 (Seção 11 da spec)

| Critério | Tipo | Veredito | O que foi observado | O que falta | Evidência |
| --- | --- | --- | --- | --- | --- |
| G05-gate | C | `approved` | Caso comum, visto em seis Trabalhos: ao parar numa Pergunta com commit não publicado o gate recusou (`HEAD_NOT_PUBLISHED`), o Builder real publicou, o gate aceitou e só então a Execução e o boot terminaram. Uma vez com arquivo modificado sem commit (`WORKSPACE_MODIFIED`), também corrigido antes do fim. Três recusas: três `preservation-refused … WORKSPACE_UNTRACKED` em 36 s, boot encerrado como perda (`PRESERVATION_GATE_REFUSED`), ref de marcador criada, substituta iniciada com um orçamento de recuperação consumido. | Desvio do roteiro: o arquivo não rastreado foi deixado pelo próprio Builder a pedido do Ticket (confirmado por uma resposta do Operador), não recriado por processo injetado pelo canal. | `final-works/67f6c34e-f14e-4c99-a5b3-66e700aade5e.history.json`, `final-works/67f6c34e-f14e-4c99-a5b3-66e700aade5e.show.json`, `final-works/1707fc5a-e888-4503-b48a-1b48ba3b8288.history.json`, `final-works/0e0d892b-d452-4c98-9e96-7694d1a57f40.history.json` |
| G09-espera | C | `approved` | Espera humana: MicroVM terminada às 00:12:29.820 e Slot liberado às 00:12:32.221. Espera de CI: terminada às 23:43:24.599 e Slot liberado às 23:43:28.065. Nos dois casos o encerramento vem antes. | Nada. | `wf1/microvm-boot1.json`, `final-works/1707fc5a-e888-4503-b48a-1b48ba3b8288.history.json`, `w133/microvm-boot2.json`, `final-works/a23f433b-2e61-4e36-a1cc-770757201a19.history.json` |
| G10-mesma-sessao | C | `approved` | Depois da resposta à Pergunta, o boot novo continuou a mesma sessão (`SESSION_COMPATIBLE`, mesmo identificador `01a200c5…` no pedido e no fim), com o aviso de boot apontando o boot anterior e `spec` e `instructions` restaurados. Repetido no Ticket #16 (modo `continue`, 22 entradas carregadas) e numa única sessão ao longo de sete boots no Ticket #10. | O texto do aviso dentro da sessão não foi aberto; vale o registro `bootNotice` do `show`. Na primeira tentativa (release v2-acc-2) a sessão foi trocada: achado A5, corrigido. | `wf2/show-1.json`, `wf2/show-repair.json`, `wf9/usage.json`, `wf5/usage.json` |
| G11-divergencia | C | `inconclusive` (parcial) | (b) Histórico reescrito: `origin-rewrite-followed`, sessão nova (modo `replace`, `ORIGIN_HISTORY_REWRITTEN`), aviso com os dois commits e uma recuperação consumida. (c) Branch ausente: nenhum boot, Pergunta nova com as respostas `restart` ou `end`; respondido `end`, Trabalho encerrado. | (a) O commit de terceiro foi incorporado, mas **não na mesma sessão**: naquela retomada a sessão foi substituída por `SESSION_INCOMPATIBLE` (defeito A5 da release da época). O caso não foi repetido depois da correção. Mantido como parcial: as exportações finais confirmam (b) por inteiro, mas não trazem um caso (a) com a mesma sessão. | `wf1/show-blocked.json`, `final-works/827d6617-c521-48cd-84ab-8b14e151204a.history.json`, `wf14/show.json`, `wf14/usage.json`, `wf14/g11b-substitute-session-notice.txt`, `final-works/dd8abb72-db36-479a-ae6a-3c42eda41d81.history.json` |
| G12-troca | C | `approved` | Com limite de 900 s e margem de 300 s: seis trocas planejadas numa Execução, boots de 553 a 760 s, sempre com preservação aceita antes do fim. Chamada longa (`sleep 1500`) interrompida aos ~750 s (`boot-swap-due … call-interrupted`, chamada encerrada no guest, efeito `orphan-ended`). Boot único com limite de 4500 s: vivo por 4150,3 s. | A devolução do resultado "interrompido" à sessão está registrada no canal; a sessão não foi aberta. | `wf5/history.json`, `wf5/usage.json`, `wf10/history.json`, `wf10/channels.jsonl`, `wf11/usage.json`, `final-works/f702100c-fd53-4212-be58-d9d7fe733259.history.json` |
| G14-sem-progresso | C | `approved` | Dois boots seguidos terminaram por troca planejada com a branch parada no mesmo commit: `boot-loop-blocked`, Execução encerrada com `NO_PROGRESS_BETWEEN_BOOTS`, Bloqueio com a causa provável e o comando `factory resume`; nenhum terceiro boot. | Nada. | `wf10/history.json`, `wf10/show.json`, `wf10/usage.json` |
| G15-cessacao | C **OBR** | `approved` | MicroVM encerrada por fora às 01:34:14 no meio de uma chamada; o serviço registra `terminatedAt` 01:34:16.913. Na sessão copiada do boot perdido, o último pedido ao modelo é de 01:33:15.207 (a chamada que estava em curso). Depois da cessação há só dois registros escritos pelo host às 01:34:29.6: o resultado "Command aborted (effects unknown)" e o fecho `WORKER_SESSION_CLOSED_BY_HOST`, com 0 tokens e duração 0. Nenhum pedido de modelo e nenhuma chamada nova. A Factory confirmou a cessação às 01:34:32 (`boot-ended start->loss`). | Ressalva: a rubrica pede a leitura "na sessão e no registro de uso do boot". O uso em MicroVM-segundos do boot existe e fecha no `terminatedAt`, mas o uso de **tokens** daquela Execução estava `unavailable` (`SESSION_NOT_RECORDED`, achado A7, corrigido depois). A prova apoia-se na sessão. O horário do encerramento externo vem do registro de passos humanos (o arquivo da chamada ficou vazio). Uma execução só; sem log do lado do provedor (fora da rubrica). | `wf3/lost-session.jsonl`, `wf3/microvm-lost.json`, `final-works/e4e15994-9f85-4768-9df9-b6fa8152dfeb.history.json`, `wf3/usage-final.json`, `lambda-acceptance-human-steps.log` |
| G16-marcador | C | `approved` | Na perda, a ref `refs/factory/lost/<trabalho>/<boot>` apareceu na origem apontando para o commit não publicado (`1d77490`); a substituta declarou ter recuperado o commit a partir do marcador e recebeu o aviso de boot com `lost: true`; na limpeza do Trabalho, `lost-markers:removed` (também no Trabalho do C06). | A leitura da origem confirmando a ausência da ref depois da remoção está só no registro corrido; o histórico registra a remoção. | `wf3/refs-after-substitute.txt`, `wf3/show-question.json`, `final-works/e4e15994-9f85-4768-9df9-b6fa8152dfeb.history.json`, `final-works/6acadbcb-ebb0-4653-bfd6-885d0affbbfa.history.json` |
| G17-substituta | C **OBR** | `approved` | Efeito não idempotente (um script que cria uma branch `effects/*` na origem); MicroVM morta durante o efeito. A substituta começou sozinha, não rodou o script de novo, publicou o commit recuperado e abriu uma Pergunta citando o boot perdido e a chamada registrada, com as opções "dar por feito" ou "repetir". Depois da resposta: reviews limpos, PR #7, pronto, merge, entrega. Na origem havia uma única branch `effects/*` no momento da Pergunta. | A contagem "1 efeito" **ao fim** do Trabalho está só no registro corrido (a listagem de refs gravada é do momento da Pergunta; a terceira Execução não tem chamada ao script no histórico, mas a sessão dela não foi aberta). Uma execução só; a variância do modelo está fora da rubrica. | `final-works/e4e15994-9f85-4768-9df9-b6fa8152dfeb.history.json`, `wf3/show-question.json`, `wf3/refs-before-kill.txt`, `wf3/refs-after-substitute.txt` |
| G20-canal | C | `approved` | Na release v2-acc-6: túnel morto durante uma chamada longa; em 2,6 s a recuperação encerrou a chamada órfã no guest (`call-ended`), registrou o efeito `orphan-ended` e a ativação seguiu no mesmo boot. Canal irrecuperável (v2-acc-5): cinco tentativas, `SANDBOX_CHANNEL_UNRECOVERABLE`, boot encerrado como perda e substituta com uma recuperação consumida. | O caminho de esgotamento foi alcançado por causa do defeito A11 (a reconexão não conseguia encerrar a órfã), não por um túnel bloqueado além do limite, e não foi repetido depois da correção. As cinco tentativas constam do motivo da perda (o registro do canal daquela tentativa não foi guardado). O texto "indeterminado" recebido pela sessão está só no registro corrido. | `wf9/channel.jsonl`, `final-works/907c00d4-05cd-409d-8526-f73ca52999cc.history.json`, `final-works/6acadbcb-ebb0-4653-bfd6-885d0affbbfa.history.json`, `wf6/show.json` |
| G23-revisores | C | `approved` | Sonda pelo canal como usuário `reviewer`, em dois boots: escrita em `/workspace` e no checkout recusada, leitura permitida, socket do Docker inacessível (`permission denied`), sem `sudo`. Vereditos reais dos dois revisores produzidos em MicroVM, no repositório de apoio e no real. | Nada. | `probes/g23-g24-run1.txt`, `probes/g23-g24-run2.txt`, `final-works/f702100c-fd53-4212-be58-d9d7fe733259.history.json`, `final-works/efc54451-96d5-4fce-9fda-fea0091a04b8.history.json` |
| G24-credenciais | C | `approved` | Varredura como usuário `builder` com sentinela de controle positivo encontrado (arquivo e ambiente): nenhum token em arquivo, em linha de comando ou na configuração do Git; nenhuma variável `AWS_*`, nenhum arquivo de credencial; o serviço de metadados não entrega credenciais (404). | Dentro da exclusão da rubrica: o processo residente do marcador carrega o token no ambiente, legível pelo usuário do Builder (aceito nas decisões 9 e 10). Limites da sonda: 9 processos de `root` com ambiente ilegível não foram lidos; `/var/lib/docker` ficou fora; a primeira varredura foi recusada pelo transporte e a parte de arquivos da segunda foi invalidada, valendo a terceira. | `probes/g24-run3.txt`, `probes/g23-g24-run2.txt` |
| G27-ambiente | C | `approved` | Imagem construída a partir do ambiente declarado do repositório real (`created` no primeiro Trabalho) e reusada sem build nos seguintes (`reused`); no guest, `openjdk25-jdk-25.0.5.1_p2-r0`, igual à versão declarada. Declaração com versão inexistente: Execução retida sem boot, Bloqueio com a mensagem literal do `apk`. Três builds registrados em toda a campanha (2 criados, 1 falho). | Nada. | `final-works/a23f433b-2e61-4e36-a1cc-770757201a19.history.json`, `final-works/efc54451-96d5-4fce-9fda-fea0091a04b8.history.json`, `probes/c08-containers.txt`, `wf12/show.json`, `final-works/usage-all.json` |
| G30-validate | C | `inconclusive` (parcial) | Com concurrency 3: bloqueio `lambda-quota` citando a conta ("3 x 4096 MiB = 12288 MiB; quota 8192 MiB"). Com uma ação retirada da role: bloqueio citando a ação pelo nome (`lambda:DeleteMicrovmImageVersion`) e o próximo passo. `doctor` final (v2-acc-7): 30 checks aprovados, nenhum bloqueado. | A lacuna do rascunho (não havia saída gravada de um `doctor` sem bloqueios) foi fechada. Fica como parcial só pela letra da testemunha, "todos os checks do Lambda aprovados": dois checks do Lambda saem `unverified` por desenho (`lambda:PassNetworkConnector`, achado A1, e `lambda-runtime`). Se o Operador aceitar `unverified` como o resultado esperado desses dois, o critério está cumprido. Desvio registrado: a role ficou cerca de 2 minutos sem a ação e foi restaurada à mão. | `doctor-concurrency3.json`, `doctor-missing-permission.json`, `final-works/doctor-final.raw.json`, `lambda-acceptance-human-steps.log` |
| G30b-espera-capacidade | A | `inconclusive` (não coberto) | Não foi tentado: nenhuma recusa de capacidade foi provocada (a rubrica admite tentar só se couber nos tetos). | Tudo. | — |
| G32-consumo | C | `inconclusive` (parcial) | `factory usage` traz MicroVM-segundos por boot e por Trabalho, com início e fim iguais aos do serviço (por exemplo 348,166 s no #133; 4662,8 s em sete boots no #10). A reconciliação encerrou a MicroVM órfã do C06. Depois da correção A7, Execuções perdidas aparecem como `partial / SESSION_ENDED_BY_LOSS`. | (1) A reconciliação não é "por tag": o serviço não aceita tag na MicroVM (A2); o caso de uma órfã sem registro de boot não foi exercitado. (2) Não há, no boot morto do G15, uma declaração explícita de "evidência do guest perdida": na época o uso saiu como `SESSION_NOT_RECORDED`. | `w133/usage-final.json`, `w133/microvm-boot2.json`, `wf5/usage.json`, `final-works/6acadbcb-ebb0-4653-bfd6-885d0affbbfa.usage.json`, `wf3/usage-final.json` |

### Custo e limpeza

| Critério | Tipo | Veredito | O que foi observado | O que falta | Evidência |
| --- | --- | --- | --- | --- | --- |
| X1-custo | A | `approved` | Leitura final: 51 MicroVMs, todas `TERMINATED`, 30 030 s = 8,34 MicroVM-horas (teto 40); pico de 2 simultâneas (teto 2); 3 builds de imagem (teto 30); 32 995 685 tokens (teto 150 M); estimativa do catálogo do SDK US$ 2,31. Leitura de uso às 14:21 UTC de 2026-11-22. | Nada dentro da rubrica. **Mudou em relação ao rascunho** (era parcial): faltavam a leitura final, os builds, os tokens e a estimativa. A estimativa em dólares é do catálogo do SDK para os tokens, não uma fatura; a cobrança da AWS não foi lida (fora da rubrica). | `probes/x1-microvms-final.jsonl`, `final-works/usage-all.json`, `final-works/status.json` |
| X2-cleanup | C | `inconclusive` (parcial) | Feito e verificado por leitura: nenhuma MicroVM viva; 3 imagens → 0; bucket de build com 0 objetos; 3 log groups de build ausentes; repositório real sem PR aberto e sem refs da Factory, ruleset igual ao anterior. Repositório de apoio apagado. | Pendentes do Operador: stack `factory-sfv2acc` (roles e o bucket, já vazio), usuário IAM `factory-sfv2acc-operator` e sua chave, perfis AWS locais `factory-sfv2acc` e `factory-sfv2acc-source`, e `lb1/credentials`. Além disso, a limpeza do próprio produto não removeu tudo sozinha: `cleanup-images` falhou na última versão de cada imagem (A18, corrigido e verificado com release local, ainda fora da `main`) e dois Trabalhos cancelados com Pergunta aberta seguraram a última imagem (A19, aberto); duas das três imagens saíram pela CLI da AWS. | `cleanup-images-failed.json`, `cleanup-images-acc8.json`, `cleanup-images-final.json`, `cleanup-environments.jsonl`, `fixture-refs-before-delete.txt`, `lambda-acceptance-human-steps.log` |

## 3. Achados

### 3.1 Resolvidos e verificados na conta real

- **A1** — o `doctor` acusava como faltante uma permissão que o simulador da AWS não sabe avaliar; agora marca `unverified` (`final-works/doctor-final.raw.json`).
- **A2** — o serviço não aceita tag ao iniciar a MicroVM; o início passou a funcionar sem tag própria (release v2-acc-2). Consequência: o uso de MicroVM não aparece no filtro por tag da cobrança.
- **A3** — a linha útil de um erro da CLI da AWS não aparecia no diagnóstico; corrigido na v2-acc-3. Verificação: só no registro corrido. (O rótulo A3 também foi usado para "upgrade com Execução retida", que funcionou como documentado.)
- **A4** — repositório privado no plano gratuito do GitHub não aceita ruleset; resolvido por decisão do Operador (repositório de apoio tornado público), não por mudança no produto.
- **A5** — a retomada trocava a sessão do Builder (`SESSION_INCOMPATIBLE`); corrigido na v2-acc-3 e a mesma sessão foi observada (`wf2/show-repair.json`).
- **A6** — publicação bloqueada virava beco sem saída mesmo com o commit verificado na origem. Na v2-acc-7, no Ticket #1 do repositório de apoio: a reavaliação levantou o bloqueio, uma Execução só de publicação abriu o PR #37, a Factory o marcou como pronto, merge humano e entrega (`final-works/1707fc5a-e888-4503-b48a-1b48ba3b8288.history.json`). **Mudou em relação ao rascunho**: estava como "não exercitado".
- **A7** — `factory usage` não contava os tokens de uma Execução perdida; na v2-acc-5 aparecem como `partial / SESSION_ENDED_BY_LOSS` (`final-works/6acadbcb-ebb0-4653-bfd6-885d0affbbfa.usage.json`).
- **A8** — a troca planejada derrubava a ativação (`WORKER_SECRET_SYNC_SCHEMA`); corrigido na v2-acc-4, seis trocas seguidas observadas (`wf5/history.json`).
- **A9 parte A** — Trabalho ficava parado sem recuperação nem Bloqueio depois de uma falha; nas releases seguintes toda perda foi seguida de `recovery-requested` (Trabalhos `6acadbcb` e `67f6c34e`).
- **A11** — a reconexão do canal não encerrava a chamada órfã (processo zumbi tido como vivo); corrigido na v2-acc-6 e confirmado (`wf9/channel.jsonl`).
- **A13** — o push de preservação de um Trabalho bloqueava a publicação de outro (`UNEXPECTED_REF_CHANGE`); na v2-acc-7 a reavaliação do #128 foi aceita e vinculou o PR #137.
- **A14** — marcador do PR digitado errado pelo modelo bloqueava a publicação sem reavaliação; na v2-acc-7 a reavaliação mostra o marcador exato e, corrigido o corpo do PR #136, foi aceita.

### 3.2 Correções que ainda não fecharam o ciclo

- **A9 parte B** — implementada, com teste automatizado, na `main` (`97d6932d`, release v2-acc-7), mas **não exercitada na conta real**: falha devolvida que não é transitória ganha uma Execução substituta automática.
- **A18** — `factory cleanup-images --yes` (v2-acc-7) terminou `IMAGE_CLEANUP_INCOMPLETE`: o serviço real não apaga a última versão de uma imagem isoladamente ("This is the last version. Please delete the entire image"); o fake dos testes modelava o contrário. Correção `ed96011b` (a limpeza e a nova tentativa de build falho apagam a imagem inteira). **Verificada na conta real** com a release local v2-acc-8, construída da branch `fix/lambda-concurrent-wip-push`: a imagem removível saiu como `removed`. **Ainda não está na `main`**: `npm run test:ci` falhou quatro vezes por causa ambiental (cota de usuário do `/tmp`), nunca no código alterado; a integração espera uma rodada verde. A nova tentativa depois de um build falho, também tocada pela correção, não foi exercitada na conta. Evidência: `cleanup-images-failed.json`, `cleanup-images-acc8.json`.

### 3.3 Observações que viram tickets (rascunhos em `tickets/`)

- **A10** (`tickets/17`) — os revisores só veem o diff agregado, não a lista de commits; não conseguem verificar um requisito como "um commit por passo".
- **A12** (`tickets/18`) — com o PR fechado pela exclusão da branch, o próximo passo indicado (`factory reopen`) falha e a causa (branch ausente) não aparece; a resposta à Pergunta pendente não foi lida.
- **A15** (`tickets/19`) — pareceres rebaixados a `incomplete` porque o revisor, em sessão continuada, não relê o que já leu; `incomplete` não tem nova tentativa e o Trabalho fica aberto **sem Bloqueio nem próximo passo como Bloqueio**. Um `update-scope` do Operador inicia, sim, uma nova Execução verificada (foi a saída usada no #135); a lacuna é a falta de nova tentativa e de Bloqueio visível.
- **A16** (`tickets/20`) — removida a regra que bloqueava o merge, a Factory não reavaliou a prontidão sozinha em ~3 minutos; o humano marcou os PRs como prontos.
- **A17** (`tickets/21`) — reparo automático de conflito perdido: o Builder fez rebase, não rodou o gate, o portão de preservação recusou o push e o Builder descartou o reparo com `git reset --hard` para satisfazer o portão; o Trabalho ficou aberto, em conflito, sem Bloqueio e sem nova correção.
- **A19** (`tickets/26`) — Trabalho cancelado com Pergunta aberta não tem saída: `factory answer` responde `WORK_NOT_OPEN`, a limpeza do ambiente e o `forget` respondem `PROTECTED`; o ambiente e a imagem que ele usa nunca saem pelo produto (Trabalhos `67f6c34e` e `8019ed17`; `cleanup-images-final.json`).

Candidatos de acompanhamento:

- (`tickets/22`) Matar só o lançador ou só o supervisor deixa o processo dono rodando sem supervisão (não investigado).
- (`tickets/23`) O processo 1 do guest não recolhe filhos órfãos: sobram zumbis.
- (`tickets/24`) `show` exibe o modo `initial` para uma Execução substituta.
- (`tickets/25`) Início de boot recusado por defeito do produto exigiu comando do Operador; e a MicroVM sem tag própria deixa sem cobertura a órfã sem registro de boot e o custo por tag.

Outras observações desta conferência, sem ticket próprio: o total de tokens de um Trabalho sai `partial` quando as sessões dos revisores ficam como `SESSION_INTEGRITY_UNVERIFIED`; um revisor precisou de nova tentativa por `REVIEW_VERDICT_BASIS_INVALID`; retirado o rótulo com boot ativo, a atividade em curso ainda publica um PR em rascunho (comportamento herdado do MVP); a primeira sonda de credenciais foi recusada pelo transporte sem código registrado.

### 3.4 Ticket #10 do repositório de apoio (Trabalho `0e0d892b`)

A pendência do rascunho foi resolvida: o `update-scope` foi executado pelo agente a pedido explícito do Operador no chat; a nova
Execução teve revisão limpa e publicou o PR #36. O PR nasceu em conflito com a base, a Factory abriu a correção sozinha e o
reparo se perdeu (A17). O Trabalho foi cancelado no fechamento; **o PR #36 não foi entregue**.

## 4. Não coberto

Fora da rubrica desde o início (limites declarados no plano):

- V2-04 (capacidade ausente): não é observável em conta real; fica só com os testes compostos.
- CA-03 com três Builders (a quota comporta dois).
- CA-02 com dados inacessíveis e fechamento não conclusivo; CA-05 com comentário de conta não autorizada; CA-07 com falha de limpeza; CA-12 com revisão indisponível e validação não executada.
- CA-06 nos cortes exatos depois de push, criação de PR e publicação de Pergunta.
- Push lento; hook com remoto indisponível; conexão além de 38 minutos com medição; oito horas e carga sustentada; sessões longas e compactação.
- x86_64, outras regiões e tamanhos, VPC; cache entre boots e limite de pulls do Docker Hub.
- Log do lado do provedor do modelo; variância do modelo além de uma execução; efeitos em serviços reais.
- Cobrança acima do baseline e custo por tag na fatura da AWS.

Dentro da rubrica e não observado nesta campanha:

- G30b: espera automática por falta de capacidade (não tentado).
- C05: outro Trabalho iniciado durante a espera de uma Pergunta.
- C07: branch preservada na origem depois de um cancelamento.
- C10: rótulo retirado de um Ticket ainda na fila.
- G11(a): commit de terceiro incorporado mantendo a mesma sessão.
- G20: canal bloqueado além do limite depois da correção A11.
- G30: os dois checks do Lambda que saem `unverified` por desenho.
- G32: órfã conhecida só por tag; declaração de evidência do guest perdida.
- X0: versões e caminhos de `aws-cli`, `ssh` e `websocat`.
- A9 parte B na conta real; a nova tentativa depois de build falho com a correção A18.
- X2: os quatro itens de limpeza pendentes do Operador.

## 5. Custos

| Item | Valor final | Teto | Situação |
| --- | --- | --- | --- |
| MicroVM-horas | 8,34 h (51 MicroVMs, 30 030 s, todas `TERMINATED`) | 40 h | dentro do teto |
| MicroVMs simultâneas | pico de 2 | 2 | dentro do teto |
| Builds de imagem registrados | 3 (2 criados, 1 falho de propósito) | 30 | dentro do teto |
| Tokens | 32 995 685 (21,20 M de entrada, 0,15 M de saída, 11,64 M de leitura de cache) | 150 M (parada em 120 M) | dentro do teto |
| Atividades medidas | 109 (101 medidas, 8 indisponíveis) | — | total `partial` |
| Estimativa em dólares | US$ 2,31 pelo catálogo do SDK (tokens) | US$ 30 (parada em US$ 22) | ver nota |

Notas. A estimativa de US$ 2,31 é a do catálogo do SDK para os tokens registrados: é uma estimativa, não uma fatura.
A cobrança da AWS não foi lida (a role de operação não tem acesso e a fatura está fora da rubrica). Como ordem de
grandeza, pela base usada no plano (menos de US$ 0,47 por MicroVM-hora), 8,34 MicroVM-horas ficam abaixo de US$ 4;
esse número é uma conta, não uma medição. Oito atividades não têm tokens medidos, então o total de tokens é um piso.
Leituras: uso da instalação às 14:21 UTC de 2026-11-22 (`final-works/usage-all.json`); listagem de MicroVMs em
`probes/x1-microvms-final.jsonl`; estado final em `final-works/status.json` (23 Trabalhos: 13 entregues, 9 cancelados,
1 fechado sem merge, 0 abertos; controller parado e nenhuma MicroVM viva às 14:2x UTC).

## 6. Limpeza

Estado de cada item conforme o registro corrido (seção "Fechamento") e os arquivos de limpeza. "Feito e verificado" quer
dizer conferido por leitura depois do passo. Critério X2: `inconclusive` (parcial), pelos itens pendentes do Operador e
porque a limpeza do produto não removeu tudo sozinha (A18 e A19).

Antes de remover:

- [x] Controller parado e nenhuma MicroVM fora de `TERMINATED` — **feito e verificado** (51 MicroVMs, todas `TERMINATED`; `probes/x1-microvms-final.jsonl`).
- [x] Cópia sanitizada da evidência — **feito e verificado** para este conjunto publicado (varredura sem ocorrência de identificador de conta, ARN, token ou e-mail).
- [x] Avaliação por critério gravada — **feito** (`lambda-acceptance-assessment.json`).

Remoções na AWS:

- [x] MicroVMs: nenhuma viva — **feito e verificado**.
- [x] Imagens de MicroVM da instalação `sfv2acc` — **feito e verificado**: 3 imagens → 0. Uma saiu pela Factory (`cleanup-images` com a release local v2-acc-8); duas pela CLI da AWS (a de build falho, ao conferir o fato de serviço da A18, e a última, presa pela A19).
- [x] Ambientes dos Trabalhos pela Factory — **feito**: `factory cleanup --select environment` nos 9 Trabalhos que seguravam a imagem, 7 confirmados; os 2 restantes são os da A19 (`cleanup-environments.jsonl`).
- [x] Objetos do bucket de build — **feito e verificado** (2 artefatos apagados, 0 objetos).
- [x] Log groups de build — **feito e verificado** (3 ausentes: 2 apagados, 1 já ausente).
- [ ] Stack CloudFormation `factory-sfv2acc` (roles de operação e de build, e o bucket já vazio) — **pendente do Operador**.
- [ ] Usuário IAM `factory-sfv2acc-operator` e sua chave de acesso — **pendente do Operador**.
- [ ] Perfis AWS locais `factory-sfv2acc` e `factory-sfv2acc-source` — **pendente do Operador**.

Remoções no GitHub:

- [x] Repositório de apoio `Sanmoo/sfv2acc-fixture` apagado — **feito**; com ele saíram as refs de marcador, branches, PRs e Tickets de teste (listas salvas antes em `fixture-refs-before-delete.txt`, `fixture-issues-before-delete.json`, `fixture-prs-before-delete.json`).
- [x] Repositório real: nenhuma ref da Factory — **feito e verificado**. A branch `chore/factory-environment` é anterior à campanha e foi deixada.
- [x] Repositório real: nenhum PR da campanha aberto — **feito e verificado** (PRs #134, #136, #137 e #138 mesclados). A remoção do rótulo `factory-acc` não consta do registro.
- [x] Ruleset do repositório real igual ao anterior — **feito e verificado**.
- [ ] Instalação do GitHub App sem o repositório de apoio — não consta do registro como passo próprio; o repositório foi apagado.

Local:

- [x] Worktrees e branches já integrados removidos — **feito**. Fica o worktree `lambda-concurrent-wip-push` (correção A18, pendente de integração).
- [ ] `lb1/credentials` — **pendente do Operador**. A remoção do restante da raiz `lb1` não consta do registro.
- [ ] Branch local `prototype/v2-lambda-acceptance` — não consta do registro.
- [ ] Evidência bruta — conservada no diretório local da campanha; não foi apagada.

## 7. Resposta do ticket 16

O texto da seção `## Answer` está em `ticket-16-answer.md`.
