# 11: Canal caído com ambiente vivo

**What to build:** Queda do canal sozinha não encerra a ativação. O adapter consulta o serviço; com o ambiente ativo, reconecta, encerra o grupo de
processos da chamada órfã e devolve à sessão o resultado "indeterminado", nunca "não executada". Não há reanexação à saída do processo
órfão.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-21, V2-22.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 05

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Canal caído com ambiente ativo: o adapter reconecta com as mesmas credenciais de transporte do boot e a host key fixada.
- [ ] O grupo de processos da chamada que estava em curso é encerrado depois da reconexão (a prova mostrou que canal fechado não encerra o processo).
- [ ] A chamada interrompida volta à sessão como "indeterminado", com texto que deixa claro que o efeito pode ter ocorrido; nunca como "não executada".
- [ ] Não há reanexação à saída do processo órfão.
- [ ] Canal caído com ambiente encerrado segue o caminho do ticket 10, não o de reconexão.
- [ ] Efeitos de resultado indeterminado ficam registrados pelo Controle, para o pacote da substituta (ticket 13).
- [ ] Reconexão que falha repetidamente com ambiente ativo tem limite e vira impedimento visível, sem laço.
