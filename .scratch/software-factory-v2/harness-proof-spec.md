# Prova local de harnesses substituíveis — Pi e Claude Code

Asset de [Especificar a prova de harnesses substituíveis com Pi e Claude Code](issues/06-harness-proof-spec.md).

Estado: spec aprovada explicitamente pelo Operador após leitura do asset. Execução solicitada em seguida, sujeita ao preenchimento do gate operacional abaixo.
**Não executada. Aprovação documental não autoriza execução nem implementação de produção.**

## Problem Statement

O Operador quer saber se Claude Code oficial pode ocupar o lugar de Pi nos papéis da fábrica,
sem perder autoridade do controlador, confinamento, devolução de controle ou continuidade do Trabalho.
A viabilidade documental não demonstra esse encaixe. Revalidar toda a fábrica, porém, obscureceria
essa pergunta e ampliaria desnecessariamente o experimento.

A prova usa como base imutável o MVP no commit `aabe06abfb20e83593020c0fee19b078d235466b`.
Na preparação desta spec, a branch `integration/software-factory-mvp` e sua worktree existente
estavam nesse SHA; `main` continha os registros de planejamento, não foi tomada como implementação.
Nenhuma implementação mais recente foi usada. Futuro uso de outra referência exige registrar SHA,
diferenças relevantes e impacto no desenho, antes de autorizar a execução.

## Solution

Uma prova local descartável, em três jornadas e dois desvios de recuperação, testa somente as
fronteiras afetadas pelo harness. Workers é o seam principal candidato; Sandbox, Records, Protocol
e Controle permanecem referências existentes, não uma nova arquitetura ou bateria de regressão.

A conclusão será delimitada ao perfil testado: resultado por critério, aceite do conjunto local e,
separadamente, decisão posterior de adoção/composição. Mesmo sucesso integral não homologa Lambda
nem produção. Falhas voltam ao Operador; não autorizam redesenho, relaxamento ou fallback silencioso.

## User Stories

1. Como Operador, quero avaliar Claude oficial como Builder, para saber se ele executa uma tarefa pelas ferramentas autorizadas.
2. Como Operador, quero avaliar Claude como Standards e Spec, para manter duas revisões com objetivos distintos e somente leitura.
3. Como Operador, quero receber dois pareceres na continuidade do Builder, para distinguir revisão entregue de revisão efetivamente consumida.
4. Como Operador, quero configurar harness por papel, para não tornar todos os papéis dependentes da mesma escolha.
5. Como Operador, quero verificar que o caminho Claude não contorna projeções e filtragem, para preservar as garantias existentes sem revalidá-las integralmente.
6. Como Operador, quero que pergunta e revisão devolvam o controle, para não haver atividade oculta do Builder durante a espera.
7. Como Operador, quero interromper Claude e confirmar cessação, para não admitir outro escritor enquanto o anterior ainda pode produzir efeitos.
8. Como Operador, quero mudar Pi → Claude e Claude → Pi por parada, configuração e reinício, para continuar o mesmo Trabalho sem comando de troca em operação.
9. Como Operador, quero reconstruir o ambiente do remoto e fornecer contexto explícito, para não depender de disco nem de conversão de transcript.
10. Como Operador, quero preservar identidade, histórico, consumo e limites do Trabalho, para que reconfiguração não os reinicie.
11. Como Operador, quero que perda antes do push e efeitos incertos sejam explícitos, para não recuperar um estado fictício nem repetir ações cegamente.
12. Como Operador, quero distinguir evidência real, dublês e ausência de observação, para não aprovar compatibilidade por suposição.
13. Como Operador, quero conhecer o perfil exato e autorizar a execução separadamente, para controlar autenticação, recursos e consumo.
14. Como Operador, quero evidências sanitizadas e cleanup verificável, para não deixar processos, ambientes ou credenciais descartáveis esquecidos.

## Implementation Decisions

### Hipótese e fronteiras

- Pi e Claude executam seus loops no host. Ferramentas operam no guest Gondolin local.
- Claude usa binário oficial inalterado via Agent SDK, sem built-ins e com MCP explicitamente definido.
  Não usar ferramentas nativas encaminhadas por hooks como substituto implícito da fronteira Sandbox.
- Refinar Workers é hipótese de encaixe. O experimento pode conter integração descartável mínima;
  não define interfaces TypeScript, registry de plugins ou adapters de produção.
