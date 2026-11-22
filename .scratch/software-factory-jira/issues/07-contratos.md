# Definir contratos, persistência e compatibilidade com GitHub Issues

Status: resolved
Assignee: Samuel Santos
Type: grilling
Label: wayfinder:grilling
Map: [Operar a Software Factory com tickets do Jira](../map.md)
Blocked by: 04, 05, 06

## Question

Em quais módulos entram o adapter Jira, composição, configuração, referências, observações e efeitos persistidos? Traçar do polling à recuperação do Trabalho; nomear interfaces e mudanças nos consumidores que hoje esperam identidade GitHub. Definir exemplos de payloads, versões, atualização/retorno e comportamento para instalações e Trabalhos GitHub existentes. Explicitar o que não precisa mudar no repositório de código, no harness e no sandbox.

## Answer

**Uma origem por Ticket; um destino por Trabalho.** Jira Cloud e GitHub Issues podem alimentar simultaneamente o mesmo repositório GitHub. Não deduplicar por título, chave exibida, menção ou semelhança de conteúdo. Desligar a descoberta de uma fonte impede novas admissões por ela; não muda a origem, o destino nem as comunicações dos Trabalhos existentes. Não é uma revogação de acesso: se a credencial for de fato retirada, os efeitos que dependem dela ficam pendentes com diagnóstico local, não são redirecionados.

### Configuração e fronteiras

- Em `src/entrypoints/configuration.ts`, continuar aceitando o YAML v1 sem alterações: os repositórios executáveis continuam fontes GitHub Issues, com as mesmas etiquetas, operadores e permissões. Não ler credencial Jira nem chamar o Jira nesse caminho. Na configuração v2, separar repositórios executáveis de fontes de descoberta. Exemplo parcial (os IDs são ilustrativos; as rotas referenciam repositórios já autorizados):

  ```yaml
  schemaVersion: 2
  ticketSources:
    - { tracker: github, repository: equipe/payments-api, discover: true }
    - tracker: jira
      discover: true
      siteId: site-A
      url: https://equipe.atlassian.net
      email: fabrica@example.org
      tokenFile: credentials/jira-token
      projectId: "10010"  # PAG
      label: factory-ready
      routes:
        - { componentId: "10022", repository: equipe/payments-api }
  ```

  Validar origem do site e correspondência com o ID configurado, escopos e destinos; um repositório somente de dependências não é destino. O segredo é lido no host, nunca incluído no YAML, em observações, logs ou contexto do agente. O seletor `discover` não remove o adapter necessário à retomada.
- Em `src/entrypoints/controller/composition.ts`, `composeProductionAccess` compõe o adapter GitHub atual e, se configurado, o adapter Jira de `src/issue-tracker/` sobre um cliente REST v3 do host. Selecionar por origem persistida, não pelo tracker padrão atual. O cliente lida com autenticação, paginação, ADF e falhas HTTP; não decide admissões nem executa comandos de Trabalho.
- No contrato `IssueTracker`, discriminar `TrackerScope`, `TicketRef`, observações de bloqueio e entradas por provedor. Manter `listCandidates`, `readTicket`, leitura de bloqueadores e de entradas; distinguir leitura válida, parcial e indisponível, com origem e instante. Um grafo GitHub não vira requisito do Jira, e uma lista Jira vazia não enfraquece a exigência do GitHub. No lado de escrita, separar busca/publicação de comentário de atualização de *remote link* por `globalId`, capacidade Jira. Não exigir que o GitHub simule links Jira.

### Do polling à retomada

