# 07: Gate de preservação e encerramento nas esperas

**What to build:** Quando o adapter não declara disco persistente, toda devolução de controle com espera externa (Pergunta ao humano, espera de CI,
prontidão) é precedida pelo gate de preservação, imposto pelo Controle e não confiado ao prompt. Aceito o gate, a MicroVM é encerrada
(não suspensa) e a cessação confirmada precede a liberação do Slot. O comportamento do Gondolin fica como no MVP.

Este ticket cobre o gate antes das esperas; a troca planejada e a sessão substituta reutilizam o mesmo gate nos tickets 09 e 13.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-05, V2-06, V2-07, V2-08, V2-09.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 06

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] O gate verifica no guest: workspace limpo, incluindo untracked não ignorados; ausência de stash; `HEAD` igual à ponta da branch do Trabalho consultada no `origin` por `ls-remote`, sem confiar na ref de acompanhamento local.
- [ ] Workspace sujo, untracked, stash, commit sem push, remoto indisponível e remoto não confirmado são recusados, cada um com motivo próprio (os seis casos de G1 como testes de regra).
- [ ] A recusa volta ao Builder com o motivo, para correção, na mesma devolução; o Builder pode publicar WIP mesmo antes de existir PR.
- [ ] Três recusas seguidas na mesma devolução geram Bloqueio com o diagnóstico da última.
- [ ] O texto entregue ao Builder diz que o procedimento não autoriza versionar segredos ou dados impróprios: sem publicação segura, ele reporta o impedimento em vez de forçar o commit.
- [ ] Depois do gate aceito em Pergunta, espera de CI e prontidão, a MicroVM é encerrada e a cessação confirmada pelo serviço precede a liberação do Slot.
- [ ] O commit confirmado pelo gate fica registrado no Trabalho para a retomada.
- [ ] Com adapter que declara disco persistente, nenhum gate é exigido e o fluxo do MVP não muda.
