# Escolher o runtime de agentes e seus pontos de integração

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão Pi `01a1a19c-b1dc-72a8-8dc8-48e5b7bbafcc`; branch de registros `software-factory-agent-runtime`, worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-agent-runtime`; integração em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 01, 02, 03

## Question

Qual runtime de agentes cumpre os contratos do MVP com a menor complexidade total, considerando a pesquisa e a fronteira de autoridade confirmada?

Definir SDK/processo de integração, ferramentas necessárias, como ask user encerra ou suspende a execução liberando slot, como uma retomada recupera contexto, como os dois revisores são iniciados sem escrita e como habilidades, modelos, sessões, cancelamento e uso ficam integrados. Não atribuir durabilidade do controlador ao histórico do runtime.

Explicitar versão/perfil de suporte, adaptação necessária, limitações aceitas dentro do PRD e provas ainda requeridas. Se nenhuma opção tiver evidência suficiente, formular experimento de desempate para aprovação, não declarar aderência. Não executar o experimento ou construir adaptador neste ticket.

## References

- [Escolher a estratégia mínima de durabilidade e recuperação](02-durability-strategy.md): base Pi Durable aprovada para o controle, sem escolha automática de coding-agent. Fixar perfil/versão e custo completo de integração; incompatibilidade que invalide a simplicidade esperada volta ao operador, sem bridge/motor adicional silencioso.
- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md): concretização posterior dos contratos que este ticket seleciona, junto com isolamento/estados; não antecipar schema de mensagens aqui.
- [PRD — Software Factory MVP](../prd.md): RF-05–07, RF-10, RF-12–13; RNF-01–03 e RNF-05.

- [Investigar runtimes de agentes contra o contrato do PRD](03-agent-runtime-research.md): relatório imutável e limites da evidência.
- Fontes primárias conferidas pelo supervisor nesta sessão (2026-11-03), no SHA `9c9ce8547e5a88cbe834a53e9a6d83a789d08e47`: [manifesto do coding-agent](https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/package.json), [SDK](https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/docs/sdk.md) e [settings/retries](https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/docs/settings.md). Manifesto declara 1.5.0/Node >=22.19.0; SDK oferece overrides explícitos e eventos, sem equivalência entre `agent_end` e encerramento de toda continuação automática; settings permitem desabilitar retry de agente e manter retry de provider em zero. Leitura documental, não prova de instalação/composição nem de cessação de processos.

## Comments

- Criado na cartografia aprovada; não é ticket de implementação.
- Aprovações HITL: Q1/Q2 aceitas (“de acordo com as recomendações”); Q3/Q4 aceitas (“Para as demais perguntas, estou de acordo”);
  Q5 aceita com reforço “Deve ser totalmente independente do perfil do operador”; Q6/Q7 aceitas (“de acordo com as recomendações”).
- As aprovações parciais foram consolidadas em Answer, a única fonte da resolução. Nenhum adaptador, agente ou experimento foi executado.
- Revisão explícita durante [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](07-isolation-choice.md): após esclarecer que o Pi não fornece subagentes prontos no core, o operador aprovou o handoff mínimo ao controlador para disparar Standards/Spec em paralelo e devolver resultados à sessão do Builder, reutilizando o mecanismo de workers. Isso substitui a preferência intermediária por orquestração de subagentes pelo Builder. Permanecem retiradas as exigências adicionais de snapshot/referência imutável, commit obrigatório, worktree limpa e auditoria genérica de processos para iniciar revisão. Answer e encaminhamentos alinhados; revisão integral e sem escrita permanecem.

## Answer

### Escolha e justificativa

Adotar **Pi coding-agent via SDK para Builder, Standards e Spec**, em workers separados do controlador Pi Durable.
O SDK é embutido no processo Node do worker; não se adota a CLI interativa ou RPC como interface de controle do MVP.
Cada revisor tem worker/sessão próprios. Pi Durable permanece a autoridade única do Trabalho, não o transcript do coding-agent.

A escolha reaproveita coding tools, sessões e carregamento de recursos já documentados, em vez de construir um harness de coding
sobre Pi Durable ou LangGraph. Usar Pi Durable também como harness poderia reduzir superfícies de conversa/tarefa,
mas não herda o ambiente de coding ou as skills do coding-agent. Mastra oferece suspensão/paralelismo mais prontos,
com custo adicional de integração e subordinação de seu ciclo ao controle escolhido. Eve sobreporia seu workflow
com cuidados próprios de atualização. Nenhuma alternativa foi declarada tecnicamente incapaz.

É comparação qualitativa de complexidade total, não medição de LOC/custo nem conformidade demonstrada.
A integração usa eventos/resultados e contexto do worker, **sem converter sessões entre os dois formatos,
sem bridge de persistência e sem segundo motor de workflow**. Se o encaixe exigir complexidade que invalide essa vantagem,
voltar ao operador; não acrescentar silenciosamente outro motor, banco de controle ou caminho de execução.

### Perfil independente e suporte inicial

O runtime deve ser **totalmente independente do perfil do operador**. A fábrica fornece explicitamente modelo/model runtime,
settings, resource loader, ferramentas, contexto, credenciais e armazenamento de sessões.
Não descobrir/herdar settings, extensões, skills, templates, MCP, sessões ou credenciais pessoais da máquina.
As credenciais necessárias são configuradas para a fábrica, limitadas por papel e fornecidas ao worker conforme sua autorização;
a chave emissora GitHub continua somente no controlador, conforme a decisão de autoridade.

Ler instruções aplicáveis, inclusive AGENTS.md, não autoriza executar plugins ou carregar configurações de credenciais do repositório.
Extensões e integrações adicionais exigem inclusão explícita no perfil versionado da fábrica.
O SDK documenta overrides para essas fronteiras; o loader padrão sem configuração não satisfaz esta decisão.

Suporte inicial: **Node.js em Linux, uma única combinação fixada e validada por versão da fábrica**; Bun não integra esse suporte.
Base documental inicial: `@earendil-works/pi-coding-agent` **1.5.0**, snapshot
`9c9ce8547e5a88cbe834a53e9a6d83a789d08e47`, cujo manifesto exige Node **>=22.19.0** e declara licença MIT.
Isso não é uma faixa autorizada de atualização automática nem prova de artefato publicado/instalação homologada.
A distribuição deverá fixar artefato/integridade, dependências e versão exata de Node efetivamente validados.
Uma combinação diferente exige mudança explícita do perfil, não substituição silenciosa durante um Trabalho.

Registrar por Execução versões/identidades do runtime e formato de sessão, ferramentas/extensões,
skills/instruções, especificação/base e configuração resolvida de provider/modelo por papel.
Builder, Standards e Spec são configuráveis independentemente, sem fallback silencioso.
Modelo ausente, credencial inválida ou perfil incompatível deve produzir falha/bloqueio visível, não herança do operador.
Atualizações seguem a parada controlada já aprovada na decisão de durabilidade, preservando contexto e perguntas pendentes.
O pacote exato de skills, captura de fontes e manifestos de instalação serão concretizados pelos encaminhamentos abaixo.

### Ferramentas e responsabilidades do host

O Builder dispõe de ferramentas explícitas de leitura/pesquisa, edição/escrita e comandos para implementar, validar,
instalar dependências e usar Git/API na política aprovada. A publicação continua direta pelo Builder via GitHub App.
Rede e testes que criam containers Docker continuam requisitos; não são garantias fornecidas pelo SDK.

Disponibilizar **ask user** e um **handoff mínimo de revisão ao controlador** no perfil da fábrica.
O Builder sinaliza que está pronto para revisão; o controlador reutiliza o mecanismo de workers para executar Standards/Spec em paralelo
na mesma VM e fornecer os dois resultados à sessão existente do Builder. Adaptar o ponto de revisão de implement/code-review a esse fluxo,
sem exigir ferramenta genérica de subagentes, pacote adicional de delegação ou segundo motor de workflow.
O host fornece execução dos workers, permissões e registros; o Builder decide quando pedir revisão e como tratar os achados.
Não depender de UI local, stdin humano, skills globais ou extensão genérica de subagentes do operador.
Carregar uma skill não comprova sua execução; as chamadas/resultados efetivos sustentam as evidências exigidas, sem gateway novo de revisão.
/pr prepara a descrição; não é, por si, publicador ou autorização de prontidão/merge.
O conjunto físico de ferramentas, fronteiras de filesystem/processo e permissões permanece sujeito ao isolamento aprovado.

### Pergunta, suspensão e retomada

ask user devolve o controle à fábrica, em vez de manter uma ferramenta/Promise aguardando resposta remota:

1. O worker entrega pergunta e contexto ao controlador.
2. O controlador confirma o registro durável da pergunta e intenção de publicação.
3. O worker encerra a atividade da Execução, preservando sessão e artefatos.
4. Liberar o Slot somente após confirmar que a Execução deixou de estar ativa.
5. O controlador publica/reconcilia a pergunta e aceita somente resposta autorizada e correlacionada.
   A resposta permite nova Execução pela fila/categoria/ordem do Trabalho, após revalidar elegibilidade e dependências.

Encerrar ativação não significa apagar o ambiente do Trabalho. Falha de comunicação ou crash entre esses passos exige
reconciliação; não comprova ausência de publicação nem morte do escritor. Publicação/resposta podem ocorrer durante recuperação,
sem perder correlação ou autorizar disparo direto. O handshake exato pertence ao protocolo, não é uma API pronta alegada do SDK.

Preferir **retomar sessão compatível** do Builder. Se ela não puder ser reutilizada com segurança, criar substituta
com o contexto recuperado e registrar a troca/razão. Em ambos os casos fornecer especificação versionada,
pergunta/resposta, feedback autorizado e estado reconciliado de branch/worktree/PR, sem repetir cegamente a última ferramenta.
Contexto insuficiente para avançar com segurança produz bloqueio.

O SessionManager representa o contexto finalizado do SDK; o formato JSONL v3 documentado não é checkpoint de Git/GitHub/processos
nem autoridade de autorização, fila ou limites. Não restaurar apenas mensagens em memória ignorando seu contrato de persistência.
Não há promessa de preservar raciocínio interno, a mesma instrução ou migração universal entre runtimes.

### Revisores e validações

O Builder executa implement e **devolve o controle sinalizando que está pronto para revisão**.
O controlador dispara **Standards e Spec em paralelo**, em workers/sessões independentes, com objetivos e modelos próprios,
usando a **mesma VM e o mesmo workspace do Trabalho**, e em seguida alimenta a sessão existente do Builder com os resultados.
Durante as revisões o Builder não é executado em paralelo. O runtime fornece aos revisores ferramentas somente leitura.
A revisão cobre o conteúdo integral proposto, incluindo alterações não commitadas e arquivos novos; Spec recebe a especificação versionada.
Não exigir VM auxiliar, snapshot próprio, commit candidato obrigatório, checagem de worktree limpa ou auditoria genérica de quiescência
como gate intermediário para iniciar revisão. A exigência anterior de referência imutável foi retirada por decisão explícita do operador;
a garantia agora é o handoff cooperativo com Builder inativo durante a revisão, sem alegar congelamento do workspace contra escritores externos.

Revisores não recebem escrita, shell irrestrito ou credencial GitHub de escrita.
O isolamento também deve impedir modificar a worktree revisada: uma allowlist anunciada ao modelo não basta.
Enquanto o Builder aguarda essas revisões, seu Slot continua ocupado; revisores não consomem Slots adicionais.
Isso não limita o total de processos/chamadas de modelo ao número de Slots.

Registrar conclusão/falha de cada revisor, achados e tratamento pelo Builder (corrigido ou não acolhido com justificativa),
correlacionados ao conteúdo/spec/perfil. O Builder não pode fabricar ou dispensar a conclusão dos revisores.
Falha não equivale a ausência de achados; alterações posteriores relevantes invalidam a revisão antes da prontidão.
As regras exatas de cobertura/registro, invalidação, gates e dispensa humana ficam no contrato de skills/revisão,
sem acrescentar plataforma genérica de delegação, novo motor ou snapshot obrigatório ao handoff aprovado.
Validação não executada não é sucesso; dispensa humana não contorna checks obrigatórios.

### Retentativas, cancelamento e evidências

Desabilitar **retry automático de agente do SDK** (`retry.enabled: false`) e manter
**retry do provider em zero** (`retry.provider.maxRetries: 0`).
Retomadas após falhas operacionais são decididas pelo controlador, com limites persistentes, espera progressiva e reconciliação.
Falhas de autorização/configuração não entram em repetição automática. Não multiplicar limites do controlador por retries ocultos
nem trocar de modelo silenciosamente. Isso não proíbe o Builder de investigar falha de teste, corrigir código e testar novamente
na mesma Execução, nem altera a compactação de contexto. Um timeout de transporte não é timeout global da Execução.

Cancelamento usa o sinal/abort do SDK e a supervisão externa para confirmar cessação do worker e atividades associadas.
`abort()`/`dispose()` não provam encerramento de containers, processos desassociados ou efeitos GitHub já enviados.
O controlador impede novos disparos/renovações, reconcilia resultados externos e preserva artefatos, conforme autoridade/durabilidade.
O mecanismo de interrupção/exclusividade física será escolhido no isolamento e concretizado no protocolo.

Correlacionar eventos, sessão, ferramentas/comandos, revisores e configuração com Trabalho/Execução/papel.
`message_end` traz a mensagem finalizada; `agent_end` pode anteceder continuação automática e não comprova conclusão do ciclo.
`agent_settled` informa ausência de continuação automática pelo Pi, não sucesso dos gates nem cessação de todos os processos.
Nem texto final nem exit code isolado substituem evidências de revisão, validação, artefatos e prontidão verificada pelo controlador.

Capturar uso/custo quando disponíveis, incluindo revisores e tentativas falhas/abortadas; indisponível é distinto de zero.
Não exigir raciocínio interno nem publicar transcrições automaticamente no GitHub.
Localização, retenção, redaction e apresentação operacional de logs/sessões permanecem na névoa de observabilidade,
sem criar outra autoridade de controle.

### Encaminhamentos e provas antes do aceite

- [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](07-isolation-choice.md): workers separados,
  ferramentas de revisão sem escrita na mesma VM, proteção de estado/segredos, evidência de cessação e testes Docker concorrentes.
- [Definir estados, filas, persistência e reconciliação dos efeitos](08-state-and-effects-contract.md):
  IDs/transições, registro durável de pergunta/resposta, Slots e contadores sob a única autoridade.
- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md):
  mensagens, recibos, handshake de pergunta, eventos/resultados, sobreviventes, duplicatas e rejeição de gerações obsoletas.
- [Definir a captura versionada da especificação e das instruções](16-specification-snapshot-contract.md):
  snapshot das fontes/instruções, atualização autorizada de escopo e contexto de retomada/revisão.
- [Definir o pacote de skills e o contrato verificável de revisão e validação](17-skills-and-review-contract.md):
  distribuição explícita, integração de `implement`, `code-review` e `/pr`, cobertura integral, resultados, invalidação e gates.

Provas futuras incluem: instalar a combinação fixada sem recursos pessoais; alterar o perfil do operador sem afetar o worker;
verificar modelos/credenciais por papel e ausência de fallback; executar as skills próprias;
obter duas revisões paralelas sem escrita sobre o mesmo conteúdo integral e invalidá-las após mudança;
perguntar, confirmar suspensão/liberação de Slot e retomar com resposta autorizada;
retomar sessão compatível/substituir incompatível com contexto; observar falha de revisor/validação sem falso sucesso;
verificar retry interno desabilitado e limites persistentes; cancelar com subprocessos/containers;
recuperar crashes durante ferramenta e após push/PR/pergunta sem duplicar efeitos/escritores; agregar uso dos três papéis.
Cobrem especialmente CA-01/03/05/06/07/08/11/12, sem dispensar a cobertura final de CA-01–12.

**Esta resolução aprova o desenho, não demonstra essas provas.** Nenhum pacote, serviço, adaptador ou agente foi instalado/executado.
Falta decisiva de API/evidência ou prova reprovada exige investigação/retorno ao operador,
não relaxamento do PRD nem construção de um adaptador especulativo nesta cartografia.
