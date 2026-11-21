# 01: Capacidades declaradas e sandbox por instalação (prefactor)

**What to build:** Hoje a configuração só aceita o perfil Gondolin e o Controle não lê capacidade nenhuma do Sandbox. Este ticket prepara o terreno sem
mudar o comportamento do Gondolin: a configuração da instalação escolhe estaticamente um adapter para todos os repositórios; cada adapter
declara suas capacidades (Docker; disco que sobrevive ao boot; duração máxima do boot e margem de rotação; propriedades de saída de rede);
o Controle passa a ler capacidades, nunca detalhes do serviço. "Parar preserva disco/workspace" deixa de ser contrato universal e vira
consequência da capacidade de disco persistente, que o Gondolin declara.

O adapter Lambda ainda não existe aqui: selecioná-lo é recusado com diagnóstico até os tickets seguintes.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-01, V2-03, V2-04.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** None (can start immediately)

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] A configuração da instalação escolhe um único adapter para todos os repositórios; não há escolha por repositório ou por Trabalho, seleção automática, Slots por adapter nem política híbrida.
- [x] O adapter Gondolin declara Docker e disco persistente; duração máxima do boot ausente (sem rotação); saída de rede mediada como no MVP.
- [x] O Controle decide por capacidade lida do adapter, sem conhecer o nome do adapter nem detalhe do serviço (regra coberta pelo gate de arquitetura).
- [x] Repositório que exige capacidade não declarada pelo adapter não inicia: impedimento visível com diagnóstico que nomeia a capacidade; nunca há fallback para outro sandbox. Teste com um adapter de teste sem Docker e uma declaração de ambiente com imagens.
- [x] Instalações existentes (configuração com o perfil Gondolin atual) continuam válidas sem edição; a identidade de ambientes já preparados não muda.
- [ ] A suíte do MVP passa sem alteração de comportamento no Gondolin. (Não marcado: `npm run test:ci` termina FAIL nesta máquina por 5 testes de 2 arquivos que já falham na base sem alterações; ver Answer. Os outros 1851 passam.)

## Answer

Prefactor entregue sem mudar o Gondolin.

- **Seleção por instalação (V2-01):** `sandbox.adapter` em `config.yaml` (`gondolin`, default quando ausente; `lambda` recusado com
  `SANDBOX_ADAPTER_UNAVAILABLE` e check `sandbox-adapter` no `doctor`; qualquer outro valor ou lista é inválido). A chave nunca entra no
  perfil do adapter: a configuração efetiva do Gondolin e a identidade dos ambientes preparados ficam idênticas. Seleção pura em
  `selectSandboxAdapter` (`src/sandbox/configuration.ts`, exportada por `src/sandbox/index.ts`); `validate`/`prepare`/`start` passam por ela.
- **Capacidades declaradas (V2-03):** tipo `SandboxCapabilities` em `src/contracts/sandbox-capabilities.ts` (`docker`, `persistentDisk`,
  `bootDuration: { maxSeconds, rotationMarginSeconds } | null`, `egress: { mediation, publicTcp }`). O Gondolin declara
  `gondolinCapabilities` (Docker, disco persistente, `bootDuration: null`, saída mediada HTTP). A composição
  (`composeProductionExecution`) entrega só as capacidades ao Controle em `ExecutionPorts.sandbox.capabilities`. "Parar preserva
  disco/workspace" está documentado como consequência de `persistentDisk`; o primeiro consumidor dessa capacidade é o ticket 07.
- **Capacidade ausente (V2-04):** regras puras em `src/control/rules/capabilities.ts` (`requiredCapabilities`, `missingCapabilities`,
  `capabilityImpediment`). Declaração com `images` exige `docker`. O Controle deriva o impedimento `SANDBOX_CAPABILITY_MISSING` do pin do
  Trabalho e das capacidades a cada leitura (`capabilityGate` em `src/control/durable/control.ts`): aparece em `list`/`show`, bloqueia a
  seleção do despacho e nada é preparado. Não é gravado no estado durável (sem mudança de formato).
- **Gate de arquitetura:** regra ESLint em `src/control/**` proíbe identificadores e literais com nome de adapter ou serviço
  (`gondolin`, `lambda`, `microvm`, `qemu`); coberta em `test/architecture/architecture-gate.test.ts`.

Testes: `test/sandbox/adapter-selection.test.ts`, `test/control/capability-rules.test.ts`, `test/control/capability-flow.test.ts` (adapter
de teste sem Docker e declaração com imagens), mais casos em `configuration.test.ts`, `release-composition.test.ts` e no gate de arquitetura.

Limites e pendências:

- `ExecutionPorts.sandbox.capabilities` é opcional: ausente significa composição anterior à v2, sem gate de capacidade. A composição de
  produção sempre declara. Os dublês existentes do MVP não foram editados; ticket que decidir por `persistentDisk` ou `bootDuration`
  precisa definir o que a ausência significa ou tornar o campo obrigatório.
- `createSandbox` continua sendo a implementação Gondolin; o despacho para um segundo adapter entra com o adapter Lambda (ticket 02 em diante).
- O `since` do impedimento é o instante do pin; o Trabalho bloqueado não é reavaliado contra uma declaração nova (o pin é lido uma vez,
  regra do MVP): corrigir a declaração vale para Trabalhos admitidos depois.
- `npm run test:ci` (2026-11-21): 1873 testes, 1851 passam, 17 pulados, 5 falham, resultado FAIL. As 5 falhas são de
  `test/sandbox/audited-vfs-guard.test.ts` (4) e `test/sandbox/sandbox-adapter-diagnostics.test.ts` (1) e ocorrem igualmente na base
  sem alterações: `test/sandbox/fixtures/audited-vfs-manifest.ts` fixa `.worktrees/software-factory-mvp-05/node_modules/...`, worktree
  que não existe nesta máquina. Não foi corrigido aqui (fora do escopo).
