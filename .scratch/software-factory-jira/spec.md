# Jira Cloud como origem de Tickets da Software Factory

**Spec aprovada para implementação.** Esta extensão pós-v2 muda de onde pode vir um Ticket, não onde se entrega código. O controlador pode descobrir Tickets no Jira Cloud e no GitHub Issues ao mesmo tempo. Cada Trabalho conserva uma origem e um único repositório GitHub autorizado. O merge do PR próprio torna o Trabalho **Entregue**; não resolve o Ticket. Esta spec não registra implementação, migração executada nem homologação de uma instalação.

## 1. Configurar fontes, destinos e acesso

Preservar o YAML v1: repositórios executáveis, etiquetas, operadores e permissões GitHub mantêm o significado atual. Nesse caminho nem abrir arquivo de credencial Jira nem criar cliente Jira. No YAML v2, `ticketSources` descreve fontes separadamente dos repositórios executáveis. Exemplo parcial: ambos os repositórios mencionados abaixo já foram autorizados como destinos GitHub.

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
    projectId: '10010'  # PAG
    label: factory-ready
    routes:
      - { componentId: '10021', repository: equipe/checkout-web } # Checkout
      - { componentId: '10022', repository: equipe/payments-api } # Pagamentos
```

Validar a origem HTTPS contra o site configurado e as referências por ID. Um repositório configurado apenas para leitura de dependências não é destino. O operador fornece URL, e-mail e token de API no host; não precisa fornecer `accountId` nem reservar uma conta exclusiva. A conta deve conseguir ler projeto, Tickets, vínculos, categoria de status e comentários, publicar comentários comuns da Platform e manter *remote links*. Falta de permissão produz diagnóstico, não uma tentativa de ampliar o acesso. Não dar o token ao agente, aos prompts, às observações, aos comentários ou aos logs. Não escrever status, responsável ou resolução. Jira Service Management e migração entre sites não estão cobertos.

`discover: false` desliga **novas admissões**, não o adapter: perguntas, entradas ou avisos de Trabalhos existentes continuam na origem persistida. Se retirar também a credencial, mostrar a pendência localmente até restaurar acesso. Não encaminhá-la para outra fonte.

## 2. Fronteiras de implementação

| Ponto atual | Mudança exigida | O que permanece |
| --- | --- | --- |
| `src/entrypoints/configuration.ts`; `composeProductionAccess` em `src/entrypoints/controller/composition.ts` | Interpretar a versão do YAML e compor adapters por origem. Cliente REST v3 do Jira no host: autenticação, paginação, ADF, diagnóstico de acesso e falhas HTTP. | Credenciais e acesso GitHub continuam separados; sem alteração de transporte Git, harness ou sandbox. |
| `IssueTracker` em `src/issue-tracker/` | Discriminar `TrackerScope`, `TicketRef`, observações de bloqueio, autor, entrada e cursor por provedor. Expor listar candidatos, reler Ticket, observar bloqueio, ler entradas e procurar/publicar comentário. Upsert de *remote link* por `globalId` é capacidade Jira separada. | O adapter reporta fatos, origem, instante e completude. Não admite Trabalho nem autoriza comandos. GitHub não simula links Jira nem troca seu grafo pela regra de bloqueadores visíveis. |
| `src/control/durable/polling.ts`, `src/control/rules/admission.ts` e `admitTicket` | Selecionar a fonte; revalidar e decidir antes de criar Trabalho Jira. Indexar impedimentos pré-admissão por Ticket e motivo. | Pausa, proteção contra duplicata, ciclos e FIFO continuam no controlador. |
| Entradas, perguntas, views, CLI, histórico e prompts | Selecionar leitor/publicador pela origem persistida; exibir `PAG-42` ou `owner/repo#n`; separar recibo de entrada de confirmação de saída. | Fluxo normal de retomada; o agente não recebe um cliente Jira. |
| `src/code-repository/`, `readOriginOf`, `descriptionCheck`, `classifyCandidate`, `recordDiscovery` | Separar refs e reconhecimento de PR próprio da associação por número de issue; para Jira usar correlação de publicação (§5). | Timeline, descrição e convenções GitHub Issues permanecem no ramo GitHub. Checks, proteção da base e evidência de merge não mudam. |
| `recordMergeObservation`, reconciliação e limpeza | Gravar entrega e intenções no mesmo commit; varrer pendências mesmo depois da saída da fila. | Jira informa a equipe, não decide se houve entrega. |

## 3. Descoberta e admissão

