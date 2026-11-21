# 12: Perda visível e ref de marcador

**What to build:** Se o ambiente morre antes da publicação, perde-se o trabalho local desde o último push, e isso fica visível: ocorrência e consumo
registrados, sessão antiga conservada como evidência. Como melhor esforço, o hook de término empurra o `HEAD` commitado para
`refs/factory/lost/<trabalho>/<boot>`. Essa ref nunca conta como preservação nem satisfaz o gate.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-16, V2-17, V2-02 (Remover).

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 07, 10

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Morte do ambiente com trabalho não publicado é registrada como perda no Trabalho, com o último commit confirmado, o boot e o consumo.
- [x] A sessão antiga é conservada como evidência e não é continuada.
- [x] O hook de término empurra o `HEAD` commitado para `refs/factory/lost/<trabalho>/<boot>`; não aceita parâmetros do chamador.
- [x] A ref de marcador nunca satisfaz o gate nem é tratada como preservação concluída (teste negativo).
- [x] Limites documentados e não tratados como erro: arquivos sem commit, push lento, remoto indisponível, falha do próprio serviço.
- [x] A existência (ou ausência) da ref de marcador é registrada no Trabalho para a substituta.
- [x] Remover apaga a ref de marcador do Trabalho e registra; continua sem tocar branch nem PR.

## Answer

### Decisão de credencial tomada pelo implementador (pede confirmação do Operador)

O hook de término não tem como autenticar um push sem algum segredo residente no guest. A opção escolhida é a única que achei compatível
com a letra da V2-24; as outras foram descartadas:

- **Escolhida:** um processo "holder" que o HOST arma no guest pelo canal, como `builder`, com o token reduzido do Builder (o mesmo grant
  da Execução) só em ambiente de processo (`FACTORY_GIT_TOKEN`, credential helper em memória na linha do único `git push`). Nada em arquivo,
  script, URL ou payload; sem deploy key. O holder segue a vida do grant: armado a cada entrega e a cada renovação, encerrado na retirada e
  antes de todo Parar. O hook só puxa um gatilho (FIFO que só root escreve) e não lê nada de quem o chama.
- **Descartadas:** deploy key no guest (V2-24 proíbe); token no payload do hook de início (não é "comando em ambiente explícito pelo canal",
  o payload pode ser registrado pelo serviço, e o token vence em 1 h, menos que um boot); token próprio de marcador com vida de boot (sobreviveria
  à retirada de credenciais do MVP §8).
- **Resíduo a decidir:** o token passa a morar no ambiente de um processo residente do guest enquanto o grant vale (o Builder, mesmo usuário
  Unix, já recebe esse token nos próprios comandos; ele pode matar ou trocar o holder). O push do holder não passa pela política de push
  do Host do Builder: é um programa fixo do host, com ref validada pelo padrão do marcador. Se o Operador não aceitar esse resíduo, o
  ponto único a desligar é `credential` em `serveLambdaOwner` (sem holder não há marcador; o resto do ticket não depende dele).

### O que foi construído

- **Ref de marcador** (`src/contracts/loss-marker.ts`): `lostMarkerRef(workId, boot)` = `refs/factory/lost/<trabalho>/<boot>`, `lostMarkerPrefix`,
  `lostMarkerPattern`.
- **Guest** (`src/sandbox/lambda/guest-files.ts`, muda o pin da imagem): o script de início cria `/run/factory/terminate` (FIFO 0644 de root) e
  `/run/factory/marker` (do `builder`); o agente dos hooks ganhou `on_terminate`: escreve uma linha fixa no FIFO e espera até 45 s pelo
  arquivo `done`. Sem leitor no FIFO não há holder: retorna na hora (um Parar pedido não espera nada).
- **Holder** (`src/sandbox/lambda/loss-marker.ts`): `armLossMarker` / `disarmLossMarker`, programas fixos `loss-marker-arm` / `loss-marker-disarm`.
  No gatilho: `git push --force <remoto> HEAD:<ref>` com teto de 40 s, uma vez. `serveBootOwner` ganhou a parte opcional `credential(token | undefined)`
  (o Gondolin não a passa: nada muda lá); `serveLambdaOwner` arma e desarma em ordem e desarma no `close`.
- **GitHub** (`src/code-repository/loss-markers.ts`): `readLostMarkers` (listagem completa, grant de leitura) e `cleanupLostMarkers` (uma exclusão
  condicional atômica por ref, cada uma com seu grant de cleanup de uso único, releitura no fim; nunca DELETE simples). `deleteRefIfAt` da sessão
  de cleanup aceita `{ lostMarker }` além de `{ branch }`, validado pelo padrão.
