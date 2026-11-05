# Definir a fronteira mínima entre controlador e builder

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Context: decisão HITL confirmada nesta sessão; branch de registro `plan/software-factory-authority`;
integração em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 05

## Question

Qual é a divisão mais simples de responsabilidades e poderes entre o controlador da fábrica e o builder que cumpre o PRD?

Comparar credenciais restritas entregues ao worker, execução externa de operações GitHub/Git e uma composição mínima,
sem pressupor gateway, broker ou publicador próprio. Identificar o que precisa de enforcement técnico,
o que fica como instrução e quais riscos residuais são compatíveis com o PRD.

Percorrer pelo menos: push na branch-base e merge indevidos; cancelamento antes e depois de enviar um efeito;
lease após atualização humana; instrução maliciosa em conteúdo consultado; recuperação após publicação sem confirmação local.
Usar as possibilidades e limitações documentadas em
[Investigar APIs e permissões GitHub para os controles do MVP](05-github-capabilities.md).

A resposta precisa atribuir autoridade por operação, indicar credenciais visíveis a cada papel,
mecanismos mínimos de controle e lacunas que exigem prova. A preferência explícita do operador é a solução tecnicamente mais simples.
Na abertura do ticket, concentrar operações privilegiadas no controlador era apenas uma proposta não aprovada.
A decisão requer conversa com o humano; evidência não a resolve sozinha.

## References

- [PRD — Software Factory MVP](../prd.md): RF-04–05, RF-08–12; RNF-01–02 e RNF-05.
- [Investigar APIs e permissões GitHub para os controles do MVP](05-github-capabilities.md): pesquisa documental e relatório imutável.

## Comments

- Criado na cartografia aprovada; não é ticket de implementação.
- Reivindicado antes da discussão, em worktree isolada; claim integrado em `main` no commit `bab7a07`.
- Aprovações HITL: publicação direta confirmada; Q2 aprovada; Q3 escolheu GitHub App; Q4–Q6 aprovadas;
  Q7–Q8 aprovadas; Q9 original não aprovada e substituída pela fronteira reformulada, confirmada pelo operador.
- A recomendação inicial de publicação mediada foi retirada após o operador informar que os repositórios já possuem barreiras adequadas.
  As respostas parciais foram consolidadas abaixo, sem manter cópias concorrentes da decisão.
- Revisão HITL explícita durante [Definir o contrato de permissões e verificação da GitHub App](11-github-app-contract.md):
  o operador retirou certificação/provas negativas e monitoramento das barreiras pela fábrica, atribuindo sua configuração/manutenção
  ao time operador. Answer e encaminhamentos alinhados; os detalhes dessa revisão vivem somente no contrato da App.

## Answer

### Escolha e justificativa

O builder publica diretamente via GitHub App. Não haverá publicador próprio, gateway, broker ou fallback de publicação mediada no MVP.

O operador informou que os repositórios já possuem as barreiras GitHub adequadas. Dada essa premissa,
publicação direta aproveita as ferramentas usuais do agente e evita código próprio para executar Git e publicar PRs.
A alternativa mediada facilitaria centralizar validações por operação, mas adicionaria uma superfície de execução e recuperação.
Uma composição híbrida preservaria a necessidade de proteger a credencial de push e dividiria a publicação entre componentes.

A configuração/manutenção das barreiras da App é responsabilidade do time operador, não certificação exigida à fábrica.
A revisão explícita dessa fronteira e seus riscos vivem em [Definir o contrato de permissões e verificação da GitHub App](11-github-app-contract.md).
Falha da configuração operacional bloqueia a operação afetada; não criar silenciosamente outro caminho de publicação.

### Autoridade por operação

| Operação | Responsável |
| --- | --- |
| Implementar, testar, commitar, tratar achados, resolver conflitos e preparar rebase | Builder, conforme especificação e política autorizadas |
| Push na branch do trabalho; criar/atualizar o próprio PR draft e descrição com `/pr` | Builder, por Git/API com credencial da App |
| Verificar identidade, localização dos artefatos, commits, reviews, validações e bloqueios | Controlador |
| Decidir e converter prontidão para revisão humana | Controlador, por regras explícitas |
| Publicar perguntas/marcos; validar respostas e comandos autorizados | Controlador; builder usa `ask user` |
| Controlar elegibilidade, filas, limites, disparos, cancelamento e recuperação | Controlador |
| Aprovação humana e merge | Humano; nunca builder ou controlador em nome do operador |
| Confirmar merge e executar cleanup conservador dos recursos próprios | Controlador |

A credencial de escrita pode permitir ao builder marcar um PR como pronto.
Essa marcação no GitHub não substitui a prontidão verificada pela fábrica nem comprova aprovação dos gates.
Não se promete que o token imponha toda a divisão de responsabilidades acima.

### Credenciais e barreiras técnicas

- Identidade técnica: GitHub App, não identidade pessoal do operador.
- Chave privada e material emissor ficam somente no controlador, fora dos ambientes dos agentes.
- Cada execução de builder recebe installation access token reduzido ao repositório do trabalho e às permissões necessárias.
  Emissão/renovação exigem execução autorizada; a expiração do token não vira timeout implícito do trabalho.
- Revisores não recebem escrita GitHub; recebem leitura somente quando necessária.
  A proibição de escrita na worktree revisada também precisa ser imposta pelo isolamento.
