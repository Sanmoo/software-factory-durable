# Definir o fluxo de manutenção e reconciliação autorizada do PR

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão `01a1a5fb-b367-75a8-bc33-e05c210f9790`; branch `wayfinder/software-factory-pr-maintenance`; worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-pr-maintenance`; integração em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 08, 10, 15, 16, 17

## Question

Qual contrato determina o contexto de cada reparo, o tratamento de mudanças humanas e o retorno ao acompanhamento do mesmo PR,
sem duplicar correções, ampliar escopo ou sobrescrever alterações desconhecidas?

Definir seleção e consolidação do feedback ainda relevante: review humano autorizado CHANGES_REQUESTED, conflitos confirmados,
checks obrigatórios do conteúdo atual, atualização efetivamente exigida pela regra strict para permitir merge e comandos autorizados;
comentários comuns, checks opcionais e resultados antigos não disparam sozinhos.
Aplicar o [contrato de prontidão](10-readiness-checks-contract.md#answer): mero avanço da branch-base com PR apto não dispara
Execução, revisão, rebase ou draft. Strict efetivamente impeditivo gera reparo automático, sujeito a limites/autorização/lease,
sem comando adicional por ocorrência; não confundir aprovação humana pendente, CI pendente ou estado desconhecido com defeito.
Após alteração do resultado no fluxo de reparo, integrar os pareceres atuais das sessões Standards/Spec conforme o contrato responsável.
Escolher correlações/cursor ou registros de processamento que permitam polling repetido e recuperação sem perder feedback,
distinguindo evento observado, gatilho aceito, contexto entregue e tratamento confirmado pelo Builder.
Explicitar eventos que chegam durante Execução, perguntas ou recuperação, sem escritor paralelo nem cobrança por evento.

Concretizar reconciliação autorizada após mudança humana da branch, falha de lease, alteração de base ou pedido de escopo,
incluindo as evidências apresentadas ao operador e fornecidas ao Builder.
Não recapturar lease e insistir às cegas, adotar PR desconhecido, substituir PR fechado ou zerar limites.
Distinguir autorização para reconciliar conteúdo de autorização para atualizar a especificação.
Definir revalidação/invalidação de reviews, validações e prontidão, reaproveitando os contratos responsáveis sem duplicá-los.

Saída: fluxo de manutenção, registro mínimo do feedback e ações autorizadas, exemplos de concorrência/obsolescência e provas necessárias.
Desenhar, não executar reparos, alterar PRs ou implementar o controlador.

## References

- [Definir estados, filas, persistência e reconciliação dos efeitos](08-state-and-effects-contract.md).
- [Definir a avaliação de checks obrigatórios e prontidão do PR](10-readiness-checks-contract.md).
- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md).
- [Definir a captura versionada da especificação e das instruções](16-specification-snapshot-contract.md).
- [Definir o pacote de skills e o contrato verificável de revisão e validação](17-skills-and-review-contract.md).
- [PRD — Software Factory MVP](../prd.md): RF-03–06, RF-08–13; CA-04, CA-06, CA-09–10 e CA-12.

## Comments

- Graduado da névoa de manutenção após a decisão de estados e efeitos. Sem escolha de algoritmo de feedback nesta criação.
- Atualizado pela resolução de [Definir a avaliação de checks obrigatórios e prontidão do PR](10-readiness-checks-contract.md#answer):
  gatilho strict explicitamente aprovado em Q10 e nenhuma manutenção por mero avanço da base. O algoritmo de feedback/reconciliação continua aberto.
- Rodada HITL desta sessão: operador questionou se Q1 realmente propõe o mínimo viável/mais simples; Q1 permanece aberta, sem aprovação de um registro de ciclo de vida por evento. Confirmou: “De acordo para as demais”. Aprovações parciais, ainda sem resolução do ticket:
  - Q2: `CHANGES_REQUESTED` autorizado não perde relevância apenas por push posterior. Registrar tratamento ou obsolescência justificada; dúvidas passam por pergunta. Aprovação posterior/dismissal pode retirar o gatilho, preservando histórico e reavaliando demais motivos. Comentários comuns complementam contexto, sem gatilho ou autorização implícita de escopo.
  - Q3: acumular feedback novo para a próxima ativação, sem interromper/injetar instruções durante ferramentas ou revisões; reavaliar relevância antes de ativar. Durante pergunta, feedback não remove bloqueio nem responde pelo humano. Isso não posterga as regras de cancelamento, merge ou concorrência humana observada.
  - Q4: autorização de reconciliação vinculada à divergência concreta apresentada, preservando/incorporando mudanças humanas por padrão. Mostrar referências anterior/remota/local, identidade de branch/PR e incertezas. Nova divergência remota exige nova avaliação/autorização; descarte exige autorização específica. Não recapturar lease e repetir cegamente, alterar spec ou renovar orçamento implicitamente.
  - Q5: troca da branch-alvo bloqueia continuação automática; operador restaura a base esperada ou autoriza a nova, compatível com a configuração. Reavaliar instruções/comparação/reviews/checks afetados, sem mudança silenciosa de escopo. Avanço normal da mesma base conserva a regra de ausência de manutenção sem impedimento efetivo.
- Q1 reformulada aprovada pelo operador (“de acordo”): reaproveitar Trabalho/correção/Execução, sem máquina de estados por evento, histórico de cada polling, registro individual de descartes, fila adicional ou ACK próprio de consumo. Consolidar motivos atuais na correção pendente; preservar identidade/versão do feedback acionável, contexto usado por Execução e referências de tratamento nos registros/artefatos existentes. Checks/conflitos são reavaliados pelo estado atual; pedidos humanos exigem memória do tratamento. Recuperação usa contexto/sessão/resultado/Git reconciliados; incerteza não vira confirmação e pode exigir bloqueio, sem protocolo novo para eliminar toda ambiguidade. Esta aprovação substitui a proposta inicial de Q1.
- Rodada final HITL: operador confirmou “de acordo com as recomendações” para Q6–Q8, sobre encerramento da correção, discordância de pedido humano e prevenção de tentativas sem motivo novo. Resolução consolidada abaixo; nenhuma implementação ou prova real executada.

## Answer

### Escolha e limite de complexidade

Reutilizar os registros de Trabalho, correção e Execução da autoridade já aprovada, sem máquina de estados por evento,
fila adicional, broker, histórico de cada polling, registro individual de descartes ou ACK específico de consumo de feedback.
Distinguir observação, aceitação, entrega de contexto e tratamento é uma obrigação de interpretação das evidências,
não quatro estados novos que cada evento deva percorrer.

O controlador decide autorização, elegibilidade, consolidação, fila e prontidão; o Builder interpreta o pedido,
trata feedback e preserva evidências. Não introduzir avaliador semântico de correções no controlador.
Aceitar bloqueio explícito quando a recuperação for inconclusiva, em vez de acrescentar protocolo para eliminar toda ambiguidade.

Esta decisão complementa, sem substituir, os contratos de
[estados e efeitos](08-state-and-effects-contract.md#answer),
[prontidão](10-readiness-checks-contract.md#answer),
[protocolo controlador–worker](15-controller-worker-protocol.md#answer),
[especificação](16-specification-snapshot-contract.md#answer) e
[skills e revisão](17-skills-and-review-contract.md#answer).

### Contexto e memória mínimos

| Necessidade | Registro existente e conteúdo mínimo |
| --- | --- |
| Motivo atual de manutenção | Correção pendente do Trabalho: motivos consolidados e referências pertinentes de PR/head/base/check/review/comando |
| Evitar repetir pedido humano | Identidade/origem e versão do feedback acionável, autor autorizado e referência ao tratamento; preservar o conteúdo necessário à retomada, não apenas URL mutável |
| Saber o que foi fornecido | Contexto identificado associado à Execução, com feedback selecionado e referências aos artefatos existentes |
| Saber o que foi tratado | Resultado/artefato do Builder ligado ao feedback: tratamento e evidência, ou dúvida/impedimento explícito |
| Recuperar atividade incerta | Sessão, contexto da Execução, resultado e Git/PR reconciliados, conforme o protocolo existente |

Identidade/versão distingue repetição da mesma entrada de alteração efetiva do pedido. Comandos/respostas continuam usando
a deduplicação e autenticação do ingresso já aprovadas. Um push não torna um review humano automaticamente obsoleto.
Não depender apenas de um cursor temporal para afirmar que todo feedback foi processado: reavaliar o estado pertinente do PR,
com consultas completas segundo o contrato de prontidão, e confrontar pedidos humanos com os tratamentos preservados.
Não exigir histórico de todas as versões observadas/descartadas nem varrer novamente todo o histórico da instalação.

Checks/conflitos são principalmente condições atuais: correlacionar requisito, origem, SHA e tentativa conforme o avaliador existente.
Reobservar o mesmo resultado antigo não cria outra correção. Pedidos humanos exigem memória de tratamento, inclusive após
substituição de sessão; transcript sozinho não é a autoridade dessa memória.
Associação de contexto à Execução não comprova consumo pelo modelo; relato de tratamento não comprova sucesso de CI/publicação.

### Seleção de feedback e autoridade humana

Aplicar exclusivamente os gatilhos aprovados: conflito confirmado, falha obrigatória pertinente, atualização strict efetivamente
impeditiva, review humano autorizado `CHANGES_REQUESTED` e comando explícito autorizado.
Mero avanço da base, comentário comum, check opcional, resultado de SHA antigo, aprovação humana pendente,
CI pendente ou conflito indeterminado não disparam reparo sozinhos.
Comentários relevantes podem complementar o contexto; bots, terceiros ou conteúdo consultado não concedem autorização.

Ao iniciar/retomar, reunir o conjunto de feedback ainda relevante, não somente o evento inicial.
`CHANGES_REQUESTED` sobre commit anterior permanece considerado até tratamento explícito ou evidência de perda de relevância.
Aprovação posterior/dismissal pode retirar o gatilho correspondente; preservar o histórico e reavaliar os outros motivos,
sem concluir que um review remove pedidos independentes ou que a fábrica satisfez requisitos humanos de merge.

O Builder pode registrar pedido já atendido ou não mais aplicável, com evidência.
Se discordar realmente de um pedido humano autorizado, considerá-lo incompatível com o pedido ou não conseguir atendê-lo,
usar `ask user`, não apenas marcar como não acolhido. A liberdade de não acolher achados internos com justificativa
não se estende automaticamente ao review humano. Ambiguidade de requisito passa por pergunta.
Nenhum tratamento declarado dispensa gate/check ou autoriza alterar a especificação.

### Fluxo da correção e eventos concorrentes

1. Consultar identidade/estado do PR próprio e condições atuais. Encerramentos, retirada de autorização, dependências,
   pergunta, concorrência e limites seguem suas regras; leitura incompleta não é ausência de impedimento.
2. Havendo gatilho relevante, criar ou atualizar a correção pendente no Trabalho, consolidando motivos.
   Manter identidade e sequência FIFO da correção existente; não cobrar por evento, push ou polling.
3. Antes da ativação, revalidar motivos, autorização, dependências, exclusividade e orçamento pelos contratos existentes.
   Se todos os motivos desapareceram antes do início, retirar a correção pendente sem consumir tentativa;
   reserva/início incerto segue reconciliação, não liberação presumida.
4. Fornecer contexto identificado à Execução. Sessão compatível recebe `continue` com feedback/motivo;
   substituta recebe referências de recuperação. Não reiniciar `implement` nem recapturar a spec por conveniência.
5. Builder trata os itens, registra resultado/impedimentos, executa os gates/reviews aplicáveis e publica quando necessário.
   Alteração humana desconhecida e falha de lease interrompem a próxima escrita até reconciliação autorizada.
6. Feedback novo durante ferramentas/revisões fica acumulado para a próxima ativação, sem injeção ou interrupção por esse motivo.
   Reavaliá-lo antes da ativação: um problema já eliminado não precisa provocar outro reparo.
7. Se chegou antes do encerramento da correção e ainda não foi tratado, permanece na mesma correção,
   conservando posição e cobrança entre ativações. Só retomar após cessação e nova admissão autorizada pela fila.
8. Encerrar a correção quando houver tratamento registrado, reviews/gates aplicáveis concluídos,
   publicação reconciliada quando necessária e devolução de controle com cessação confirmada,
   sem feedback relevante ainda pendente dessa correção.
9. Voltar ao acompanhamento do mesmo PR. Não esperar CI remoto terminar para encerrar a correção:
   correção encerrada não equivale a PR pronto. Nova falha pertinente posterior pode criar nova correção,
   com nova sequência FIFO e consumo de orçamento, sem zerar o histórico.

O registro de encerramento e a incorporação de feedback são decisões duráveis do controlador;
a ordem observada/confirmada define se o item entrou na correção ainda aberta ou exige outra.
Não prometer uma ordem global de eventos GitHub nem considerar conhecido um evento ainda não observado.

Durante espera por pergunta, feedback não responde pelo operador nem remove o impedimento; acompanha a retomada autorizada.
Durante recuperação, reconciliar primeiro ownership, atividade e efeitos, depois selecionar o feedback pertinente.
Acumular feedback não posterga cancelamento, merge, encerramentos ou bloqueio de escrita por concorrência humana.
Nenhuma dessas situações autoriza segundo escritor ou retenção de Slot durante espera externa confirmada.

### Limites e ausência de progresso

As ativações de uma mesma correção mantêm sua identidade e cobrança; pergunta/resposta não cobra outra correção,
e recuperação operacional usa o contador separado existente quando aplicável.
Se, depois do início confirmado, o Builder verificar que nada precisa mudar, registrar a razão e concluir:
o início continua contando, mesmo sem alteração ou publicação.

Se um problema conhecido permanece sem solução, apresentar impedimento e pedir orientação.
Não devolver o controle para o polling gastar novas tentativas sobre exatamente a mesma falha já declarada insolúvel.
Uma falha pertinente do resultado novo, após correção publicada, pode justificar outra correção dentro do limite;
reobservar o resultado antigo ou o mesmo pedido já tratado não justifica isso.
Novas tentativas/concessões humanas preservam histórico e revalidam os demais impedimentos; não significam autorização genérica.

### Reconciliação de conteúdo, lease e base

Alteração remota não atribuível à fábrica por evidências recuperáveis, inclusive falha de lease,
impede a próxima escrita. Preservar trabalho local, expectativa remota anterior e evidências da divergência.
Não recapturar o remoto como lease e insistir, nem supor autoria pelo nome da branch.

Apresentar ao operador e preservar para o Builder:

- Identidades de Trabalho, repositório, branch e PR próprios.
- Referência anteriormente conhecida/esperada, referência remota atual e resultado local preservado.
- Diferenças e evidências recuperáveis da mudança, autoria quando comprovável e incertezas remanescentes.
- Reconciliação proposta e a autorização concreta aceita, com autor/origem/correlação.

Padrão aprovado: preservar e incorporar mudanças humanas. Descartá-las exige autorização específica.
A autorização vale para a divergência apresentada; mudança remota adicional antes da publicação exige nova avaliação/autorização.
Depois de reconciliação autorizada, preservar a expectativa correspondente e usar lease explícito na branch do Trabalho,
conforme o protocolo de publicação direta. Não acrescentar ferramenta de intenção, wrapper Git ou publicador mediado.
Proibição de `--force`, reescrita da base, adoção de PR desconhecido e substituição automática de PR fechado permanece.
PR fechado sem merge segue reabertura do mesmo PR e retomada explícita, ou abandono/novo ciclo conforme o contrato de estados.

Distinguir avanço da mesma base de troca da branch-alvo:

- Avanço normal só causa manutenção por conflito/strict efetivamente impeditivo ou outro gatilho aprovado;
  rebase permanece o padrão salvo estratégia do repositório.
- Troca da branch-alvo bloqueia continuação automática. Operador restaura a base esperada ou autoriza a nova,
  compatível com a configuração do repositório. Reavaliar comparação, instruções, reviews e checks afetados.

Reconciliação de conteúdo/base não renova orçamento nem autoriza novo escopo.
Se a mudança também exige alterar o pedido, obter autorização específica conforme o contrato de especificação;
a mesma resposta pode autorizar a mudança concreta quando explícita e correlacionada, sem segundo comando obrigatório.
Preservar nova versão na Execução seguinte antes de implementar, sem apagar a anterior ou aceitar edições futuras do link em bloco.

### Revisão, prontidão e recuperação

Após mudança relevante no resultado/contexto, ambos os revisores emitem parecer atual conforme o contrato de skills,
preferindo sessões compatíveis retomadas. Gates e checks precisam corresponder ao conteúdo/SHA pertinentes.
Não duplicar algoritmo de invalidação nem inferir aprovação pela memória da sessão; conservar apenas as exceções já aprovadas
para commit de conteúdo idêntico e recuperação parcial de parecer com contexto inalterado.
Aplicar a política existente de perda/restauração de prontidão e draft, respeitando draft humano inesperado.
Encerrar correção, devolver controle, observar CI verde e declarar prontidão são fatos distintos.

Crash entre fornecimento de contexto, atividade e resultado não prova que o feedback foi tratado.
Após cessação/reconciliação, usar contexto da Execução, sessão/artefatos, tratamento preservado e Git/PR atuais para continuar.
Evidência insuficiente permanece incerta; pedir orientação/bloquear quando necessário, sem replay cego de ferramentas,
repetição de publicação ou novo protocolo de confirmação por item.
Resultado ambíguo de push segue o protocolo de publicação direta; a correção não é encerrada presumindo sucesso.

### Cenários e provas posteriores

| Cenário | Resultado exigido |
| --- | --- |
| Polling repete check falho/review já observado | Uma correção consolidada, sem nova posição/cobrança por observação |
| Check antigo falha depois de novo head | Histórico não dispara reparo; avaliar o SHA pertinente |
| Review humano anterior ao push continua pendente | Não descartá-lo pelo SHA; fornecer contexto e registrar tratamento |
| Pedido humano muda ou é aprovado/dismissed posteriormente | Reavaliar versão/relevância sem apagar histórico nem eliminar outros motivos |
| Builder discorda de pedido humano | Pergunta explícita, não simples não acolhimento como nos revisores internos |
| Feedback chega durante revisão ou pergunta | Acumular para próxima ativação; sem escritor paralelo, injeção ou resposta presumida |
| Motivos desaparecem antes do início | Retirar pendência sem consumir orçamento; não liberar início incerto às cegas |
| Builder inicia e verifica que nada precisa mudar | Registrar conclusão sem mudança; manter cobrança do início confirmado |
| Problema permanece declarado sem solução | Bloquear/perguntar, não consumir todo o limite por polling repetido |
| Correção termina e CI do novo resultado falha | Nova correção possível dentro do limite; não confundir encerramento com prontidão |
| Crash após entrega de feedback ou publicação | Recuperar contexto/efeitos, sem presumir consumo, sucesso ou repetir ferramenta |
| Push humano, lease falho ou nova divergência após autorização | Preservar trabalho e pedir autorização concreta; nunca renovar lease cegamente |
| Base apenas avança, ou branch-alvo é trocada | No primeiro caso aplicar gatilhos existentes; no segundo bloquear para decisão |
| PR fecha/merge ocorre durante reparo | Reconciliar encerramento e atividade, sem substituir PR, novo escritor ou publicação indevida |

Testar consolidação, fronteiras de encerramento, orçamento e obsolescência com consultas simuladas, duplicação/reordenação,
falhas de leitura e cortes de crash. Posteriormente demonstrar reviews/comandos autorizados, concorrência Git/lease,
CI do resultado novo e retomadas reais em repositório de teste/piloto autorizado.
Esta resolução é documental: não executou modelos, experimentos, reparos ou provas autenticadas nem aceitou o MVP.
Cobertura: RF-03–06, RF-08–13, RNF-01/03/04 e CA-04/06/09/10/12, integrada ao fluxo de CA-01.

### Encaminhamentos

- [Definir a configuração, a CLI e o ciclo operacional da instalação](21-installation-operations-contract.md):
  expor autorizações específicas, diferenças/impedimentos, retomada e concessões sem comando genérico de ignorar bloqueios;
  a sintaxe permanece nesse ticket, sem escolha adicional aqui.
- [Definir observabilidade, proteção de segredos e retenção dos artefatos](22-observability-retention-contract.md):
  preservar contexto/tratamentos e evidências de divergência necessários à recuperação, sem logs de cada polling ou publicação integral no PR.
- Provas de aceite e revisão cruzada permanecem na névoa do mapa; integrar os cenários acima quando essas decisões forem especificadas.
  Nenhum novo ticket ou mudança de destino é necessário para esta resolução.
