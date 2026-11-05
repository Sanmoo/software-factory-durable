# PRD — Software Factory MVP

## 1. Propósito e autoridade do documento

Especificar uma fábrica de software que transforma tickets autorizados em propostas de mudança via PR,
com implementação por agentes, revisão automatizada, manutenção do PR e merge humano.

Este PRD registra o entendimento confirmado pelo operador após uma entrevista de requisitos.
Não representa uma implementação já validada nem aprova uma tecnologia específica.
É uma especificação independente: não substitui automaticamente outros experimentos ou specs deste repositório.

**Resultado esperado:** reduzir a coordenação humana entre um ticket pronto e um PR revisável,
com trabalho observável, recuperável e limitado por políticas explícitas.
A fábrica não promete resolver qualquer ticket nem equipara abrir um PR a entregar uma mudança aceita.
Quando não conseguir avançar, deve apresentar um bloqueio com contexto e próximo passo.

## 2. Público, premissas e escopo

### 2.1 Público e ambiente

- Uma pessoa ou equipe de confiança opera uma instalação local, single-tenant, em uma única máquina.
- A instalação atende vários repositórios previamente autorizados no GitHub.
- Cada ticket representa trabalho em exatamente um repositório.
- Vários tickets podem executar simultaneamente, inclusive no mesmo repositório.
- Os repositórios e operadores são de confiança; ainda assim, entradas externas podem conter instruções maliciosas.
- O worker precisa acessar GitHub, o serviço de modelos, links públicos e fontes de dependências.
- Testes de integração que criam containers Docker são suportados desde o MVP.

### 2.2 Dentro do MVP

- GitHub Issues como tracker e GitHub PRs como superfície de entrega e revisão humana.
- Entrada por label configurada em repositório autorizado; padrão `ready-for-agent`.
- Dependências nativas de issues do GitHub: `blocked by` e `blocking`.
- Filas persistentes, concorrência configurável e prioridade para reparos.
- Builders e dois revisores por execução relevante: Standards e Spec.
- Skills versionadas e adaptáveis no repositório da fábrica.
- Perguntas remotas ao operador, recuperação após crash, CLI e logs.
- Acompanhamento por polling, manutenção de PR e cleanup conservador após merge.

### 2.3 Fora do MVP

- SaaS, múltiplos tenants, execução distribuída e alta disponibilidade.
- Jira e outros trackers, seleção por GitHub Projects e regras booleanas genéricas de entrada.
- Webhooks e interface web.
- Tickets que demandam alterações coordenadas em vários repositórios por um único builder.
- Merge automático, deploy ou acesso a produção, administração de repositórios e push direto na branch-base.
- Adoção automática de PRs humanos ou não reconhecidos como pertencentes à fábrica.
- Roteamento inteligente de modelos e fallback silencioso entre modelos.
- Garantia de contenção de código deliberadamente hostil.

### 2.4 Decisões reservadas ao desenho técnico

O PRD não escolhe framework de agentes, motor de workflow, banco de dados, mecanismo de filas,
backend de sandbox, distribuição de containers ou sistema operacional suportado inicialmente.
Pi Durable, Mastra, Eve e LangGraph são exemplos de opções a avaliar, não requisitos ou uma lista fechada.
`bwrap`, Seatbelt e containers são possibilidades de isolamento, não soluções impostas.

A implementação deve demonstrar as garantias deste documento independentemente das tecnologias escolhidas.
Um histórico de sessão persistido, por si só, não comprova workflow durável nem isolamento.

## 3. Conceitos

| Conceito | Significado |
| --- | --- |
| Ticket | Pedido e referência de especificação em um único repositório. |
| Trabalho | Unidade lógica persistente da fábrica, associada a um ticket e ao seu ciclo de entrega. |
| Execução | Uma ativação de builder para implementar, retomar ou reparar um trabalho. |
| Builder | Agente principal que implementa e decide como tratar os achados dos revisores. |
| Revisores | Subagentes paralelos de Standards e Spec, sem escrita na worktree do builder. |
| Slot | Capacidade para uma execução ativa de builder; não inclui esperas externas. |
| Reparo | Execução motivada por conflito, check obrigatório, review humano ou comando autorizado de correção. |
| Bloqueio | Condição explícita que impede avanço e requer informação, autorização ou correção operacional. |
| Pronto para revisão humana | PR com reviews dos agentes concluídos, validações atendidas e sem conflito ou bloqueio conhecido. |
| Entregue | Trabalho cujo merge foi confirmado no GitHub. |

