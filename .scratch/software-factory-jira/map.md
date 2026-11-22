# Operar a Software Factory com tickets do Jira

Status: resolved
Label: wayfinder:map

## Destination

Produzir e aprovar uma **spec técnica implementável** do suporte pós-MVP v2 ao Jira Cloud como fonte do Ticket, mantendo código, pull requests e checks no GitHub e GitHub Issues como alternativa. O resultado final é `spec.md` neste diretório: deve detalhar a implementação **e** a estratégia de testes, não apenas listar requisitos.

## Notes

- Recorte confirmado pelo operador: descobrir Tickets elegíveis, respeitar bloqueadores, fazer perguntas, receber respostas e comandos autorizados e comunicar no Ticket o vínculo com o PR e o resultado da entrega. Merge é um fato do repositório; não equivale a resolver o Ticket no Jira.
- Cada Trabalho exige um único repositório GitHub autorizado antes do início; um projeto Jira pode alimentar vários repositórios. Não adivinhar o destino nem iniciar quando não for possível verificar os bloqueadores.
- Critério documental: descrever componentes, contratos e exemplos, configuração e permissões, mudanças persistentes e compatibilidade, fluxo normal e recuperação. Para cada garantia, indicar cenário, camada, fixture ou ambiente, falha injetada quando aplicável e resultado observável. Não declarar implementado ou homologado o que foi somente especificado.
- Referências: [PRD do MVP](../software-factory/prd.md), [spec do MVP](../software-factory/spec.md), [spec da v2](../software-factory-v2/spec.md) e [política de testes](../../docs/agents/testing.md). Usar o vocabulário Ticket, Trabalho e Entregue do PRD. O contrato atual do [tracker](../../src/issue-tracker/index.ts) e a [associação de PRs](../../src/code-repository/index.ts) são pontos de partida a verificar, não o modelo a impor ao Jira.
- Wayfinder no [tracker Markdown local](../../docs/agents/issue-tracker.md); filhos em `issues/`, dependências em `Blocked by:`. Reivindicar antes de trabalhar; a resposta canônica vive no filho. Grilling + domain-modeling com o operador, pesquisa documental com research. No máximo uma decisão não-research por sessão.
- Pesquisas: relatórios citados em branches descartáveis `research/<tema>`, sem PR nem merge, com referência ao commit no ticket. Sem credenciais, acesso a tenant ou prova real. Qualificações futuras exigem autorização separada e os [guardrails de ensaios](../../docs/agents/experiment-proofs.md).
- Planejamento, não construção. A única exceção é documental: consolidar e revisar a spec ao fim do mapa.

## Decisions so far

- [Investigar o que o Jira Cloud permite afirmar sobre Tickets e bloqueadores](issues/01-visibilidade-jira.md): um link visível comprova a relação; esgotar a busca JQL não distingue a ausência de bloqueio de um bloqueador oculto.
- [Investigar identidades, permissões e comentários no Jira Cloud](issues/02-interacao-jira.md): o Jira identifica a conta autora, não sua autoridade sobre o Trabalho; reencontrar um comentário visível não garante publicação única.

- [Definir a seleção de Tickets e o roteamento para um repositório](issues/03-roteamento.md): a etiqueta indica intenção; as rotas por componente devem apontar para um único repositório autorizado na revalidação, e o Ticket recebe o diagnóstico de impedimento quando for seguro comentar.

- [Definir as condições de admissão diante de bloqueadores e leituras incompletas](issues/04-admissao.md): a admissão considera os bloqueadores visíveis; uma lista vazia válida libera esse critério, mas uma leitura com falha não.

- [Definir quem pode conduzir o Trabalho pelo Ticket Jira](issues/05-conversa.md): quem pode comentar no Card pode conduzir seu Trabalho; `/factory` endereça a fábrica e `q17:` distingue a pergunta quando necessário.

- [Definir o vínculo durável entre Ticket Jira, Trabalho e pull request](issues/06-correlacao.md): o merge do PR próprio confirma a entrega; um link por Trabalho e um comentário comunicam o resultado no Card, mesmo que o aviso precise esperar o Jira voltar.

- [Definir contratos, persistência e compatibilidade com GitHub Issues](issues/07-contratos.md): cada Trabalho conserva origem e destino separados; desligar a descoberta não interrompe a retomada, e o retorno de versão depende da compatibilidade dos dados e da configuração.

- [Definir a estratégia de testes e os oráculos de aceite](issues/08-testes.md): cada cenário verifica o resultado e o efeito proibido, inclusive na retomada de um Trabalho GitHub antigo; aprovar a spec não homologa uma instalação.

- [Consolidar e revisar a spec técnica do suporte ao Jira](issues/09-spec.md): a spec foi aprovada para implementação, sem homologar uma instalação.

## Not yet specified

Nenhuma decisão em aberto após a revisão da spec.

## Out of scope

- Jira Data Center, sincronização Jira ↔ GitHub Issues, issue espelho ou migração do backlog de planejamento deste repositório.
- Alterar coluna/status, responsável ou resolução do Ticket; distribuir um único Trabalho por vários repositórios.
- Implementar a feature, provisionar serviços ou executar qualificação real neste mapa.
