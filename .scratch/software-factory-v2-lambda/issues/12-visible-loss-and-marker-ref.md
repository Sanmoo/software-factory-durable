# 12: Perda visível e ref de marcador

**What to build:** Se o ambiente morre antes da publicação, perde-se o trabalho local desde o último push, e isso fica visível: ocorrência e consumo
registrados, sessão antiga conservada como evidência. Como melhor esforço, o hook de término empurra o `HEAD` commitado para
`refs/factory/lost/<trabalho>/<boot>`. Essa ref nunca conta como preservação nem satisfaz o gate.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-16, V2-17, V2-02 (Remover).

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 07, 10

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Morte do ambiente com trabalho não publicado é registrada como perda no Trabalho, com o último commit confirmado, o boot e o consumo.
- [ ] A sessão antiga é conservada como evidência e não é continuada.
- [ ] O hook de término empurra o `HEAD` commitado para `refs/factory/lost/<trabalho>/<boot>`; não aceita parâmetros do chamador.
- [ ] A ref de marcador nunca satisfaz o gate nem é tratada como preservação concluída (teste negativo).
- [ ] Limites documentados e não tratados como erro: arquivos sem commit, push lento, remoto indisponível, falha do próprio serviço.
- [ ] A existência (ou ausência) da ref de marcador é registrada no Trabalho para a substituta.
- [ ] Remover apaga a ref de marcador do Trabalho e registra; continua sem tocar branch nem PR.