Buscar por projeto e etiqueta, paginando a busca JQL. Isso produz candidatos, **não** autorização de execução. Imediatamente antes da criação, reler por ID a etiqueta, lista de componentes e vínculos; usar a configuração vigente. Se o Ticket não tiver mais a etiqueta, não iniciar nem comentar. Se não for possível verificar a intenção, diagnóstico apenas local.

1. Com componentes completos, tomar os destinos autorizados distintos das rotas do projeto. `Checkout` mais um componente sem rota ainda aponta para `checkout-web`; duas rotas para esse mesmo repositório também. Zero destinos ou dois destinos distintos impedem o Trabalho. Lista parcial não significa zero rotas. Se a única rota válida mudou desde a descoberta, vale a revalidada.
2. Resolver o tipo `Blocks` e seu sentido pelo catálogo do site. Se A *é bloqueado por* B, ler a categoria do status de B, mesmo fora do projeto e sem etiqueta; se A *bloqueia* B, B não impede A. Tipo customizado ou direção ambígua requer indicação do operador antes da admissão. Categoria `Done`, não nome local de coluna, satisfaz o critério.
3. Leitura válida sem bloqueador visível ou todos os visíveis em `Done`: liberar este critério. Bloqueador conhecido não concluído: **bloqueado**. Campo ausente, leitura parcial, 403/404 do vizinho ou timeout: **não foi possível verificar**, nunca `[]`. Exemplo de fato válido: `{source:"jira-rest", outcome:"observed", coverage:"visible", blockers:[], observedAt:"2026-11-21T10:00:00Z"}`. A API pode omitir silenciosamente um bloqueador; a instalação aceita esse risco. Terminar a paginação não comprova visibilidade global nem constitui snapshot atômico.
4. Na recusa, não criar Trabalho nem despachar Execução. Com intenção e audiência confirmadas, comunicar o motivo e a ação corretiva no Card, sem expor dados restritos de outro projeto. Não repetir pelo mesmo impedimento; motivo novo permite novo aviso. Se inseguro, diagnosticar localmente. Na próxima tentativa, fazer leitura nova.
5. Na admissão, persistir evidência, origem, destino, índice de ciclos e posição FIFO atomicamente. Exemplo: `ticket:{tracker:"jira",siteId:"site-A",issueId:"81017",key:"PAG-42",url:"https://equipe.atlassian.net/browse/PAG-42"}` e `repository:{repository:"equipe/payments-api",repositoryId:73,base:"main"}`. Chave interna Jira = tupla sem colisões `(jira, siteId, issueId)`; a GitHub não muda. Mudança para `FIN-18` atualiza a apresentação; não cria Trabalho nem recalcula destino. Não localizar substituto pela chave antiga ou fundir Tickets por título, menção ou número aparente.

## 4. Entradas, perguntas e saídas recuperáveis

Só interpretar comentários comuns da Platform lidos no Card de origem. Usar `author.accountId` observado, não uma alegação no texto. Para comandos **do Trabalho daquele Card**, a permissão Jira de comentar basta. Não aplicar lista de operadores GitHub nem aceitar comandos globais, administrativos ou destrutivos da instalação. Uma conta compartilhada pode publicar tanto uma pergunta automática como uma resposta humana.

| Entrada observada | Regra |
| --- | --- |
| `[Software Factory · Pergunta Q-17] …`, mesmo contendo `/factory` | Cabeçalho reservado identifica texto que nunca é instrução; não é prova de autoria. |
| Texto sem prefixo inicial `/factory` | Conversa humana. Não executar nem responder automaticamente. |
| `/factory cancel` | Sintaxe exata de comando do Trabalho. Não inferir cancelamento de texto livre; comando conhecido incompleto pede orientação, não vira resposta. |
| `/factory sim, preserve a API` | Responder somente se houver uma única pergunta aberta no Card. Com zero, orientar; com várias, listar referências. |
| `/factory q17: sim` ou `/factory answer Q-17 sim` | Exigir pergunta aberta deste Card. Referência de outro Ticket não confere autoridade. |

Validar o ADF e a audiência; não projetar texto restrito num comentário para mais leitores. Se não for possível confirmar a audiência, não publicar. Ignorar instrução observada já editada; para corrigir, pedir novo comentário. Não desfazer transição por edição posterior. Gravar `(siteId, issueId, commentId)` e transição no mesmo commit; só avançar o cursor sobre entradas processadas. A releitura depois de restart não cancela duas vezes nem responde duas vezes. Resposta aceita segue a fila normal, sem disparo direto de Execução.

