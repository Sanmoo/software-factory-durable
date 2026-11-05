# Definir o protocolo de execução e retomada entre controlador e worker

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão Wayfinder de protocolo controlador–worker; branch de registros `plan/software-factory-worker-protocol`, worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-worker-protocol`; destino de integração `main` em `/home/sanmoo/dev/github.com/Sanmoo/pkm`. Decisão HITL concluída; integração local, sem publicação de main.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 06, 07, 08, 19

## Question

Qual é o contrato concreto entre o controlador baseado em Pi Durable e o executor dos builders/revisores para iniciar, observar, suspender, interromper e retomar uma Execução, preservando exclusividade e descobrindo resultados após crash?

Definir mensagens/comandos/resultados, identidades e versões, confirmação de recebimento versus efeito ocorrido, autorização de despacho e rejeição de resultados obsoletos. Concretizar a barreira de boot/retomada: abrir o estado não pode autorizar scheduler/tasks a lançar builders antes da reconciliação. O worker não abre o storage de controle para escrita; ingressos CLI/GitHub são processados pelo proprietário dessa autoridade, sem acesso direto ao banco como interface operacional. Concretizar o lock exclusivo local por armazenamento e a reação a uma segunda inicialização conforme a decisão de estados, sem confundir serviço systemd único, escrita SQLite serializada e exclusão física de Builders. Usar as reservas/identidades/fases já aprovadas para evidenciar início ou não início, cobrar/liberar orçamento, medir duração e confirmar cessação; identidade antiga não pode alterar a reserva vigente.

Usar o runtime e isolamento escolhidos e os identificadores/transições definidos na decisão de estados; não redefinir esses três contratos. Aqui cabem o encaixe entre eles, evidências de processo/artefato, interrupção confirmada de sobreviventes antes de retomar (sem adoção de execução viva), suspensão liberando Slot, retomada com contexto e descoberta de publicação sem confirmação. Fencing de estado não deve ser apresentado como fencing automático de Git/processos. Preservar publicação direta pelo builder via GitHub App, sem inventar publicador mediado ou garantia de prevenção de toda mutação permitida pelo token.

Explicar pelo menos: reserva persistida antes de spawn; spawn concluído sem recibo; controlador morto com builder vivo; cancelamento antes/depois do envio de efeito; pergunta publicada sem checkpoint; tool/revisor concluído com resultado perdido; atualização com payloads/registry incompatíveis; mensagem duplicada, atrasada ou de geração anterior. Para cada caso, dizer quem pode agir, que evidência permite confirmar resultado/cessação e quando bloquear sem relançar. Escolher retomada ou substituição de contexto conforme RNF-01, sem prometer continuação da mesma instrução.

Respeitar a interface de sandbox: configuração, defaults e validação específicos pertencem ao adapter escolhido;
o controlador não conhece flags QEMU ou regras/cgroups systemd dos ambientes nem mantém campos paralelos de RAM/vCPUs/disco.
Usar handles/resultados da interface para iniciar, observar e interromper ambientes, com as evidências de cessação necessárias,
sem vazar a implementação do adapter para a máquina de estados ou criar framework genérico de plugins.
O dimensionamento inicial escolhido para o adapter Gondolin está registrado na decisão de isolamento, não é contrato universal de outros adapters.
Usar os handles/resultados definidos no contrato do adapter, sem duplicar sua interface. Concretizar o handoff mínimo aprovado:
Builder sinaliza revisão, controlador dispara os dois reviewers paralelos na mesma VM e entrega resultados à sessão do Builder;
Slot permanece ocupado, sem snapshot/commit obrigatório ou plataforma de subagentes.
Consumir o [fechamento das ferramentas e do contexto de revisão](19-gondolin-adapter-contract.md#revisores-somente-read-e-contexto-da-rodada)
no handoff, sem ampliar poderes do revisor ou transformar o controlador em coletor documental.

Aplicar o [contrato da GitHub App](11-github-app-contract.md) ao ciclo de autorização da Execução e retirada do acesso,
sem persistir o segredo do token, acrescentar serviço/cofre ou usar expiração/revogação como prova de cessação.
O risco de token perdido após crash já foi aceito nesse contrato; não criar certificação/monitoramento de barreiras como compensação.

Desenhar contratos e critérios de validação, não implementar adaptadores, iniciar agentes, provisionar isolamento ou executar provas. Graduar lacuna documental se uma API essencial não estiver sustentada; teste futuro exige autorização própria.

## References

- [Escolher a estratégia mínima de durabilidade e recuperação](02-durability-strategy.md): Pi Durable/SQLite, autoridade única e barreira de reconciliação aprovadas.
- [Definir a fronteira mínima entre controlador e builder](01-control-authority.md): publicação direta, credenciais, cancelamento e riscos residuais aprovados.
- [Escolher o runtime de agentes e seus pontos de integração](06-agent-runtime-choice.md).
- [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](07-isolation-choice.md).
- [Definir o contrato e o perfil distribuível do adapter Gondolin](19-gondolin-adapter-contract.md): configuração, operações, handles e resultados da interface de sandbox.
- [Definir estados, filas, persistência e reconciliação dos efeitos](08-state-and-effects-contract.md).
- [Definir o contrato de permissões e verificação da GitHub App](11-github-app-contract.md).
- [Definir a captura versionada da especificação e das instruções](16-specification-snapshot-contract.md#answer): primeira ativação, continuação e recuperação; armazenamento documental direto pelo Builder, sem protocolo de ingestão no controlador.
- [PRD — Software Factory MVP](../prd.md): RF-03–06, RF-10, RF-12–13, RNF-01–02 e CA-03/05/06/07.

## Comments

- Graduado da névoa após a escolha de durabilidade; ticket de decisão, não implementação.
- Q1 e Q2 aprovadas sob condição de simplicidade: “se isso for o mais simples” e “Se for um mecanismo super simples”; Q3 aprovada.
- Q4–Q6 aprovadas explicitamente após reapresentação: “Para as outras questões que você havia me apresentado anteriormente, estou de acordo com as recomendações”.
- Q7 original e refinada (ferramenta de registro prévio de publicação) foram substituídas, não aprovadas. Após discutir custos e consequências, o operador escolheu “a alternativa mais simples”. Q8 sobre lease explícito e registros normais também aprovada.
- Q9/Q10 receberam esclarecimento de compatibilidade coordenada, relógio monotônico versus calendário e limites após crash. Após o exemplo com `performance.now()`, o operador confirmou “okay, de acordo. Podemos seguir”.
- Aprovações consolidadas no Answer, única fonte da resolução. A revisão de publicação foi refletida nos contratos anteriores de estados/durabilidade; não altera as demais exigências de intenção/reserva.
- Conferência documental de 2026-11-04: reutilizadas as pesquisas concluídas e verificadas fontes primárias de Pi Durable, Node, flock e systemd. Nenhuma instalação, agente/modelo, VM, prova de runtime ou alteração do host foi executada.
- Validação documental: git diff --check; 22 tickets com metadados/status/tipos/labels/Answers e dependências válidos, grafo sem ciclos; 19 resolvidos indexados uma vez; 71 links locais/âncoras conferidos nos quatro arquivos alterados. Probe LSP ativo nos quatro arquivos sem erros/avisos. Markdownlint CLI indisponível; não instalado nesta sessão. As provas de runtime permanecem futuras, não foram reportadas como executadas.

## Answer

### Alcance e composição mínima

Usar **protocolo local versionado sobre sockets Unix**, com controlador Pi Durable como única autoridade,
workers Pi coding-agent via SDK e a interface do adapter Gondolin já aprovada.
Sem HTTP público, broker, segundo banco/fila persistente, framework RPC, publicador mediado ou supervisor próprio.
CLI e ingressos GitHub entram pelo proprietário do controle; worker/adapter nunca escrevem no storage Pi Durable.

Distinguir quatro fatos: **pedido recebido, decisão persistida, efeito observado e cessação confirmada**.
Nenhum implica automaticamente o seguinte. Transcript, recibos e arquivos de resultado são evidências,
não autoridades de autorização, Slot, orçamento ou prontidão.

Os nomes de mensagens e fases abaixo são o contrato da fábrica, não APIs prontas alegadas do Pi/Gondolin.
A composição deverá ser provada no perfil fixado antes do aceite, sem converter desenho em homologação.

### Transporte, identidades e versão

Usar `node:net`, socket com pathname em diretório privado da conta da instalação e mensagens JSON delimitadas por linha.
O decoder acumula frames completos: uma leitura do socket não equivale a uma mensagem.
Validar tipo, versão e campos antes de agir; mensagem inválida/incompatível falha explicitamente.
Arquivos grandes, sessões, diffs e pareceres completos seguem por referências aos artefatos próprios, não cópias integrais no canal.
Aplicar limites de frame/buffer do perfil de release; exceder limite produz erro, nunca truncamento aceito como resultado.

Envelope mínimo:

| Campo | Significado |
| --- | --- |
| `protocol_version` | Versão do contrato de comunicação; inicialmente uma única versão suportada por release |
| `controller_run_id` | Identidade desta abertura do proprietário; muda a cada reinício |
| `work_id`, `execution_id` | Identidades já definidas; quando aplicáveis à mensagem |
| `worker_id`, `role` | Invocação concreta e papel Builder/Standards/Spec; papel não é informado pelo modelo |
| `message_id`, `reply_to` | Identidade estável da solicitação/evento e correlação da resposta |
| `kind`, `payload` | Operação e dados validados conforme sua fase |
| `environment_ref`, `boot_ref` | Handles opacos da interface de sandbox, somente nas operações pertinentes |
| `round_id`, `attempt_id` | Correlação da revisão/tentativa quando pertinente, sem criar outro orçamento |

O host associa a conexão ao worker/ambiente que esperava iniciar. O handshake declara versão/identidades;
aceitar a declaração sozinha não concede um papel ou Execução.
Diretórios/socket privados e o perfil fechado protegem o canal de agentes no guest; processos host da mesma conta
continuam na base confiável já aceita. Não alegar isolamento contra comprometimento desses processos nem adicionar PKI/mTLS.

Mesmo `message_id` e mesmo conteúdo reenviados recebem o resultado já registrado, sem reaplicar transição.
Reuso da identidade com conteúdo diferente é erro. Conferir também fase, Execução vigente e registro da operação:
UUID sozinho não fornece idempotência. Registrar decisões críticas com a transição correspondente; eventos de progresso
podem ser apenas observacionais e não funcionam como ACK durável.

Mensagens de uma abertura/Execução/boot antigos não modificam reservas vigentes nem disparam atividade.
Recibos antigos ainda podem ser examinados pelo reconciliador como evidência histórica; sua incorporação é uma decisão
nova do proprietário atual, não aceitação de comando antigo.

Não negociar formatos antigos ou operar versões concorrentes. Releases diferentes podem compartilhar o mesmo protocolo
quando compatíveis; não incrementar a versão por mero lançamento. Incompatibilidade impede atuação e explica a ação necessária.

### Exclusividade local e barreira de boot

Concretizar o lock com **flock exclusivo não bloqueante**, antes de abrir o storage ou aceitar comandos de mutação.
Forma de lançamento: `flock --exclusive --nonblock --no-fork <lock-do-storage> <controlador>`.
O comando do controlador substitui flock e mantém o descritor: não há daemon de lock nem eleição.

Todos os caminhos de inicialização usam o mesmo arquivo estável associado ao storage local canônico.
Não apagar/substituir esse arquivo para “limpar lock”, nem criar locks diferentes por alias do mesmo storage.
Arquivo/PID presente não é prova de posse; o kernel arbitra a exclusão. Segunda abertura falha com diagnóstico, sem takeover.
Workers e subprocessos não herdam o descritor do lock; configurar spawn sem repassá-lo e provar isso no perfil.
Assim, sobreviver um worker não mantém artificialmente o lock do controlador morto.
Lock liberado tampouco prova que o worker morreu.

Sequência de boot:

1. Adquirir lock; verificar compatibilidade do estado/registry/perfil. Limpar somente socket obsoleto próprio, após exclusividade,
   nunca usar existência/ausência do socket como lock.
2. Abrir Pi Durable com a barreira de despacho **fechada por padrão**; registrar a nova abertura.
3. Inventariar reservas, Execuções, handles e artefatos pendentes. Pelo adapter, descobrir recursos próprios mesmo se o
   processo proprietário anterior morreu; a superfície de observação/parada não depende de ele voltar a funcionar.
4. Interromper sobreviventes próprios; confirmar cessação, reconciliar efeitos/recibos, atualizar consumos e reservas.
   Não adotar execução viva nem permitir reconexão que restaure a autorização anterior.
5. Liberar despacho somente da capacidade e dos Trabalhos comprovadamente reconciliados, respeitando pausa/impedimentos.

Incerteza limitada a um Trabalho mantém seu bloqueio e reserva, mas não impede os demais com capacidade comprovadamente livre.
Incerteza global de autoridade/capacidade mantém admissão fechada. O inventário inicial precisa delimitar essa distinção
antes da liberação; não ignorar recursos desconhecidos para declarar capacidade livre.

**Integração pública Pi Durable:** documentos Session guardam o domínio; commits normais de `Session/Conversation.commit`
e tarefas próprias via `tx.createTask` unem reserva e intenção de despacho. Respeitar leituras antes das escritas;
quando usar `submit(tx, draft)`, uma admissão por commit e resultado provisório até o commit armazenado.
Não marcar controle crítico como deferred. Manter SQLite WAL/FULL pelo adapter público escolhido na decisão de durabilidade.

`resume()`, `submit()` e waits podem iniciar o scheduler: toda fase que alcança spawn, envio de comando ou nova ferramenta
consulta a barreira do host e a autorização/identidade atual, não apenas o ponto inicial de `resume()`.
Durante a recuperação, fases não autorizadas não fazem efeitos nem loops de redisparo; o host só as conduz após reconciliação.
Uma fase reexecutada consulta os registros/recursos antes de agir. Recuperação de task não é autorização para repetir spawn.
O ciclo inteiro do Builder não é encapsulado como tool `replay: safe`.
Conclusão/abort de task Pi Durable não comprova morte de processos externos.

### Comandos, eventos e recibos

| Fluxo | Conteúdo/condição essencial | Confirmação |
| --- | --- | --- |
| Preparar/iniciar ambiente | Handles e operação identificada da interface existente; reserva/autorização confirmadas | Operacional com `boot_ref`, falha conhecida ou indeterminado; não implica início do agente |
| Ativar worker | Execução/papel, perfil fixado, referências de sessão/contexto, ambiente e comando identificados | Handshake recebido é conexão; recibo de início é entrada em atividade |
| Observar/progresso | Identidades, fase, atividade, uso/duração disponíveis, referências de ferramentas | Não libera Slot nem comprova sucesso/cessação |
| `ask_user` | Identidade estável, pergunta/contexto e destino | ACK de pergunta/intenção duráveis; publicação e cessação são confirmações separadas |
| Solicitar revisão | Rodada, conteúdo/contexto e paths preservados; Builder devolveu controle | Rodada registrada e despacho autorizado dos papéis |
| Resultado de revisor | Papel/tentativa, status e referência do parecer completo | Incorporação durável correlacionada; não é prova de término dos workers |
| Fim da ativação/falha | Motivo, sessão e evidências de ferramentas/artefatos | Controlador decide espera/bloqueio; confirma cessação antes da liberação |
| Interromper/cancelar | Identidade da atividade própria e razão registrada | Pedido aceito é distinto de `cessation_confirmed` |
| Resposta/comando CLI | Autor/origem autorizada, correlação e identidade do ingresso | Transição durável, nunca disparo direto por ACK |

Resultados transportados distinguem **sucesso conhecido, falha conhecida e indeterminado**.
Recibo de transporte não substitui ACK do commit; timeout/erro de canal não é resultado negativo do efeito.
Falha de persistência não é anunciada como sucesso. Texto final ou exit code isolado não confere prontidão.

### Admissão, início e orçamento

Antes de qualquer spawn, o controlador confirma a admissão da Execução: identidade vigente, autorização/elegibilidade,
fila, Slot, orçamento aplicável e tarefa/intenção de despacho. Persiste a identidade da operação que permitirá descobrir
os recursos criados; não depende apenas de um handle devolvido depois do efeito.
O adapter correlaciona esse pedido com os handles/operação próprios, sem expor PIDs, units ou flags QEMU ao domínio.

O worker confiável, antes de acionar o agente, grava um **recibo persistente de início**, com Execução, invocação,
abertura/boot, perfil e referências temporais. Gravação completa/durável antecede qualquer chamada de modelo/ferramenta;
falha nessa gravação impede iniciar. Usar artefato host protegido, fora do workspace editável pelo guest:
gravação temporária, sincronização e publicação atômica, com identidade verificável e detecção de arquivo incompleto.
Não criar banco/journal de workflow do worker.

Esse é o marco de início: **recibo confirmado conta como Execução iniciada mesmo se o worker cair antes de chamar o modelo**.
O controlador consome a reserva de orçamento uma vez ao incorporar a evidência. Reenvio/redescoberta não cobra novamente.
O recibo não autoriza a Execução por si só: precisa corresponder à admissão existente.

- Spawn com recibo de transporte perdido: observar os recursos pela identidade já persistida; não lançar duplicata.
- Recibo de início completo encontrado: confirmar início/consumo, mesmo se a notificação se perdeu.
- Não início comprovado e cessação/ausência de atividades confirmada: liberar Slot/orçamento não consumido.
- Recibo ausente em storage danificado, observação incompleta ou propriedade incerta: não inferir não início.
  Conservar reserva e bloquear até reconciliação. Ausência só vale como evidência negativa quando o armazenamento
  íntegro e a barreira obrigatória anterior à atividade permitirem demonstrá-la.

Fim de processo sem evidência não apaga início confirmado. Recibo de início não prova que a Execução ainda está viva.
Sem timeout configurado, preparação/execução lenta não cria teto implícito; o operador vê fase/atividade e pode cancelar.

### Perda de canal, cancelamento e cessação

EOF/fechamento/erro confirmado do canal de controle faz worker/adapter negar novas chamadas e iniciar interrupção
pela supervisão existente. Silêncio de logs, ferramenta longa, ausência de evento ou mero timeout de uma solicitação
não comprovam desconexão/cessação; não usar timeout de inatividade do socket como timeout da Execução.
Não adicionar heartbeat que mate trabalho silencioso.

Cancelamento confirma primeiro a proibição de novas ações/renovações no controle. A fila local de despacho consulta
essa proibição antes de enviar novos comandos. O worker bloqueia novas chamadas ao receber interrupção/perder canal,
aciona abort do SDK e a parada supervisionada. Comando/efeito já enviado pode concluir; registrar o resultado efetivo.

A interface do adapter observa workers e recursos próprios associados ao boot, incluindo VMM e subprocessos.
Sua implementação usa identidade da invocação supervisionada e grupos systemd, não PID solto ou `MainPID=0`.
Parar apenas o processo principal não basta: a evidência deve cobrir ausência de processos próprios capazes de continuar
atuando, inclusive no grupo de execução, e ausência de novo despacho autorizado.
No término forçado da VM, os processos guest deixam de executar; operações remotas já enviadas continuam reconciliáveis.

A observação pelo adapter diferencia ativo, cessação confirmada e indeterminado; controlador não interpreta cgroups.
O caminho host do adapter pode observar/encerrar o grupo mesmo com o proprietário Gondolin morto.
Usar a parada graciosa e o prazo configurado no adapter; depois término forçado dos recursos próprios.
Parada forçada não comprova integridade do disco; preservar e verificar usabilidade antes de novo boot.

Liberar Slot somente após cessação. Se a parada falha, propriedade/cessação incerta mantém reserva/bloqueio.
A mera emissão de SIGTERM/SIGKILL, retorno de `abort/close`, revogação de token, exit code ou fim de task não são a prova.
Encerrar/crash do controlador não torna seus workers inofensivos: essa é a razão da reconciliação antes de substitutos.

### Pergunta, suspensão e contexto de retomada

`ask user` atribui identidade estável antes do envio e preserva a solicitação completa em artefato do worker.
O controlador confirma pergunta, impedimento e intenção de publicação no mesmo commit antes do ACK.
O worker encerra a atividade sem Promise aguardando resposta humana; preservar sessão e artefatos.
Encerrar ambiente/atividades e confirmar cessação precede liberação de Slot. Disco/workspace permanecem.

Se o ACK se perder, recuperar pelo identificador: registro existente é reutilizado; solicitação íntegra preservada pode ser
registrada com a mesma identidade se ausente. Conteúdo irrecuperável exige bloqueio/orientação, não pergunta inventada.
Reconciliar também encerramentos/autorização atuais: pergunta recuperada não reativa Trabalho cancelado/entregue.
O worker não publica outra pergunta por conta própria.

Publicar/reconciliar o comentário com marcador estável. Pergunta publicada sem checkpoint é descoberta antes de republicar;
consulta incompleta não prova ausência. A primeira resposta autorizada/correlacionada confirmada duravelmente é aceita uma vez,
mesmo se chegou durante recuperação. Resposta não remove suspensão de autorização, esgotamento ou outros impedimentos.
Voltar à fila/categoria/ordem conservadas, sem spawn pelo receptor da resposta.

Primeira ativação usa `/implement <link-ticket>`; retomada compatível usa `continue` com resposta/feedback/motivo.
Sessão incompatível/ausente é substituída com razão registrada e referência aos artefatos recuperados.
Builder consulta spec/instruções preservadas, perguntas/respostas, feedback e Git/PR reconciliados; o controlador não monta
coletor documental nem presume que a issue atual seja a especificação vigente.
Contexto insuficiente bloqueia. Não repetir cegamente a última ferramenta nem prometer a mesma instrução/raciocínio interno.

### Handoff e recuperação dos revisores

Builder sinaliza revisão e devolve controle. O worker host suspende novos turnos/ferramentas do Builder e informa fim dessa
atividade ao controlador; não basta uma frase do modelo ou `agent_end` isolado.
A sessão/processo Builder pode permanecer ociosa enquanto a mesma Execução aguarda revisão; isso não é execução paralela do agente.
Não introduzir auditoria genérica de todos os processos guest, snapshot, commit candidato ou worktree limpa para o handoff:
a fronteira cooperativa e seus limites já foram escolhidos.

Controlador registra rodada e inicia Standards/Spec em paralelo, na mesma VM e Slot, com invocações próprias.
Fornecer índice/diff/identidade integral do conteúdo, referências da rodada e paths de spec/instruções/fontes preservadas.
Revisores usam apenas `read` nativo do Pi com backend confinado do adapter, sem shell, token GitHub ou consulta remota.
Contexto faltante/truncamento não superado produz revisão incompleta, não ampliação automática de ferramentas.

Cada worker preserva **parecer final completo antes da notificação**, incluindo rodada/papel/tentativa/sessão/perfil,
conteúdo/contexto examinados, status, cobertura/achados e referências.
Mesmo padrão de arquivo completo/durável dos recibos; fragmento de streaming não é resultado final.
Controlador verifica correlação e incorpora uma vez. Não aceita parecer fabricado pelo Builder.

Notificação perdida permite recuperar o artefato completo sem rerodar o revisor, desde que conteúdo/contexto correspondam.
Identidade antiga não altera a Execução atual; o reconciliador vincula explicitamente a evidência válida à recuperação.
Sem resultado completo, o revisor permanece inconclusivo. Preservar o outro parecer válido quando o contexto não mudou;
recuperar apenas o que faltou usando os limites operacionais existentes, sem retry oculto do SDK ou orçamento paralelo.
Quando a falha interrompe a Execução, a recuperação ocorre em nova Execução após cessação/fila; não adotar worker sobrevivente.
Nova proposta/conteúdo relevante exige rodada dos dois, conforme o contrato de revisão.

Builder só volta a executar após encerrada a atividade dos revisores e com seus resultados/estado de falha efetivos,
entregues à sessão preservada ou substituta contextualizada. A entrega ao SDK também tem identidade/correlação:
se cair entre entrega e checkpoint da sessão, não afirmar que foi consumida nem repetir ferramenta automaticamente.
Reconstruir a continuação com os pareceres e os efeitos locais já observados.
Slot e relógio permanecem ocupados durante a revisão interna; suspensão para humano/CI é outro fluxo.

### Q7 — Publicação direta sem ferramenta adicional de intenção

**Revisão explícita aprovada:** não exigir ferramenta `registrar_efeito`, intenção específica no controlador ou ACK adicional
antes de cada push/criação de PR. Não implementar wrappers Git/gh, parser genérico de shell, proxy/publicador ou diário especial.
O Builder publica diretamente; a recuperação usa identidades de Trabalho/branch/PR, Git local/remoto e registros normais
das ferramentas. Isso pode exigir mais intervenção após falhas ambíguas; não promete recuperação automática em todo corte.

As skills orientam capturar a expectativa remota antes da preparação e usar
`--force-with-lease=<ref>:<OID>` explícito somente na branch do Trabalho.
Preservar nos registros normais o valor efetivamente usado, não somente variável cujo valor se perdeu.
Não recapturar o OID atual como novo lease, usar `--force` ou presumir que ref de tracking atualizada mantém a expectativa original.
Se a evidência necessária não for recuperável, bloquear repetição e pedir orientação, sem acrescentar ferramenta/diário obrigatório.

Após cessação, consultar branch/commits e PR próprio por identidades/correlação.
Commit local/remoto compatível pode permitir reconhecer push; branch com nome esperado sozinha não prova autoria.
PR inequivocamente encontrado é vinculado, não recriado. Múltiplos candidatos, mudança humana desconhecida, consulta incompleta
ou resultado ainda ambíguo impedem repetição insegura. Não declarar “não ocorreu” apenas porque não apareceu na primeira leitura.
Um push repetido não duplica commits por si; o risco relevante é sobrescrever concorrência/publicar conteúdo errado.
A intenção prévia também não provaria envio/conclusão: retirá-la não retira a reconciliação.

Para ferramentas comuns, resultado completo e correlacionado pode ser recuperado dos registros; sucesso não é inventado
por ausência de erro. Resultado perdido de comando com efeitos requer inspeção do workspace/Git/recursos, não replay automático.
Repetir uma leitura segura é diferente de repetir um comando arbitrário; comandos/gates só voltam a executar por continuação
autorizada, preservando resultados desconhecidos como desconhecidos.

Essa revisão é restrita a push/criação de PR pelo Builder. Permanecem intenções/commits de despacho, perguntas,
conversão de prontidão e cleanup, conforme os contratos correspondentes.
Cancelamento continua barrando novas ações e reconciliando as já enviadas.
Fencing de estado e orientação das skills não impedem tecnicamente toda mutação permitida por um token copiado.

### Credenciais e poderes durante a ativação

Controlador mantém chave emissora e tokens somente em memória; persiste metadados, não segredo.
Token reduzido do Builder chega pelo ambiente explícito dos comandos Git/gh via adapter, nunca por prompt/argv/recibo.
Revisores não recebem token nem ambiente de escrita. Não criar cofre ou broker de credenciais.

Renovar enquanto a Execução tiver autorização de permanecer ativa, sem confundir retirada de elegibilidade com cancelamento.
Cada novo comando recebe o token vigente; processo já iniciado conserva o ambiente antigo.
Falha por expiração exige reconciliar efeito antes de repetir, não retry de comando por renovação automática.
Espera externa, cancelamento ou fim da ativação retiram novas entregas/renovações e revogam tokens conhecidos quando possível.
Handoff de revisão não exige rotação por rodada.

Após crash, valor perdido pode impedir revogação; registrar o risco aceito de cópia externa válida até expirar.
Isso não exige suspender a instalação inteira e não prova cessação. Confirmar interrupção/reconciliação antes de nova credencial
para uma Execução substituta. Filtrar segredos antes de logs/resultados/sessões, conforme o contrato da App.

### Duração, timeout e relógios

Medir duração ativa com relógio monotônico local, por exemplo `performance.now()` de `node:perf_hooks`.
Não é relógio próprio, serviço ou dependência adicional. Guardar também data/hora de calendário para apresentação/auditoria;
`Date.now()` pode saltar após ajuste de hora e não governa sozinho o timeout em execução.

O worker host do Builder mantém a medição da ativação inclusive quando o agente está ocioso no handoff de revisão.
O marco inicial acompanha o recibo antes de acionar o agente; progresso e encerramento preservam duração medida/identidade
do processo de origem e horários disponíveis. Um timer local verifica o timeout configurado independentemente de logs/atividade;
atingi-lo sinaliza o controlador e solicita interrupção, preservando evidência do motivo e bloqueando sem renovar o prazo.
O controlador acompanha o prazo e a supervisão; a perda do worker segue recuperação, não deixa sua ausência autorizar continuação.
Isso não exige manter o modelo ou ferramentas ativos durante o handoff, nem heartbeat que cancele silêncio.

`performance.now()` tem origem no processo: não comparar diretamente valores de processos diferentes,
nem converter uma hora de calendário após reboot em continuidade monotônica garantida.
O relógio de sleeps/backoff persistidos do Pi Durable continua estável entre aberturas conforme seu contrato;
não substituir globalmente seu `now` por `performance.now()`.
A medição de duração da Execução é separada desses prazos.

Na recuperação, combinar recibos/observações de início, duração e cessação com origem identificada.
Distinguir duração comprovada, estimativa/limites e intervalo final desconhecido; não preencher perda com zero,
subtrair calendários como prova exata ou declarar suspensão/reboot corretamente contabilizados sem evidência.

- Timeout configurado e ultrapassagem comprovada: interromper quando necessário e bloquear.
- Timeout configurado e evidência suficiente de cessação antes do limite: recuperação pode seguir as regras normais.
- Timeout configurado e incerteza que não permite excluir ultrapassagem: bloquear retomada automática para intervenção.
- Sem timeout: duração imprecisa é informação de observabilidade, não bloqueio/cancelamento por si só.

Implementação, comandos e reviews internos pertencem ao mesmo relógio. Espera externa encerra a atividade;
a próxima Execução tem identidade/relógio novos e preserva contadores/correção.
Não usar restart para apagar duração anterior, escapar de timeout ou zerar limites.
Não acrescentar teto acumulado por Trabalho nem limite fixo de 60 minutos.
Prazo de parada graciosa do adapter é outro parâmetro, não substituto do timeout de Execução.

### Atualização e compatibilidade

Parar admissão, encerrar Execuções ou aguardar sua conclusão com confirmação, preservar artefatos/perguntas,
atualizar os componentes coordenadamente conforme o [contrato operacional](21-installation-operations-contract.md#atualização-e-limite-de-recuperação),
sem suporte integrado a backup/restauração. A continuação após parada administrativa limpa segue a classificação e cobrança do
[contrato de estados](08-state-and-effects-contract.md#limites-falhas-e-tempo), sem tratar intenção de parada como cessação.
Validar separadamente protocolo, schema do backend, documentos/tasks/registry, perfil de runtime/skills e formato de sessão.
Uma versão de protocolo compatível não prova compatibilidade dos demais.

Registry é reinstalado pelo host; usar migrações públicas de docs/tasks quando suportadas, preservando IDs, reservas,
contadores, perguntas e efeitos pendentes. Definição ausente/antiga ou payload/migração inválidos impedem atuação,
com diagnóstico, sem apagar/ressubmeter tarefa como modo de contornar incompatibilidade.
Abrir storage segue a mesma barreira de reconciliação; migração suportada deve detectar interrupção e definir sua recuperação.
Cópias externas não são certificadas, não desfazem GitHub e não dispensam essa barreira.
Sem rolling update, negociação multiversão, restauração integrada ou migração universal de contexto.

### Cortes de falha e validação futura

| Corte/cenário | Quem age e evidência/resultado exigidos |
| --- | --- |
| Reserva confirmada antes de spawn | Controlador/adapter descobrem recursos pela operação persistida; não início comprovado libera orçamento sem consumo, após ausência/cessação confirmada |
| Spawn sem recibo de transporte | Observar identidade da inicialização/invocação; nunca repetir cegamente nem inferir ausência |
| Recibo de início salvo, notificação perdida ou modelo nem chamado | Reconciliador confirma início e consumo uma vez; artefato ausente/corrompido não cria conclusão favorável |
| Controlador morto com Builder/revisores vivos | Lock novo não é exclusão física; encerrar próprios, confirmar cessação, reconciliar e só depois substituir |
| Cancelamento antes/depois de envio | Antes: impedir novo envio; depois: interromper e descobrir resultado efetivo, sem desfazer publicação automaticamente |
| Pergunta registrada/publicada sem checkpoint ou resposta durante boot | Descobrir mesma identidade, aceitar resposta autorizada uma vez; liberação depende de cessação e retomada passa pela fila |
| Tool concluída sem resultado disponível | Inspecionar efeitos/evidências; não apresentar gate verde nem repetir comando arbitrário automaticamente |
| Revisor terminou e resultado/notificação se perdeu | Recuperar parecer completo correlacionado; sem ele, inconclusivo. Preservar outro parecer válido e limites de recuperação |
| Mensagem duplicada/atrasada de abertura/Execução/boot antigo | Deduplicar transição ou rejeitar; evidência histórica só é incorporada explicitamente pelo reconciliador |
| Push/PR sem intenção específica e sem confirmação | Usar Git/identidades/registros normais; reconhecer próprio ou bloquear ambiguidade, sem novo lease cego/PR duplicado |
| Registry/protocolo/payload incompatível | Bloquear atuação e diagnosticar, sem execução especulativa ou descarte do estado |
| Timeout, ajuste de hora, crash ou reboot | Medição monotônica enquanto viva; duração perdida não vira zero. Incerteza relevante ao timeout bloqueia, ausência de timeout não cria corte |
| Parada parcial/forçada ou recurso de propriedade incerta | Manter reserva se cessação incerta; preservar artefatos e verificar disco antes de reutilizar; não limpar recursos alheios |

Provas futuras cobrem CA-01/03/05/06/07/09/11/12 e a cessação dos recursos Docker de CA-08:
cortes antes/depois de commits/recibos/spawn, chamada de scheduler antes da barreira, segunda inicialização,
não herança do lock, perda de canal, revisão com Builder inativo, mensagens antigas/duplicadas,
resultado parcial, pergunta/resposta concorrente, push/PR com concorrência humana e lease explícito,
atualização incompatível, relógio alterado e timeout incerto.
Documentação não substitui essas provas; uma reprovação exige corrigir o desenho/implementação ou voltar ao operador,
não enfraquecer o PRD. Nenhuma dessas provas foi executada nesta decisão.

### Evidências e encaminhamentos

Conferência documental em 2026-11-04, sem executar o código consultado:

- [Pesquisa imutável de autoridade durável](https://github.com/Sanmoo/pkm/blob/8bad2459743f16d4724bcb730af7a648ab45ec2f/.scratch/software-factory/research/agent-control-durability.md),
  reutilizada via objeto Git local; sem relançar pesquisa.
- Pi Durable no SHA `9c9ce8547e5a88cbe834a53e9a6d83a789d08e47`:
  [README](https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/durable/README.md) e
  [spec pública](https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/durable/docs/spec.md):
  commits, tasks, scheduler, relógio de sleeps e migrações; não são protocolo pronto de workers.
- Node, documentação oficial móvel:
  [IPC Unix](https://nodejs.org/api/net.html#ipc-support),
  [performance.now](https://nodejs.org/api/perf_hooks.html#performancenow) e
  [stdio dos subprocessos](https://nodejs.org/api/child_process.html#optionsstdio).
  A release fixa Node; não adotar funcionalidades recentes fora desse perfil.
- [flock util-linux](https://man7.org/linux/man-pages/man1/flock.1.html):
  exclusivo/não bloqueante/no-fork e herança do descritor; [systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html):
  término de grupo versus processo principal. Essas primitivas não demonstram ownership/cessação da composição.
- Interfaces/runtime de Pi coding-agent e Gondolin continuam nas evidências fixadas dos respectivos tickets;
  não se alterou perfil/backend nem se alegou compatibilidade por consulta a docs móveis.

Encaminhamentos já existentes, sem resolver outro ticket nesta sessão:

- [Definir o fluxo de manutenção e reconciliação autorizada do PR](20-pr-maintenance-contract.md):
  usar publicação simplificada, lease explícito e recuperação sem sobrescrever concorrência; detalhar feedback/reparo.
- [Definir observabilidade, proteção de segredos e retenção dos artefatos](22-observability-retention-contract.md):
  localizar/reter recibos, resultados e registros normais; distinguir progresso/ACK/efeito/cessação e duração conhecida/incerta,
  preservando contexto e OID necessários sem novos journals.
- [Definir a configuração, a CLI e o ciclo operacional da instalação](21-installation-operations-contract.md):
  paths canônicos/socket privado, lançamento flock, diagnósticos, atualizações e recuperação após crash, sem backup integrado.
  Manter configuração específica de sandbox no adapter.
- Cobertura final de aceite/construção incremental e revisão cruzada permanecem na névoa do mapa até os contratos restantes;
  nenhum piloto, implementação ou consolidação da spec integral foi antecipado.