## 4. Jornada principal

1. O operador torna um ticket elegível em um repositório autorizado.
2. A fábrica consulta o ticket e suas dependências nativas; se satisfeitas, admite o trabalho na fila normal.
3. Havendo slot e elegibilidade atual, inicia o builder em worktree e branch próprias daquele trabalho.
4. O builder recebe a referência do ticket, a especificação, a branch-base e as instruções aplicáveis;
   executa a skill `implement`, incluindo validações e as revisões Standards e Spec.
5. Se precisar de informação ou aprovação, usa `ask user`; a fábrica registra a pergunta e suspende a execução.
6. Concluída a implementação, a fábrica verifica o resultado e a localização dos artefatos.
   Se ainda não houver PR, solicita sua publicação, usando `/pr` para a descrição.
7. O PR é aberto como draft. Quando as condições de prontidão forem satisfeitas, é convertido para revisão humana.
8. A fábrica acompanha o PR sem ocupar slot. Conflitos, checks obrigatórios com falha e feedback acionável geram reparos prioritários.
9. O builder de reparo recebe o contexto atualizado, trata os problemas, valida, publica a atualização e devolve o controle.
10. Uma pessoa revisa e realiza o merge. A fábrica confirma o resultado e executa o cleanup dos recursos que lhe pertencem.

## 5. Requisitos funcionais

### RF-01 — Configuração e autorização de entrada

- Manter configuração explícita de repositórios autorizados, branch-base e label de elegibilidade.
- A combinação de repositório autorizado, ticket aberto e label configurada autoriza a entrada sem segunda aprovação.
- A fábrica não altera labels, assignees, projetos ou status personalizados como parte do fluxo padrão.
- Um ticket tem no máximo um trabalho lógico ativo, mesmo após vários ciclos de polling ou reinícios.
- Retomadas e reparos pertencem ao mesmo trabalho, não criam outro ticket ou outro trabalho independente.
- Após entrega ou cancelamento, a permanência da label não dispara nova implementação; nova execução exige comando explícito.
- PR associado ao ticket, mas não reconhecido como próprio, gera situação reportada em vez de adoção automática.

### RF-02 — Dependências nativas

- Consultar exclusivamente relações nativas de bloqueio do GitHub; não interpretar prosa nem uma seção `Depends on`.
- Ausência de bloqueadores só pode ser afirmada após uma consulta bem-sucedida e completa das relações acessíveis.
- Permitir dependências entre repositórios dentro do escopo efetivamente suportado pelo GitHub e pelas permissões da instalação.
  A compatibilidade entre os repositórios-alvo deve ser validada; limitações devem ser explicitadas, sem fallback para Markdown.
- Dependência executada pela fábrica é satisfeita quando seu PR tiver merge confirmado.
- Dependência externa é satisfeita quando a issue estiver encerrada como concluída, não apenas fechada.
  Encerramentos como não planejada, duplicada ou sem motivo conclusivo não comprovam entrega.
- Relação inválida, dependência inacessível, ciclo ou conclusão indeterminada produz bloqueio visível.
- Reavaliar dependências antes de iniciar ou retomar execução. Um trabalho bloqueado não impede outros de avançar.
- Não pressupor que o GitHub remova ou satisfaça relações automaticamente ao fechar uma issue.

### RF-03 — Filas e concorrência