- Backend confinado e filtragem existentes são base, com limitações conhecidas. Verificar o caminho
  Claude até essas fronteiras, não repetir suas baterias internas nem alegar nova homologação delas.
- Não criar controlador alternativo completo, segundo banco de domínio ou plataforma de observabilidade.
  Registros mínimos de teste podem preparar estado e registrar eventos, mas não comprovam durabilidade
  de produção. Evidência deve identificar quais operações usaram Controle/Records reais ou fixtures.
- SDK, CLI e loop no guest não são alternativas automáticas. Impedimento da hipótese exige resultado
  explícito e retorno ao Operador. Harness, modelo, sandbox ou cobrança não mudam silenciosamente.

### Git e diferenças deliberadas da v2

O remoto será um servidor/repositório Git local descartável, separado dos clones de execução,
acessível pelo guest com permissões mínimas. Commit, push, consulta ao remoto, descarte do clone e
reconstrução serão reais. Isso não comprova autenticação GitHub App, transporte GitHub ou PR real.
O perfil deve explicar como o guest acessa o remoto sem expor o restante do filesystem host.

O MVP fixado exige ambiente reutilizado na recuperação e separa implementação de publicação,
proibindo push no modo de implementação. A prova não altera esses contratos ou prompts do MVP.
Usará roteiro e instruções v2 descartáveis, com autorização explícita de WIP/push no remoto de teste:

1. Antes de espera humana normal, Builder faz commit/push seguro, inclusive WIP.
2. Gate no guest confirma workspace limpo, incluindo untracked não ignorados, ausência de stash e
   HEAD igual à branch efetivamente consultada no origin; tracking ref local não basta.
3. Falha recuperável retorna ao Builder dentro dos limites autorizados. Sem correção possível,
   cessar e reportar bloqueio operacional, não espera preservada. Nunca forçar publicação de segredo.
4. Retomada em clone novo parte do remoto confirmado; não exige workspace host ou checkpoint alternativo.

Isso demonstra participação do harness no fluxo proposto, **não recuperação v2 implementada**.
Arquivos ignorados são descartáveis/reconstruíveis. Nenhum push externo é previsto nesta prova;
o push local futuro da fixture não é publicação das branches deste repositório.

### Suspensão, retomada e autoridade

- O controlador decide admissão, pergunta, revisão, autorização e retomada. Subagentes nativos do Claude
  não substituem as duas revisões da fábrica.
- Encerrar uma ativação e retomá-la é mecanismo admissível de suspensão; não exigir processo estacionado.
  Sessão nativa pode continuar se compatível ou ser substituída com motivo registrado.
- Após a barreira de suspensão, Builder não inicia inferências nem ferramentas. Efeitos em andamento
  precisam de reconciliação/cessação antes de liberar capacidade ou admitir substituto.
- Promise MCP aguardando humano e silêncio no stream não são evidência de suspensão.
- Pergunta persistida, ACK durável e apresentação ao humano são marcos distintos. Persistência precede
  ACK; gate precede apresentação como espera preservada. Resposta só produz atividade por nova admissão.
- Manter sessão inativa não exige cessar revisores autorizados. Durante revisão, a inatividade exigida
  é a do Builder; durante pergunta, não pode permanecer atividade do Trabalho esperando o humano.

### Contexto independente de conversa

Trocas e reconstruções não recebem transcript anterior nem resumo do executor anterior. Recebem:

- pedido, instruções e autorização versionados;
- identidade do Trabalho, Execuções e boots, histórico relevante e limites/consumo acumulados;
- repositório, base, branch e OIDs remotos confirmados;
- perguntas/respostas e pareceres relevantes completos;
- gates vinculados ao conteúdo e efeitos pendentes/ambíguos.

O controlador entrega registros/referências, não interpreta código para produzir resumo semântico.
Sessões antigas ficam preservadas como evidência durante o ensaio, mas inacessíveis ao novo executor.
Reconfiguração é sequencial: parar, confirmar cessação e reconciliar efeitos, alterar configuração,
reiniciar. Nenhuma Execução em andamento muda de harness.

### Perfil e versões

