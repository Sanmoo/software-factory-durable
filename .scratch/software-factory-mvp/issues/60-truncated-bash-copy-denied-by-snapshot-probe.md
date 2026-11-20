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

- [ ] Um comando com saída truncada, com sondagens de conteúdo ativas, devolve a apresentação normal com o caminho da cópia completa; a
  Execução continua.
- [ ] As sondagens e leituras próprias do Host não invalidam a captura do comando do agente (ou a cópia acontece antes delas), sem
  enfraquecer a regra "um comando novo do agente invalida o anterior" nem a proteção contra cópia repetida.
- [ ] Uma cópia negada de fato vira um código próprio registrado (não "Command aborted"), e o rótulo da sessão para aborto do Host não diz
  `WORKER_PROVIDER_UNAVAILABLE`.
- [ ] Teste: saída truncada + snapshot ativo → cópia publicada e sessão continua (vermelho antes da correção).

## Comments

- Forense: probes `b9a34512` (antes), comando `2619f661` (51.810 bytes), probe `d381a90d` (depois), re-probe `57c6b393` do catch; sessão
  `pl2/r/HtzXPSbHQXWrQNYZO5h76Q/w-sZtCfv`. Origem: db505b2 (cópia de saída truncada) + 90ed69c (sondagens).