- Persistir a ordem de admissão e as categorias de trabalho.
- Atender reparos antes da fila normal; usar FIFO dentro de cada categoria, sem interromper builders ativos para abrir espaço.
- Consolidar eventos repetidos do mesmo PR/trabalho e incorporar o contexto relevante na execução seguinte.
- O limite de concorrência conta builders ativos, incluindo o período em que coordenam revisores e comandos.
- Revisores internos não consomem slots adicionais; o consumo real de processos e modelos pode exceder a concorrência de builders.
- Esperas por resposta, CI ou merge não ocupam slot.
- Permitir vários builders no mesmo repositório, sem mutex global por repositório.
- Ao receber resposta válida, uma implementação retorna à fila normal preservando sua ordem original de admissão.
  A retomada de um reparo continua na categoria de reparo.
- Trabalhos temporariamente inelegíveis são ignorados na seleção, sem bloquear a cabeça da fila para os demais.

### RF-04 — Worktrees, branches e autoria

- Cada trabalho possui worktree e branch próprias; reparos reutilizam a identidade daquele trabalho.
- Garantir no máximo um builder escrevendo na mesma worktree/branch, inclusive durante recuperação de crash.
- Não assumir que um processo morreu apenas porque o controlador reiniciou; reconciliar sua propriedade antes de iniciar substituto.
- Revisores não modificam a worktree revisada.
- Reconhecer mudanças humanas na branch e não sobrescrever alterações concorrentes desconhecidas.
- Worktrees não constituem, sozinhas, uma sandbox de filesystem; aplicar também os requisitos de isolamento de RNF-02.

### RF-05 — Especificação e instruções

- Usar o ticket e os documentos explicitamente referenciados como especificação mínima, sem exigir PRD separado por ticket.
- Registrar a versão da especificação utilizada por execução e as referências de base relevantes.
- Não incorporar silenciosamente mudanças posteriores de escopo. Uma atualização de escopo exige solicitação autorizada e nova execução.
- Respostas correlacionadas, reviews e comandos autorizados integram o contexto operacional sem substituir implicitamente a especificação.
- Fornecer ao builder uma referência inequívoca de ticket, repositório e branch-base.
- Identificar as instruções de validação e convenções do repositório, inclusive `AGENTS.md`.
- A política da fábrica prevalece sobre instruções que ampliem poderes, dispensem limites ou mandem realizar merge.
  Incompatibilidades devem ser reportadas.

### RF-06 — Skills e revisão dos agentes

- Versionar as skills necessárias no repositório da fábrica, incluindo `implement`, `code-review`, `/pr` e dependências aplicáveis.
- Permitir evolução das skills e de sua integração sem depender das versões globais da máquina do operador.
- Executar duas revisões paralelas, com contexto suficiente e objetivos distintos:
  Standards verifica padrões do repositório; Spec verifica aderência ao pedido e escopo.
- A especificação de RF-05 deve estar disponível ao revisor Spec; sua ausência não autoriza omitir silenciosamente esse revisor.
- Garantir que a revisão inclua todas as alterações propostas, não apenas um diff que exclua alterações ainda não commitadas.
- Registrar achados, conclusão de cada revisor e tratamento pelo builder: corrigido ou não acolhido com justificativa.
- Falha de execução de revisor não equivale a revisão sem achados.
- Alterações posteriores relevantes exigem nova revisão antes de declarar prontidão novamente.
- Novas rodadas podem retomar as sessões dos revisores; cada um determina a profundidade necessária e emite parecer atualizado e justificado.
  Preservar histórico não equivale a reutilizar automaticamente uma aprovação antiga.
- Mero avanço da branch-base, enquanto o PR permanece apto sem impedimento efetivo, não dispara nova revisão.
- Aprovações humanas exigidas pelas skills, quando não registradas previamente, devem passar por `ask user`.

### RF-07 — Validação do resultado

- Identificar os comandos/gates aplicáveis ao repositório: testes, typecheck, lint e demais validações documentadas.
- Registrar comandos executados e resultados. Não inferir sucesso de validação não executada.
- Falta de instrução, impossibilidade de executar ou falha não resolvida exige orientação explícita.
- Uma dispensa humana pode ser registrada, mas não permite contornar checks obrigatórios do GitHub.
- Suportar instalação de dependências e execução de testes de integração com Docker dentro das políticas de isolamento.

### RF-08 — Publicação e prontidão do PR

