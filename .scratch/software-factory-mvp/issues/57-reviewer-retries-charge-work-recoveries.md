# 57: Novas tentativas de revisor consomem as recuperações do Trabalho

**What to build:** no #126 do piloto 2, as tentativas do revisor Spec terminaram `cancelled` (stop `aborted`, `WORKER_QUALIFICATION_CLOSED`)
às 04:59:42, 05:02:54 e 05:11:39 UTC. Cada nova tentativa foi cobrada das recuperações operacionais do **Trabalho** (r2a2, r2a3, r3a2 → 3/3).
As rodadas fecharam `incomplete`, e o Standards ficou limpo. Quando o Builder sofreu `WORKER_PROVIDER_UNAVAILABLE` (05:15:10), não havia mais
recuperação: `RECOVERY_LIMIT_REACHED`, sem culpa do Builder. É preciso entender por que o revisor fecha (qualificação encerrada no meio da
rodada? provedor? memória do host com swap pesado) e separar o orçamento de novas tentativas dos revisores do orçamento de recuperação do
Trabalho.

**Blocked by:** —

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Causa de `WORKER_QUALIFICATION_CLOSED` nas sessões do revisor identificada e registrada.
- [ ] Nova tentativa de revisor tem limite próprio por rodada; esgotar esse limite não consome as recuperações do Trabalho.
- [ ] `WORKER_PROVIDER_UNAVAILABLE` transitório tem tratamento explícito (registrado), sem retry implícito sem limite.

## Comments

- Evidência: `/home/sanmoo/software-factory-test/pl2-pilot-evidence/findings.md` item 10; `history-126.json`; sessões
  `pl2/r/LhaThlhFT_GZJ5ap3ww-gQ/w-bt0Txp`, `w-BElqGM`, `w-GXTe42`.