Antes da autorização de execução, um manifesto deve fixar commit do experimento, SHA de referência,
versões exatas de Node, Pi/patches, Claude Code, Agent SDK, Gondolin e auxiliares; harness/modelo por
papel; instruções e hashes; ferramentas, políticas e configuração efetivamente carregadas; modalidade
nativa de autenticação por harness, sem segredos. Registrar também data e identificador de modelo
exposto pelo fornecedor: serviço remoto não é necessariamente reproduzível por versão imutável.

O MVP declara Node 24.21.0, Pi coding-agent 1.5.2, Pi Durable 1.5.0 e Gondolin 0.14.0; são referências,
não homologação da nova combinação. Não foi escolhida versão Claude/SDK nesta sessão. Os mínimos
citados pela pesquisa não constituem perfil completo. Congelar combinação documentalmente compatível
com os mecanismos utilizados; manifesto incompleto impede executar. Atualização posterior gera novo
perfil e reavaliação dos critérios afetados, sem upgrade automático no meio da campanha.

## Testing Decisions

### Princípio e preparação

Testar comportamento observável na fronteira mais alta suficiente: ativar um papel por Workers,
entregar/observar eventos e interromper, exercitando ferramentas através das projeções existentes.
Não aprovar propriedade por mock que implementa o próprio resultado esperado.

Usar uma fixture pequena de alteração textual ou lógica determinística, com pedido, padrões e teste
simples versionados, sem código privado, segredos reais ou dependências externas desnecessárias.
A correção do resultado da tarefa deve ser verificável sem avaliar apenas a autodeclaração do modelo.
Reaproveitar ativações para várias evidências; falha ou ausência de etapa não aprova etapas futuras.

### Jornadas e critérios obrigatórios

| Jornada | Procedimento e fronteira real | Critérios/evidências |
| --- | --- | --- |
| J1 — Claude trabalha e revisa | Claude Builder resolve a fixture; Standards e Spec Claude revisam; Builder recebe ambos os pareceres. Ensaios dirigidos tentam escrita pelo revisor, traversal/symlink, ferramenta host e saída com canário. | C1: tarefa verificável e três papéis efetivos. C2: dois pareceres distintos, entrega e consumo observados. C3: zero novos pedidos de modelo/tools do Builder durante revisão. C4: backend recusa escrita/acesso fora da projeção, filesystem permanece intacto e inventário não oferece built-ins/MCP extras. C5: canário bruto não chega ao harness nem à persistência nativa. |
| J2 — Claude devolve controle | Builder altera fixture, preserva WIP e pergunta; resposta admite retomada. Ensaio curto separado interrompe Claude durante ferramenta com atividade guest observável. | C6: remoto confirmado e gate antes da espera, pergunta persistida antes do ACK, nenhuma atividade aguardando humano e retomada correlacionada. C7: cessação confirmada de worker/binário/MCP/descendentes e operação guest antes de liberar capacidade/substituir; nenhum escritor concorrente. |
| J3 — Continuidade | Mesmo Trabalho Pi → parada → Claude → parada → Pi, com clone reconstruído em cada passagem e sem transcript/resumo anterior. Distribuir revisões para Builder Pi/revisores Claude e Builder Claude/revisores Pi. | C8: ambas as direções, perfis por papel e sessões substitutas identificadas. C9: tarefa continua a partir do origin e dos registros explícitos, preservando identidade/histórico/limites/consumo, sem reset ou conversão de conversa. C10: dois arranjos mistos completam revisão e retorno dos pareceres sob controle externo. |

J1 inclui tentativas dirigidas determinísticas na projeção real; não depender de o modelo espontaneamente
emitir um ataque. Distinguir recusa no wrapper, ausência no inventário e recusa pelo backend.
Para C5, usar somente canários sintéticos em saída normal, chunks/erros e progresso dos canais
habilitados, com falha de filtro dirigida e bloqueio sem entrega bruta. Inspecionar entrada do harness,
transcript e auxiliares do perfil descartável; não basta filtrar o relatório final. Canais multimodais
não necessários ficam desabilitados, com recusa verificada. Não executar bateria geral de Records.

Dois desvios limitados da J3:

- **D1 / C11 — perda antes do push:** criar mudança local não publicada e descartar o ambiente.
  Reconstrução real deve mostrar somente o remoto; ocorrência e consumo ficam registrados e o novo
  executor recebe perda explícita, sem contexto que presuma o arquivo desaparecido.
