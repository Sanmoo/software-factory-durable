# 05: Ferramentas por papel no guest Lambda

**What to build:** As ferramentas dos workers (`read`, `write`, edição e `bash`, com progresso) funcionam sobre um boot Lambda pelo canal SSH, com as
mesmas regras por papel do MVP. Autenticar o túnel não autoriza operações: o papel é vinculado pelo host a cada chamada. Revisores só têm
`read`, sem shell; no guest, o revisor é um usuário Unix somente leitura, sem grupo `docker` e sem forwarding, como segunda camada. O
token reduzido do Builder segue o MVP: em memória, entregue por comando em ambiente explícito pelo canal, nunca gravado no guest.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-02 (Executar ferramenta), V2-20, V2-23, V2-24, V2-26.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 04

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Um worker Builder executa `read`, `write`, edição e `bash` (com progresso e interrupção) num boot Lambda, com os mesmos resultados e códigos de erro do contrato de ferramentas do MVP.
- [x] O papel de cada chamada é vinculado pelo host; contexto de outra invocação ou de outro boot é recusado como no MVP.
- [x] Revisor só tem `read`; no guest roda como usuário Unix somente leitura, sem grupo `docker` e sem forwarding. Teste negativo: o usuário do revisor não escreve no workspace nem fala com o Docker.
- [x] O token do Builder chega por comando em ambiente explícito e não aparece em arquivo, histórico de shell nem variável persistente do guest (verificado por varredura do guest após uso). Sem deploy key; a chave emissora da GitHub App nunca vai ao guest.
- [x] Nada é colocado no guest que o Builder não possa ver (o Builder com Docker lê qualquer arquivo do guest).
- [x] O guest de produção não tem porta de diagnóstico. O risco residual (usuário do revisor alcança portas locais por loopback, sem ferramenta que abra conexões) fica documentado.

## Answer

As ferramentas por papel do MVP rodam sobre um boot Lambda, pelo canal do ticket 04, sobre o fake da conta e um guest em processo. Nenhuma
chamada AWS, nenhum `ssh`/`websocat` e nenhuma MicroVM. Feito em red-green para leitura do revisor, escrita/edição e Bash; os testes de
token, interrupção, vínculo de papel, segunda camada e perda nasceram verdes (o código já existia pelos cortes anteriores) e tiveram a
sensibilidade conferida por nove mutações, todas detectadas.

- **Sem bifurcar o contrato.** O dono de ferramentas (`serveReadTools`), os programas do guest e os códigos de erro são os do MVP. O canal
  do boot entra onde entra a VM do Gondolin: `lambdaGuestOwner(channel)` em `src/sandbox/lambda/tools.ts` implementa o `GuestOwner`
  (um programa por conexão; vetor de argumentos entre aspas simples; `env` vira ambiente explícito do processo; stdout em fluxo).
- **Costura para o host:** `sandbox.serveTools({ environment, boot })` (`serveLambdaTools`) abre, a partir do registro do boot, um canal
  por usuário do guest e devolve `tools.bind(binding)` / `tools.close()`. `bind` recebe o mesmo `ReadBinding` do MVP (`endpoint`,
  `context`, `signal`, `records`, `credential`, `copyOutput`, `selectedOutputCopies`, `skillPackFiles`, limites) e serve o endpoint que o
  worker já usa (`connectReadTools`, ou `createSandbox({ toolEndpoint }).executeTool`). Recusa `STALE_TOOL_CONTEXT` para contexto de outro
  Trabalho, ambiente ou boot e para invocação já vinculada neste boot; boot parado dá `unavailable` (`BOOT_NOT_ACTIVE`).
- **Papel vinculado pelo host, duas camadas (V2-23).** O papel do contexto vinculado decide as ferramentas (revisor: só `read`;
  `BASH_ROLE_DENIED`, `WRITE_ROLE_DENIED`, `EDIT_SOURCE_DENIED` sem nada rodar no guest) e o usuário Unix (`guestUserOfRole`: `builder`
  ou `reviewer`). A imagem cria `reviewer` sem grupo e sem posse de nada; o `sshd_config` o admite com `DisableForwarding yes` e
  `PermitTTY no`; o agente do hook autoriza a mesma chave de sessão para os dois usuários (a chave autentica o host, não o papel).
  `/artifacts` passa a existir na imagem, do `builder`. O pin da imagem mudou (esperado).
- **Token do Builder (V2-24).** Convenção `guestConventions: 'ssh-channel'` no vínculo: o Bash usa `channelPrelude`
  (`src/sandbox/bash-tools.ts`), que recebe o token como ambiente do processo (`GH_TOKEN`, pelo `environment` do canal), nunca em
  argumento, stdin ou arquivo; limpa o ambiente herdado, exporta identidade de commit e `PATH` fixos, junta stderr ao stdout no guest e
  configura um credential helper em memória. Renovação e retirada seguem o MVP (valor lido a cada comando novo). Revisor não recebe
  credencial. Nenhuma deploy key; nada da GitHub App além desse token passa pelo canal.
- **Arquivos legíveis pelo revisor.** Com usuários distintos, o que as ferramentas do Builder criam precisa ser legível pelo `reviewer`:
  na mesma convenção, os programas de escrita criam com `0o644`/`0o755` em vez de `0o600`/`0o700` (`write-tools.ts`). Gondolin inalterado.
