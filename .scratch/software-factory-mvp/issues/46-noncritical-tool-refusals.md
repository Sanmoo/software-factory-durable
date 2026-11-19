# 46: Recusas sem efeito e timeouts com cessação confirmada não encerram a Execução do Builder

**What to build:** no piloto (ticket 35, 2026-11-18/19) quatro Execuções reais de Builder em `Sanmoo/java-springboot-event-sourcing`
terminaram `WORKER_INTERRUPTED` e consumiram recoveries (#125 chegou a 3 de 3, #126 a 2 de 3) sem nenhuma falha do modelo, da rede ou do
controlador. Diagnóstico (sessões e evidências em `pl1/`):

- **edit de arquivo acima de 8 KiB** (Executions `71ffe5cd`, `5ad14a97`): a captura da fonte do edit é recusada pelo owner com
  `EDIT_SOURCE_NOT_LOSSLESS` quando o arquivo passa de `editSourceMaxBytes` = 8192 (`src/sandbox/read-tools.ts:292`). O worker trata qualquer
  falha da captura como crítica (`src/workers/edit.ts:107`: `check(); critical()`), `critical()` aborta a sessão
  (`src/workers/worker-session.ts:131-133`) e a Execução acaba `WORKER_INTERRUPTED`. A captura é uma leitura: recusá-la não tem efeito no guest.
  Arquivos Java de domínio e de teste passam de 8 KiB com facilidade (`CreditAccountTest.java` > 11 KiB).
- **timeout de bash** (Execution `27a60d10`): `./gradlew test` com `timeout: 120` escolhido pelo modelo; o owner revoga a invocação
  (`src/sandbox/bash-tools.ts:122-125`, `BASH_TIMEOUT_EFFECTS_UNKNOWN`) e `src/workers/bash.ts:102` chama `critical()`. A mensagem
  "Command timed out after … (effects unknown)" (`bash.ts:158`) é inalcançável: o sinal já foi abortado e o modelo vê "Command aborted".

Princípio: só é crítico o que deixa efeito desconhecido. Uma recusa antes de qualquer efeito, ou um timeout cuja cessação o Host confirma,
é erro comum da ferramenta: o modelo recebe o motivo e escolhe outro caminho; a invocação continua.

**Blocked by:** —

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] `edit`: recusa da captura por tamanho/conteúdo não textual (`EDIT_SOURCE_NOT_LOSSLESS`) e demais recusas comprovadamente anteriores a
  qualquer escrita retornam erro de ferramenta com motivo acionável (ex.: "file exceeds N bytes; use write or bash"), sem `critical()` e sem
  abortar a sessão. Falhas com efeito possível (aplicação/escrita/release) continuam críticas.
- [x] Limites de `edit`/`write` revistos: se o canal suportar, `editSourceMaxBytes`/`writeMaxBytes` sobem para um valor que cubra arquivos de
  código comuns (alvo ≥ 64 KiB), com o limite registrado na release; se não suportar, a recusa clara acima basta e o motivo fica documentado.
- [ ] `bash` com timeout: o owner encerra o processo e só se a cessação for confirmada (processo/grupo terminado) devolve um erro de
  ferramenta não crítico "timed out after N s; process terminated" (com a saída capturada até ali, se houver). Sem confirmação de cessação,
  o comportamento atual (crítico, efeitos desconhecidos) permanece. A mensagem alcançável corresponde ao que aconteceu.
- [x] Skills (nova versão do pacote): `implement` e `alpine-diagnostics` orientam timeouts generosos para build/teste (ex.: 1800 s, sobretudo
  na primeira execução que baixa dependências) e o uso de `write`/`bash` para arquivos grandes; o manifesto da release aponta o pacote novo.
- [ ] Testes: regra pura/unidade para cada caminho (recusa sem efeito → não crítico; efeito possível → crítico; timeout com/sem cessação),
  e regressão de que a sessão não é abortada nos casos não críticos. `npm run test:ci` verde.
- [ ] Nova release (`mvp-34.6`) construída da ponta limpa, instalada por `upgrade check/apply` na raiz do piloto com os Trabalhos abertos
  preservados; a retomada do piloto prova um edit > 8 KiB e um timeout de build sem `WORKER_INTERRUPTED`.

## Comments

- Origem: piloto 35; diagnóstico forense em 2026-11-19 (sessões `pl1/r/*/profile/sessions/2026-11-19T01-13-21-269Z_…`, `…01-42-05-338Z_…`,
  `…01-13-18-033Z_…`). Relacionados: [45](45-recovery-cause-and-build-timeouts.md) (causa na recovery), [44](44-per-project-guest-environment.md).
- Implementação (branch `fix/46-noncritical-tool-failures`, 2026-11-19):
  - `edit` (`src/workers/edit.ts`, regra pura `captureRefusal`): recusas da captura decididas pelo owner na leitura somente-leitura do
    guest, antes de existir versão da fonte — `EDIT_SOURCE_NOT_LOSSLESS` (tamanho, bytes de controle, conteúdo protegido),
    `READ_BINARY_UNSUPPORTED`, `READ_PATH_DENIED`, `GUEST_READ_FAILED` (ausente/diretório/symlink) — viram erro comum com motivo
    acionável que nomeia o limite do Host ("exceeds the edit source limit of 8192 bytes … Change it with bash"); sem `critical()`, a
    invocação e a sessão seguem. Continuam críticas: `PROTECTED_READ_UNAVAILABLE` (inclui UTF-8 malformado), `STALE_TOOL_CONTEXT`,
    `TOOL_CHANNEL_CLOSED`, `EDIT_SOURCE_LIMIT`/`DENIED`, `INVALID_TOOL_CALL`, metadados inválidos e toda falha de página, commit
    (exceto o já existente `EDIT_SOURCE_CHANGED`) e release. Prova pública: `normal-edit` modos `budget` e `secret` agora completam
    (a escrita seguinte e o turno seguinte rodam) em vez de `WORKER_INTERRUPTED`.
  - Limites mantidos em 8192 (comentário em `src/entrypoints/release.ts`): cada RPC do owner (conteúdo do write, substituição do commit,
    página da fonte) é UM frame do protocolo de no máximo 64 KiB (`maxFrameBytes`; chamadas limitadas a 49152 bytes codificados) e não há
    protocolo de write/commit/página em partes; 64 KiB em base64/JSON não cabe num frame. Subir exige protocolo em partes (ticket próprio).
  - `bash` com timeout: **não feito, continua crítico.** O exec do Gondolin 0.14.0 não tem pedido de término: o abort só rejeita a sessão
    no host (`rejectExecSession`, sem mensagem ao guest; o protocolo de controle não tem kill/cancel) e o `sandboxd` não cria grupo de
    processo por exec, então o owner não consegue encerrar o comando nem confirmar a cessação. Mesmo com `setsid` + varredura, o daemon
    do Gradle se desanexa (setsid) e é ele quem roda os testes. Corrigido apenas a mensagem alcançável: agora é "Command timed out after
    N seconds (effects unknown)" mesmo depois do abort da sessão que o próprio `critical()` provoca. A mitigação real é o pacote v8.
  - `factory-skills-v8` (8.0.0): `implement` §2 e `alpine-diagnostics` pedem timeout generoso (ex.: `timeout: 1800`, sobretudo na primeira
    execução que baixa dependências; nunca 120 s) e `bash` para arquivos acima de 8192 bytes; a release compõe o último pacote com
    continuação (v8, `release-composition.test.ts`). v7 intacto.
