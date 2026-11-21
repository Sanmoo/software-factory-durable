# 02: Instalação Lambda e `validate`

**What to build:** O Operador consegue preparar a própria conta e saber, sem gastar nada, se a instalação está pronta para o perfil Lambda. A release traz
um template que ele aplica para criar a role de operação com política mínima, a role de build e o bucket de artefatos de build; a Factory
nunca cria IAM e usa um perfil AWS nomeado na configuração, sem guardar credenciais. O perfil do adapter (região, arquitetura, tamanho,
duração, margem e intervalo de observação) fica encapsulado no adapter, fora do Controle. `validate` confere identidade, região,
permissões, quota e recursos de instalação sem iniciar MicroVM.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-29, V2-30 (validate), V2-31, V2-02 (Validar).

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 01

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] A configuração aceita o adapter Lambda com perfil próprio; padrões do perfil de aceite: `us-east-1`, ARM64, baseline 1 GB / 0,5 vCPU com pico 4 GB / 2 vCPU, `additionalOsCapabilities: ["ALL"]`, duração 3600 s, margem 600 s.
- [ ] Duração acima de 3600 s é aceita e marcada como não provada no diagnóstico.
- [ ] A release inclui o template da conta (role de operação, role de build, bucket). `CreateMicrovmImage` e `TagResource` ficam em `*`, a segunda condicionada à tag da instalação; o limite está documentado para o Operador.
- [ ] `validate` não inicia MicroVM e diagnostica, cada um com causa própria: perfil AWS ausente ou sem identidade, região errada, permissão faltante (nomeando a ação), recurso de instalação ausente (role, bucket).
- [ ] `validate` diagnostica quando concorrência de Builders × tamanho do perfil excede a quota de memória lida da conta, sem ajuste automático.
- [ ] Nenhuma credencial AWS é gravada pela Factory; o Controle não recebe região, tamanho nem outro detalhe do perfil.
- [ ] Smoke em conta AWS real, no perfil de aceite (`us-east-1`, ARM64), com evidência registrada no `## Answer`. Exige autorização específica do Operador antes de rodar (conta, permissões, teto de consumo, prazo e cleanup), conforme `docs/agents/experiment-proofs.md`. Sem autorização, o critério fica desmarcado e declarado; nunca é dado por feito pelo fake.