1. **Descobrir e admitir.** `src/control/durable/polling.ts` lista por fonte. No Jira, relê intenção, componentes, bloqueadores visíveis e destino autorizado imediatamente **antes de criar** o Trabalho, conforme [roteamento](03-roteamento.md#answer) e [admissão](04-admissao.md#answer). O GitHub conserva seu caminho atual; não copiar para o Jira a criação com `DEPENDENCIES_NOT_EVALUATED`. Exemplo de evidência Jira: `{source:"jira-rest", outcome:"observed", coverage:"visible", blockers:[], observedAt:"2026-11-21T10:00:00Z"}`; um 403 é `unavailable`, nunca esse array vazio. Persistir impedimento/aviso de pré-admissão por identidade do Ticket e motivo, sem criar um Trabalho fictício.
2. **Fixar identidades.** Em `src/control/rules/admission.ts`, preservar exatamente a chave GitHub existente; a chave Jira usa só `jira + siteId + issueId` (componentes codificados sem colisão). Exemplo de campos do Trabalho: `ticket:{tracker:"jira",siteId:"site-A",issueId:"81017",key:"PAG-42",url:"https://equipe.atlassian.net/browse/PAG-42"}` e `repository:{repository:"equipe/payments-api",repositoryId:73,base:"main"}`. Em `admitTicket`, gravar evidência, Trabalho, índice de ciclos e sequência FIFO no mesmo commit, mantendo a verificação de pausa e duplicata. Após reinício, reler pelo ID, nunca recalcular o destino de um Trabalho pela rota de hoje. Views, CLI, histórico e prompts devem apresentar a referência discriminada; preservar `owner/repo#n` para GitHub e não converter `PAG-42` em issue 42.
3. **Receber e publicar.** No controle de perguntas e entradas, não tratar cursor numérico, login do GitHub ou sintaxe de marcador HTML como universais. A referência estável de entrada Jira inclui site, issue e ID do comentário. Persistir recibo e transição juntos; avançar o ponto de leitura apenas sobre entradas processadas, admitindo releitura sem repetir comandos. Manter referências e recibos GitHub existentes. Para saídas, persistir destino, referência lógica, conteúdo e estado antes de enviar. A retomada procura autoria, referência e conteúdo; não transforma timeout em falha definitiva nem em confirmação. Aplicar as regras de edição, audiência e reenvio da [conversa no Ticket](05-conversa.md#answer).
4. **Publicar e reconhecer o PR.** `CodeRepository` continua GitHub. Separar leitura de refs/branches e descoberta do PR próprio da associação por timeline de issue: hoje `readOriginOf` passa `work.ticket.number` até para ler refs. Manter timeline e convenções de descrição para GitHub Issues; no Jira, `descriptionCheck` não exige closing keyword GitHub. Incluir referência de apresentação do Card sem usá-la como prova. Reusar `classifyCandidate` (marcador, autor, branch, base e repositório); `recordDiscovery` fixa a identidade do PR e a intenção de atualizar o link no mesmo commit. Não mudar checks, proteção da base, semântica do merge, transporte Git, harness ou isolamento do sandbox. O agente recebe texto/referências apropriados, não um cliente Jira.
5. **Entregar e comunicar.** Em `recordMergeObservation`, gravar o merge, a saída da fila, a memória do ciclo e as intenções de comunicação Jira juntas. Por exemplo, para um Trabalho entregue: `link:{globalId:"software-factory:work:<uuid>",desired:"delivered",state:"pending"}` e `notice:{ref:"delivery:<uuid>",state:"pending"}`. Na retomada, varrer pendências **inclusive de Trabalhos já entregues**. Atualizar o link para o estado desejado mais recente, reconciliar o comentário à parte e registrar a confirmação de cada um. O controle não repete a entrega nem depende do Jira para confirmá-la. Não descartar a única referência de uma pendência durante a limpeza. O [contrato de vínculo e entrega](06-correlacao.md#answer) define o que conta como confirmação para cada efeito.

### Atualização e retorno

O formato de armazenamento **2** não pode passar a conter silenciosamente registros que um controlador GitHub antigo interpretaria mal. A especificação deve prever formato **3** e migração explícita `factory-storage-2-to-3` no fluxo de inspeção/migração existente (`src/control/durable/{format,migration}.ts`), **antes da primeira escrita incompatível**. Registrar a matriz de versões de documentos e configuração no manifesto da release. Não confundir a versão do YAML com a do armazenamento.

Com controlador parado e pré-checagens satisfeitas, inspecionar o formato, validar a transformação e aplicá-la em um único commit. Preservar IDs e chaves GitHub, índice de ciclos (inclusive memória após `forget`), ordem FIFO, perguntas abertas/respondidas, cursores, recibos, PRs próprios e efeitos pendentes. Não inventar novo efeito ou reenviar perguntas durante a migração. Validar contagens, referências e digest da projeção preservada; interrupção não pode deixar uma mistura operável de versões. Reconhecer formato 1 somente pelo percurso explícito já suportado até 2 antes da nova etapa. Formato desconhecido, misto ou pré-checagem inconclusiva: recusar sem escrita.

**Retirar Jira da descoberta não é fazer downgrade.** Manter a release capaz de ler o estado e reconciliar os efeitos. `upgrade rollback` apenas resseleciona um executável: admitir o retorno somente se a release anterior operar **tanto o armazenamento quanto a configuração**, com as pré-checagens normais aprovadas. Depois de migrar para um formato que ela não suporta, recusar e indicar correção para a frente. Não prometer migração reversa, restauração automática ou reexecução segura de efeitos externos a partir de backup. A continuidade a demonstrar é, por exemplo, retomar uma pergunta GitHub já publicada e aceitar sua resposta uma vez, sem novo Trabalho nem novo comentário.

Esta decisão especifica o comportamento; não registra migração executada, adapter implementado ou homologação em tenant.
