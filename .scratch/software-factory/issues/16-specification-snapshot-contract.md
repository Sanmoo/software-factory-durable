# Definir a captura versionada da especificação e das instruções

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão Pi `01a1a3db-e43d-72a8-8dc8-48f1e6e01937`; branch `software-factory-specification-snapshot`, worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-specification-snapshot`. Destino de integração: `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`; sem publicação de `main`. Decisão HITL confirmada; branch/worktree de registros históricas, removíveis após integração e validação.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 01, 06

## Question

Qual contrato de captura e versionamento entrega ao Builder e ao revisor Spec uma especificação inequívoca por Execução,
sem incorporar silenciosamente mudanças de escopo ou herdar o perfil do operador?

Definir o conteúdo mínimo do snapshot do ticket e dos documentos explicitamente referenciados, identidade/versão das fontes,
tratamento de links indisponíveis ou mutáveis, instruções aplicáveis do repositório e sua precedência em relação à política da fábrica.
Separar especificação autorizada, instruções, perguntas/respostas e feedback operacional; definir como uma atualização autorizada
produz nova versão de especificação e chega à próxima Execução sem sobrescrever a referência usada anteriormente.

Explicitar o contexto necessário para retomar uma sessão compatível ou criar uma substituta e para a revisão Spec.
O perfil executável é próprio da fábrica: ler AGENTS.md não autoriza carregar plugins, settings, skills ou credenciais automaticamente.
Identificar a relação entre versão da especificação, base do repositório e perfil da Execução, sem duplicar a autoridade de filas/estado.
Desenhar contratos e exemplos de mudança de escopo/crash/fonte inacessível, não implementar captura nem executar agentes.

## References

- [Definir a fronteira mínima entre controlador e builder](01-control-authority.md): autoridade e precedência da política da fábrica.
- [Escolher o runtime de agentes e seus pontos de integração](06-agent-runtime-choice.md): SDK, perfil próprio e retomada/substituição de sessão.
- [Definir o pacote de skills e o contrato verificável de revisão e validação](17-skills-and-review-contract.md): consumidor do snapshot na revisão Spec.
- [PRD — Software Factory MVP](../prd.md): RF-05–06, RF-09–10 e RNF-01/05.

## Comments

- Graduado da névoa após a escolha do SDK e do perfil totalmente independente do operador.
- Decisão HITL: operador determinou a entrada mínima em Q1; aprovou preservação após esclarecer Q3,
  Q4, Q5–Q6, Q7–Q9 e Q12. As propostas intermediárias de captura anterior ao Builder,
  ingestão/verificação documental pelo controlador e repetição de `/implement` foram corrigidas na conversa.
- Confirmação final de Q10/Q11: “okay, de acordo, com as observações que você fez agora”.
  A resolução abaixo consolida as aprovações e substitui as propostas intermediárias; não houve implementação ou prova.

## Answer

### Entrada mínima e responsabilidade

A primeira chamada ao Builder é **`/implement <link-ticket>`**, com ferramentas de consulta ao tracker.
O Builder busca o contexto que julgar necessário. O controlador não monta previamente um pacote documental,
não percorre links pelo agente e não recebe um pacote de captura para ingestão.
O MVP permanece em GitHub; a referência a Jira/outros trackers na conversa não amplia o escopo do PRD.

Política, ferramentas, credenciais e perfil independente da fábrica continuam sendo configuração do ambiente;
a entrada mínima não os remove nem autoriza herdar o perfil do operador.
Ticket, repositório e branch-base permanecem identificáveis no contexto do Trabalho.

A própria skill `implement` orienta o Builder a consultar e preservar o pedido antes de implementá-lo.
A captura ocorre no início da primeira Execução, **não na admissão à fila nem antes de iniciar o Builder**.
Não exige uma segunda aprovação humana para a entrada já autorizada.

### Conteúdo e identidade das versões

Preservar o conteúdo consultado do ticket e dos documentos usados como especificação, não apenas um resumo do modelo.
O ticket e seus documentos explicitamente referenciados continuam sendo a especificação mínima do PRD;
a liberdade de investigar não autoriza omitir requisitos ou ampliar silenciosamente o pedido.

Distinguir:

| Conteúdo | Papel |
| --- | --- |
| Ticket e documentos do pedido | Especificação do que entregar |
| Instruções aplicáveis do repositório | Convenções, validações e modo de trabalhar |
| Perguntas/respostas, reviews e comandos autorizados | Contexto operacional; não substituem implicitamente a especificação |
| Documentação de biblioteca e outros materiais de investigação | Referência auxiliar; consulta não transforma o material em requisito |

Cada versão possui cópias e um registro simples das fontes: origem, data de consulta, hash do conteúdo
e commit/revisão quando disponível. Referenciar a versão usada por Execução; várias Execuções podem usar a mesma.
Identidade da especificação, referências Git de base/trabalho e versão do perfil da fábrica são registros distintos:
rebase ou atualização de runtime não alteram automaticamente o pedido.

Não exigir que uma página externa tenha versionamento próprio, nem prometer captura simultânea/atômica de todas as fontes.
Conteúdo preservado com origem/data/hash identifica a leitura efetivamente usada.
Documento necessário descoberto depois é registrado; o Builder verifica se complementa o pedido ou implica mudança de escopo
que exige autorização. Preservar versões anteriores, sem reescrever o histórico do que já foi usado.

### Armazenamento direto pelo Builder

O Builder escreve as cópias e o registro de fontes, com ferramentas normais de escrita,
em um **diretório de artefatos do Trabalho**, acessível aos revisores e fora das alterações destinadas ao PR.
Ele organiza as versões e não sobrescreve as anteriores.

Não há mensagem de solicitação de armazenamento, API de ingestão, coletor de contexto ou validador de snapshots
no controlador. “A fábrica conserva” significa manter os arquivos escritos pelo Builder junto dos recursos do Trabalho,
inclusive nas esperas e retomadas, não processar um pacote documental.

A skill distingue captura incompleta de concluída — por exemplo, escrevendo o registro final somente após as cópias.
Uma captura interrompida não pode ser apresentada como especificação completa para revisão/retomada.
Essa disciplina não é certificação semântica pelo controlador, prova de que o Builder encontrou todas as fontes
nem garantia de imutabilidade contra código hostil.

A concretização do layout e do consumo dos artefatos pertence ao
[contrato de skills e revisão](17-skills-and-review-contract.md);
disponibilização no ambiente e retenção seguem os contratos do
[adapter Gondolin](19-gondolin-adapter-contract.md) e de
[observabilidade e retenção](22-observability-retention-contract.md).
Não criar outro banco, motor ou protocolo documental para cumprir essa decisão.

### Fontes indisponíveis e conteúdo posterior

Fonte necessária inacessível, incompleta ou inutilizável leva a `ask user` para obter conteúdo acessível
ou orientação explícita. Não inventar requisitos nem omitir o documento.
Isso inclui documento privado de outro repositório que o token restrito do Builder não pode ler, conforme aprovação na
[revisão cruzada](23-architecture-cross-review.md). Não há busca documental genérica pelo controlador, ampliação de token ou
ferramenta adicional de consulta entre repositórios no MVP. Leitura das relações nativas de dependência pelo controlador é outra operação
e permanece obrigatória; não concede ao Builder acesso documental adicional.
Falha em fonte meramente auxiliar pode ser contornada procurando outra, sem bloqueio automático do Trabalho.
Uma cópia já preservada permanece utilizável se o link ficar indisponível depois.

Reler o ticket não autoriza incorporar novo escopo. Ao encontrar mudança no pedido, o Builder a reporta e solicita
autorização antes de incorporá-la; ambiguidade exige `ask user`.
Uma edição posterior não substitui silenciosamente a especificação nem é, por si só, novo gatilho de reparo.
Elegibilidade, fechamento, cancelamento e gatilhos operacionais mantêm as regras já aprovadas.

Uma resposta explícita, autorizada e correlacionada a uma pergunta sobre mudança de escopo pode autorizar essa mudança,
**sem segundo comando obrigatório**. A autoridade do controlador continua sendo validar/registrar a resposta ou comando,
não decidir o conteúdo da especificação.
A próxima Execução incorpora e preserva a nova versão antes de implementar a mudança.

A autorização se refere à mudança concreta discutida, não a qualquer conteúdo futuro do link.
Esclarecimento operacional não é autorização genérica: responder qual separador usar no CSV não autoriza acrescentar outro formato.
A nova versão não apaga a anterior nem transforma feedback comum em requisito autorizado.

### Instruções do repositório e precedência

O Builder lê instruções aplicáveis aos caminhos em que trabalha, inclusive `AGENTS.md`,
e registra os conteúdos e referências Git utilizados.
Instruções mais específicas prevalecem dentro de seu escopo, sempre subordinadas à política da fábrica.
Conflitos sem solução clara passam por `ask user`; conteúdo consultado não amplia poderes, dispensa limites ou autoriza merge.

Leitura de instruções não carrega automaticamente plugins, settings, skills, templates ou credenciais.
Recursos executáveis exigem inclusão explícita no perfil versionado da fábrica, conforme a decisão de runtime.
Alterações que o próprio Builder faça nas instruções não autorizam, por si só, redução dos gates do seu Trabalho.

### Revisão, retomada e substituição de sessão

Spec consulta a versão preservada usada na implementação, não presume que o conteúdo atual do link seja o pedido vigente.
Standards recebe as instruções aplicáveis; ambos continuam sujeitos ao handoff, às permissões e às regras de revisão já aprovados.
A captura documental **não reintroduz snapshot da worktree**, commit obrigatório, worktree limpa ou outro gate retirado
na decisão de isolamento. O controlador não passa a certificar a especificação capturada.

| Situação | Ativação e contexto |
| --- | --- |
| Primeira chamada | `/implement <link-ticket>`; o Builder investiga e preserva o pedido |
| Sessão compatível retomada | `continue`, acompanhado da resposta, feedback ou motivo da retomada quando houver |
| Sessão indisponível/incompatível | Instrução de recuperação identificando o Trabalho e seus artefatos, para recuperar contexto e continuar |

Não reiniciar a skill nem repetir o pedido inteiro em cada retomada compatível.
Exemplo: “A resposta à sua pergunta foi X. Continue.”
Um `continue` isolado não basta para uma sessão substituta que não tem a conversa anterior.

Na recuperação, os registros disponíveis incluem especificação preservada, instruções, perguntas/respostas,
feedback autorizado e referências reconciliadas de branch/worktree/PR.
O agente consulta esses registros; não precisa receber um pacote documental montado pelo controlador.
Transcript é contexto útil, não substituto desses registros nem autoridade de fila, autorização ou efeitos.
Contexto insuficiente exige pergunta/bloqueio, não reconstrução presumida a partir do ticket atual.
Reconciliação e exclusividade antes de retomar seguem os contratos de estados e runtime.

### Cenários e validação futura

| Cenário | Resultado esperado |
| --- | --- |
| Ticket pede CSV; depois alguém acrescenta PDF | Spec consulta o pedido preservado; Builder não incorpora PDF sem autorização |
| Operador aprova PDF; depois surge XLSX no link | Próxima Execução incorpora apenas a mudança autorizada; ambiguidade gera pergunta |
| Documento necessário inacessível na primeira consulta | `ask user`; não inventar ou omitir requisitos |
| Documento fica indisponível após captura completa | Revisão/retomada usam a cópia preservada |
| Crash durante escrita das cópias | Captura permanece incompleta; não tratá-la como versão final nem aceitar conteúdo posterior como equivalente sem verificar |
| Crash após captura, com sessão compatível | Reconciliar o Trabalho e continuar usando registros preservados, sem recapturar silenciosamente o pedido atual |
| Sessão perdida/incompatível | Instrução de recuperação e leitura dos artefatos; ausência de contexto necessário gera bloqueio |
| Builder altera instruções para dispensar testes | Alteração não autoriza por si só redução dos gates |
| Rebase sem mudança autorizada do pedido | Referências Git mudam; a versão da especificação não muda automaticamente |

Esses cenários orientam as provas posteriores de RF-05–06, RF-09–10, RNF-01/05 e CA-01/05/06/12.
Nenhum agente, mecanismo de captura ou experimento foi executado; esta resolução aprova o contrato, não comprova sua implementação.

### Encaminhamentos

- [Definir o pacote de skills e o contrato verificável de revisão e validação](17-skills-and-review-contract.md):
  concretizar layout/registro documental, disciplina de captura completa e acesso dos revisores, sem ingestão pelo controlador.
- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md):
  aplicar primeira ativação, continuação e recuperação, mantendo autorização e correlação de Execuções sem transporte de snapshots.
- [Definir o contrato e o perfil distribuível do adapter Gondolin](19-gondolin-adapter-contract.md):
  disponibilizar os artefatos do Trabalho para Builder e revisores com as permissões já aprovadas.
- [Definir o fluxo de manutenção e reconciliação autorizada do PR](20-pr-maintenance-contract.md):
  consumir feedback/mudança autorizados sem recaptura silenciosa de escopo.
- [Definir observabilidade, proteção de segredos e retenção dos artefatos](22-observability-retention-contract.md):
  preservar o contexto documental necessário aos Trabalhos abertos conforme a retenção do PRD.

Os encaminhamentos já possuem tickets; não criar uma nova plataforma documental nem duplicar essas decisões.