- **D2 / C12 — efeito externo incerto:** fixture registra efeito simulado de resultado indeterminado.
  A retomada respeita o impedimento de repetição até reconciliação autorizada. Serviço/dublê registra
  tentativas; não se alega teste de GitHub real ou de toda a máquina de recuperação do controlador.

### Dublês versus execução real

| Elemento | Tratamento |
| --- | --- |
| Pi/Claude, SDK, ferramentas/projeções, filtragem até entrada/persistência do harness | Reais nos critérios que dependem deles; modelo dublado não aprova comportamento Claude. |
| Gondolin, filesystem, operação guest interrompida e Git remoto/reconstrução | Reais; infraestrutura local descartável, não Lambda. |
| Estados prévios, resposta humana de fixture, falhas pontuais e efeito externo incerto | Podem ser preparados/injetados deterministicamente; registrar exatamente o que foi simulado. |
| Controle/Protocol/Records existentes | Reutilizar onde suficiente; substituir trechos só para preparar o ensaio mínimo, identificando o limite da evidência. Não declarar integração completa com controlador se ele foi dublado. |
| Quota/auth expirada ou erros que não ocorram naturalmente | Simulação opcional da reação local, não comprovação do sinal do fornecedor. Não provocar exaustão real nem alterar credencial pessoal. |

### Oráculos e evidências

- Manifesto e inventário efetivos, não somente opções solicitadas ou prompt de proibição.
- Linha do tempo correlacionada por Trabalho/Execução/papel: admissão, pedidos de modelo,
  ferramentas, pergunta/ACK, suspensão, pareceres, retomada e parada.
- Observar início de pedido na fronteira real do harness quando tecnicamente disponível, sem
  interceptar TLS, modificar binário Claude ou capturar credenciais. Se a API só expõe stream e
  não permite comprovar ausência de novos pedidos, C3/parte pertinente de C6 é inconclusiva.
- Inventário/término de processos e operação guest, não apenas exit code ou ACK de interrupt.
  Término local não prova que o fornecedor cessou processamento/cobrança de pedido já enviado;
  registrar essa incerteza, sem contabilizar ausência de métrica como zero.
- OIDs consultados no remoto, gate, clones/boots, diff final, pareceres e marcadores das tentativas
  recusadas. Preservar a evidência mínima sanitizada; não criar plataforma nova de telemetria.
- Distinguir consumo observado, estimado, indisponível e limite inferior; custo estimado não é fatura
  nem saldo da assinatura. Registrar pedidos em voo de consumo desconhecido na interrupção.

### Roteiro e comandos previstos

Esta spec não introduz comandos de produção. O executor futuro registra comandos exatos do runner
no manifesto após construir o código descartável e antes de pedir autorização. Não inventar agora
flags de SDK ou um executável inexistente. O roteiro mínimo é:

1. Conferir SHA/perfil e pré-requisitos, sem instalação implícita; criar somente recursos autorizados.
2. Preparar origin descartável e clone acessível no guest; ativar papéis com configuração explícita.
3. No guest, usar operações Git usuais: `git status --porcelain --untracked-files=all`,
   `git stash list`, `git rev-parse HEAD`, `git ls-remote origin refs/heads/<branch>` e commit/push
   na branch da fixture. Comparar OIDs explicitamente, não considerar saída vazia uma confirmação.
4. Rodar J1/J2/J3 e os dois desvios; parar/configurar/reiniciar entre harnesses, sem comando de troca.
5. Reconstruir por `git clone --branch <branch> <origin> <novo-clone>` em novo ambiente autorizado,
   conferir OID e entregar contexto independente de transcript.
6. Coletar relatório por critério e executar cleanup autorizado. Nenhum desses comandos foi executado.

### Resultado e precedentes

- **Aprovado:** comportamento exigido observado com evidência suficiente na fronteira pertinente.
- **Reprovado:** violação demonstrada ou resultado contrário ao critério.
- **Inconclusivo:** falta de observação ou pré-condição, inclusive quota insuficiente/login expirado.
- C1–C12 são obrigatórios; qualquer obrigatório não aprovado impede aceite do conjunto local.
  Um caso pode ter resultados diferentes por critério. Etapas não realizadas permanecem inconclusivas.
- Sucesso local só se aplica ao perfil e fronteiras realmente usados. Adoção/composição é decisão
  posterior; não inferir segurança de produção nem sucesso de Lambda.

