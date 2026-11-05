# Investigar isolamento Linux com Docker concorrente por trabalho

Status: resolved
Claimed by: pesquisador delegado pelo responsável do mapa
Research branch: research/software-factory-linux-docker
Research worktree (histórica; removida limpa após verificação): /home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/sf-research-linux-docker
Context: cartografia Wayfinder aprovada nesta conversa; pesquisa documental AFK delegada.
Research workflow: 1cb0b420-981c-4677-86ed-705118696c24
Research state: pesquisa documental corrigida, verificada e publicada; resolução não escolhe backend.
Research correction run: 79ea1938-0bc1-4b68-ad34-e989454f4ceb
Local report: [Relatório preservado](../research/linux-docker-isolation.md)
Type: research
Label: wayfinder:research
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: none

## Question

Quais composições mínimas de isolamento em Linux permitem ao builder instalar dependências e executar testes Docker simultâneos, sem expor amplamente filesystem, processos e credenciais do host?

Avaliar opções plausíveis de menor complexidade primeiro: usuário/daemon rootless dedicado, sandbox de processo ou container com daemon por trabalho; considerar VM/microVM se resolver lacunas relevantes. Não presumir microVM obrigatória nem montagem do socket Docker do host aceitável como padrão. Distinguir isolamento por instalação, trabalho e execução, namespaces de recursos e acesso efetivo do daemon aos caminhos do host.

Cobrir compatibilidade documentada com Testcontainers/Ryuk e bind mounts, rede/portas, volumes/nomes fixos, concorrência, limites de recursos, encerramento de árvores de processos, sobrevivência ao crash do controlador e cleanup limitado aos recursos próprios. Explicitar dependências do kernel, privilégios na instalação e poderes residuais; o PRD não promete conter código deliberadamente hostil.

Verificar as provas locais rootless e seus limites, separando registro histórico de evidência oficial e de comportamento ainda não provado. Entregar alternativas, trade-offs de simplicidade e propostas de provas mínimas, sem decidir o backend.

Pesquisa documental apenas: não instalar serviços, executar Docker, criar usuários, alterar o host ou rodar provas. Relatório em `.scratch/software-factory/research/linux-docker-isolation.md`, em branch de pesquisa separada, nunca integrada.

## References

- [PRD — Software Factory MVP](../prd.md): RF-03–04, RF-07, RF-12 e RF-14; RNF-01–02; CA-03, CA-06–08.

## Comments

- Criado na cartografia aprovada; não é ticket de implementação.
- A revisão do supervisor detectou IDs de requisitos/aceites trocados na matriz inicial. O pesquisador corrigiu a rastreabilidade na mesma branch, com commit/push normal; referência canônica abaixo aponta para a versão corrigida.

## Answer

Pesquisa documental concluída e verificada pelo responsável do mapa. [Relatório imutável corrigido](https://github.com/Sanmoo/pkm/blob/9d2994e3befd386495282fb8d96b28a3b98220ff/.scratch/software-factory/research/linux-docker-isolation.md), commit `9d2994e3befd386495282fb8d96b28a3b98220ff`, branch `research/software-factory-linux-docker`. Consulta em 2026-11-03 UTC; substitui como referência canônica o relatório inicial `5760aeb`.

- Rootless reduz poderes do daemon, mas conta/daemon dedicados à instalação não isolam automaticamente Trabalhos. Sandbox do cliente não restringe a visão/permissões do daemon que resolve bind mounts.
- Daemon por Trabalho separa inventários Docker, não necessariamente UIDs, filesystem indireto, rede host, portas ou processos sobreviventes. Configuração multi-daemon exige cuidado e é descrita como experimental pela Docker.
- A composição oficial dind-rootless dentro de Docker rootful ainda exige container externo privilegiado; não equivale a contenção mínima comprovada. VM/microVM desloca a fronteira e acrescenta ciclo de vida, imagem, rede e armazenamento; não foi escolhida.
- Há registro local positivo de um método Java com Testcontainers/Ryuk, não demonstração de concorrência três, quotas, crash/recovery, Git isolado ou cleanup em SIGKILL.
- Revisores, worktrees/metadados Git, credenciais, cgroups, ownership e recursos Docker precisam entrar no contrato de ambiente e reconciliação. Dez provas foram propostas, nenhuma executada.

**Verificação:** relatório e correção lidos; matriz corrigida confrontada com o PRD, incluindo CA-03/05–08, RNF-01 e RF-12. Fontes/links locais, escopo de diff e SHA remoto conferidos. Documentação primária Docker rootless foi confrontada por amostragem, incluindo dind privilegiado e limites cgroup. O pesquisador registrou 44 referências/37 fontes externas; essas validações são documentais, não aceite de isolamento.

**Encaminhamento:** usar em [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](07-isolation-choice.md). Nenhum backend, provisionamento ou prova ficou autorizado por esta resolução.
