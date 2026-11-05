# Definir estados, filas, persistência e reconciliação dos efeitos

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Context: sessão `01a1a34c-76da-72a8-8dc8-48e80b313497`; branch `plan/software-factory-state-effects`; worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-state-effects`. Integração dos registros em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`; sem publicação de `main`.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 01, 02, 05

## Question

Como representar e atualizar trabalho, execução, elegibilidade, filas, perguntas, revisões e efeitos externos para cumprir o PRD com recuperação segura?

Usar a estratégia de durabilidade e autoridade já decididas. Definir entidades/identificadores, esquema lógico e limites transacionais, estados ortogonais (entrega, espera/bloqueio, categoria de fila), FIFO/prioridade e retomadas, exclusão de escritores, limites separados de correção e falha operacional, cancelamento e tratamento de efeitos parcialmente concluídos.

Para push, criação/conversão de PR, pergunta e cleanup, definir intenção, identidade observável, confirmação e reconciliação; não prometer exactly-once sem mecanismo. Explicitar remoção/renovação de elegibilidade, PR desconhecido/humano, mudança humana de branch/escopo, respostas correlacionadas e operações CLI que autorizam retomadas. Não basta renomear os estados do PRD.

A resposta deve conter transições/invariantes e exemplos de crash/cancelamento, indicar armazenamento concreto e migrações mínimas, e graduar detalhes dependentes do runtime/isolamento para decisões posteriores quando necessário. Desenhar, não implementar.

## References

- [Escolher a estratégia mínima de durabilidade e recuperação](02-durability-strategy.md): Pi Durable com documentos Session/tarefas e SQLite WAL/FULL; commits críticos não deferred, uma admissão por commit, intenções/fases reconciliáveis e limites RF-13 prevalecendo sobre replay/restart nativos. Concretizar schema/IDs/transações e migrações sem reabrir silenciosamente essa escolha.
- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md): concretização posterior de mensagens/recibos/evidências usando os IDs/transições definidos aqui; não criar duas fontes de autoridade.
- [PRD — Software Factory MVP](../prd.md): RF-01–04, RF-08–14; RNF-01, RNF-03–05; CA-02–07, CA-09–11.

## Comments

- Criado na cartografia aprovada; não é ticket de implementação.
- Aprovações HITL nesta sessão: Q1–Q3, Q4–Q5, Q7–Q9, Q10–Q13 e Q14–Q16 aprovadas nas respectivas rodadas.
  Q6 foi aprovada separadamente com “sim”, após esclarecer a comparação de simplicidade e o reaproveitamento da CLI existente.
- As aprovações parciais foram consolidadas no Answer abaixo. O mapa recebe somente síntese e link.
  Nenhum controlador, agente, banco, sandbox ou prova do MVP foi implementado ou executado nesta decisão.
- Validação documental da sessão: `git diff --check`; 22 tickets com status/tipos/labels e Answers consistentes,
  dependências existentes e sem ciclos; 181 referências locais verificadas; fronteira recalculada e névoa graduada sem duplicação.
  Essas checagens não são testes de execução do MVP.

## Answer

### Escolha e limites

Adotar registros de domínio explícitos, dimensões ortogonais de estado e fases reconciliáveis no domínio transacional
Pi Durable/SQLite já aprovado. Não adicionar segundo banco, event sourcing, broker, publicador mediado ou motor genérico próprio.
O histórico registra o que ocorreu, mas não precisa ser reproduzido para reconstruir a autoridade corrente.

