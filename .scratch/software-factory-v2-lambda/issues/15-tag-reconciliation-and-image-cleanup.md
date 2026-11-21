# 15: Reconciliação por tag e cleanup de imagens

**What to build:** Depois de um crash do controlador, nenhuma MicroVM fica rodando sem dono. A Factory inventaria os recursos pela tag da instalação e
encerra MicroVMs sem proprietário vivo. Imagens de MicroVM ficam enquanto houver Trabalho aberto com a chave e saem só por cleanup
explícito.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-33, V2-34.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 03, 06

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Todo recurso AWS criado pela Factory leva tags de instalação e de Trabalho (verificado para MicroVM, imagem e artefatos de build).
- [ ] Na subida do controlador depois de crash, o inventário por tag encerra MicroVMs sem Execução viva que as possua, com cessação confirmada e registro.
- [ ] MicroVM de outra instalação (outra tag) nunca é tocada.
- [ ] MicroVM com proprietário vivo não é encerrada pela reconciliação.
- [ ] Imagem de MicroVM não é removida enquanto houver Trabalho aberto com a chave; sai só por comando explícito de cleanup, que recusa imagem em uso.
- [ ] Um cenário real de SIGKILL do controlador com boot em curso (fora do tier `fast`), seguido de reconciliação; as variações são testes de regra pura.
- [ ] A evidência de ciclo de vida usada é a de `GetMicrovm`; a documentação registra que Run/Terminate não aparecem no CloudTrail por padrão.