- A fábrica verifica a existência e identidade do PR; se ausente, solicita ao builder sua publicação.
- Usar `/pr` para redigir a descrição; não presumir que a skill, sozinha, realize push ou criação de PR.
- Garantir publicação na branch de trabalho e associação inequívoca entre trabalho, ticket, branch e PR.
- Abrir como draft após implementação e reviews dos agentes.
- Converter para pronto quando as validações exigidas estiverem atendidas, os dois reviews concluídos e não houver conflito ou bloqueio conhecido.
- PR aberto, pronto e entregue são condições diferentes; a condição atual deve ser visível ao operador.
- Abertura do PR não encerra o ticket. O vínculo normal de fechamento por merge pode ser utilizado.
- Não realizar merge nem aprovação humana em nome do operador.

### RF-09 — Acompanhamento e reparos

- Acompanhar conflitos, checks obrigatórios, reviews, comentários relevantes e resultado do PR.
- Gerar reparo por conflito confirmado, falha de check obrigatório do commit atual,
  exigência efetiva de atualizar a branch com a base para permitir merge sob regra strict,
  review humano autorizado `CHANGES_REQUESTED` ou comando explícito de operador autorizado.
- Mero avanço da branch-base, enquanto o PR continua apto, não dispara execução, revisão ou rebase.
  Aprovação humana pendente, CI pendente e estado de merge desconhecido não são gatilhos genéricos de reparo.
- Comentário comum, check opcional ou resultado de commit antigo não dispara reparo automaticamente.
- Ao iniciar, fornecer o conjunto de feedback ainda relevante, não apenas o evento que motivou o disparo.
- Check pendente ou ainda não publicado significa espera. Estado de conflito indeterminado não é conflito confirmado nem sucesso.
- Necessidade de aprovação humana para rodar workflow é bloqueio operacional, não defeito de código a corrigir.
- Se não for possível determinar os checks obrigatórios, reportar o problema sem assumir que o PR está verde.
- Incorporar a branch-base por rebase por padrão, salvo estratégia diferente indicada pelo `AGENTS.md`.
- Autorizar `push --force-with-lease` apenas na branch do trabalho, capturando a referência remota esperada antes da operação.
- Se o lease falhar, preservar o trabalho e reportar concorrência; não renovar a expectativa e insistir às cegas.
- Nunca usar `--force` nem reescrever a branch-base.
- Conflito que o builder não consiga resolver com confiança requer intervenção.

### RF-10 — Perguntas e comandos autorizados

- Disponibilizar `ask user` como ferramenta do worker, com pergunta e contexto suficientes para ação do operador.
- Publicar no issue ou PR conforme o contexto, com identificador estável e instrução de resposta explícita.
- Aceitar resposta correlacionada, por exemplo `/factory answer Q-17 ...`, ou resposta via CLI.
  O formato final da interface será documentado no desenho técnico.
- Manter lista explícita de operadores GitHub autorizados a responder e comandar.
- A CLI local opera sob a confiança da conta do sistema que administra a instalação.
- Comentários de bots, terceiros ou conteúdo de páginas consultadas não concedem autorização.
- Persistir a pergunta, sua publicação e a resposta; suspender o worker sem manter um slot ocupado.
- Após resposta válida, recolocar o trabalho na fila e informar ao worker a pergunta e a resposta recebida.
- Resposta insuficiente pode produzir nova pergunta; não equivale a uma aprovação genérica.
- Publicar apenas marcos relevantes e perguntas, não o fluxo integral de logs.

### RF-11 — Elegibilidade retirada e encerramentos externos

- Retirar a label ou encerrar o ticket antes do merge impede novos disparos.
- Isso não mata implicitamente uma execução já ativa; ela pode concluir e publicar seu resultado.
- Retomar após retirada de autorização exige autorização renovada; reabrir um ticket não retoma automaticamente o trabalho.
- Fechar ticket não comprova entrega do trabalho da fábrica sem merge.
- Fechar PR sem merge produz resultado não entregue, sem reabertura ou substituição automática.
- Um PR fechado sem merge não deve ser confundido com cancelamento de uma execução que ainda precise ser interrompida.

### RF-12 — CLI e cancelamento

