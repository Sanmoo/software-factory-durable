# 05: Ferramentas por papel no guest Lambda

**What to build:** As ferramentas dos workers (`read`, `write`, edição e `bash`, com progresso) funcionam sobre um boot Lambda pelo canal SSH, com as
mesmas regras por papel do MVP. Autenticar o túnel não autoriza operações: o papel é vinculado pelo host a cada chamada. Revisores só têm
`read`, sem shell; no guest, o revisor é um usuário Unix somente leitura, sem grupo `docker` e sem forwarding, como segunda camada. O
token reduzido do Builder segue o MVP: em memória, entregue por comando em ambiente explícito pelo canal, nunca gravado no guest.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-02 (Executar ferramenta), V2-20, V2-23, V2-24, V2-26.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 04

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Um worker Builder executa `read`, `write`, edição e `bash` (com progresso e interrupção) num boot Lambda, com os mesmos resultados e códigos de erro do contrato de ferramentas do MVP.
- [ ] O papel de cada chamada é vinculado pelo host; contexto de outra invocação ou de outro boot é recusado como no MVP.
- [ ] Revisor só tem `read`; no guest roda como usuário Unix somente leitura, sem grupo `docker` e sem forwarding. Teste negativo: o usuário do revisor não escreve no workspace nem fala com o Docker.
- [ ] O token do Builder chega por comando em ambiente explícito e não aparece em arquivo, histórico de shell nem variável persistente do guest (verificado por varredura do guest após uso). Sem deploy key; a chave emissora da GitHub App nunca vai ao guest.
- [ ] Nada é colocado no guest que o Builder não possa ver (o Builder com Docker lê qualquer arquivo do guest).
- [ ] O guest de produção não tem porta de diagnóstico. O risco residual (usuário do revisor alcança portas locais por loopback, sem ferramenta que abra conexões) fica documentado.