A [pesquisa do seam](research/execution-seam.md) documenta precedentes E18 (jornada integrada), E26
(cessação/recuperação), E28 (parecer parcial) e E33 (compatibilidade/upgrade) do SHA fixado. Usá-los
como base com seus limites, não repetir suas matrizes nem transferir conclusões para Claude.

Rastreabilidade T1–T10: T1 → J1/J3; T2 → C4; T3 → C3/C6; T4 → J2/gate; T5 → C5;
T6 → C7; T7 → J3; T8 → J3/D1/D2. T9 → manifesto/checklist e diagnóstico, sem exigir esgotamento
real de quota. T10 → compatibilidade na reconfiguração e precedentes do MVP; recuperação integral
de parecer parcial/upgrade não é uma bateria desta prova. Os cenários são entrada, não desenho
integralmente adotado. Esses cortes não dispensam garantias de produção; delimitam evidência local.

## Out of Scope

- Regressão geral do controlador, filas, Slots, contabilidade, Protocol, Records e Gondolin.
- Matriz completa de crashes/ACK, upgrade, review parcial e combinações de modelos/harnesses.
- Alterar MVP, PRD/spec vigentes, implementar interface/adapters de produção ou recuperação v2 completa.
- Provar Lambda, SSH/WebSocket, Docker/Testcontainers, rede AWS ou composição final.
- GitHub/PR reais e autenticação GitHub App; multimodal habilitado; dados privados ou segredos reais.
- Migração de transcripts, comando de troca em operação, framework universal ou fallback automático.
- Login, modelos, credenciais, instalações, infraestrutura ou push externo nesta sessão documental.

## Further Notes

### Checklist curta antes da execução — autorização separada

A aprovação desta spec não preenche nem dispensa estes itens:

- [ ] Manifesto completo e perfil efetivo conferido, pré-requisitos disponíveis; instalação ausente é bloqueio.
- [ ] Operador identifica contas/modalidades autorizadas de Pi e Claude; revalida termos atuais do arranjo
  concreto em fontes oficiais. Autenticação nativa dedicada, sem extração/compartilhamento de tokens,
  herança de perfil pessoal ou API key inadvertida. Não usar `--bare` como solução OAuth.
  Dúvida de enquadramento bloqueia uso da assinatura, não autoriza API paga.
- [ ] Recursos descartáveis identificados e alcance de falhas autorizado. Falhas só afetam a prova;
  nenhum serviço compartilhado, credencial pessoal ou infraestrutura existente será interrompido.
- [ ] Operador aprova limites numéricos de prazo, ativações, tentativas, concorrência e consumo/custo
  quando mensuráveis. Definir como parar/escalonar; sem limites preenchidos não executar. Métrica
  indisponível não é orçamento garantido: explicitar risco residual e obter aceitação ou bloquear.
- [ ] Parar em violação de confinamento/filtragem, autenticação/cobrança não autorizada, perda de
  controle/observabilidade ou limite atingido. Priorizar contenção e evidência mínima; retomada requer
  diagnóstico e autorização, não relaxamento. Falta de quota não autoriza outro harness/modelo.
- [ ] Cleanup previsto e verificável: confirmar cessação, remover somente recursos/perfis da prova e
  tratar autenticação dedicada pelo fluxo oficial, sem afetar perfil pessoal. Inspecionar logs/transcripts
  temporariamente e reter apenas evidências sanitizadas necessárias; registrar restos e impedimentos.

### Autoridade e referências

O entendimento foi confirmado pelo Operador após reduzir a bateria a diferenças do harness, três
jornadas e dois desvios. A extensa rodada operacional anterior foi substituída pela checklist curta;
seus detalhes não aprovados não são requisitos desta spec. Valores de autorização continuam pendentes
por desenho, sem impedir aprovação documental e sem permitir execução.

Fontes canônicas:

- [Mapa v2](map.md).
- [Direção de harnesses](issues/04-substitutable-harnesses-direction.md#answer).
- [Investigação da interface](issues/05-execution-seam-research.md#answer) e [relatório](research/execution-seam.md).
- [Direção Lambda/reconstrução](issues/01-lambda-microvms-direction.md#answer).

Condições mutáveis de SDK/serviço/termos foram herdadas como pesquisa, não revalidadas nesta escrita.
O resultado desta sessão é documentação. A resolução do ticket requer aprovação explícita desta
spec registrada; a execução pertence a autorização posterior própria.
