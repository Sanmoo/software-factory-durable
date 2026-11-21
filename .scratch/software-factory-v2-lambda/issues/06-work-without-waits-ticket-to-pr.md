# 06: Trabalho sem esperas, do Ticket ao PR, no Lambda

**What to build:** Primeira jornada integrada: com o adapter Lambda selecionado, um Trabalho que não precisa de espera externa vai do Ticket ao PR.
Builder, revisões internas, tratamento de achados e push acontecem no mesmo boot, sem checkpoint entre Builder e revisores; ao fim, Parar
e Remover.

**Decisão a tomar neste ticket.** Hoje o Controle confirma a identidade da proposta entregue, a impressão do checkout e a fonte
preservada por leituras confinadas do workspace no host. No Lambda o workspace só existe no guest, e a spec diz que nada lido do guest
decide autorização (V2-26). A spec da v2 não diz o que substitui essas leituras. Antes de implementar, propor a substituição (por
exemplo: o que pode ser ancorado no `origin`, o que vira observação não autoritativa pelo canal, o que deixa de existir quando o adapter
não declara disco persistente) e registrar a decisão do Operador no `## Answer`. Se a decisão alterar contrato da spec, parar e pedir a
decisão em vez de assumir.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-02 (Remover parcial), V2-05 (mesmo boot), V2-08, V2-26; MVP §5.6, §7.3.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 01, 05

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] A decisão sobre as leituras de host do workspace está registrada, com aprovação do Operador, antes do código que depende dela.
- [ ] Com o adapter Lambda, um Trabalho sem espera externa percorre Builder, revisões de padrões e de spec no mesmo boot, tratamento de achados, publicação do PR e fim, pela composição de produção sobre o fake do serviço.
- [ ] Não há workspace no host nem cache bare montado: o clone é feito no guest a partir do `origin`.
- [ ] Ao fim, Parar confirma cessação antes de liberar o Slot; Remover encerra o que restar e registra, sem tocar branch nem PR.
- [ ] Nenhum mecanismo de checkpoint além do Git remoto: sem S3, git bundle ou cópia do workspace no host.
- [ ] O mesmo cenário continua passando com o adapter Gondolin, sem mudança de comportamento.
- [ ] Jornada em conta AWS real com um repositório real, no perfil de aceite (`us-east-1`, ARM64), com evidência registrada no `## Answer`. Exige autorização específica do Operador antes de rodar (conta, permissões, teto de consumo, prazo e cleanup), conforme `docs/agents/experiment-proofs.md`. Sem autorização, o critério fica desmarcado e declarado; nunca é dado por feito pelo fake.