- **Controle:** na morte do ambiente, sem disco persistente, `recordLossOf` (`dispatch.ts`) grava `work.losses[]` (`LossRecord`, `types.ts`) ANTES de
  liberar o Slot, com o evento `loss-recorded`: Execução, boot, motivo, `confirmed` (ponta da branch do Trabalho lida pelo Controle naquele
  instante; se a leitura falhar, o último commit do gate), `consumption.executionMs`, `session` (`conserved-as-evidence`) e `marker`
  (`present` com commit | `absent` | `unknown`, da leitura do Controle). Regras puras em `rules/loss.ts`; gravação em `durable/loss.ts`.
  `sessionDecision` ganhou `environmentLost` → `replace` / `ENVIRONMENT_LOST`.
- **Remover:** recurso novo `lost-markers:<trabalho>` em `planCleanup`, para todo Trabalho que rodou sem disco (Execução com `origin`), entregue
  ou cancelado (entra na seleção `environment` do cleanup explícito); `sweepMarkers` em `delivery-desk.ts` grava intenção e resultado no
  ledger de cleanup. Branch e PR não são tocados. O `removeLambdaEnvironment` do adapter não mudou (ele não tem credencial GitHub).
- **Documentação dos limites:** `docs/lambda-installation.md` §10 e o cabeçalho de `loss-marker.ts`.

Testes: `test/sandbox/lambda-loss-marker.test.ts` (holder e `on_terminate` REAIS com bash, git e python3 locais contra um bare: push do HEAD,
arquivo sem commit fora, remoto indisponível sem erro, desarme, rearme), `test/entrypoints/github-loss-markers.test.ts`,
`test/control/loss-rules.test.ts`, `test/control/loss-flow.test.ts` (perda, marcador ausente/desconhecido, teste negativo do gate, cleanup),
caso negativo em `test/sandbox/lambda-preservation.test.ts` (programa real do gate com a ref de marcador no `origin`), e as duas jornadas
compostas (`lambda-environment-death-composed`: holder armado, hook, perda com marcador lido pelo Controle; `lambda-journey-composed`: fim
normal não deixa holder).

### Formas não provadas (nada rodou em guest, conta ou GitHub reais)

- GitHub aceitar push de token de instalação para `refs/factory/lost/...` (a prova G4 usou uma branch e deploy key) e `updateRefs` apagar uma
  ref fora de `refs/heads/`. Se o push for recusado, todo marcador sai `absent`; se a exclusão for recusada, o recurso fica `failed`/`kept`.
- Holder destacado com `setsid sh -c` sobreviver ao fim da conexão SSH no Alpine; `timeout`, `seq`, `mkfifo -m` do BusyBox.
- O serviço esperar a resposta do hook de término antes de matar a MicroVM (observado só com o hook da prova).
- PID do holder reutilizado entre o fim dele e um rearme mataria outro processo do `builder` (mesmo risco do ticket 11).

### Limites e pendências

- Sem marcador, por construção: Execução retida (credenciais retiradas), boot entre ativações sem grant entregue, grant só de leitura
  (`builder-start`, composição sem rodadas de revisão), token vencido entre renovações.
- A perda só é gravada no caminho vivo do despacho. Depois de queda do controlador, a reconciliação encerra o boot mas NÃO grava
  `work.losses` (o recurso `lost-markers` é planejado mesmo assim e apaga um marcador que exista).
- "Não continuada" está provado pela regra (`ENVIRONMENT_LOST`) e pelo caminho existente de interrupção (sessão nova); a Execução seguinte
  neste perfil depende dos tickets 08 e 13, então nenhuma ativação substituta real foi observada.
- `consumption` traz só o tempo da Execução; MicroVM-segundos do boot vêm do ticket 14, pelo `boot` da perda.
- Não foi red-green estrito: programas do guest e operações do GitHub foram escritos antes da primeira execução dos testes. Vermelhos reais:
  ambiente nulo no registro da perda, escape do agente Python e uma corrida entre armar e acionar (o holder agora anuncia `ready`).
- **Mudanças não pedidas:** `test/architecture/publication-boundary.test.ts` foi alterado para admitir o push do holder (só para a ref de
  marcador) e a exclusão atômica de ref de marcador; `lambda-journey-composed` fixa os dois programas novos.

### Para os tickets seguintes

- **13:** ler `work.losses` (último = perda mais recente): `confirmed.commit`, `boot`, `marker` (`present` → `ref` e `commit` para aproveitar),
  `session.invocationId`. Nunca tratar `marker` como preservação. Passar `environmentLost` já é feito em `activationPlan`.
- **16:** a aceitação deve conferir em conta real as formas não provadas acima.

`npm run test:ci` (2026-11-21, depois do merge da ponta de `integration/software-factory-v2-lambda` com os tickets 14 e 15): 2072 testes, 2050
passam, 17 pulados, 5 falham, resultado FAIL. As 5 falhas são as conhecidas da base: `test/sandbox/audited-vfs-guard.test.ts` (4) e
`test/sandbox/sandbox-adapter-diagnostics.test.ts` (1).