Para qualquer comentário automático, **antes** do POST guardar destino, referência lógica e conteúdo. Após resultado incerto, paginar os comentários visíveis e confrontar conta autora, referência e conteúdo. Uma correspondência confirma; nenhuma em leitura completa permite reenviar **com a mesma referência**; mais de uma, falha de acesso ou paginação incompleta mantém pendência e diagnóstico, sem reenvio às cegas. Isso limita o efeito lógico, não garante cópia visual única. Não encerrar uma pergunta pela mera presença de comentário com cabeçalho semelhante.

## 5. Publicação, merge e recuperação

Ao publicar no repositório autorizado, incluir uma referência legível ao Card na descrição, sem inventar closing keyword GitHub. Se perder a resposta à abertura, procurar por repositório, branch, base, autoria GitHub da fábrica **e** marcador da publicação. Só fixar o PR próprio diante de candidato único verificável em leitura completa; depois reler pela identidade persistida. Mera menção em PR humano não conta. Leitura parcial ou ambígua impede nova abertura, adoção arbitrária e anúncio de entrega. Não consultar timeline de issue espelho.

Ao fixar o PR, gravar no mesmo commit a intenção de manter o link do Trabalho no Card, inclusive para rascunho. Usar um `globalId` estável, por exemplo `software-factory:work:<uuid>`. O título passa de `Trabalho T-17 · Abrir PR` a `PR fechado sem merge` ou `Entregue`, mantendo a URL e a referência ao Trabalho. Fechar sem merge apenas atualiza o vínculo; título do link não comprova entrega.

**Percurso normal.** `PAG-42` está marcado, `Pagamentos` aponta só para `payments-api`, e seu bloqueador visível está em `Done`. A releitura autoriza T-17. Uma pessoa responde à única pergunta com `/factory sim, preserve a API`; a resposta fica no mesmo Trabalho. O controlador confirma seu PR em `payments-api`, publica o link e acompanha os checks no GitHub. Merge confirmado na base `main`: registra **Entregue**, retira T-17 da fila e guarda as duas intenções; atualiza o link e publica `[Software Factory · Entrega T-17] O PR foi integrado a main: <URL>`. O Ticket continua com o status Jira anterior.

**Percurso interrompido.** O GitHub confirma o mesmo merge enquanto o Jira está indisponível. No commit da entrega ficam a saída da fila, a memória do ciclo, `link:{globalId,desired:"delivered",state:"pending"}` e `notice:{ref:"delivery:<uuid>",state:"pending"}`. Após reinício, varrer também Trabalhos entregues; manter o mesmo `globalId`, aplicar o estado desejado mais recente e confirmar o link separadamente do comentário. Se o Jira aceitou o aviso mas a resposta do POST se perdeu, reconciliar como no §4. Se houver duas cópias, informar ambiguidade; T-17 **continua Entregue**. Não reabrir, repetir a entrega, perder a referência na limpeza nem transicionar o Ticket.

## 6. Ordem de implementação e operação de atualização

1. Introduzir as referências discriminadas e contratos comuns sob regressão GitHub, mantendo as capacidades específicas em cada adapter. Atualizar consumidores, composição e validação das versões de configuração antes de habilitar descoberta Jira.
2. Estender `src/control/durable/{format,migration}.ts` e a matriz do manifesto da release. Antes da primeira escrita incompatível, parar o controlador, inspecionar dados/configuração e validar a transformação `factory-storage-2-to-3`. Formato 1 passa pelo caminho explícito existente até 2. Estado misto, desconhecido ou pré-checagem inconclusiva: recusar sem escrita.
3. Aplicar a migração em um commit. Preservar chaves e IDs GitHub, índices e memória dos ciclos (inclusive após `forget`), FIFO, cursores/recibos, perguntas, PRs e efeitos pendentes. Comparar contagens, referências e digest da projeção preservada. A transformação não publica nada. Interrupção deixa versão antiga ou nova íntegra. Versão do YAML não é formato de armazenamento.
4. Integrar cliente Jira, descoberta, revalidação e avisos de impedimento. Em seguida integrar conversa e retomada; por fim separar correlação GitHub do PR, persistir e reconciliar links/avisos. Só habilitar a fonte para novos Tickets quando todo o fluxo estiver disponível.
5. Para interromper entradas, desligar descoberta, não remover a origem de Trabalhos ativos. Na falha de leitura, mostrar Ticket/Trabalho, motivo, efeito pendente e ação segura (conferir acesso, rotas ou aguardar nova leitura). Para rollback, pré-checar **dados e configuração** contra a release anterior antes de resselecioná-la. Se incompatível, recusar sem alteração e orientar correção para a frente. Não prometer migração reversa nem replay seguro de backup contra serviços externos.

