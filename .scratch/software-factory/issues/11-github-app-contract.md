# Definir o contrato de permissões e verificação da GitHub App

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão Pi `01a1a3bb-87a4-72a8-8dc8-48ee47d6a4a4`; branch `software-factory-github-app`, worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-github-app`. Destino de integração: `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`; sem publicação de `main`. Recursos de registros históricos, removíveis após integração e validação.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 01, 05, 06, 07

## Question

Como instalar, configurar e fornecer credenciais da GitHub App a cada papel,
e que verificação operacional permite operar um repositório com publicação direta pelo Builder?

Usar a fronteira aprovada em [Definir a fronteira mínima entre controlador e builder](01-control-authority.md),
a pesquisa GitHub e os contratos de runtime/isolamento. Definir:

- Permissões da App e dos installation access tokens por papel/operação, distinguindo teto instalado de acesso entregue.
- Instalações/repositórios autorizados; proteção da chave emissora; emissão, entrega, renovação e retirada de acesso,
  inclusive execução longa, suspensão, cancelamento e crash.
- Alteração de workflows como configuração explícita por repositório, sem segunda aprovação por Ticket.
- Fronteira entre configuração segura a cargo do time operador e verificação operacional da fábrica;
  falhas de acesso/configuração e correção pelo operador, sem fallback de publicação mediada.
- Matriz de permissões, riscos residuais e validações futuras da integração que cabe à fábrica.

O escopo original incluía comprovar regras/bypasses e provas negativas de base/merge.
O operador retirou expressamente essa exigência e o monitoramento contínuo; a responsabilidade foi delimitada no Answer.
Não instalar a App, emitir tokens reais, mudar regras ou executar provas nesta decisão.

## References

- [Definir a fronteira mínima entre controlador e builder](01-control-authority.md): autoridade e riscos já aprovados;
  fronteira de certificação alinhada com a revisão explícita desta sessão.
- [Investigar APIs e permissões GitHub para os controles do MVP](05-github-capabilities.md): relatório imutável e limites documentais.
- [Escolher o runtime de agentes e seus pontos de integração](06-agent-runtime-choice.md).
- [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](07-isolation-choice.md).
- [PRD — Software Factory MVP](../prd.md): RF-04, RF-08–12; RNF-01–02/05; CA-06/09.
- [Emissão de installation token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app):
  seleção de repositórios/permissões, validade de uma hora e `expires_at`.
- [Revogação de installation token](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token):
  `DELETE /installation/token` autenticado com o próprio token.
- [Permissões oficiais da App](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).
- [Leitura de ruleset](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset):
  `bypass_actors` pode permanecer oculto sem escrita no ruleset; leitura administrativa não garante sua visibilidade.
- [Ambiente do gh](https://cli.github.com/manual/gh_help_environment): `GH_TOKEN`, configuração própria e modo não interativo.
- [Helper Git do gh](https://github.com/cli/cli/blob/trunk/pkg/cmd/auth/gitcredential/helper.go):
  `gh auth git-credential`, também conferido por `--help` local, sem autenticação.
- [ExecOptions do Gondolin fixado](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/src/exec.ts):
  `env` permite fornecer ambiente separadamente de comando/argv. Isso não demonstra a integração completa.

## Comments

- Reivindicado antes do trabalho em worktree isolada; claim integrado localmente em `main` no commit `461e211`.
- Q1–Q3 aprovadas com “sim às 3”. Q4 aprovada explicitamente com “De acordo com as recomendações”.
- Q5 original não aprovada; Q6 rejeitada: “Não precisamos provar isso, isso é responsabilidade da App,
  que será criada pelo time que operará a fábrica.” Q5 reformulada aprovada com “Sim”, reduzindo explicitamente Q2.
- Q7 aprovada com “Sim, a forma mais simples possível, por favor!”; Q8 aprovada com “Sim!”.
- Aprovações parciais consolidadas no Answer, única fonte da resolução. Nenhuma implementação ou prova autenticada executada.
- Validação documental: `git diff --check`; estrutura/status/tipos/labels e dependências dos 22 tickets, grafo sem ciclos,
  77 links locais nos seis arquivos alterados e índice do mapa conferidos. Encaminhamentos já têm tickets próprios;
  nenhuma nova decisão especificável surgiu desta resolução e nenhuma spec final foi produzida.

## Answer

### Escolha e fronteira de responsabilidade

Usar **uma GitHub App da fábrica**, criada e instalada pelo time operador nos repositórios selecionados,
com installation access tokens reduzidos por repositório, papel e finalidade.
Instalações de owners diferentes são identificadas separadamente; não existe token global entre instalações.
Publicação permanece direta pelo Builder, por Git/gh via HTTPS, sem broker, publicador mediado ou serviço de credenciais.

O **time operador** configura e mantém a App e as proteções GitHub que impedem escrita na base/merge pela App,
sem administração de escrita ou bypass que dispense essas barreiras. O token de `Contents: write` permite push e merge;
portanto essa responsabilidade inclui regras do repositório, não somente as permissões selecionadas na App.

A **fábrica** verifica sua configuração operacional: identidade/instalação esperadas, repositório/base autorizados,
acesso necessário e permissões para as operações suportadas. Não certifica a segurança configurada pelo time.
Não exige provas negativas em repo real/descartável, matriz de equivalência ou evidência administrativa alternativa das barreiras.
Não monitora bypasses nem revalida proteções como condição para cada início, retomada ou renovação de token.
Uma alteração insegura nas regras pode passar despercebida; evitar/corrigir isso é responsabilidade do time operador.

Isso substitui expressamente o gate anterior de comprovação das barreiras pela fábrica e a proposta de auditoria contínua,
não retira a obrigação de as barreiras existirem. A leitura de regras para checks/prontidão continua necessária à sua função própria,
conforme [Definir a avaliação de checks obrigatórios e prontidão do PR](10-readiness-checks-contract.md).
Não acrescentar auditoria de CI nem fallback de publicação mediada quando a configuração operacional falhar.

### Matriz de permissões e teto instalado

R = leitura; W = escrita incluindo leitura; — = não conceder.
A tabela descreve tetos por finalidade, não um token universal com todos os poderes.

| Permissão GitHub | Controlador | Builder | Revisores |
| --- | --- | --- | --- |
| Metadata | R | R | R, se houver token |
| Contents | R; W somente para cleanup remoto próprio | W | R, se necessário |
| Issues | W, para perguntas e marcos | R | R, se necessário |
| Pull requests | W, para acompanhamento e prontidão | W, para publicar/atualizar PR | R, se necessário |
| Checks | R | R, para diagnóstico | — |
| Commit statuses | R | R, para diagnóstico | — |
| Actions | R, quando necessário a diagnóstico de CI | R, quando necessário a diagnóstico de CI | — |
| Administration | R, para leituras necessárias | — | — |
| Workflows | — | W somente conforme configuração explícita do repo | — |

O teto instalado é a união das permissões necessárias aos usos configurados da App; o token de cada operação é reduzido explicitamente.
`Workflows: write` só precisa integrar esse teto se algum repositório configurado autorizar esse uso;
isso não o entrega aos tokens de repositórios que não o autorizaram.
Não solicitar escrita em checks/statuses, Actions, administração, segredos, ambientes ou deployments.
Actions R não autoriza aprovar, disparar ou reexecutar workflows.

- **Controlador:** consultas, perguntas/marcos e transições de prontidão usam permissões adequadas ao endpoint.
  Token para excluir branch remota própria após merge é emitido com Contents W para aquele repo e finalidade;
  não ampliar o token de acompanhamento por conveniência. Clone/fetch do cache usa Contents R.
- **Builder:** recebe acesso somente ao repositório do Trabalho. Leitura de dependências **nativas** pelo controlador usa as
  instalações correspondentes conforme o [contrato de dependências](09-dependency-compatibility.md); não é busca documental para o agente.
  A promessa anterior de coletar fontes privadas de outros repositórios foi retirada na
  [revisão cruzada](23-architecture-cross-review.md). Fonte documental necessária inacessível segue
  [o contrato de captura](16-specification-snapshot-contract.md#fontes-indisponíveis-e-conteúdo-posterior): `ask user`,
  sem ampliar token, adicionar coletor ou ferramenta de consulta entre repositórios.
- **Revisores:** preferencialmente sem token, com contexto capturado; somente o subconjunto de leitura necessário se precisarem consultar GitHub.
  Nenhum token de escrita do Builder é encaminhado às ferramentas de revisão. Isso não cria outra VM nem muda o handoff aprovado.
  O [perfil inicial definido no contrato do adapter](19-gondolin-adapter-contract.md#revisores-somente-read-e-contexto-da-rodada)
  escolheu o caminho sem token/consulta remota para revisores; a permissão opcional acima não é exigência de habilitá-lo.
- **Workflows:** opção explicitamente definida por repositório; ausência é configuração incompleta que exige esclarecimento,
  não permitir/proibir implicitamente nem pedir segunda aprovação por Ticket.

Issues W permite mais que comentar; Pull requests W permite mais que abrir draft; Contents W não restringe branch/endpoint.
A fábrica limita suas operações autorizadas, mas não apresenta essa política como escopo nativo do token.
Permanecem os riscos aceitos de mutações indevidas em outras branches/PRs do mesmo repo e de instrução maliciosa.

### Instalação e verificação operacional

O time operador fornece à instalação a identidade da App, as instalações correspondentes aos owners,
a referência à chave privada e a configuração de repos/base e alteração de workflows.
A chave fica em arquivo protegido da conta que administra o Controlador, fora do Git, storage de sessões,
workspace, disco e mounts dos agentes. JWT/material emissor não é entregue aos agentes.
Não usar PAT, identidade pessoal ou credenciais globais como fallback.

A fábrica verifica a correspondência entre App/instalação/repositório configurados, acesso à base e permissões necessárias.
Tokens especificam explicitamente repositório e permissões; não depender de defaults que herdem todo o teto da instalação.
Conferir o escopo/permissões efetivamente devolvidos, usando acesso operacional quando necessário, sem afirmar que a resposta prova barreiras de branch.
Falha ou resultado incompatível não autoriza entregar token mais amplo.

- Identidade/instalação errada, repo/base inacessível, opção obrigatória ausente ou permissão insuficiente:
  mostrar o item afetado, bloquear a operação e orientar correção pelo operador. Sem loop automático de falha de autorização/configuração.
- Indisponibilidade transitória/rate limit: distinguir de configuração inválida e usar a política de espera/recuperação já aprovada,
  sem presumir ausência de eventos/checks ou aumentar poderes.
- Draft/prontidão, leitura de checks/statuses e exclusão da branch própria precisam funcionar no plano/perfil suportado;
  incompatibilidade visível não autoriza publicar PR pronto em vez de draft ou ignorar checks.
- Uma configuração explícita corrigida pode ser revalidada no aspecto afetado; não exigir recertificação de segurança.

Sintaxe/caminhos finais da configuração e experiência de instalação pertencem ao ticket operacional,
sem criar novo comando/serviço de credenciais. O suporte de dependências e de regras/checks continua nos respectivos contratos.

### Entrega mínima e renovação

O Controlador guarda tokens somente em memória e fornece o token atual **pelo ambiente dos comandos autorizados no guest**,
separadamente de comando/argv: `GH_TOKEN` para gh; Git HTTPS usa `gh auth git-credential`.
Configurar o helper sem armazenar o token; não usar login persistente, credential store/cache com segredo,
token no remoto, argumentos, prompt, sessão ou histórico. Configuração de Git/gh da fábrica é independente do perfil do operador.
Não criar serviço de credenciais, broker, cofre durável ou uma segunda API de publicação.

O adapter usa a interface existente de execução com ambiente explícito; não encaminha todo o ambiente pessoal/do Controlador.
Não logar o ambiente secreto nem devolver o segredo ao modelo como resultado da configuração.
Filtrar tokens conhecidos antes de persistir/exibir saídas ou alimentar sessões. O tratamento geral de logs fica no contrato de observabilidade.
Código no guest pode acessar/copiar a credencial que recebeu legitimamente; não se promete contenção de código deliberadamente hostil.

Renovar automaticamente antes de `expires_at`, enquanto a Execução continuar autorizada a permanecer ativa,
com o mesmo escopo permitido. Validade de uma hora não é limite de duração do Trabalho.
Não confundir essa autorização com nova elegibilidade para despacho: retirar label/fechar Ticket não mata implicitamente Execução ativa.
A renovação não exige auditoria das proteções GitHub nem aprovação humana recorrente.

Novas chamadas recebem o token atualizado. Processo já iniciado conserva seu ambiente antigo;
renovação não atualiza magicamente subprocessos nem repete o comando inteiro.
Falha por expiração exige verificar o resultado e reconciliar eventual efeito antes de repetir a operação.
Falha definitiva de autorização/configuração produz bloqueio; falha transitória segue limites/esperas já definidos,
sem retry ilimitado ou nova Execução criada apenas para renovar token.

### Suspensão, cancelamento e perda do token após crash

Ao encerrar atividade para espera por resposta/CI/merge ou cancelar, impedir novas entregas/renovações,
retirar o acesso temporário e revogar tokens ainda conhecidos quando possível.
O handoff interno aos revisores permanece dentro da Execução/Slot já aprovado, sem exigir rotação por rodada de review;
revisores não recebem o ambiente secreto nem shell irrestrito.
Encerrar processos e confirmar cessação continua obrigatório; apagar uma cópia local ou deixar de renovar não invalida token remoto.
Efeito já enviado pode concluir e deve ser reconciliado, não desfeito automaticamente.

Persistir somente metadados necessários à recuperação: Trabalho/Execução, instalação/repositório, papel/finalidade,
permissões e validade conhecida. Não persistir o segredo do token nem criar cofre para recuperá-lo.
O endpoint de revogação exige o próprio token: após crash, seu valor pode ter sido perdido e não há revogação imediata garantida.
Registrar essa condição sem afirmar revogação; uma cópia pode continuar utilizável até expirar.
Não suspender a instalação inteira para resolver isso, pois afetaria outros Trabalhos.

Após crash, usar o fluxo aprovado: identificar/interromper sobreviventes próprios, confirmar cessação,
reconciliar GitHub/artefatos e só então retomar com credencial nova e contexto recuperado.
Expiração de token não comprova ausência de escritor local. Propriedade/cessação indeterminada bloqueia substituição;
não iniciar outro Builder só porque o token antigo venceu.
O operador aceitou expressamente o risco residual de uma cópia externa do token perdido permanecer válida até expirar.

### Encaminhamentos e validação futura

- [Definir o contrato e o perfil distribuível do adapter Gondolin](19-gondolin-adapter-contract.md):
  concretizar execução com ambiente explícito e ferramentas de revisão sem exposição do token de escrita, preservando chave/host.
- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md):
  associar entrega/retirada de acesso à Execução autorizada e confirmar cessação antes de substituição, sem persistir o segredo.
- [Definir a configuração, a CLI e o ciclo operacional da instalação](21-installation-operations-contract.md):
  incorporar os campos operacionais, arquivo protegido da chave e diagnósticos, sem instalar/administrar a App automaticamente
  ou introduzir gate de certificação/monitoramento das barreiras do time operador.
- [Definir observabilidade, proteção de segredos e retenção dos artefatos](22-observability-retention-contract.md):
  concretizar filtragem antes de logs/sessões e exibição dos metadados sem segredos, sem cofre durável de tokens.

A futura validação da integração **que a fábrica implementa** inclui escopo por repo/papel, acesso Git/gh sem login persistente,
ausência da chave emissora no ambiente dos agentes, renovação além de uma hora sem reiniciar o Trabalho,
expiração em comando já iniciado sem repetição cega, revisão sem token de escrita, retirada/revogação conhecida,
crash com token perdido sem falsa revogação, cessação confirmada e reconciliação de publicação sem duplicação,
e erros de acesso/configuração sem ampliação silenciosa de poderes.
Não reintroduzir nessas validações a certificação de base/merge, provas negativas ou auditoria de regras/bypasses rejeitadas pelo operador.

Esta resolução decide o contrato, não demonstra sua implementação. Nenhuma App, token real, regra, workflow,
VM, serviço ou modelo foi criado/alterado/executado nesta sessão. A spec final e os demais tickets permanecem abertos.


### Adendo aprovado — HTTPS privado de autenticação App (2026-11-05)

Proveniência: aprovação explícita do operador na continuação do ticket MVP 04,
registrada em `/tmp/software-factory-mvp-test-authorization.md` e na instrução
“NEW OPERATOR DESIGN APPROVAL” desta sessão (checkpoint inicial `d54b95f`).
Exceção estreita ao transporte gh: somente o controlador usa HTTPS nativo Node
para **GET /app**, **GET /app/installations/{configured-id}** e
**POST /app/installations/{configured-id}/access_tokens**. A instalação é a
configurada, não um parâmetro arbitrário fornecido pelo modelo. Endpoint fixo
`https://api.github.com:443`, TLS validado, REST `2026-03-10`, JWT Bearer somente
em memória. Sem redirects, proxy, descoberta de auth/ambiente, fallback ou
interface genérica de rede para agentes. Limites de 15s e 2 MiB, validação de
status/headers/completude/payload, erros sanitizados e distinção tipada de emissão
rejeitada conhecida versus resultado desconhecido; POST incerto nunca é repetido
automaticamente. Chave/JWT/token são protegidos e registrados para filtragem
antes do uso. **Todas as demais operações conservam gh api com installation
tokens reduzidos**, inclusive leituras dos adapters distintos Tracker e
CodeRepository. Não é substituição global de transporte nem serviço emissor
novo. Workflows permanece explicitamente proibido no ensaio autorizado.
Fixture da fronteira HTTPS não comprova GitHub real; evidência real e lacunas
ficam em `docs/evidence/04-github-app-access-diagnostics.md`.