O controlador é o único proprietário da escrita de controle, com lock exclusivo local por armazenamento.
Execução em primeiro plano ou serviço opcional segue o [contrato operacional](21-installation-operations-contract.md#alcance-e-instalação-autocontida);
a supervisão systemd dos ambientes permanece obrigatória.
Uma segunda inicialização não pode operar o mesmo storage. A CLI envia comandos ao proprietário; não altera diretamente o banco.
O lock não mata workers nem protege GitHub: após crash, encerrar sobreviventes próprios e confirmar cessação antes de substitutos,
conforme [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](07-isolation-choice.md).

### Identidades e esquema lógico

IDs internos de Trabalho, Execução, Pergunta e Efeito são opacos e estáveis; não derivar identidade somente de título, URL ou número.
Guardar identidades GitHub de repositório, issue, PR e autores junto dos nomes/números/URLs usados na apresentação.
Referências externas e dados do agente não concedem autorização por si mesmos.

Os registros abaixo são o esquema lógico de documentos/tarefas da autoridade, não uma segunda base SQL paralela nem nomes de APIs privadas.

| Registro | Chave e campos mínimos |
| --- | --- |
| Instalação | Identidade/versão do estado; pausa de admissão; sequências FIFO; índice Ticket → Trabalho vigente e ciclos anteriores; referências de configuração |
| Trabalho | `work_id`, Ticket/repositório/base, predecessor, resultado, suspensão de autorização, impedimentos, admissão original, categoria/posição de fila, correção pendente, Execução vigente, branch/workspace/ambiente, PR, referências remotas conhecidas, limites/consumos/reservas, spec/perfil/contexto, prontidão e cleanup |
| Execução | `execution_id`, Trabalho, motivo inicial/continuação/reparo/recuperação, correção associada quando houver, fase, reserva de Slot/orçamento, evidência de início, duração/atividade, cessação/resultado, referências de sessão/revisores/validações |
| Pergunta | `question_id`, Trabalho/Execução de origem, conteúdo/contexto, destino issue/PR, Efeito de publicação/comentário observado, situação e única resposta aceita com autor/origem |
| Efeito externo | `effect_id`, Trabalho/Execução quando aplicável, operação/alvo, intenção e referências esperadas, fase, observações/recibos e resultado confirmado ou ambiguidade |
| Histórico | Transição/comando, correlações, origem/autor autorizado, identidade de ingresso quando disponível, antes/depois relevante e motivo; referências de evidências |

Uma correção tem identidade persistente dentro do Trabalho para ligar suas ativações, eventos consolidados, posição de fila e cobrança.
É um registro técnico de controle, não novo sinônimo para Execução: cada ativação continua sendo uma Execução conforme o PRD.
Logs, sessões SDK, relatórios e artefatos são referenciados; não decidem autorização, Slot, contadores ou resultado por conta própria.

### Dimensões e invariantes

Manter separadamente:

- **Resultado:** em aberto, cancelado, PR fechado sem merge ou entregue. Merge confirmado é fato de entrega mesmo durante cancelamento.
- **Autorização/impedimentos:** retirada de autorização, dependências, pergunta, configuração, limites, concorrência humana e ambiguidade
  podem coexistir. Resolver um não apaga os demais. Espera normal não é automaticamente falha operacional.
- **Fila:** categoria normal/reparo, posição persistente e trabalho pendente; não confundir estar ordenado com poder executar agora.
- **Execução:** reserva, início/atividade/fase, interrupção e cessação são fatos distintos; reserva não prova spawn e pedido de parada não prova morte.
- **Prontidão:** evidências atuais de conteúdo/spec/reviews/gates/checks/conflito, independentes de existir PR ou estar entregue.
- **Cleanup:** recursos pendentes/removidos/falhos, independente do resultado de entrega.

Invariantes obrigatórios:

1. No máximo um ciclo vigente por Ticket, incluindo Trabalho bloqueado ou com PR fechado sem merge.
   O índice mantém memória dos ciclos encerrados; permanência da label não cria novo Trabalho após entrega/cancelamento.
2. No máximo uma Execução escritora por Trabalho/workspace/branch. Mensagem atrasada de outra Execução não altera a reserva vigente.
3. Reserva de capacidade, autorização de despacho e orçamento precisam de commit confirmado antes de iniciar efeitos de execução.
4. Não liberar Slot enquanto a Execução/atividades associadas ainda puderem permanecer ativas ou sua cessação for incerta.
   Revisões internas ocupam o mesmo Slot, sem execução simultânea do Builder e sem Slots adicionais para revisores.
5. Espera externa confirmada por resposta, CI ou merge não ocupa Slot. Trabalho impedido não bloqueia seleção de outros.
6. Entregue requer merge confirmado; pronto requer avaliação do controlador, não texto do agente ou flag isolada no GitHub.
7. Cancelamento impede novos disparos/publicações/renovações; efeitos já enviados podem terminar e precisam ser reconciliados.
8. Nenhum replay, resposta, push ou evento repetido zera contadores ou substitui autorização humana.

### Transações e armazenamento concreto

Usar SQLite local em WAL e `synchronous=FULL` na autoridade Pi Durable; manter a exigência de versão SQLite corrigida e adapter público
estabelecida em [Escolher a estratégia mínima de durabilidade e recuperação](02-durability-strategy.md).
Não tratar progresso deferred, callback ainda não confirmado ou sessão SDK como commit durável.
As leituras precedem as escritas conforme o contrato escolhido, e cada admissão usa um commit próprio.

| Fronteira atômica | O que confirmar junto |
| --- | --- |
| Admitir Trabalho | Ausência de outro ciclo vigente, autorização/observações válidas, criação do Trabalho, vínculo no índice e sequência de admissão |
| Admitir Execução | Elegibilidade/dependências/impedimentos revalidados, posição/categoria, capacidade, identidade da Execução, referência vigente, reserva de Slot e eventual orçamento, tarefa/intenção de despacho |
| Confirmar início | Evidência correlacionada à Execução vigente, consumo da reserva de orçamento aplicável e transição de fase |
| Registrar pergunta | Pergunta, impedimento e intenção de publicação; suspensão/Slot só se confirmam segundo as evidências de cessação |
| Aceitar resposta/comando | Autenticação/correlação e deduplicação, resposta/transição autorizada, histórico e pendência de fila; sem disparo direto |
| Interromper/cancelar | Pedido, proibição de novos disparos/renovações/publicações e intenções de interrupção; confirmação física ocorre depois |
| Confirmar efeito/cessação | Observação correlacionada, resultado/fase, reservas liberáveis e histórico correspondente |

GitHub, spawn, arquivos de workspace, VM e memória do modelo ficam fora dessas transações.
Abrir estado/restabelecer registry não autoriza despacho antes da reconciliação de boot.
Mensagens e comandos repetidos não reaplicam a mesma transição: conferir identidade de origem quando disponível, fase e Execução vigente.
O [protocolo controlador–worker](15-controller-worker-protocol.md) concretiza recibos, transporte e evidências, sem criar autoridade concorrente.

### Filas, autorização e ciclos

- Fila normal usa sequência original de admissão do Trabalho; preservá-la após pergunta/espera.
- Cada nova correção pendente recebe sequência de reparo. Eventos consolidados e retomadas dessa correção preservam a posição.
  Uma correção posterior, depois de encerrada a anterior, recebe outra sequência.
- Reparos precedem a fila normal; FIFO dentro de cada categoria, sem preempção, mutex global por repositório ou política extra de justiça.
- Trabalho temporariamente impedido é ignorado sem perder posição. Reserva ainda incerta continua conservando capacidade até reconciliação.
- Revalidar autorização/dependências antes de iniciar ou retomar; consulta incompleta não significa ausência de bloqueadores.
  O escopo de compatibilidade fica em [Definir o escopo suportado e a validação das dependências nativas](09-dependency-compatibility.md).
- Retirada observada da label ou fechamento da issue suspende novos disparos, sem matar implicitamente a Execução ativa.
  Recolocar label ou reabrir issue não remove a suspensão: usar o comando existente de retomada, com requisitos atuais satisfeitos.
- Pausa global só impede novos disparos. Despausar não remove suspensão de autorização ou qualquer outro impedimento de um Trabalho.
- Depois de entrega/cancelamento, somente comando explícito cria outro Trabalho, ligado ao anterior, com outra identidade e recursos próprios.
  Após cancelamento, confirmar interrupção e reconciliar efeitos pendentes antes de admitir o novo ciclo; cleanup prévio não é obrigatório.
- PR aberto de um ciclo cancelado requer decisão do operador antes de nova admissão. Não adotar, fechar ou substituir silenciosamente.

A CLI precisa permitir listar/inspecionar, pausar/despausar admissão, cancelar, responder, autorizar retomada/nova tentativa,
conceder orçamento adicional com histórico, solicitar novo Trabalho e cleanup explícito.
Essas são operações semânticas; a sintaxe/distribuição não foi escolhida aqui.
Não há comando que signifique ignorar todos os impedimentos: cada ação registra o que autorizou, revalida e volta à fila.

### Limites, falhas e tempo

Padrões: até três correções automáticas por Trabalho e até três retomadas operacionais recuperáveis, em contagens separadas/configuráveis.
Não cobrar cada edição/teste do Builder nem cada evento de CI. Uma correção mantém identidade entre suas ativações:
pergunta/resposta ou recuperação não cobram outra correção; recuperação pode consumir retomada operacional.
Novos pushes, polling, respostas e reinícios não zeram o histórico; concessões adicionais são explícitas e auditáveis.

Reservar orçamento atomicamente na admissão e consumi-lo quando houver início confirmado.
Se houver confirmação de que não começou, liberar sem consumo. Se o início for incerto, manter a reserva até reconciliar:
nem devolver tentativa nem lançar substituto às cegas. Falha anterior ao início não pode virar evidência falsa de execução.

| Situação | Tratamento |
| --- | --- |
| Falha transitória de modelo/transporte/worker interrompendo Execução | Reconciliar, confirmar cessação e, se autorizado/com orçamento, admitir retomada operacional |
| Retomadas operacionais padrão | Esperas persistidas/configuráveis de 5, 15 e 45 segundos; espera maior indicada pelo serviço prevalece |
| Falha de autorização/configuração, timeout ou propriedade incerta | Bloquear; não repetir automaticamente |
| Falha de polling, consulta de reconciliação ou publicação de pergunta | Recuperar acompanhamento/operação segura ou reconciliada, sem lançar builder nem consumir orçamento de retomada operacional |
| Esgotamento | Bloqueio visível com motivo/ação necessária; nova concessão não apaga tentativas anteriores |

**Continuação após parada administrativa limpa:** conforme aprovação em
[Revisar a composição da arquitetura e suas fronteiras](23-architecture-cross-review.md), motivo administrativo durável e cessação confirmada
encerram a ativação sem consumir retomada operacional só pela parada. A continuação é nova Execução, admitida pela fila/categoria/posição
já existentes, preservando identidade e cobrança da correção quando houver. Não adotar processo vivo, cobrar outra correção pela continuação,
zerar contadores ou remover pausa, autorização suspensa ou outros impedimentos. Timeout atingido permanece bloqueio; evidência temporal
incerta segue o protocolo. Crash/parada incerta permanece recovery, não se torna parada limpa apenas por haver uma intenção administrativa.

Não repetir POST ambíguo sob o rótulo de retry operacional. Eventos repetidos não antecipam espera persistida nem renovam orçamento.
O retry SDK/provider permanece desabilitado conforme a decisão de runtime.

Timeout opcional/configurável é **por Execução**, incluindo implementação, comandos e revisões internas.
Espera externa encerra atividade, sem consumir tempo/Slot; a ativação seguinte tem novo relógio e preserva contadores/correção.
Não introduzir segundo teto acumulado por Trabalho/correção. Timeout atingido interrompe e bloqueia, sem nova ativação automática
para renovar o tempo. Sem configuração, não existe corte fixo; duração e última atividade permanecem observáveis.
Medição/recuperação das evidências temporais são concretizadas no protocolo, sem usar reinício como prova de duração zero da Execução anterior.

### Perguntas, respostas e contexto

Persistir pergunta/intenção antes de anunciar registro durável. Encerrar atividade e confirmar cessação antes de liberar Slot;
publicação e resposta podem ser descobertas durante recuperação. O identificador estável acompanha comentário e comando de resposta.

Aceitar uma resposta por Pergunta: a primeira autenticada, correlacionada e confirmada duravelmente pelo controlador.
Isso é ordem de aceitação durável, não promessa de ordenar globalmente comentários pela hora em que foram escritos.
Duplicatas não reaplicam; respostas concorrentes posteriores ficam não aplicadas, sem substituir a aceita.
Correção/esclarecimento exige nova Pergunta. Resposta insuficiente não concede aprovação genérica.

Aceitar somente operadores GitHub autorizados ou CLI sob a confiança da conta administradora.
Resposta remove apenas seu impedimento; não renova autorização, orçamento ou outros requisitos.
Resposta tardia não reativa Trabalho entregue/cancelado. Retomada sempre passa pela fila/categoria/ordem vigente.
Mudanças de escopo exigem solicitação autorizada e versão de especificação por Execução, não atualização silenciosa por polling;
o contrato de captura fica em [Definir a captura versionada da especificação e das instruções](16-specification-snapshot-contract.md).

### Efeitos externos e reconciliação

Para efeitos conduzidos pelo controlador, manter **intenção confirmada → operação fora do commit → observação → confirmação durável**.
A exigência de intenção prévia específica para cada push/criação de PR foi revisada explicitamente pelo operador em
[Definir o protocolo de execução e retomada entre controlador e worker — publicação direta sem ferramenta adicional de intenção](15-controller-worker-protocol.md#q7--publicação-direta-sem-ferramenta-adicional-de-intenção).
Aplicar esse recorte à publicação direta pelo Builder; intenção, quando existir, e ausência de recibo não comprovam se o efeito ocorreu.
Registrar observações incompletas/ambiguidade e bloquear repetição insegura, sem gateway ou alegação de que o token obriga a conduta do agente.

| Efeito | Identidade/evidência para descoberta | Confirmação e decisão após incerteza |
| --- | --- | --- |
| Push | Repositório/ref do Trabalho, OID remoto esperado antes da preparação, commits e evidências recuperáveis das ferramentas/Git local/remoto | Consultar ref/commit; confirmar resultado compatível ou bloquear divergência desconhecida. Lease só com expectativa preservada, nunca recaptura cega |
| Criar PR draft | Trabalho/Ticket/branch/base, identidade GitHub e identificador estável de correlação | Descobrir candidato próprio antes de repetir; registrar o existente. Múltiplos candidatos/identidade incerta bloqueiam; erro/incompletude de consulta não prova ausência |
| Converter prontidão | PR próprio e evidências do conteúdo/spec/reviews/gates/checks/conflito avaliados | Reconsultar PR e revalidar evidências; flag ready isolada não confirma prontidão. Algoritmo/invalidação pertencem ao contrato de prontidão |
| Publicar pergunta | `question_id`, destino issue/PR e marcador estável no comentário | Descobrir publicação antes de republicar, guardar identidade do comentário e aceitar resposta correlacionada uma vez |
| Cleanup | Identidade/ownership e localização de cada recurso do Trabalho, intenção individual de remoção | Ausência confirmada encerra aquela remoção; falha/ownership incerto fica visível. Não inferir cleanup global pelo êxito de um recurso |

Alteração remota não atribuível à fábrica por evidências recuperáveis impede a próxima escrita até reconciliação autorizada; não exigir intenção prévia para essa atribuição.
Preservar referências conhecidas e informar divergência; apenas buscar o novo OID e usá-lo como lease não é reconciliação.
PR associado mas não reconhecido como próprio bloqueia admissão, sem adoção automática.
Não incorporar mudanças de branch/base/escopo silenciosamente.

### Cancelamento, PR fechado, entrega e cleanup

Cancelamento persiste proibição de novas ações/renovações, solicita interrupção por supervisão e preserva artefatos.
Pedido, resultado lógico e cessação são dimensões distintas. Operação enviada pode terminar depois do pedido; registrar o resultado efetivo,
sem desfazer push, fechar PR ou apagar branch automaticamente.

PR fechado sem merge mantém identidade, contadores, artefatos e exclusividade do ciclo vigente, sem retomada automática.
Fechamento não prova que a Execução ativa terminou. Não reabrir/substituir PR automaticamente;
continuação exige reabertura do mesmo PR e retomada explícita do mesmo Trabalho pela CLI.
Para abandonar e começar outro ciclo, cancelar e solicitar novo Trabalho, respeitando cessação/reconciliação.

Merge confirmado torna o resultado entregue mesmo durante cancelamento; preservar o histórico do pedido e impedir novas ações do Builder.
Cleanup exige cessação confirmada e recursos próprios identificados. Falha de cleanup não desfaz entrega.
Trabalhos não entregues preservam recursos até limpeza explícita; nunca remover base, recursos desconhecidos, de outros Trabalhos ou Docker global.
Remoção de ambiente não apaga histórico/resumo/referências/reviews/decisões. Retenção padrão de logs/sessões continua a do PRD,
sem apagar contexto de retomada; localização, redaction e execução da retenção ficam no contrato operacional correspondente.

### Transições e cortes de falha

| Evento/corte | Transição/invariante resultante |
| --- | --- |
| Polling repetido de Ticket elegível | Consultar índice; não duplicar Trabalho nem renovar ciclo entregue/cancelado |
| Reserva persistida; spawn ainda não ocorreu ou recibo sumiu | Manter identidade/Slot/orçamento reservado; descobrir início ou não início antes de confirmar consumo/liberação |
| Controlador cai com Builder/revisores vivos | Barreira de boot; encerrar sobreviventes próprios, confirmar cessação, reconciliar artefatos/efeitos e só então decidir retomada operacional |
| Push terminou, confirmação local faltou | Consultar refs/commits e evidências recuperáveis; registrar resultado atribuível sem repetir cegamente ou sobrescrever mudança humana. Ambiguidade bloqueia |
| PR criado, confirmação local faltou | Descobrir PR próprio e vincular; ambiguidade bloqueia, não cria PR adicional |
| Pergunta publicada sem confirmação; resposta chega durante recuperação | Descobrir comentário, autenticar/correlacionar e aceitar uma vez; fila só após cessação e requisitos atuais |
| Resposta chega, mas autorização foi retirada | Remover somente impedimento da Pergunta; suspensão de autorização continua até retomada explícita |
| Novos eventos do mesmo PR durante reparo | Consolidar contexto pendente sem criar escritor paralelo, cobrar evento ou deslocar FIFO da correção vigente |
| Cancelamento durante requisição GitHub enviada | Impedir novas ações, confirmar cessação e descobrir resultado; não declarar ausência de efeito nem desfazer resultado automaticamente |
| Merge humano durante cancelamento | Resultado entregue, histórico de cancelamento preservado; cleanup somente após cessação/ownership confirmados |
| PR fechado sem merge enquanto Builder ainda existe | Resultado não entregue e sem novos disparos; não confundir fechamento com morte do processo ou substituição autorizada |
| Timeout ou limite esgotado | Interromper quando aplicável e bloquear com ação necessária, sem loop de novas ativações |
| Falha parcial de cleanup | Entrega permanece; repetir somente recursos próprios pendentes após verificar seu estado |

### Migrações e fronteiras restantes

Versionar estado/schema, docs/tasks e perfil do agente/skills conforme a estratégia já aprovada.
Migração mínima: pausar admissão, confirmar parada dos escritores, validar compatibilidade, executar somente migração suportada e solicitada e preservar IDs,
índice dos ciclos, sequências, perguntas, reservas, contadores e intenções pendentes; reinstalar registry compatível e reconciliar antes de retomar.
Formato/perfil incompatível bloqueia abertura operacional; não assumir equivalência ou permitir versões concorrentes escrevendo.
Aplicar o [contrato operacional](21-installation-operations-contract.md#atualização-e-limite-de-recuperação): migração interrompida exige
recuperação definida, sem aceitar estado parcial como operacional; backup/restauração integrado está fora do MVP.
Proteção contra perda do storage é externa e não substitui reconciliação de GitHub/processos após crash.

Encaminhamentos, sem reabrir escolhas desta resolução:

- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md): mensagens, recibos,
  evidências de início/tempo/cessação, integração pública Pi Durable, rejeição de mensagens antigas e recuperação da publicação direta conforme a revisão HITL referenciada acima.
- [Definir a avaliação de checks obrigatórios e prontidão do PR](10-readiness-checks-contract.md): algoritmo, evidência e invalidação.
- [Definir a captura versionada da especificação e das instruções](16-specification-snapshot-contract.md) e
  [Definir o pacote de skills e o contrato verificável de revisão e validação](17-skills-and-review-contract.md): conteúdo, revisões e gates.
- [Definir o fluxo de manutenção e reconciliação autorizada do PR](20-pr-maintenance-contract.md): feedback relevante, reparos e concorrência humana.
- [Definir a configuração, a CLI e o ciclo operacional da instalação](21-installation-operations-contract.md): interfaces, configuração e atualização.
- [Definir observabilidade, proteção de segredos e retenção dos artefatos](22-observability-retention-contract.md): diagnóstico, redaction e retenção.

**Provas pendentes:** CA-02–07 e CA-09–12, incluindo reserva/início incerto sem cobrança/liberação indevida, FIFO após pergunta/reparo,
exclusividade após crash, push/PR/pergunta sem duplicação, respostas concorrentes, suspensão de autorização, encerramentos distintos,
limites/timeout e cleanup parcial. Incluir parada administrativa limpa repetida sem consumir retomadas por falha,
preservando fila/correção e bloqueios, e contraste com crash/parada incerta. Conferir também integração ao fluxo CA-01.
Aprovação de desenho não demonstra SQLite/FULL, SDK, GitHub, VM ou recovery reais, nem autoriza executar essas provas nesta cartografia.
