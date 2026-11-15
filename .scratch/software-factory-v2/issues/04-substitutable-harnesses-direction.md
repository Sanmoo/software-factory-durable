# Definir a direção da v2 para harnesses substituíveis

Status: resolved
Assignee: operador, assistido pelo agente desta sessão
Claim context: registro retrospectivo da entrevista aprovada; branch docs/v2-unified-map, worktree .worktrees/v2-unified-map/; destino main no checkout principal, sem push.
Type: grilling
Label: wayfinder:grilling
Map: [Software Factory v2 — ambientes reconstruíveis e harnesses substituíveis](../map.md)
Blocked by: none

## Question

Como permitir diferentes harnesses na fábrica, inclusive Claude Code com a assinatura do Operador,
sem perder continuidade do Trabalho nem criar comandos de troca, migração de transcripts ou um
segundo centro de decisão separado dos contratos de sandbox da v2?

## References

- [Direção aprovada para Lambda MicroVMs](01-lambda-microvms-direction.md#answer).
- [Contrato de sandbox a revisar](03-revised-sandbox-contract.md).
- [Pesquisa documental de assinatura Claude Code](../../software-factory/research/claude-code-subscription.md).
- [Runtime aprovado do MVP](../../software-factory/issues/06-agent-runtime-choice.md#answer).

## Comments

- O operador aprovou a direção em entrevista e corrigiu duas premissas: uso próprio é do Operador
  da instalação, não de uma pessoa específica; troca ocorre por parada, configuração e reinício,
  não por comando de troca da fábrica. A restrição inicial de manter um Trabalho no mesmo harness
  foi substituída pela continuidade via sessão substituta, em alinhamento à direção da v2.
- A proposta inicial de mapa separado foi substituída, com aprovação do operador, por um único
  mapa v2: trilhas de sandbox e harness podem investigar em paralelo, mas convergem nas decisões
  de composição e no PRD/spec integrado. Nenhuma prova foi executada nesta resolução.
- Validação documental do registro: nove documentos v2 e ponteiro de roadmap do MVP, 91 links/âncoras
  locais válidos, oito tickets com dependências acíclicas e fronteira 02/05; direção e protótipo Lambda
  preservados salvo o título do link do mapa. `git diff --check` e probe LSP nos dez arquivos sem
  erros/warnings. Não houve teste de runtime nem validação de credenciais ou recursos externos.

## Answer

### Objetivo e âmbito

Permitir harnesses substituíveis por adapters que satisfaçam os contratos obrigatórios da fábrica,
começando por Pi e Claude Code oficial. Não prometer compatibilidade universal nem criar framework
especulativo de plugins, descoberta dinâmica ou roteamento automático.

Uso próprio significa uma instalação operada por seu Operador, que pode ser outra pessoa no futuro
e usar sua própria assinatura pelo fluxo oficial permitido pelo fornecedor. Não compartilhar contas,
extrair/intermediar credenciais nem oferecer a assinatura como backend para terceiros. A pesquisa
é evidência de entrada: permissões aplicáveis e condições atuais devem ser revalidadas para a prova.

Harness identifica o executor do loop de agente e sua sessão nativa; sandbox identifica o ambiente
de execução das ferramentas. Suas escolhas são distintas, não uma promessa de todas as combinações.
Builder, Standards e Spec podem ter harnesses configurados independentemente. Incompatibilidade de
papel, perfil ou combinação produz diagnóstico; não autoriza relaxar permissões nem fallback silencioso.

### Reconfiguração, não operação de troca

Não haverá comando de troca de harness em operação. O fluxo é parar a fábrica, alterar a configuração
e reiniciar sequencialmente. Registrar o perfil efetivo por Execução. Antes de admitir nova Execução,
reconciliar sobreviventes, confirmar cessação e resolver efeitos externos de resultado incerto.
Uma Execução em andamento não muda de harness; falta de quota/indisponibilidade é condição visível,
não gatilho para outro harness, modelo ou cobrança API.

Continuidade do Trabalho não exige continuidade da sessão nativa. No reinício, continuar a sessão
somente quando compatível; mudança de harness abre sessão substituta, sem conversão de transcript.
O Trabalho mantém identidade, histórico, consumo e controles; reiniciar não zera limites/tentativas.

A recuperação recebe pedido e instruções versionadas, estado Git confirmado e registros relevantes
(perguntas, respostas e pareceres). Resumo do executor anterior pode ajudar, mas não é requisito de
recuperação após crash. O controlador fornece referências/registros, não passa a interpretar código
ou produzir resumos semânticos. A localização e o formato mínimo dessa entrega precisam ser definidos
pelos tickets seguintes, sem exigir um formato universal de conversa.

Preservação confirmada, interrupção sem publicação e perda do ambiente são situações distintas.
Seguir a direção v2 de Git remoto/reconstrução, sem exigir disco permanente, workspace no host ou
migração de sessão. Perda antes do push pode perder trabalho local desde o último estado remoto,
com ocorrência/consumo visíveis; efeitos externos incertos não são apagados pela sessão substituta.

### Garantias e prova exigida

Preservar autoridade do controlador sobre filas, Slots, autorização, perguntas, revisão e recuperação;
confinamento por papel, revisores tecnicamente somente leitura, cessação confirmável e ausência de
fallback silencioso. Não enfraquecer garantias para acomodar um harness. Mecanismos do MVP não são
invariantes universais da v2, mas relaxamentos de propriedades exigem decisão explícita.

A prova deve cobrir Claude como Builder, Standards e Spec, primeiro isoladamente se útil e depois no
fluxo combinado, com Builder inativo durante a revisão e dois pareceres devolvidos à sua continuidade.
Cobrir perguntas persistidas/suspensão/retomada, ferramentas confinadas, impedimento real de escrita,
cancelamento/crash sem escritores concorrentes e reconciliação sem repetição cega de efeitos.

Demonstrar Pi → Claude e Claude → Pi no mesmo Trabalho por parada, reconfiguração e reinício,
a partir de estado preservado e contexto explícito. Não exigir Lambda para a prova local dessas
propriedades; não confundir essa evidência com homologação da composição final com Lambda.
Fixtures/mocks ajudam a validar integração determinística, mas não substituem evidência com Claude
real nos pontos dependentes dele. Usar repositório descartável e falhas induzidas no escopo autorizado.

Classificar cada critério como aprovado, reprovado ou inconclusivo. Quota insuficiente ou autenticação
expirada não prova incompatibilidade nem sucesso. Critério obrigatório sem evidência impede aprovação
da integração. Divergências retornam ao operador, sem redesenho ou fallback pago silencioso.

### Planejamento e autorização

Um único mapa v2 coordena sandbox e harness, com provas próprias e convergência explícita dos
contratos compartilhados. Primeiro localizar a interface existente e especificar a prova; somente após
resultados e decisão de viabilidade consolidar a interface implementável e adapters no PRD/spec da v2.
Não congelar agora métodos/interfaces TypeScript nem criar camada redundante sobre Workers.

Esta resolução autoriza o registro do planejamento, não login, uso de credenciais, consumo de modelos,
provisionamento, instalação no host ou implementação de produção. A prova exige autorização específica
de ambiente, autenticação, limites de consumo/prazo e cleanup. MVP e decisões anteriores permanecem
intactos; aprovação documental não equivale ao aceite funcional da v2.