- **Qualificação do perfil:** `profileOrigin` aceita também `factory-lambda-ssh-channel-v1` (`tool-binding.ts`), o que libera no Lambda a
  cópia de saída do Builder e o Read do Builder, como no perfil Gondolin qualificado.
- **Mudança não pedida, necessária ao contrato:** o clone do ticket 04 passou de `/workspace/repo` para `/workspace/checkout`
  (`guestRepositoryDirectory`), o caminho que ferramentas e prompts dos workers usam (MVP §7.3).
- **Fake do guest** (`test/sandbox/lambda-guest-fake.ts`): usuários lidos do `Dockerfile` e do `sshd_config` do artefato da imagem (quem
  loga, quem está no grupo `docker`, quem é dono do workspace); programa `tool` que reconhece os programas fixos (read, write, edit, cópia,
  Bash) e os aplica ao disco falso como o usuário da conexão; comandos de shell por texto (`world.commands`); saída em fluxo; `inside()`
  roda um programa como um processo de um usuário dentro do guest.

Risco residual documentado (V2-23): o usuário `reviewer` alcança as portas locais do guest por loopback (hooks na 9000, `sshd`, o
listener WebSocket na 8022, portas publicadas por contêineres), mas não tem ferramenta que abra conexões: seu único programa é a leitura
fixa. O guest não tem porta de diagnóstico (teste em `lambda-guest-image.test.ts` enumera os listeners). O Builder com Docker lê qualquer
arquivo do guest; nada é colocado lá que ele não possa ver (só a chave pública de sessão, os programas e o token dele mesmo, em memória).

Formas não provadas (nenhuma rodou num guest real), cada uma isolada:

- **Segunda camada no guest real.** O teste negativo roda no guest falso, cujas permissões vêm da definição da imagem. Que o `reviewer`
  real não escreve em `/workspace` nem fala com o Docker, e que o `Match User` do `sshd` vale, só o smoke em conta real mostra.
- **`channelPrelude`** (`bash-tools.ts`): testado com `bash` e `git credential fill` locais, nunca por `sshd`. Supõe `compgen` no bash do
  guest e que nenhuma variável exportada seja somente leitura.
- **`gh` não está no pin do guest.** O helper de credencial é uma função de shell (como no clone), não `gh auth git-credential`; comando
  do Builder que chame `gh` só funciona se o repositório declarar o pacote.
- **`toolScript` / `lambdaGuestOwner`** (`lambda/tools.ts`): `cd <cwd> && exec <argv entre aspas>` como linha de comando remota; o stdin é
  juntado inteiro antes do envio (limite de 64 MiB, sem contrapressão); a saída é enfileirada em memória sem contrapressão; stderr chega
  só no fim (o Bash junta no guest). Programa do guest que saia com 255 é lido pelo transporte como conexão perdida (limite do ticket 04).
- **Modos `0o644`/`0o755`** dos programas de escrita e leitura do `reviewer` por permissão de "outros" (depende do umask do `git clone`).
- **Interrupção.** Abortar ou estourar o timeout fecha a conexão daquela chamada; isso não prova que o processo parou (a prova T4 mostrou
  que não para). Os códigos são os do MVP (`TOOL_CHANNEL_CLOSED`, `BASH_TIMEOUT_EFFECTS_UNKNOWN`, invocação revogada).

O que falta para os tickets seguintes:

- **06:** hospedar `sandbox.serveTools` no processo que lança os workers do boot e chamar `tools.bind` por invocação (com `records`, o
  detentor da credencial do Builder e `copyOutput`), no lugar de `serveOwnerRegistration`/`workerOwnerEndpoint`, que continuam presos ao
  dono de boot Gondolin/systemd; fechar `tools` antes do Parar. O programa de captura do handoff e as observações da decisão 1A/2 rodam
  pelo mesmo canal. O check `sandbox-adapter` do Validar continua bloqueado e `doctor` não confere `ssh`/`websocat`.
- **11:** hoje `lost`, `refused` e `closed` viram "sem status de saída" num só ponto (`settled` em `lambda/tools.ts`) e as ferramentas
  respondem com os códigos de efeito desconhecido do MVP, revogando a invocação (`BASH_EFFECTS_OR_CAPTURE_UNKNOWN`,
  `WRITE_EFFECTS_UNCERTAIN`, `GUEST_READ_FAILED`). Falta: consultar o serviço, reconectar, encerrar o grupo de processos do órfão (o
  `toolScript` ainda não cria nem registra um grupo de processos por chamada) e devolver "indeterminado"; decidir se a invocação segue
  válida depois disso. `refused` (nada rodou) hoje não se distingue de `lost`.

`npm run test:ci` (2026-11-21): 1962 testes, 1940 passam, 17 pulados, 5 falham, resultado FAIL. As 5 falhas são as conhecidas da base:
`test/sandbox/audited-vfs-guard.test.ts` (4) e `test/sandbox/sandbox-adapter-diagnostics.test.ts` (1).

Testes: `test/sandbox/lambda-tools.test.ts` (novo), casos em `lambda-guest-image.test.ts`; exceção em `test/runner/fixed-timers.test.ts`
para o argumento `timeout` da ferramenta Bash sob teste.