- Oferecer listagem de trabalhos, estados e filas; inspeção de histórico/logs; pausa e retomada da admissão de execuções;
  cancelamento de trabalho; resposta a bloqueio; solicitação de nova tentativa e limpeza explícita.
- Pausar a fábrica impede novos disparos, sem matar automaticamente builders ativos.
- Cancelar solicita interrupção do builder e processos associados, impede novos disparos/publicações e preserva os artefatos.
- Cancelamento não apaga branch, fecha PR ou desfaz mudanças externas já realizadas.
- Uma operação externa já enviada pode terminar durante o cancelamento; reconciliar e mostrar o resultado efetivo.
- Não exigir edição direta do armazenamento de estado para operar ou desbloquear a fábrica.

### RF-13 — Limites e recuperação operacional

- Padrão: até três execuções automáticas de correção por trabalho; limite configurável.
- Novos pushes e eventos de CI não zeram esse contador. Uma concessão adicional exige ação autorizada e mantém o histórico.
- Falhas operacionais recuperáveis têm até três retomadas automáticas com espera progressiva, em contagem separada e configurável.
- Falhas de autorização ou configuração não devem entrar em repetição automática.
- Esgotamento de qualquer limite gera bloqueio visível, com motivo e ação necessária.
- Duração máxima de execução é opcional e configurável por repositório; quando ausente, não há timeout de execução.
  Não existe teto global obrigatório de 60 minutos.
- Quando configurado, atingir o timeout interrompe a execução e bloqueia para intervenção, sem loop automático de novas tentativas.
- Espera por resposta, CI ou merge não consome tempo de execução nem causa cancelamento automático.
- Mesmo sem timeout, mostrar duração e última atividade e permitir cancelamento manual.

### RF-14 — Cleanup e retenção

- Confirmar o merge antes de marcar entregue e iniciar cleanup automático.
- Remover worktree, recursos temporários e branches local/remota apenas quando identificados como pertencentes ao trabalho.
- Nunca remover a branch-base nem executar limpeza global de recursos Docker ou de outros trabalhos.
- Falha de cleanup permanece visível e pode ser tentada novamente; não desfaz o resultado entregue.
- Preservar artefatos de trabalhos bloqueados, cancelados ou com PR fechado sem merge até limpeza explícita.
- Remover ambiente de execução não apaga histórico lógico, referências, revisões ou decisões.
- Reter logs detalhados e sessões por 30 dias por padrão, com configuração; manter resumo até exclusão explícita.
  A retenção não deve apagar contexto necessário à retomada de trabalhos ainda abertos ou contrariar a preservação dos artefatos acima.
- Não publicar logs ou sessões automaticamente no GitHub e evitar registrar credenciais.

## 6. Requisitos não funcionais

### RNF-01 — Durabilidade e reconciliação

A fábrica deve persistir estado suficiente para recuperar ticket, versão da especificação, fila, branch/worktree,
PR, sessão/contexto disponível, revisões, perguntas, tentativas e última fase confirmada.
Uma sessão compatível pode ser retomada ou substituída por outra com o contexto recuperado.
Não há promessa de continuar na mesma instrução de CPU ou preservar raciocínio interno do modelo.

Após crash, reconciliar o estado persistido com GitHub, processos e artefatos locais antes de publicar ou lançar substitutos.
Operações externas parcialmente concluídas exigem descoberta do resultado, evitando PRs, perguntas e escritores duplicados.
O critério é o efeito observável seguro após recuperação, não uma promessa genérica de execução exatamente uma vez.

### RNF-02 — Isolamento mínimo e credenciais

- Restringir filesystem, processos, credenciais e recursos ao mínimo necessário ao trabalho.
- Não expor amplamente o diretório pessoal, credenciais do operador ou configurações globais da máquina.
- Permitir rede necessária para GitHub, modelos, páginas públicas e dependências.
- Não disponibilizar poderes de administração, merge, push na branch-base ou produção ao worker.
- Acesso a Docker deve ser explicitamente considerado na avaliação de isolamento; não presumir que uma sandbox de processo o contenha.
- Identificar recursos de integração por trabalho. Repositórios com portas, volumes ou nomes fixos incompatíveis com paralelismo
  precisam de adequação explícita; a fábrica reporta a incompatibilidade em vez de reescrever seus testes implicitamente.
