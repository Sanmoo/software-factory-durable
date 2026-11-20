# 61: Publicação concorrente de outro Trabalho bloqueia como mudança inesperada de ref

**What to build:** no piloto 2 (janela 2, concorrência 2), a publicação do #124 (Work `2dd8c691`) foi bloqueada às 13:24:02 UTC com
`UNEXPECTED_REF_CHANGE:refs/heads/factory/125-f4f421b6` e `GUEST_EFFECT_OUT_OF_SCOPE`. O retrato `refsBefore` foi tirado no pedido (13:12:04),
e a sessão de publicação rodou às 13:22. Entre os dois, o #125 (Work `f4f421b6`) publicou a PRÓPRIA branch no head verificado dele
(`c40fe48`, PR #130). A branch do #124 está no head verificado dele (`b3716af`, PR #131 rascunho). `unexpectedRefChanges`
(`src/control/rules/publication.ts`) só exclui a branch do próprio Trabalho, então qualquer publicação concorrente bloqueia a outra. Não há
comando de operador para reavaliar o bloqueio.

**Blocked by:** —

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Uma ref que é a branch própria de OUTRO Trabalho desta instalação, que apareceu ou mudou para um head que o Control registrou para a
  publicação desse Trabalho (pedido/tentativa), não conta como mudança inesperada. Qualquer outra mudança (outra ref, outro head, branch
  própria de outro Trabalho em head não registrado, remoção) continua bloqueando.
- [ ] O motivo do bloqueio continua explícito e a regra de defesa (Contents W é do repositório todo) não é enfraquecida.
- [ ] Uma publicação já bloqueada SÓ por esse falso positivo pode ser reavaliada por um comando explícito do operador, com motivo, que relê
  o remoto e reaplica a regra corrigida (sem repetir a publicação, sem adotar nada que a regra não aceite).
- [ ] Testes: duas publicações concorrentes → nenhuma bloqueia; branch de outro Trabalho em head não registrado → bloqueia; reavaliação do
  caso do piloto → aceita; reavaliação com outra mudança real → continua bloqueada.

## Comments

- Evidência: `/home/sanmoo/software-factory-test/pl2-pilot-evidence/show-124-w2.json` (`publication.refsBefore`, `reasons`); PRs #130 e #131.

## Answer

- **Regra (pura, `src/control/rules/publication.ts`):** `unexpectedRefChanges(before, now, ownBranch, others)` deixa de contar uma ref SÓ quando ela é
  `refs/heads/<branch própria de outro Trabalho>` e o valor novo (criada ou movida) é um head que o Control registrou para a publicação desse
  Trabalho. Remoção, outro head, outra ref, tag (mesmo com o nome da branch) e o próprio Trabalho continuam contando. `decideDiscovery` recebe
  `others: OtherPublication[]`; `otherPublications(works, self)` extrai do estado do Control, por Trabalho da mesma instalação e do mesmo
  `repositoryId` (exceto o próprio): `publication.branch` e os heads de `attempts[].head` (gravados no commit de ativação, antes de qualquer
  push), `linkedHeads` e `verified.head` quando `state = requested`. Um head verificado nunca pedido nem tentado não conta.
- **Origem dos dados:** `reconcilePublications` (`src/control/durable/dispatch.ts`) lê a lista de Trabalhos ANTES da leitura remota de cada
  Trabalho; como a tentativa do outro Trabalho é gravada antes do push dele, toda publicação concorrente observável já está na lista.
- **Comando:** `factory reevaluate-publication <work> --reason <text> [--request-id <id>]` (mesmo formato de `repair`/`update-scope`).
  Recibos: `accepted` (reavaliação `pending` gravada em `publication.reevaluation`, evento `publication-reevaluation-requested`),
  `already-covered` (já pendente), `not-applied` com `WORK_NOT_FOUND`, `WORK_NOT_CURRENT`, `PUBLICATION_NOT_BLOCKED`,
  `NOT_REEVALUABLE:<motivos>` (bloqueio por algo além de `UNEXPECTED_REF_CHANGE`), `REFS_SNAPSHOT_ABSENT`, `PUBLICATION_NOT_ATTEMPTED`;
  `REQUEST_ID_CONFLICT` para identidade reutilizada. Saída 0 aceito, 2 recusado/inválido, 4 indeterminado. A passagem de descoberta seguinte
  relê o remoto (leitura completa; incompleta mantém o bloqueio e a reavaliação pendente), reaplica `decideDiscovery` com o `refsBefore`
  persistido e o estado atual, e registra `publication-reevaluated` (`<id>:accepted:<outcome>` ou `<id>:still-blocked:<motivos>`). Aceita:
  remove `PUBLICATION_BLOCKED`/`GUEST_EFFECT_OUT_OF_SCOPE` e segue o estado normal (no piloto: `linked` → `published`); nunca repete a
  ativação de publicação nem adota o que a regra não aceita. Continua bloqueada: motivos e impedimentos da nova leitura. O `nextStep` do
  bloqueio nomeia o comando quando os motivos são só `UNEXPECTED_REF_CHANGE`.
- **Testes:** `test/control/publication61-rules.test.ts`, `test/control/publication61-flow.test.ts` (dois Trabalhos publicando na janela um do
  outro: antes da correção ambos bloqueavam com `UNEXPECTED_REF_CHANGE` da branch do outro; agora ambos `published`; reavaliação do registro do
  piloto com uma tag real → continua bloqueada só pela tag; sem a tag → aceita, `published`, sem nova ativação),
  `test/entrypoints/reevaluate-publication-cli.test.ts`.
