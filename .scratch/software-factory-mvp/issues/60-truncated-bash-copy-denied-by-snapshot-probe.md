# 60: Cópia da saída truncada do bash é negada pela sondagem de conteúdo e aborta o Builder

**What to build:** no piloto 2 (janela 2, #126, 2026-11-20 12:32:34 UTC), um `bash` do Builder gerou 51.810 bytes (acima do limite de
truncamento de 50 KB do Pi). Com rodadas de revisão ativas, `src/workers/bash.ts` roda a sondagem de conteúdo "depois" (`snapshot()`, um
comando bash do próprio Host pelo mesmo canal) ANTES de pedir `copy-output`. O lado do sandbox (`src/sandbox/bash-tools.ts`) limpa `latest`
a cada novo comando, então a cópia volta `BASH_COPY_DENIED`; o `catch` chama `critical()` e a sessão termina com "Command aborted (effects
unknown)" e `WORKER_INTERRUPTED`, gastando uma recuperação. O workspace ficou limpo; nada se perdeu. A sessão ainda mostra
`WORKER_PROVIDER_UNAVAILABLE` porque `safeMessage` (`src/workers/oauth-qualification.ts`) rotula qualquer aborto assim.

**Blocked by:** —

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [x] Um comando com saída truncada, com sondagens de conteúdo ativas, devolve a apresentação normal com o caminho da cópia completa; a
  Execução continua.
- [x] As sondagens e leituras próprias do Host não invalidam a captura do comando do agente (ou a cópia acontece antes delas), sem
  enfraquecer a regra "um comando novo do agente invalida o anterior" nem a proteção contra cópia repetida.
- [x] Uma cópia negada de fato vira um código próprio registrado (não "Command aborted"), e o rótulo da sessão para aborto do Host não diz
  `WORKER_PROVIDER_UNAVAILABLE`.
- [x] Teste: saída truncada + snapshot ativo → cópia publicada e sessão continua (vermelho antes da correção).

## Comments

- Forense: probes `b9a34512` (antes), comando `2619f661` (51.810 bytes), probe `d381a90d` (depois), re-probe `57c6b393` do catch; sessão
  `pl2/r/HtzXPSbHQXWrQNYZO5h76Q/w-sZtCfv`. Origem: db505b2 (cópia de saída truncada) + 90ed69c (sondagens).

## Answer

- **Correção (menor raio):** em `src/workers/bash.ts` a cópia `copy-output` agora roda ANTES da sondagem "depois". A sondagem continua um comando
  bash pelo mesmo canal e continua invalidando `latest` (o lado do sandbox não mudou), mas a cópia já foi consumida. A cópia escreve só um
  `/artifacts/factory-output-<uuid>.txt` novo, fora de `/workspace/checkout`, que é o que a sondagem mede: o digest não muda por ela.
  Invariantes mantidos sem tocar em `src/sandbox/bash-tools.ts`: todo comando novo (do agente ou do Host) invalida a captura anterior; a
  captura é gasta antes do primeiro `await` (cópia no máximo uma vez); sem retry.
- **Cópia negada de fato:** vira código próprio, registrado na observação (`code`) e lançado: `BASH_COPY_DENIED`,
  `BASH_COPY_EFFECTS_OR_CAPTURE_UNKNOWN`, `BASH_COPY_UNAVAILABLE`, `BASH_COPY_METADATA_INVALID` ou `BASH_NATIVE_FOOTER_UNAVAILABLE`. O aborto
  é lido ANTES de `critical()` (que aborta o sinal da sessão), então só um aborto externo vira "Command aborted (effects unknown)". Continua
  crítico (sem retry).
- **Rótulo da sessão:** `safeMessage` (`src/workers/oauth-qualification.ts`) rotula `WORKER_PROVIDER_UNAVAILABLE` só quando a falha é do
  provedor (`providerFailed`); aborto ou fechamento do Host (incluindo o limite de bytes do provedor) vira `WORKER_SESSION_CLOSED_BY_HOST`.
- **Testes:** `test/workers/native-bash-copy.test.ts` (saída truncada + `probeContent` ativo pelo owner real → cópia publicada, caminho na
  apresentação, sessão continua; cópia repetida negada; comando novo invalida a captura anterior; cópia negada → `BASH_COPY_DENIED`
  registrado, não "Command aborted"), `test/workers/session-closure-cause.test.ts` (rótulo do aborto do Host). Vermelho antes, verde depois.
  `test/entrypoints/normal-oauth.fixture.ts` (modo `provider-bytes`) foi ajustado ao novo rótulo; é tier slow, fica para o CI.