## 7. Aceite e limites da prova

Os cenários abaixo são **critérios para a implementação**, não resultados de testes já executados. Em cada linha medir o efeito positivo e a ausência do efeito proibido. A [matriz de testes e os oráculos de aceite](issues/08-testes.md#answer) detalha fixtures e variantes obrigatórias.

| Requisito e decisão | Cenário, camada e falha | Oráculo positivo; efeito proibido |
| --- | --- | --- |
| [Roteamento](issues/03-roteamento.md#answer) | Regra + controlador: editar componentes/etiqueta entre descoberta e admissão; variar duas rotas para um destino, destinos divergentes e leitura parcial. | Só um Trabalho no destino único revalidado; nenhum despacho diante de impedimento, nenhum comentário sem intenção confirmada. |
| [Admissão](issues/04-admissao.md#answer) e [visibilidade Jira](issues/01-visibilidade-jira.md#answer) | Regra + fixture REST: inverter direção, usar vizinho externo aberto/Done, lista vazia válida, 404, campo ou página faltante. | Diferenciar liberado, bloqueado e não verificável; falha nunca libera, ausência visível não atesta ausência global. |
| [Autoridade no Card](issues/05-conversa.md#answer) | Contrato de entradas + controlador: ADF, conta compartilhada, cabeçalho, edição, perguntas concorrentes, referência de outro Card; reiniciar e reler. | Só resposta válida consome pergunta uma vez; não executar comentário automático, comando incompleto ou entrada de outro Card. |
| [Publicação incerta](issues/02-interacao-jira.md#answer) e [regra de reenvio](issues/05-conversa.md#answer) | Fixture HTTP + restart: perder resposta após POST; devolver zero/uma/duas correspondências ou leitura incompleta. | Mesmo ID lógico, reconciliação ou pendência explícita; sem segunda pergunta nem reenvio cego. |
| [Identidade e PR](issues/06-correlacao.md#answer) | Controlador com clientes simulados: mudar chave, perder resposta ao abrir PR; inserir PR humano com menção, variar ambiguidade. | Mesmo Trabalho, destino e PR verificável; nenhum PR humano adotado, segundo PR aberto ou timeline de espelho consultada. |
| [Entrega e comunicação](issues/06-correlacao.md#answer) | Armazenamento real temporário: reproduzir os dois percursos do §5 e o fechamento sem merge. | Fila, fato de entrega, link e aviso observáveis separadamente; sem segunda entrega nem alteração de status do Card. |
| [Coexistência](issues/07-contratos.md#answer) | Composição e contratos por provedor: v1 só GitHub; em v2 mesmo número aparente e destino, descoberta desligada e credencial retirada. | Origem determina o adapter; sem ler segredo/fazer chamada Jira em v1, mesclar identidades ou admitir por fonte desligada. |
| [Continuidade e retorno](issues/07-contratos.md#answer) | Fixture real formato 2 com pergunta GitHub publicada; migrar, reabrir, responder duas vezes. Injetar interrupção no commit, versão mista e destino de rollback incompatível. | Digest e relações preservados; mesma pergunta respondida uma vez. Sem republicação, novo Trabalho, chamada Jira ou escrita na recusa. |

Usar IDs e token sentinela sintéticos, relógio injetado, armazenamento novo por cenário e transporte que registra inclusive chamadas inesperadas. Incluir controle positivo para não confundir fixture desconectada com ausência de escrita. Registrar estado inicial/final, versão, evento/falha, chamadas e transições. Regras e adapters em `fast` por padrão; um crash real representativo por mecanismo, se necessário, em `slow` justificado. Sem `sleep`, caminho ou porta fixos. Gate da construção: `npm run test:ci` conforme a [política de testes](../../docs/agents/testing.md).

Fixtures não demonstram permissões, audiência, comportamento real do *remote link* nem acesso ao PR em um tenant. Se uma instalação exigir homologação, solicitar ensaio separado em projeto e repositório de teste, com contas de audiências distintas, evidência sanitizada e limpeza conforme os [guardrails](../../docs/agents/experiment-proofs.md). Aprovação documental não autoriza esse ensaio e nenhuma conta prova ausência de bloqueadores invisíveis.