- Credenciais pessoais, configurações globais e segredos adicionais do controlador não são expostos ao builder/revisores.
- A App não possui poderes administrativos de escrita nem bypass que permita merge ou escrita na base.
  `Contents: write` por si só não separa push de merge: a restrição efetiva depende das regras GitHub e da identidade.
- Não se afirma escopo server-side por branch, PR ou endpoint quando a credencial só é restrita por repositório/permissão.

### Cancelamento e recuperação

Distinguir pedido persistido de cancelamento de interrupção confirmada.
Ao cancelar, impedir novos disparos e renovações de credencial e interromper builder/processos pelo ambiente de execução,
sem depender da obediência do modelo. Não confirmar interrupção enquanto houver dúvida sobre processos capazes de publicar.

Operação externa já enviada pode terminar durante o cancelamento; reconciliar e mostrar o resultado efetivo,
sem desfazer o efeito automaticamente. Preservar branch, PR e artefatos: cancelar não significa limpar.
Não há promessa de transação atômica entre o pedido local e uma requisição já enviada ao GitHub.

Após crash, o controlador verifica propriedade/processos e consulta branch/PR antes de repetir efeito ou iniciar substituto.
PR próprio já criado deve ser reconhecido e registrado, não recriado porque falta confirmação local.
Identidade ambígua, múltiplos candidatos ou escritor cuja situação não possa ser determinada produzem bloqueio.
Nenhum substituto é iniciado enquanto o anterior ainda puder escrever.

### Concorrência humana e conteúdo malicioso

Capturar o OID remoto de referência antes de preparar a atualização. Após rebase, usar
`--force-with-lease=<ref-do-trabalho>:<OID-esperado>`, somente na branch do trabalho.
Falha de lease ou mudança humana desconhecida interrompe publicação e preserva artefatos;
não recapturar expectativa e insistir às cegas. Na retomada, comparar com a última referência conhecida e reconciliar antes de continuar.
Lease não protege a worktree nem reconhece sozinho alterações humanas anteriores à captura; exclusividade local é outro controle obrigatório.

Conteúdo consultado não concede autorização para ampliar escopo/poderes ou dispensar gates.
Base, merge e administração são protegidos tecnicamente; isolamento restringe host, outros trabalhos e segredos.
Destino do push, sintaxe de lease, operações permitidas e interpretação de instruções também dependem de instruções e controles do runtime.

O operador aceita o risco residual de a credencial permitir mutações em outras branches desprotegidas/PRs do mesmo repositório.
Prompt injection pode induzir uso desses poderes; não há promessa de contenção de código deliberadamente hostil.
Essa aceitação não dispensa as barreiras técnicas obrigatórias acima nem concede autorização para essas mutações.

### Fronteira com CI e produção

A fábrica responde pelas credenciais que fornece, pelo isolamento e pelas operações que autoriza.
Não fornece credenciais de produção ao builder nem executa deploy como parte de seu fluxo.

Workflows, segredos, permissões de Actions, ambientes e aprovações de deploy são responsabilidade do repositório.
Não haverá auditoria exaustiva de CI nem reconfiguração dos repositórios como gate de entrada da fábrica.
Permissões para alterar workflows são configuração explícita da instalação conforme os trabalhos autorizados naquele repositório,
não segunda aprovação obrigatória por ticket. Não foi aprovado proibir `Workflows: write` por padrão.

Push pode acionar CI existente, inclusive comportamento de deploy definido pelo repositório.
Isso não é operação de deploy comandada pela fábrica; ela acompanha os checks exigidos, mas não certifica a segurança de todo o CI.
O operador confirmou essa interpretação da fronteira: ausência de credenciais de produção no builder não garante ausência de efeitos de produção
no CI externo. Não se concede com isso ao agente acesso direto a produção ou autorização para comandar deploy.

### Encaminhamentos e provas pendentes

Esta resolução aprova o desenho de autoridade, não certifica a instalação nem executa provas autenticadas.

- [Definir o contrato de permissões e verificação da GitHub App](11-github-app-contract.md): permissões por papel,
  instalação e emissão/renovação/retirada de acesso; delimita verificação operacional e responsabilidade do time pelas barreiras GitHub.
- [Escolher a estratégia mínima de durabilidade e recuperação](02-durability-strategy.md) e
  [Definir estados, filas, persistência e reconciliação dos efeitos](08-state-and-effects-contract.md): registros,
  identificadores, transações e descoberta dos efeitos, incluindo publicação direta sem confirmação local.
- [Escolher o runtime de agentes e seus pontos de integração](06-agent-runtime-choice.md) e
  [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](07-isolation-choice.md): concretizar ferramentas,
  distribuição de tokens, isolamento de revisores, propriedade de processos e interrupção verificável.

Validações futuras da integração incluem: escrita positiva na branch do trabalho;
acesso reduzido por repositório/papel e ausência da chave emissora no worker; renovação em execução longa;
lease com atualização humana concorrente sem sobrescrita; cancelamento antes/depois do envio de efeito;
crash após push/criação de PR sem duplicar escritores/PRs; e prontidão não inferida apenas do estado observado no GitHub.
Os mecanismos e roteiros concretos pertencem às decisões indicadas e à cobertura final de aceite; não foram implementados nem demonstrados aqui.
Não permanece como gate da fábrica a exigência anterior de provar negação de base/merge ou certificar barreiras da App;
ver a revisão HITL no [contrato da GitHub App](11-github-app-contract.md).