- A instalação não é uma plataforma segura para código adversarial. Limitações residuais devem ser documentadas.

### RNF-03 — Observabilidade e auditoria

A CLI deve mostrar, por trabalho: ticket, repositório, branch, PR, estado, motivo de bloqueio/espera, fase,
execução ativa, duração, última atividade, logs, tentativas, correções, perguntas, validações, revisões e cleanup.
Mostrar globalmente slots, filas, bloqueios e falhas de comunicação com serviços externos.

Registrar transições com correlação ao trabalho/execução, modelo e configuração utilizados.
Uso e custo devem ser exibidos quando mensuráveis, com indicação explícita de indisponibilidade; revisores integram o consumo observado.
Não exigir acesso ao raciocínio interno dos modelos.

### RNF-04 — Acompanhamento externo

Usar polling configurável, com padrão de 60 segundos em condições normais.
Respeitar limites de API, aplicar espera progressiva quando necessário e reconciliar após reinício.
Não prometer detecção instantânea nem confundir falha de consulta com ausência de eventos ou sucesso.

### RNF-05 — Controle previsível

O workflow controla estados, fila, autorização, limites, disparos e recuperação por regras explícitas.
Os agentes decidem como implementar e investigar, mas não podem ampliar seus próprios poderes ou ignorar o controle da fábrica.
Modelos de builder, Standards e Spec são configuráveis por papel, sem fallback silencioso.

## 7. Estados e resultados observáveis

Esta tabela define distinções de produto; não impõe um schema ou uma máquina de estados específica.
Espera, bloqueio e categoria de fila devem permanecer distinguíveis mesmo quando se sobrepõem.

| Condição | O que o operador deve entender |
| --- | --- |
| Aguardando dependência | Trabalho ainda não pode executar; bloqueadores identificados. |
| Enfileirado | Elegível, sem execução ativa; categoria e ordem visíveis. |
| Executando | Builder ativo, com fase e última atividade. |
| Aguardando resposta | Pergunta publicada, identificada e sem slot ocupado. |
| Aguardando CI | PR existente, resultados ainda pendentes; sem slot ocupado. |
| Pronto / aguardando revisão ou merge | Condições atuais atendidas; decisão humana pendente. |
| Reparo pendente | Motivo registrado e categoria prioritária. |
| Bloqueado ou suspenso | Limite, autorização, configuração ou informação impede avanço; ação necessária indicada. |
| Cancelado / fechado sem merge | Não entregue, sem retomada automática, artefatos preservados. |
| Entregue | Merge confirmado, independentemente de cleanup ainda pendente. |

## 8. Critérios de aceite

Os cenários abaixo devem ser demonstrados antes de considerar o MVP aceito.
Falhas de infraestrutura podem ser injetadas de forma controlada; a utilidade também deve ser validada com tickets reais.
A seleção dos repositórios-piloto e a execução das provas são trabalho posterior, não resultados já obtidos por este PRD.

