# Especificar tecnicamente o MVP da Software Factory

Status: resolved
Label: wayfinder:map

## Destination

Chegar a uma spec técnica implementável do MVP de [Software Factory](prd.md), com decisões justificadas, componentes, contratos, estados/invariantes e critérios de validação suficientes para posterior decomposição em tickets de implementação.

## Notes

- Localização atual: `Sanmoo/software-factory-durable`, com tracker Markdown local.
  [Proveniência e limites da migração](../../docs/migrations/software-factory-from-pkm.md) explicam os arquivos importados e os relatórios preservados.
  Commits, branches, worktrees e destinos do PKM citados nos registros anteriores são contexto histórico; trabalhos futuros usam este repositório.

- Mapa e cobertura inicial aprovados pelo operador nesta conversa. A autoridade de produto é o PRD; este esforço não adota automaticamente specs ou experimentos anteriores.
- Planejamento, não construção. Exceção documental explícita: o destino inclui consolidar as decisões em `spec.md` deste diretório ao final do mapa. Nenhuma spec implementável foi produzida na cartografia, e a consolidação não pode inventar decisões que ainda não foram confirmadas.
- Premissas confirmadas antes da cartografia: cobrir o MVP inteiro com construção futura incremental; liberdade tecnológica; Linux em uma única máquina como plataforma inicial; aceitar o custo de ambientes dedicados e Docker isolado se necessário. Isso não escolhe backend ou grau adicional de contenção.
- Preferência transversal do operador: a solução tecnicamente mais simples que cumpra o PRD. Comparar complexidade total de código próprio, dependências, instalação, operação e recuperação. Não presumir que menos serviços seja sempre mais simples. Reforço explícito durante isolamento: reaproveitar os fluxos das skills existentes e evitar toda complexidade acidental; não redesenhar sua orquestração sem necessidade demonstrada.
- Diretriz transversal de interface: configurações e detalhes específicos da sandbox pertencem ao seu adapter e à interface de sandbox, sem flags ou dimensionamento específicos de backend espalhados pelo controlador; registro em [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](issues/07-isolation-choice.md).
- Usar o vocabulário de Ticket, Trabalho, Execução, Builder, Revisores, Slot, Reparo, Bloqueio, Pronto para revisão humana e Entregue definido na seção 3 do PRD. Não importar sentidos incompatíveis dos experimentos antigos nem criar glossário global para este domínio específico.
- Skills: Wayfinder para navegação; grilling e domain-modeling para decisões HITL; research para investigação de fatos; prototype somente se uma decisão exigir artefato concreto e houver autorização. Uma sessão resolve no máximo um ticket não-research.
- Tracker: Markdown local, conforme [instruções](../../docs/agents/issue-tracker.md). Filhos em `issues/`, `Type:` para tipo, `Blocked by:` para dependências numéricas. Usar somente labels `wayfinder:*`, sem labels de triagem/implementação. Tickets começam `Status: open`; marcar `Status: claimed` e responsável/contexto antes do trabalho; `Status: resolved` e `## Answer` ao resolver.
- Fronteira: consultar os filhos abertos, sem reivindicação e com todos os bloqueadores resolvidos, em ordem numérica. O mapa não duplica a lista de tickets abertos. Em toda comunicação humana, referir-se aos tickets pelo título com link.
- Resolução vive em um único lugar: `## Answer` do ticket. Este mapa recebe apenas uma síntese com link em Decisions so far. Decisões HITL exigem confirmação humana; relatório de pesquisa não é aprovação de tecnologia.
- Pesquisas iniciais são documentais, usando fontes primárias atuais, com versões/data de consulta e limites da evidência. Não instalar serviços, executar modelos/provas, alterar host/configuração ou usar credenciais reais. Experimentos eventualmente necessários exigem autorização própria.
- Pesquisadores trabalham em branches descartáveis `research/software-factory-<tema>`, com worktrees isoladas sob `.worktrees/` do checkout principal. Cada um lê a skill research, grava um relatório em `.scratch/software-factory/research/` na própria branch, valida, commita e publica somente essa branch, sem PR e sem merge. Não edita mapa/tickets. O responsável pelo mapa verifica o relatório e registra referência imutável no ticket antes de resolver a pesquisa. Falha de publicação é bloqueio visível, não permissão para trocar transporte ou relaxar SSH.
- Evidências antigas podem reduzir pesquisa, não impor desenho: bateria Restate com executor simulado não prova GitHub + agente + Docker; prova Docker rootless não demonstra automaticamente concorrência/crash recovery. Detalhes e referências pertencem às pesquisas/tickets.
- Destino de integração dos registros deste esforço: branch `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`. Edições e validações usam worktree isolada; preservar alterações e worktrees preexistentes. Não publicar `main` sem autorização específica; autorização de pesquisa cobre apenas suas branches.
- As três pesquisas iniciais terminaram e foram verificadas; referências imutáveis/publicação e ressalvas estão nos Answers. As branches locais/remotas de pesquisa foram preservadas como evidência, sem merge/PR; as três worktrees foram removidas após confirmar limpeza e publicação. O relatório de isolamento passou por correção de rastreabilidade antes da resolução. Workflow inicial `1cb0b420-981c-4677-86ed-705118696c24` e retomada de correção `79ea1938-0bc1-4b68-ad34-e989454f4ceb` concluídos, sem pesquisa ativa restante desta rodada. Não relançar as pesquisas.
- Rodada de durabilidade autorizada em 2026-11-03: reaproveitar as pesquisas concluídas, comparar controlador próprio, Restate, DBOS, Mastra durable, LangGraph e Pi Durable individualmente e delegar somente lacunas decisivas. Temporal, Hatchet e Inngest são referências, sem descarte técnico antecipado. A pesquisa inicial de runtimes não será reaberta. Registros comparativos pertencem ao ticket de durabilidade e seu artefato; aprovações parciais vivem nos comentários HITL do ticket até sua resolução, não são inferidas das pesquisas. Novas pesquisas seguem a mesma regra de branches publicadas sem merge/PR e verificação do responsável. Nesta rodada, os pesquisadores têm read/write/web sem shell/git: entregam os relatórios nas worktrees dedicadas e o supervisor assume validações Git, commits, publicação exclusiva das branches de pesquisa por SSH BatchMode e confirmação remota. Workflow `e7e44352-d35b-4c31-bcc2-bdac2708af23` concluído; os três relatórios foram lidos/verificados, publicados exclusivamente nas branches de pesquisa e resolvidos com referências imutáveis. Worktrees da rodada removidas limpas; branches locais/remotas de evidência preservadas sem merge/PR. Nenhuma pesquisa ativa restante nesta rodada; não relançar.
- A investigação adicional de Gondolin terminou no run `36359d3b-b5dc-4757-aaa5-9083be4bb8af`: relatório materializado e verificado pelo supervisor, publicado exclusivamente em branch de pesquisa com referência imutável no Answer. Branches local/remota preservadas sem merge/PR; worktree de pesquisa removida limpa. Nenhuma pesquisa ativa restante; não relançar. A pesquisa não aprovou backend; a escolha HITL posterior foi consolidada em [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](issues/07-isolation-choice.md).
- Antes de encerrar o mapa, verificar que não há decisão de desenho pendente ou névoa em escopo; conferir cobertura de RF-01–14, RNF-01–05 e CA-01–12. Se uma lacuna aparecer, criar a decisão/investigação correspondente, não preencher a spec com suposições.

