# Verificar Gondolin como ambiente de execução isolado da fábrica

Status: resolved
Claimed by: pesquisador delegado pelo responsável do mapa
Claim context: investigação documental solicitada pelo operador ao discutir isolamento; sessão supervisora Pi `01a1a1d0-7fa4-72a8-8dc8-48e72b6d1c93`. Na abertura da pesquisa, Q1 não aprovada e Q2 ainda sem resposta; aprovação posterior de Q2 registrada nos Comments da decisão de isolamento.
Research branch: research/software-factory-gondolin
Research worktree (histórica; removida limpa após confirmação da publicação): /home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/sf-research-gondolin
Research state: investigação documental concluída, verificada e publicada exclusivamente na branch de pesquisa, sem PR/merge.
Research run: 36359d3b-b5dc-4757-aaa5-9083be4bb8af
Local report: [Relatório preservado](../research/gondolin-isolation.md)
Type: research
Label: wayfinder:research
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: none

## Question

Gondolin oferece uma composição documentalmente viável e potencialmente mais simples que VM convencional ou conta/sandbox/Docker rootless por Trabalho para o isolamento do MVP, em Linux x86_64, com três Builders concorrentes e testes Docker?

Concentrar em: custo-base configurado versus consumo efetivamente demonstrado; QEMU/KVM e krun experimental; Docker no guest, storage driver, Testcontainers/Ryuk, certificados e rede interna/egress; persistência de worktree/metadados Git e alterações não commitadas, VFS versus root disk, checkpoints e tmpfs; propriedade/interrupção de workers/VM após crash do controlador; revisão imutável sem escrita e proteção do host/segredos. Comparar manter agente no guest versus somente ferramentas no guest sem reabrir silenciosamente a decisão de runtime. Identificar lacunas decisivas e provas futuras, sem presumir conformidade ou escolher tecnologia.

Leitura inicial do supervisor: upstream `6b381a9fd1c353e80cc9b4cf35474b6909703a16`, manifesto host 0.14.0. Há exemplo Docker aarch64 com `--storage-driver=vfs`, defaults de 1G e 2 vCPUs (não RSS/benchmark), backend QEMU recomendado pelo projeto e krun experimental. Não foram encontrados Testcontainers/Ryuk nas áreas consultadas. Docs de limitações dizem Alpine, mas custom-images descreve rootfs OCI Debian; verificar o alcance real, sem repetir a limitação de forma absoluta. A extensão Pi é exemplo de ferramentas remotas com agente no host, não prova do perfil da fábrica.

Pesquisa documental somente. Não instalar pacotes, executar VM/Docker/modelos/provas, alterar host, ler credenciais ou medir carga. Usar fontes primárias com commit/versão e limites de evidência. Relatório em `.scratch/software-factory/research/gondolin-isolation.md` na branch de pesquisa descartável, sem PR/merge. Pesquisador não edita mapa/tickets nem executa shell/Git; supervisor assume validação Git, commit e publicação via SSH BatchMode, sem publicar main.

## References

- [Gondolin — código consultado](https://github.com/earendil-works/gondolin/tree/6b381a9fd1c353e80cc9b4cf35474b6909703a16).
- [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](07-isolation-choice.md).
- [Escolher o runtime de agentes e seus pontos de integração](06-agent-runtime-choice.md).
- [Escolher a estratégia mínima de durabilidade e recuperação](02-durability-strategy.md).
- [Investigar isolamento Linux com Docker concorrente por trabalho](04-linux-docker-research.md).
- [PRD — Software Factory MVP](../prd.md).

## Comments

- Criado após questionamento do operador sobre peso de VMs e indicação explícita do Gondolin. A proposta de VM convencional permanece não aprovada; a pesquisa não resolve a decisão HITL.
- O pesquisador retornou o relatório no artefato da execução, sem criar o arquivo solicitado na worktree. O supervisor materializou o texto, acrescentou data/origem e conferiu as fontes antes de commit/publicação; não houve nova pesquisa ou transporte alternativo.

## Answer

Pesquisa documental concluída e verificada. [Relatório imutável — Gondolin como isolamento da Software Factory MVP](https://github.com/Sanmoo/pkm/blob/3f928a4ff4eeae3268661d8921b722cdee714b7a/.scratch/software-factory/research/gondolin-isolation.md), commit `3f928a4ff4eeae3268661d8921b722cdee714b7a`, branch `research/software-factory-gondolin`. Consulta em 2026-11-03 UTC; upstream fixado em `6b381a9fd1c353e80cc9b4cf35474b6909703a16`, manifesto 0.14.0.

Gondolin é candidato documentalmente plausível, sem prova de menor complexidade/custo nem de aceite do MVP. QEMU/KVM já oferece o caminho microVM x86_64; krun é experimental, não requisito para obter microVM. Defaults de 1G/2vCPUs não são RSS medido nem capacidade demonstrada para JVM/Docker e concorrência três.

As lacunas decisivas são Docker/Testcontainers/Ryuk e CA no guest; disco/I/O do driver Docker `vfs`; semântica Git pelo VFS/FUSE versus armazenamento em disco; persistência de worktree/sessão fora dos defaults efêmeros; e supervisão/exclusividade após crash. O wrapper de CA cobre `docker run`, não demonstra containers criados pela API. Abort é local e close é best-effort; o fallback de término pode sinalizar outros VMMs do mesmo processo. Esses limites precisam entrar no desenho e nas provas propostas, não ser tratados como reprovação universal do projeto.

**Verificação:** relatório lido integralmente; confronto por amostragem com código/docs fixados de defaults, máquina QEMU, Docker/CA, VFS, checkpoints/tmpfs, integração Pi e término de children. Fonte Docker oficial confirmou deep copy/maior disco do driver `vfs`. Links locais e catálogo de fontes S1–S15 conferidos; `git diff --cached --check` passou. Publicação SSH BatchMode e SHA remoto conferidos. Relatório não foi integrado nem recebeu PR; branches local/remota preservadas como evidência, worktree removida limpa.

**Encaminhamento:** retomar [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](07-isolation-choice.md) com comparação informada. A pesquisa não escolhe backend/posição do agente/layout de dados e não aprova instalação, benchmark ou prova. Os cinco gates propostos no relatório permanecem a autorizar e demonstrar; o desenho HITL continua aberto.