| ID | Cenário e resultado verificável | Requisitos principais |
| --- | --- | --- |
| CA-01 | Ticket autorizado passa por implementação, dois reviews, PR draft, prontidão, merge humano e cleanup. | RF-01, RF-05–08, RF-14 |
| CA-02 | Dependência nativa bloqueia a execução; conclusão válida libera; dados inacessíveis e fechamento não conclusivo não liberam. | RF-02 |
| CA-03 | Concorrência três executa três builders, dois no mesmo repositório, sem compartilhar worktree/branch nem duplicar escritores. | RF-03–04 |
| CA-04 | Conflito e falha de check obrigatório geram reparos antes de trabalhos novos, sem preempção e com eventos duplicados consolidados. | RF-03, RF-09 |
| CA-05 | Pergunta libera slot; resposta autorizada e correlacionada retoma; comentário não autorizado não desbloqueia. | RF-03, RF-10 |
| CA-06 | Crash durante execução e após push, criação de PR ou publicação de pergunta recupera o resultado sem duplicar efeitos ou escritores. | RF-04, RF-08, RF-10, RNF-01 |
| CA-07 | Cancelamento, esgotamento de limites e falha de cleanup deixam resultados explícitos e operáveis, preservando trabalho não entregue. | RF-12–14 |
| CA-08 | Testes de integração dos repositórios-piloto criam containers simultaneamente, sem colisão de recursos entre trabalhos. | RF-07, RNF-02 |
| CA-09 | Rebase segue a política do repo; mudança remota concorrente faz o lease falhar sem sobrescrever a atualização humana. | RF-09 |
| CA-10 | Retirar elegibilidade, fechar issue ou fechar PR não provoca nova execução ou conclusão indevida; repetição do polling não duplica trabalho. | RF-01, RF-11 |
| CA-11 | Sem timeout configurado não há corte fixo de 60 minutos; timeout do repo bloqueia; esperas externas não consomem tempo/slot. | RF-03, RF-13 |
| CA-12 | Revisão indisponível e validação não executada não são apresentadas como sucesso; CLI explica o bloqueio e seu histórico. | RF-06–07, RNF-03 |

## 9. Métricas de avaliação do piloto

- Tempo entre elegibilidade, início, abertura de PR, prontidão e merge, separando espera de execução.
- Quantidade de intervenções humanas, perguntas, correções e retomadas operacionais por trabalho.
- Trabalhos entregues, bloqueados, cancelados e fechados sem merge, com respectivos motivos.
- Utilização de slots, espera nas filas e impacto da prioridade de reparos.
- Uso/custo quando disponíveis, incluindo revisores.
- Recuperações bem-sucedidas, duplicações de efeitos e falhas de cleanup.

Não fixar uma taxa de sucesso, custo-alvo ou prazo de resolução arbitrários antes do piloto.
Abrir PR não é, isoladamente, evidência de qualidade; merge e avaliação humana também informam o resultado.

## 10. Evolução prevista

Preservar a possibilidade de adicionar Jira e outros trackers e novos backends de sandbox,
sem exigir um sistema genérico de plugins no MVP.
A autorização e o repositório-alvo devem permanecer distinguíveis da representação específica do tracker.

Execução distribuída, SaaS, webhooks e UI web não são compromissos desta versão.
A evolução não autoriza enfraquecer limites, revisão humana, auditoria ou isolamento sem revisão explícita do produto.

## 11. Riscos

A prioridade de reparos pode prolongar a espera de trabalhos novos sob carga contínua de falhas.
Esse efeito deve ser observável; o MVP mantém a prioridade aprovada, sem introduzir uma política de justiça diferente implicitamente.
Sem timeout configurado, uma execução pode ocupar um slot indefinidamente; última atividade, logs e cancelamento são os controles previstos.
Retenção de artefatos não entregues exige acompanhamento de espaço disponível e limpeza explícita pelo operador.

## 12. Referências e limites da evidência

- [GitHub — Creating issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies).
- [GitHub — REST issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies).
- [GitHub — Dependencies on issues, disponibilidade geral](https://github.blog/changelog/2025-08-21-dependencies-on-issues/).
- [GitHub — Closing an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/closing-an-issue).
- [GitHub — REST issues](https://docs.github.com/en/rest/issues/issues#update-an-issue).

As fontes oficiais consultadas documentam relações nativas, leitura por API, disponibilidade em planos GitHub.com
Free, Pro, Team e Enterprise Cloud, e limite de 50 relações por tipo por issue.
A consulta não confirmou escopo cross-organization, garantias de preservação da relação ao fechar/reabrir,
semântica completa de satisfação automática nem versões mínimas de Enterprise Server.
Esses pontos não devem ser presumidos.

A inspeção das skills locais mostrou que `/pr` orienta a descrição, que a revisão precisa cobrir alterações ainda não commitadas
quando aplicável e que há pontos de pergunta humana a integrar.
Essas observações justificam RF-06 e RF-10, mas não estabelecem as versões finais das skills nem impõem um runtime.
