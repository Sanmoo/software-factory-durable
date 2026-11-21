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

**Status:** ready-for-agent

## Acceptance criteria

- [ ] A configuração da instalação escolhe um único adapter para todos os repositórios; não há escolha por repositório ou por Trabalho, seleção automática, Slots por adapter nem política híbrida.
- [ ] O adapter Gondolin declara Docker e disco persistente; duração máxima do boot ausente (sem rotação); saída de rede mediada como no MVP.
- [ ] O Controle decide por capacidade lida do adapter, sem conhecer o nome do adapter nem detalhe do serviço (regra coberta pelo gate de arquitetura).
- [ ] Repositório que exige capacidade não declarada pelo adapter não inicia: impedimento visível com diagnóstico que nomeia a capacidade; nunca há fallback para outro sandbox. Teste com um adapter de teste sem Docker e uma declaração de ambiente com imagens.
- [ ] Instalações existentes (configuração com o perfil Gondolin atual) continuam válidas sem edição; a identidade de ambientes já preparados não muda.
- [ ] A suíte do MVP passa sem alteração de comportamento no Gondolin.