- Destino documental alcançado: a [Spec técnica — Software Factory MVP](spec.md) incorpora a arquitetura interna aprovada
  e recebeu aprovação humana integral. Resolução/validações em
  [Consolidar a spec técnica implementável do MVP](issues/25-consolidate-technical-spec.md#answer).
  Mapa encerrado, sem ticket aberto ou névoa em escopo identificada; isso não aprova o MVP nem autoriza construção/provas.
  Rebase local, integração e push autorizados; a divergência anterior de `main` foi resolvida pelo operador e a sincronização verificada.
  A retomada preserva decisões e contexto, com integração fast-forward/publicação normal e limpeza restrita aos recursos desta tarefa,
  conforme registro na resolução.

## Decisions so far

- [Investigar runtimes de agentes contra o contrato do PRD](issues/03-agent-runtime-research.md): primitivas e lacunas de Pi/SDK/Durable, Mastra, LangGraph e Eve documentadas; nenhuma escolha ou conformidade ponta a ponta aprovada.
- [Investigar APIs e permissões GitHub para os controles do MVP](issues/05-github-capabilities.md): capacidades, limites de permissão/checks/dependências e provas pendentes documentados; token de conteúdo não separa push de merge.
- [Investigar isolamento Linux com Docker concorrente por trabalho](issues/04-linux-docker-research.md): redução de privilégio, separação por Trabalho e contenção do daemon são propriedades distintas; alternativas/provas documentadas, sem backend aprovado.
- [Definir a fronteira mínima entre controlador e builder](issues/01-control-authority.md): publicação direta pelo builder via GitHub App,
  coordenação/prontidão pelo controlador e CI sob responsabilidade do repositório, com barreiras técnicas e riscos residuais explícitos.
- [Investigar DBOS como controle durável local da fábrica](issues/12-dbos-control-research.md): biblioteca, transações e recovery local documentados; filas/Slots, ownership externo e fronteiras core/Enterprise explicitados, sem adoção aprovada.
- [Verificar plataformas de agentes como autoridade durável do Trabalho](issues/13-agent-control-durability-research.md): Mastra, LangGraph e Pi Durable podem compor controle persistente, com fronteiras atômicas e custos próprios distintos; nenhum segundo motor/banco obrigatório demonstrado.
- [Verificar a base transacional de um controlador próprio local](issues/14-local-controller-persistence-research.md): transações SQLite, sincronização e recuperação própria inventariadas; viabilidade documental não prova menor complexidade nem aceite.
- [Escolher a estratégia mínima de durabilidade e recuperação](issues/02-durability-strategy.md): Pi Durable com SQLite WAL/FULL, autoridade única e fases reconciliáveis; risco experimental aceito, sem escolher automaticamente o runtime de coding.
- [Escolher o runtime de agentes e seus pontos de integração](issues/06-agent-runtime-choice.md): Pi coding-agent via SDK em workers próprios, perfil independente do operador, retomada compatível/substituição e retries operacionais sob o controlador; aceite ainda exige provas.
- [Verificar Gondolin como ambiente de execução isolado da fábrica](issues/18-gondolin-isolation-research.md): microVM QEMU/KVM e composição Docker documentadas; custo real, CA/Testcontainers, persistência e supervisão continuam a demonstrar, sem adoção aprovada pela pesquisa.
- [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](issues/07-isolation-choice.md): Gondolin QEMU/KVM por Trabalho, disco preservado nas esperas, workspace host/VFS e configuração encapsulada no adapter; reviews na mesma VM coordenados pelo controlador, com provas ainda pendentes.

- [Definir estados, filas, persistência e reconciliação dos efeitos](issues/08-state-and-effects-contract.md): registros e estados ortogonais, FIFO estável, reservas/limites separados, renovação explícita de autorização e reconciliação de efeitos/encerramentos, sem segundo motor.
- [Definir o escopo suportado e a validação das dependências nativas](issues/09-dependency-compatibility.md): `gh api` + REST, grafo alcançável e satisfação por ciclo; testes de cenários, pré-voo automático e avaliação em operação, sem certificação manual por par nem garantia inventada de relações invisíveis.

- [Definir a avaliação de checks obrigatórios e prontidão do PR](issues/10-readiness-checks-contract.md): avaliação correlacionada e sem verde presumido, pareceres incrementais com sessões retomadas e manutenção só por impedimento efetivo, não mero avanço da base.

- [Definir o contrato de permissões e verificação da GitHub App](issues/11-github-app-contract.md): tokens reduzidos por papel/repo, entrega via ambiente para Git/gh e renovação sem cofre; configuração das barreiras pelo time operador, sem certificação ou monitoramento pela fábrica.

- [Definir a captura versionada da especificação e das instruções](issues/16-specification-snapshot-contract.md): Builder consulta e preserva o pedido via `implement`, sem ingestão pelo controlador; versões ligadas à autorização, `continue` nas retomadas e recuperação explícita de sessões substitutas.

- [Definir o pacote de skills e o contrato verificável de revisão e validação](issues/17-skills-and-review-contract.md): pacote próprio, fontes preservadas e pareceres correlacionados ao conteúdo; recuperação parcial e gates verificáveis, com evidências detalhadas separadas de PRs curtos para humanos.

- [Definir o contrato e o perfil distribuível do adapter Gondolin](issues/19-gondolin-adapter-contract.md): interface e configuração encapsuladas, perfil Alpine/Docker vfs em Arch x86_64, cessação supervisionada e revisores apenas com `read`/contexto preservado; manifesto e provas de release sem homologação presumida.

- [Definir o protocolo de execução e retomada entre controlador e worker](issues/15-controller-worker-protocol.md): sockets locais, lock e barreira de recuperação, recibos de início/pergunta/revisão e timeout monotônico; publicação reconciliada sem ferramenta adicional de intenção.

- [Definir o fluxo de manutenção e reconciliação autorizada do PR](issues/20-pr-maintenance-contract.md): feedback consolidado nos registros existentes, correções encerradas sem esperar CI e reconciliação humana vinculada à divergência, sem máquina de estados por evento.

- [Definir observabilidade, proteção de segredos e retenção dos artefatos](issues/22-observability-retention-contract.md): registros locais correlacionados, consumo com lacunas explícitas, filtragem nos caminhos controlados e retenção conservadora; cleanup e exclusão de histórico separados, sem redisparo acidental.

- [Definir a configuração, a CLI e o ciclo operacional da instalação](issues/21-installation-operations-contract.md): instalação autocontida, conta dedicada opcional, configuração explícita e comandos correlacionados; atualização controlada e recovery após crash, sem backup integrado.

- [Revisar a composição da arquitetura e suas fronteiras](issues/23-architecture-cross-review.md): composição documental revisada, contratos operacionais alinhados e quatro ajustes confirmados nas fronteiras de exclusão, parada limpa, saídas longas e fontes privadas; sem homologação de runtime.

- [Definir a matriz de aceite e a sequência de validação incremental](issues/24-acceptance-and-incremental-plan.md): cobertura RF/RNF/CA rastreável, evidência no menor nível fiel, gates orientados a riscos e pilotos por cobertura; plano aprovado, provas e aceite do MVP ainda futuros.

- [Definir a stack de implementação e a arquitetura interna da aplicação](issues/26-implementation-stack-and-application-architecture.md):
  TypeScript/ESM, contratos separados, composição explícita e gate progressivo com regras estáticas; testes funcionais do protocolo sem camada nova de runtime.

- [Consolidar a spec técnica implementável do MVP](issues/25-consolidate-technical-spec.md#answer):
  composição completa aprovada pelo operador, com cobertura e rastreabilidade conferidas; handoff documental, sem aceite do MVP.

## Not yet specified

Nenhuma névoa em escopo ou decisão de desenho pendente identificada. Todos os filhos estão resolvidos e a spec completa foi aprovada;
o mapa está encerrado. Construção, provas, aceite do MVP e decomposição pertencem a esforços posteriores, não a esta fronteira.

## Out of scope

- Suporte integrado a backup/restauração, agendamento, expiração ou certificação de cópias: não exigido pelo PRD e retirado explicitamente durante
  [Definir a configuração, a CLI e o ciclo operacional da instalação](issues/21-installation-operations-contract.md). Proteção contra perda de storage é externa;
  persistência e reconciliação após crash permanecem obrigatórias. Essa revisão substitui os encaminhamentos anteriores de implementar um procedimento integrado,
  sem alterar os limites de retenção/exclusão nem prometer rollback do GitHub.

- Implementar a fábrica, provisionar infraestrutura, rodar experimentos/benchmarks/provas ou executar o piloto nesta cartografia.
- Auditar exaustivamente ou administrar a segurança interna do CI dos repositórios como gate da fábrica;
  limite confirmado em [Definir a fronteira mínima entre controlador e builder](issues/01-control-authority.md).
- Certificar ou monitorar continuamente as barreiras de base/merge da App, inclusive provas negativas obrigatórias;
  fronteira registrada em [Definir o contrato de permissões e verificação da GitHub App](issues/11-github-app-contract.md).
- Decompor a construção em tickets de implementação; isso vem depois da spec implementável.
- Reabrir decisões de produto do PRD silenciosamente. Incompatibilidades técnicas devem voltar ao operador com impacto explícito.
- Evoluções fora do MVP: SaaS, distribuição/HA, outros trackers, webhooks/UI web, merge automático, deploy/produção e mudança coordenada multirrepositório por builder.
- Migrar, alterar ou encerrar mapas/specs antigos deste PKM; são esforços independentes.

### Roadmap pós-MVP já identificado

Estas evoluções foram explicitamente solicitadas pelo operador; ficam registradas para esforços posteriores, sem ampliar o destino deste mapa nem virar fallback implícito do MVP.

- Outras modalidades de sandbox, incluindo opção Docker para hosts que já são VMs, especialmente sem nested KVM; diretriz e limites registrados em [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](issues/07-isolation-choice.md).
- [Software Factory v2 — ambientes reconstruíveis e harnesses substituíveis](../software-factory-v2/map.md): mapa pós-MVP integrado para avaliar Lambda MicroVMs e execução Pi/Claude, preservação via Git e continuidade após reconfiguração; não altera o PRD/spec nem os gates de implementação do MVP.
- Suporte da fábrica a macOS, aproveitando como ponto de partida o suporte documentado pelo Gondolin a QEMU/HVF; adaptações e validação próprias continuam necessárias, conforme [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](issues/07-isolation-choice.md).
