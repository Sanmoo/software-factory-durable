# Matriz de aceite e sequência de validação incremental

Asset de [Definir a matriz de aceite e a sequência de validação incremental](issues/24-acceptance-and-incremental-plan.md#answer).
Base documental: [PRD do MVP](prd.md), Answers canônicos e
[Revisar a composição da arquitetura e suas fronteiras](issues/23-architecture-cross-review.md#answer), disponíveis em `3c4ce58`.
Aprovação HITL: Q1–Q4 confirmadas pelo operador com “sim a todas essas”.

**Estado: plano aprovado; provas não executadas.** Todas as evidências de funcionamento abaixo estão **a demonstrar**.
Este documento organiza a validação futura, não implementa a fábrica, não é a spec final e não certifica uma release ou instalação.
Os contratos vinculados continuam sendo a autoridade das regras; cenários e resultados abaixo são critérios para demonstrá-las.

## Evidência no menor nível fiel

| Tipo | O que demonstra | Limite |
| --- | --- | --- |
| D — documental | Contrato, justificativa e API/fonte examinada, com referência/versionamento | Não demonstra funcionamento, contenção, capacidade ou utilidade. As pesquisas concluídas pertencem a este tipo. |
| S — simulação automatizada | Regras determinísticas com respostas controladas, relógio controlado, duplicação/reordenação e falhas injetadas | Dublê de processo, GitHub, agente ou sandbox não comprova a integração substituída. |
| I — integração real | Comportamento dos componentes e fronteiras reais na configuração registrada; falhas podem ser injetadas | Não exige modelo em cada permutação; não comprova por si só o comportamento das skills nem utilidade em tickets reais. |
| A — agentes reais | Builder e revisores com SDK, ferramentas e skills próprios, modelo/papel identificados e resultados preservados | Skill carregada, sessão persistida ou PR aberto não comprovam revisão, validação ou entrega. |
| P — piloto real | Utilidade e qualidade em tickets reais, com avaliação humana e métricas do PRD | Não substitui a bateria de falhas, permissões, regras e combinações suportadas da integração. |

Combinações como `S + I + A` indicam obrigações complementares, não opções intercambiáveis. `D` fundamenta todas as linhas, mas não as aprova.
Uma execução de teste pode cobrir vários requisitos se registrar a ligação e o resultado de cada um. Não repetir toda combinação com modelos,
nem toda manipulação de acesso em cada piloto. Relógio controlado permite exercitar retenção e prazos sem esperar 30 dias;
a integração deve demonstrar o armazenamento, disparo e efeitos reais correspondentes, sem apresentar tempo simulado como duração real.

### Registro de cada prova futura

Reaproveitar registros e artefatos previstos nos contratos; esta lista não cria outro banco ou plataforma de certificação:

- Cenário/subcaso e RF/RNF/CA cobertos; expectativa, resultado observado e lacunas, distinguindo aprovado, reprovado e inconclusivo.
- Release/commit, manifesto de versões e integridade, schema/perfil/skills/modelos, configuração efetiva e host usado.
  Versões finais e hashes ainda reservados à construção da release não são inventados neste plano.
- Precondições, comandos/gates realmente executados, injeção de falha e fronteira observada; referências de Trabalho/Execução/papel,
  Git/PR/pergunta/recibos quando aplicáveis. Ausência de efeito ou processo requer evidência, não apenas falta de ACK.
- Referências acessíveis às saídas filtradas, resultados e pareceres protegidos; limites de captura, medição, consulta ou recuperação explícitos.
- Recursos e operações autorizados para o teste, responsável pela execução e avaliação humana quando pertinente; nenhum segredo no relatório.

Não usar sucesso de um grupo como aprovação de todos os seus subcasos. Cada obrigação abaixo e nos contratos referenciados precisa de evidência própria
ou de referência inequívoca a uma prova compartilhada. Inconclusivo/ausente não significa aprovado; registros antigos não autorizam novos efeitos.

## Catálogo de cenários

### V-01 — Persistência e autoridade única

**Evidência exigida: S + I.**
[Escolher a estratégia mínima de durabilidade e recuperação](issues/02-durability-strategy.md#answer),
[Definir estados, filas, persistência e reconciliação dos efeitos](issues/08-state-and-effects-contract.md#answer) e
[Definir o protocolo de execução e retomada entre controlador e worker](issues/15-controller-worker-protocol.md#answer).

Verificar a versão SQLite efetivamente embarcada e sua correção WAL-reset, WAL/FULL no adapter público, commits confirmados de controle,
leituras antes das escritas e uma admissão por commit quando aplicável. Falha de persistência não produz confirmação durável.
Exercitar segunda abertura, aliases do mesmo storage, não herança do lock e scheduler iniciado por resume/submit/wait antes da reconciliação.
**Resultado necessário:** uma autoridade; nenhuma atuação atravessa a barreira fechada; reserva, início confirmado, cobrança e liberação são fatos distintos.
Recibos/notificações perdidos não concedem capacidade ou orçamento; incerteza mantém a reserva afetada e, quando global, o despacho fechado.

### V-02 — Perfil Gondolin, filesystem e Docker

**Evidência exigida: I; A nas ferramentas e revisores.**
[Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](issues/07-isolation-choice.md#answer) e
[Definir o contrato e o perfil distribuível do adapter Gondolin](issues/19-gondolin-adapter-contract.md#answer).

Provar o perfil Arch Linux x86_64, QEMU/KVM, guest Alpine, Docker `vfs`, assets íntegros e RealFSProvider, sem herança pessoal ou fallback de sandbox.
Exercitar Git/locks/renames/metadados por FUSE, contexto integral e paths/symlinks/aliases; negar acesso a host/controlador/outros Trabalhos
pelas ferramentas confinadas. Revisores dispõem somente de `read`, sem escrita; Builder não escreve durante o handoff.
Rodar suites reais com Testcontainers/Ryuk e, conforme os pilotos, API/Compose/build: socket guest, binds/paths, CA/TLS por camada,
DNS/portas/nomes/volumes e cleanup próprio; wrapper de `docker run` não comprova certificados de containers criados por API.
**Resultado necessário:** gates sem bypass de testes/Ryuk; ferramentas e dependências funcionais no perfil; desligar/religar preserva workspace,
pacotes/cache/Docker data/contexto sem reclone. Falha de um proprietário não encerra os demais; cessação é observável fora do proprietário morto.

### V-03 — Credenciais e filtragem nos caminhos controlados

**Evidência exigida: S + I; A para os caminhos SDK/sessão usados pelos agentes.**
[Definir o contrato de permissões e verificação da GitHub App](issues/11-github-app-contract.md#answer) e
[Definir observabilidade, proteção de segredos e retenção dos artefatos](issues/22-observability-retention-contract.md#answer).

Testar escopo por repo/papel, Git/gh com ambiente explícito sem login persistente, chave emissora ausente dos agentes e revisor sem token de escrita.
Exercitar renovação além de uma hora, expiração durante comando, retirada/revogação conhecida e token perdido no crash, sem cofre,
replay cego, falsa revogação ou ampliação de concessões. Usar segredos sintéticos para verificar filtragem de saída/erro/streaming com valor dividido
entre chunks, antes de arquivos, exibição, publicação controlada e persistência nativa do SDK, não somente no relatório final.
**Resultado necessário:** valores conhecidos ausentes desses destinos; falha de filtragem não libera bruto por alternativa; acesso local privado
sem prometer isolamento contra a conta confiável/administração. Não testar vazamento usando credenciais reais.
Não incluir certificação, monitoramento ou provas negativas das barreiras de base/merge administradas pelo time operador.

### V-04 — Admissão, identidade, autorização e encerramentos

**Evidência exigida: S + I; P para a entrada real.**
[Definir estados, filas, persistência e reconciliação dos efeitos](issues/08-state-and-effects-contract.md#answer) e
[Definir a configuração, a CLI e o ciclo operacional da instalação](issues/21-installation-operations-contract.md#answer).

Repetir polling/reinício, apresentar PR não reconhecido, retirar/repor label, fechar/reabrir issue, fechar PR sem merge e concluir por merge.
Exercitar resposta recebida após retirada de autorização, retomada explícita e novo ciclo autorizado após entrega/cancelamento.
**Resultado necessário:** no máximo um Trabalho ativo por Ticket; reparos/retomadas não criam outro; nenhum redisparo pela label persistente,
reabertura ou limpeza/exclusão. Retirada impede novos disparos, mas não mata implicitamente o ativo; fechar PR não comprova cessação,
entrega ou cancelamento. PR alheio é reportado, não adotado; fluxo padrão não altera metadados de triagem do ticket.

### V-05 — Dependências nativas e visibilidade

**Evidência exigida: S + I + P.**
[Definir o escopo suportado e a validação das dependências nativas](issues/09-dependency-compatibility.md#answer).

Cobrir paginação pequena, erro após página emitida, JSON inválido, números iguais em repos distintos, grafo transitivo/ciclos,
relações inválidas/inacessíveis, fechamento externo conclusivo/não conclusivo e merge próprio versus simples fechamento.
Em repos de teste, criar relações nativas conhecidas e ler os cenários locais e entre repos/owners/visibilidades que se pretenda declarar suportados;
repetir com acesso reduzido ao destino quando GitHub permitir. Demonstrar dependência real no piloto, sem repetir toda manipulação de acesso.
**Resultado necessário:** leitura completa das relações acessíveis e reavaliação antes de início/retomada, sem fallback Markdown ou cabeça de fila bloqueada.
Omissão silenciosa não detectável é incompatibilidade a levar ao operador, não suporte aprovado. Pré-voo automático verifica acesso,
não certifica manualmente cada par. Após exclusão de histórico próprio, último ciclo entregue continua satisfeito, cancelado não,
e novo ciclo explícito passa a ser avaliado pela memória mínima preservada.

### V-06 — Filas, Slots e três Builders

**Evidência exigida: S + I + A.**
[Definir estados, filas, persistência e reconciliação dos efeitos](issues/08-state-and-effects-contract.md#answer),
[Definir o protocolo de execução e retomada entre controlador e worker](issues/15-controller-worker-protocol.md#answer) e
[Definir o contrato e o perfil distribuível do adapter Gondolin](issues/19-gondolin-adapter-contract.md#answer).

Exercitar FIFO estável, prioridade de reparos sem preempção, eventos consolidados, trabalhos temporariamente inelegíveis e retomadas nas categorias/ordens devidas.
Executar três Builders reais simultâneos, dois no mesmo repo, com branches/worktrees/discos/VMMs próprios e containers simultâneos dos testes reais.
**Resultado necessário:** nenhum mutex global de repo, escritor duplicado ou colisão entre Trabalhos; revisores não consomem Slot adicional,
mas o handoff permanece dentro da ocupação daquele Builder. Pergunta/CI/merge não ocupam Slot; cessação precede liberação.
Medir RAM/CPU/I/O/disco incluindo overhead, driver `vfs`, workers e revisores, com host/configuração registrados; limites do guest não são consumo total.
Defaults não são capacidade comprovada; ajustes autorizados ficam explícitos na configuração testada, sem inventar teto de RAM ou SLA.

### V-07 — Pedido preservado e retomada de contexto

**Evidência exigida: S + I + A; P no pedido real.**
[Definir a captura versionada da especificação e das instruções](issues/16-specification-snapshot-contract.md#answer).

Exercitar captura pelo Builder via `implement`, interrupção antes de sources completo, mudança posterior do ticket/link,
autorização de apenas parte de novo escopo, rebase, sessão compatível e substituição incompatível/perdida.
Testar fonte necessária inacessível antes e depois de preservada, incluindo fonte privada sem credencial suficiente,
e instrução modificada pelo Builder para dispensar gates/ampliar poderes.
**Resultado necessário:** referência inequívoca de Ticket/repo/base e versão de fontes/instruções por Execução; Spec lê o pedido preservado completo.
Fonte privada inacessível gera pergunta, não coletor no controlador ou ampliação de credenciais. Retomada usa `continue` ou recuperação explícita,
sem recaptura silenciosa; mudança posterior não altera escopo autorizado nem a hierarquia de instruções.

### V-08 — Skills, pareceres e validações

**Evidência exigida: S + I + A + P.**
[Escolher o runtime de agentes e seus pontos de integração](issues/06-agent-runtime-choice.md#answer) e
[Definir o pacote de skills e o contrato verificável de revisão e validação](issues/17-skills-and-review-contract.md#answer).

Executar o pacote próprio com perfil pessoal ausente/divergente, modelos por papel e nenhum fallback silencioso; provar chamadas/resultados,
não apenas carregamento. Revisar em paralelo Standards/Spec sobre staged, não staged, novos/removidos e contexto além dos hunks,
com fontes preservadas e identificação do conteúdo. Cobrir mudança durante/depois da análise, correção de achado,
parecer parcial perdido, um revisor falho com outro válido e substituição de sessão.
**Resultado necessário:** dois pareceres atuais e completos, achados e tratamento justificado; retry só do falho quando a entrada continua igual,
sem orçamento próprio extra. Commit da proposta idêntica não causa rodada redundante; mudança relevante exige novos pareceres.
Registrar comandos/gates e resultados reais; falta de instrução, falha ou gate não executado requer orientação, não sucesso presumido.
Dispensa humana não contorna check GitHub obrigatório. Aprovação exigida pela skill passa por `ask user` se não houver autorização prévia concreta.

### V-09 — Publicação, checks e prontidão

**Evidência exigida: S + I + A + P.**
[Definir a fronteira mínima entre controlador e builder](issues/01-control-authority.md#answer) e
[Definir a avaliação de checks obrigatórios e prontidão do PR](issues/10-readiness-checks-contract.md#answer).

Provar publicação direta pelo Builder via App, uso de `/pr`, associação Trabalho/Ticket/branch/base/PR, draft após reviews e conversão controlada.
Cobrir head atual versus antigo, App emissora, check/status homônimos, neutral/skipped, rerun pendente, contexto ausente,
proteção tradicional mais rulesets herdados, strict/loose, paginação incompleta e mudança de head/regra/base entre leituras/conversão.
**Resultado necessário:** nenhum verde emprestado, conjunto obrigatório vazio por falha de leitura ou sucesso local inventado;
esperas, aprovação humana/workflow e mergeability desconhecida não viram reparo genérico. Perda de condição, incerteza e draft humano
seguem classificações canônicas. Aberto, pronto e entregue são distintos; descrição curta não elimina evidências detalhadas.
O controlador não assume que `/pr` publica, nem realiza merge/aprovação humana; abertura não encerra Ticket.

### V-10 — Manutenção e concorrência Git

**Evidência exigida: S + I + A + P.**
[Definir o fluxo de manutenção e reconciliação autorizada do PR](issues/20-pr-maintenance-contract.md#answer).

Provocar conflito confirmado, check obrigatório do resultado atual com falha, impedimento strict, `CHANGES_REQUESTED` autorizado e comando explícito;
contrapor comentário comum, check opcional/antigo, base apenas avançando e motivos que desaparecem antes do início.
Cobrir feedback durante review/pergunta, pedido humano ainda relevante após push, discordância do Builder, correção sem mudança,
correção concluída antes do CI e problema declarado sem solução. Exercitar rebase/política alternativa do repo, push humano concorrente,
lease com OID esperado capturado antes e divergência nova após autorização; encerrar PR/realizar merge durante reparo.
**Resultado necessário:** um conjunto relevante consolidado, sem escritor paralelo nem cobrança por evento; encerramento da correção não significa prontidão.
Mero avanço da base causa zero Execuções/reviews/rebases/drafts por si só. Lease falho preserva mudança humana e pede autorização concreta,
sem renovação cega, `--force` ou reescrita da base; problema não resolvido bloqueia/pergunta em vez de consumir o limite por polling.

### V-11 — Perguntas, comandos e operação pela CLI

**Evidência exigida: S + I + A + P.**
[Definir o protocolo de execução e retomada entre controlador e worker](issues/15-controller-worker-protocol.md#answer) e
[Definir a configuração, a CLI e o ciclo operacional da instalação](issues/21-installation-operations-contract.md#answer).

Provar `ask user`, pergunta durável/publicação identificável, suspensão com cessação e resposta por comentário correlacionado ou CLI.
Testar bot/terceiro/prosa maliciosa, resposta insuficiente, comando repetido, conexão perdida, mensagem inválida/fragmentada/duplicada,
identidade reutilizada com conteúdo diferente, abertura/Execução/boot antigo, frames excedidos e CLI com controlador indisponível.
**Resultado necessário:** autorização por identidade e contexto vigentes; mesma operação não reaplica transição; resposta remove apenas seu impedimento,
não concede autorização geral. Retomada passa pela fila com pergunta/resposta preservadas. CLI lista/inspeciona/pausa/retoma/cancela/responde/
solicita tentativa/limpa sem editar storage; resultado indeterminado é consultável. Pausa não mata ativos; doctor não modifica estado operacional/host/GitHub.

### V-12 — Crash e efeitos parcialmente concluídos

**Evidência exigida: S + I; A nos cortes de Builder/ferramenta/revisão/publicação.**
[Escolher a estratégia mínima de durabilidade e recuperação](issues/02-durability-strategy.md#recuperação-e-cortes-ca-06),
[Definir estados, filas, persistência e reconciliação dos efeitos](issues/08-state-and-effects-contract.md#transições-e-cortes-de-falha) e
[Definir o protocolo de execução e retomada entre controlador e worker](issues/15-controller-worker-protocol.md#cortes-de-falha-e-validação-futura).

Executar os cortes antes/depois de commit/reserva, spawn/recibo/início, ferramenta/parecer, push, criação/conversão de PR e publicação de pergunta,
incluindo resposta durante boot, cache em preparo, perda de canal e morte de controlador/worker/proprietário com subprocessos/containers sobreviventes.
**Resultado necessário:** barreira fechada e cessação dos sobreviventes próprios antes de substituto; recursos descobertos mesmo sem proprietário anterior.
Reconciliar GitHub/Git/disco/recibos; sem PR/pergunta/escritor duplicado, consumo duplicado ou repetição cega de ferramenta.
Ausência de ACK não prova ausência de efeito; ambiguidade bloqueia, sem nova ferramenta de intenção específica por push/PR.
Parecer completo correlacionado pode ser recuperado; falta de resultado não vira gate verde. Manter identidade, contexto e limites após crash/reboot.

### V-13 — Limites, tempo e interrupção

**Evidência exigida: S + I + A.**
[Definir estados, filas, persistência e reconciliação dos efeitos](issues/08-state-and-effects-contract.md#limites-falhas-e-tempo) e
[Definir o protocolo de execução e retomada entre controlador e worker](issues/15-controller-worker-protocol.md#answer).

Exercitar reserva sem início versus início confirmado, três correções e três retomadas operacionais por padrão, contagens separadas/configuráveis,
backoff, concessão autorizada e tentativas internas do SDK desabilitadas. Repetir eventos/push/restart/alteração de configuração;
contrapor falha operacional recuperável, autorização/configuração inválida, parada administrativa limpa e parada forçada/crash.
Testar ausência de timeout, timeout por repo, espera externa, ajuste de hora e duração perdida após crash/reboot, sem exigir 61 minutos reais
para todas as permutações. Cancelar antes/depois de requisição enviada e durante comandos/containers; considerar merge concorrente.
**Resultado necessário:** sem corte global de 60 minutos; espera não consome tempo ativo/Slot; incerteza de tempo não vira zero.
Timeout interrompe/bloqueia sem loop automático; contadores não zeram por evento/configuração. Parada limpa não cobra retomada por falha,
sem dispensar reconciliação ou contabilização de início já confirmado. Cancelamento impede novas ações e confirma cessação;
efeito já enviado pode terminar e deve ser descoberto, sem apagar artefatos, desfazer GitHub ou confundir pedido com interrupção confirmada.

### V-14 — Cleanup, retenção e memória mínima

**Evidência exigida: S + I; P no cleanup de entrega real.**
[Definir observabilidade, proteção de segredos e retenção dos artefatos](issues/22-observability-retention-contract.md#answer).

Provar merge confirmado antes da entrega/cleanup; transferência/preservação das evidências antes de remover ambiente; propriedade/cessação,
falha parcial, retry só dos pendentes e plano de limpeza que ficou obsoleto. Cobrir piso de espaço/disco cheio sem exclusão para abrir espaço,
recursos alheios/base, trabalho não entregue além de 30 dias e entregue com prazo vencido, arquivo em uso ou pendência protetora.
**Resultado necessário:** entrega não é desfeita por cleanup falho; nenhuma limpeza global Docker. Não entregues preservados até limpeza explícita;
logs/sessões de entregues elegíveis por padrão 30 dias após merge, na varredura diária/boot após reconciliação, respeitando proteção e uso.
Fim da pendência após o prazo não inicia mais 30 dias. Resumo/histórico/revisões/decisões ficam até exclusão explícita.
Limpeza seletiva avisa perdas, exige cancelamento quando necessário e não exclui histórico implicitamente. Exclusão exige encerramento sem pendências,
conserva memória mínima antirredisparo/resultado/merge e não transforma dependência própria em externa; testar com V-04/V-05.

### V-15 — Observabilidade, saídas e consumo

**Evidência exigida: S + I + A + P.**
[Definir observabilidade, proteção de segredos e retenção dos artefatos](issues/22-observability-retention-contract.md#answer).

Navegar pela CLI humana/JSON entre Ticket/repo/branch/PR, Trabalho/Execução/papel, fase/estado/bloqueio/espera, duração/atividade,
filas/Slots, modelos/configuração, tentativas/perguntas/gates/pareceres/cleanup. Exercitar falha/aborto e uso parcial/ausente dos três papéis,
sessão retomada sem duplicar consumo, polling padrão 60 segundos/configurável, rate limit/backoff e consulta externa falha/antiga.
Gerar saída volumosa/truncada/incompleta, falha de gravação e leitura paginada pelos agentes com suas ferramentas confinadas.
**Resultado necessário:** causa, histórico e próximo passo consultáveis; custo estimado distinto de fatura, desconhecido distinto de zero,
sem exigir raciocínio interno. Trecho truncado aponta à saída filtrada legível na área do Trabalho, sem expor registros host;
cópia editável pelo Builder não certifica gate. Captura parcial e resultado desconhecido são distintos; perda crítica impede passos dependentes,
sem replay cego nem alegação de persistência se o próprio storage falhou. Não publicar logs/sessões automaticamente no GitHub.

### V-16 — Instalação e atualização controlada

**Evidência exigida: S + I.**
[Definir a configuração, a CLI e o ciclo operacional da instalação](issues/21-installation-operations-contract.md#answer).

Testar release autocontida/manifesto/assets íntegros, setup repetido, paths privados explícitos e configuração inválida/alterada,
primeiro plano e serviço opcional, conta dedicada recomendada e systemd obrigatório dos ambientes em ambos os modos.
Exercitar pausa/parada limpa, release nova com perguntas pendentes, schema/registry/protocolo/perfil incompatível,
migração suportada solicitada e interrupção durante migração.
**Resultado necessário:** sem herança pessoal, sudo host no agente, aplicação parcial ou mudança implícita de repo/escopo/limites;
compatibilidade verificada antes de alterar estado. Parada limpa, pausa e crash são distintos. Iniciar pausada, reconciliar e inspecionar antes de despausar;
migração interrompida tem recuperação definida e não aceita estado parcial operacional. Preservar IDs/filas/perguntas/contadores/efeitos e assets ainda usados.
Não prometer relocação livre, migração automática de disco, rolling update, rollback universal ou backup/restauração integrado.

### V-17 — Jornada e utilidade no piloto

**Evidência exigida: I + A + P.**
[PRD do MVP](prd.md#4-jornada-principal),
[Definir a fronteira mínima entre controlador e builder](issues/01-control-authority.md#answer) e os cenários anteriores.

Demonstrar com tickets reais elegibilidade/dependência, fila, implementação, pedido preservado, validações, dois reviews,
pergunta/resposta quando necessária, publicação draft, prontidão, manutenção, merge humano e cleanup.
**Resultado necessário:** cadeia correlacionada verificável e avaliação humana da aderência/qualidade/utilidade;
bloqueios e intervenções são resultados registrados, não desaparecem por não haver entrega. PR aberto não basta.
O piloto representa o uso pretendido, mas não precisa repetir toda permutação destrutiva da bateria de integração.

## Matriz RF e RNF

Os links de cenário acima contêm os contratos canônicos, os subcasos e o resultado exigido. Esta matriz faz o vínculo requisito → cenário → contrato/evidência;
não substitui as condições integrais do PRD. Todos os resultados permanecem a demonstrar.

| Requisito | Cenários rastreáveis | Evidência exigida | Resultado verificável principal |
| --- | --- | --- | --- |
| RF-01 — Configuração e autorização | [Admissão e ciclos](#v-04--admissão-identidade-autorização-e-encerramentos), [CLI](#v-11--perguntas-comandos-e-operação-pela-cli), [Instalação](#v-16--instalação-e-atualização-controlada) | S + I + P | Entrada configurada, identidade única e novo ciclo somente explícito; PR alheio reportado, sem triagem automática. |
| RF-02 — Dependências nativas | [Dependências e visibilidade](#v-05--dependências-nativas-e-visibilidade), [Memória mínima](#v-14--cleanup-retenção-e-memória-mínima) | S + I + P | Só satisfação válida libera; falha/inacessibilidade/ciclo não libera; compatibilidade declarada tem evidência real. |
| RF-03 — Filas e concorrência | [Filas e três Builders](#v-06--filas-slots-e-três-builders), [Perguntas](#v-11--perguntas-comandos-e-operação-pela-cli), [Limites e tempo](#v-13--limites-tempo-e-interrupção) | S + I + A | FIFO/categorias persistentes, prioridade sem preempção, espera sem Slot e três Builders sem mutex por repo. |
| RF-04 — Worktrees e autoria | [Sandbox](#v-02--perfil-gondolin-filesystem-e-docker), [Concorrência](#v-06--filas-slots-e-três-builders), [Git](#v-10--manutenção-e-concorrência-git), [Crash](#v-12--crash-e-efeitos-parcialmente-concluídos) | S + I + A | Identidades próprias e escritor único mesmo após crash; revisores sem escrita e alteração humana preservada. |
| RF-05 — Especificação e instruções | [Pedido preservado](#v-07--pedido-preservado-e-retomada-de-contexto), [Skills](#v-08--skills-pareceres-e-validações) | S + I + A + P | Fontes/instruções/versionamento recuperáveis; mudanças de escopo só autorizadas; política prevalece. |
| RF-06 — Skills e revisão | [Skills e pareceres](#v-08--skills-pareceres-e-validações), [Prontidão](#v-09--publicação-checks-e-prontidão) | S + I + A + P | Pacote independente e dois pareceres paralelos completos sobre a proposta atual; falha não é revisão limpa. |
| RF-07 — Validação | [Docker](#v-02--perfil-gondolin-filesystem-e-docker), [Gates](#v-08--skills-pareceres-e-validações), [Saídas](#v-15--observabilidade-saídas-e-consumo) | S + I + A + P | Comandos/resultados demonstrados, inclusive integração Docker; ausência/falha/dispensa explícitas sem contornar check obrigatório. |
| RF-08 — Publicação e prontidão | [Publicação e checks](#v-09--publicação-checks-e-prontidão), [Crash](#v-12--crash-e-efeitos-parcialmente-concluídos), [Jornada](#v-17--jornada-e-utilidade-no-piloto) | S + I + A + P | PR próprio draft → pronto com evidências atuais; merge somente humano, entrega só confirmada. |
| RF-09 — Acompanhamento e reparos | [Prontidão](#v-09--publicação-checks-e-prontidão), [Manutenção e Git](#v-10--manutenção-e-concorrência-git), [Polling](#v-15--observabilidade-saídas-e-consumo) | S + I + A + P | Gatilhos efetivos/consolidados; base apenas avançando não dispara; lease falho não sobrescreve humano. |
| RF-10 — Perguntas e autorização | [Perguntas e CLI](#v-11--perguntas-comandos-e-operação-pela-cli), [Crash](#v-12--crash-e-efeitos-parcialmente-concluídos), [Jornada](#v-17--jornada-e-utilidade-no-piloto) | S + I + A + P | Pergunta/resposta persistidas e correlacionadas; terceiro não autoriza; suspensão libera Slot só após cessação. |
| RF-11 — Elegibilidade e encerramentos | [Admissão e encerramentos](#v-04--admissão-identidade-autorização-e-encerramentos), [Interrupção](#v-13--limites-tempo-e-interrupção) | S + I + A | Retirada impede novos disparos sem matar ativo; fechamento não comprova merge nem autoriza retomada/substituição. |
| RF-12 — CLI e cancelamento | [CLI](#v-11--perguntas-comandos-e-operação-pela-cli), [Interrupção](#v-13--limites-tempo-e-interrupção), [Inspeção](#v-15--observabilidade-saídas-e-consumo) | S + I + A | Operação sem edição de storage; cancelamento confirma cessação/reconcilia efeitos e preserva artefatos. |
| RF-13 — Limites e recuperação | [Autoridade](#v-01--persistência-e-autoridade-única), [Crash](#v-12--crash-e-efeitos-parcialmente-concluídos), [Limites e tempo](#v-13--limites-tempo-e-interrupção) | S + I + A | Contagens separadas/persistentes, backoff e esgotamento operável; sem retries ocultos ou timeout global. |
| RF-14 — Cleanup e retenção | [Segredos](#v-03--credenciais-e-filtragem-nos-caminhos-controlados), [Cleanup e memória](#v-14--cleanup-retenção-e-memória-mínima), [Saídas](#v-15--observabilidade-saídas-e-consumo) | S + I + A + P | Só recursos próprios removidos; entrega e cleanup distintos; retenção/contexto protegidos e segredos filtrados. |
| RNF-01 — Durabilidade | [Persistência](#v-01--persistência-e-autoridade-única), [Contexto](#v-07--pedido-preservado-e-retomada-de-contexto), [Crash](#v-12--crash-e-efeitos-parcialmente-concluídos), [Atualização](#v-16--instalação-e-atualização-controlada) | S + I + A | Estado e contexto recuperáveis, exclusividade e efeitos reconciliados; não promessa genérica de exatamente uma vez. |
| RNF-02 — Isolamento e credenciais | [Sandbox/Docker](#v-02--perfil-gondolin-filesystem-e-docker), [Credenciais](#v-03--credenciais-e-filtragem-nos-caminhos-controlados), [Concorrência](#v-06--filas-slots-e-três-builders) | S + I + A | Fronteiras reais de ferramentas/FS/processos/rede/segredos; Docker por Trabalho sem colisão nem administração host pelo agente. |
| RNF-03 — Observabilidade | [CLI](#v-11--perguntas-comandos-e-operação-pela-cli), [Registros e consumo](#v-15--observabilidade-saídas-e-consumo) | S + I + A + P | Cadeia correlacionada consultável, lacunas explícitas e consumo dos revisores incluído, sem falso zero/sucesso. |
| RNF-04 — Polling externo | [Dependências](#v-05--dependências-nativas-e-visibilidade), [Checks](#v-09--publicação-checks-e-prontidão), [Manutenção](#v-10--manutenção-e-concorrência-git), [Observações](#v-15--observabilidade-saídas-e-consumo) | S + I | Polling padrão/configurável, limites/backoff e reconciliação; falha de consulta não é ausência/sucesso. |
| RNF-05 — Controle previsível | [Autoridade](#v-01--persistência-e-autoridade-única), [Pedido](#v-07--pedido-preservado-e-retomada-de-contexto), [Skills/modelos](#v-08--skills-pareceres-e-validações), [Comandos](#v-11--perguntas-comandos-e-operação-pela-cli), [Limites](#v-13--limites-tempo-e-interrupção) | S + I + A | Controle decide autorização/fila/limites; agentes não ampliam poderes, alteram escopo ou trocam modelo silenciosamente. |

## Matriz CA

Cada linha conserva o cenário e o resultado do PRD; provas complementares dos contratos não desaparecem por estarem além do resumo de um CA.
A jornada real conecta os cenários ao mesmo fluxo, sem transformar toda permutação em ticket-piloto obrigatório.

| Critério | Cenários e contratos via catálogo | Evidência exigida | Resultado verificável |
| --- | --- | --- | --- |
| CA-01 — Jornada completa | [Pedido](#v-07--pedido-preservado-e-retomada-de-contexto), [Revisão/gates](#v-08--skills-pareceres-e-validações), [PR](#v-09--publicação-checks-e-prontidão), [Cleanup](#v-14--cleanup-retenção-e-memória-mínima), [Piloto](#v-17--jornada-e-utilidade-no-piloto) | I + A + P | Ticket autorizado → implementação → Standards/Spec → draft → pronto → merge humano confirmado → cleanup próprio. |
| CA-02 — Dependência válida | [Dependências](#v-05--dependências-nativas-e-visibilidade), [Memória após exclusão](#v-14--cleanup-retenção-e-memória-mínima) | S + I + P | Pendência bloqueia, satisfação legítima libera; inacessível/não conclusiva não libera, incluindo ciclos próprios após exclusão. |
| CA-03 — Concorrência três | [Sandbox](#v-02--perfil-gondolin-filesystem-e-docker), [Três Builders](#v-06--filas-slots-e-três-builders), [Crash](#v-12--crash-e-efeitos-parcialmente-concluídos) | S + I + A | Três Builders, dois no mesmo repo, isolados por Trabalho e sem duplicar escritores; capacidade real registrada. |
| CA-04 — Reparos prioritários | [Filas](#v-06--filas-slots-e-três-builders), [Checks](#v-09--publicação-checks-e-prontidão), [Manutenção](#v-10--manutenção-e-concorrência-git) | S + I + A | Conflito/check obrigatório falho atual gera um reparo antes de novos trabalhos, sem preempção ou cobrança por duplicata. |
| CA-05 — Pergunta e retomada | [Filas](#v-06--filas-slots-e-três-builders), [Perguntas](#v-11--perguntas-comandos-e-operação-pela-cli), [Crash](#v-12--crash-e-efeitos-parcialmente-concluídos), [Piloto](#v-17--jornada-e-utilidade-no-piloto) | S + I + A + P | Pergunta libera Slot após cessação; resposta autorizada/correlacionada recoloca na fila; terceiro não desbloqueia. |
| CA-06 — Crash sem duplicação | [Autoridade](#v-01--persistência-e-autoridade-única), [Contexto](#v-07--pedido-preservado-e-retomada-de-contexto), [Cortes de crash](#v-12--crash-e-efeitos-parcialmente-concluídos) | S + I + A | Recuperar execução e push/PR/pergunta reais sem efeitos/escritores duplicados, antes/depois dos recibos. |
| CA-07 — Interrupção e cleanup falho | [Limites/cancelamento](#v-13--limites-tempo-e-interrupção), [Cleanup](#v-14--cleanup-retenção-e-memória-mínima), [CLI](#v-15--observabilidade-saídas-e-consumo) | S + I + A | Cancelamento/esgotamento/falha parcial explícitos e operáveis; preservar não entregue e entrega já confirmada. |
| CA-08 — Docker simultâneo | [Perfil/Docker/TLS](#v-02--perfil-gondolin-filesystem-e-docker), [Concorrência](#v-06--filas-slots-e-três-builders), [Piloto](#v-17--jornada-e-utilidade-no-piloto) | I + A + P | Suites reais dos pilotos criam containers simultâneos sem colisão, bypass de teste/Ryuk ou limpeza alheia. |
| CA-09 — Rebase e lease | [Manutenção e Git](#v-10--manutenção-e-concorrência-git), [Crash](#v-12--crash-e-efeitos-parcialmente-concluídos) | S + I + A | Política do repo seguida; referência esperada anterior ao push; mudança remota faz lease falhar sem sobrescrita/renovação cega. |
| CA-10 — Retirada/fechamento/polling | [Admissão](#v-04--admissão-identidade-autorização-e-encerramentos), [Comandos](#v-11--perguntas-comandos-e-operação-pela-cli), [Cleanup/memória](#v-14--cleanup-retenção-e-memória-mínima) | S + I | Sem redisparo, duplicação de Trabalho ou entrega indevida por polling, retirada, fechamento ou exclusão. |
| CA-11 — Tempo e esperas | [Filas](#v-06--filas-slots-e-três-builders), [Limites e relógios](#v-13--limites-tempo-e-interrupção), [Inspeção](#v-15--observabilidade-saídas-e-consumo) | S + I + A | Ausência de timeout não cria corte de 60 minutos; timeout configurado interrompe/bloqueia; espera sem Slot/tempo ativo. |
| CA-12 — Ausência não é sucesso | [Pedido](#v-07--pedido-preservado-e-retomada-de-contexto), [Revisão/gates](#v-08--skills-pareceres-e-validações), [Prontidão](#v-09--publicação-checks-e-prontidão), [CLI/saídas](#v-15--observabilidade-saídas-e-consumo) | S + I + A + P | Revisão indisponível, Spec incompleto, gate não executado ou resultado desconhecido não ficam verdes; CLI explica causa/histórico/ação. |

## Sequência incremental e gates de avanço

Incrementos são organização conceitual da construção/validação futura, não autorização de execução nem backlog de implementação.
Observabilidade mínima, filtragem e evidência acompanham o primeiro teste; não são acrescentadas só no incremento operacional.

| Incremento | Entrada e foco | Gate de avanço |
| --- | --- | --- |
| Fronteiras frágeis | Com autorização própria, testar composição mínima real de V-01/V-02/V-03 e cessação de V-12: SQLite/FULL, SDK/persistência, KVM/FUSE/Docker/TLS e supervisão. Começar filtragem com segredos sintéticos. | APIs e fronteiras reais demonstradas no perfil, sem bypass, fallback ou mudança silenciosa de desenho. Falha estrutural é descoberta antes de escalar ou depender da release. |
| Controle determinístico | Em paralelo ao anterior, automatizar regras V-01/V-04/V-05/V-06/V-09–V-14 com respostas/relógio controlados; incluir mensagens e estados adversos, não só caminho feliz. | Regras e invariantes verificadas, sem usar dublê como prova da integração. Integrar com as fronteiras reais antes da jornada completa. |
| Uma jornada completa | Após os dois gates anteriores, compor V-07/V-08/V-09/V-11/V-14/V-15: um Ticket autorizado, dois reviews, pergunta/retomada, draft/pronto/merge humano/cleanup. | Cadeia real correlacionada e operável; pergunta libera Slot, contexto preservado, ausência de evidência bloqueia. Não declarar o MVP aceito por um caso feliz. |
| Concorrência e adversidades | Ampliar a composição para V-05/V-06/V-10/V-12/V-13: três Builders, Docker simultâneo, filas/reparos, lease, crash antes/depois dos efeitos e interrupções. | CA-02–11 e subcasos pertinentes demonstrados nas fronteiras reais; sem escritores/efeitos duplicados, sobrescrita humana ou falsa cessação. Repetir integrados os testes de crash/isolamento iniciados cedo. |
| Operação da release | Completar V-14/V-15/V-16: instalação reproduzível, configuração/CLI, atualização com pergunta pendente, migração interrompida, retenção e exclusão. | Release e configuração efetivas rastreáveis, operações/diagnósticos verificáveis; incompatibilidade recusada e recuperação definida. Sem gate de backup integrado ou certificação das barreiras da App. |
| Piloto útil | Seleção/autorização próprias; V-17 com tickets reais e cobertura representativa dos cenários anteriores. | Requisitos/cenários obrigatórios com evidências suficientes, limitações explícitas e utilidade/qualidade avaliadas pelo operador; não só PRs abertos. |

Uma trilha independente pode avançar enquanto outra está bloqueada, mas o gate dependente e a alegação de conformidade não avançam sem a prova necessária.
A sequência prioriza riscos, não exige esperar o fim para testar crash, capacidade, instalação ou proteção de segredos.

## Seleção e autorização dos pilotos

Escolher posteriormente o **menor conjunto suficiente por cobertura**, sem quota arbitrária de repos, tickets ou entregas:

- Repositórios de confiança, autorizáveis, com instruções/gates reproduzíveis e dependências executáveis no perfil inicial;
  tickets reais com escopo julgável e pessoa disponível para avaliar/revisar/realizar merge.
- Representar implementação e manutenção de PR, pedido preservado, interação com operador, dependência nativa e Docker/Testcontainers.
  CA-08 exige suites reais dos pilotos; CA-03 exige três Builders, dois no mesmo repo. Usar o mesmo recurso para várias provas quando seguro e rastreável.
- Bateria de integração separada para relações/permissões/regras declaradas suportadas e para falhas/manipulações destrutivas;
  não assumir cross-owner/visibilidade por teste positivo de outro cenário nem exigir certificação manual de todos os pares de uso.
- Incompatibilidade de testes com portas/volumes/nomes fixos ou dependências musl não se resolve por reescrita silenciosa, bypass de gate
  ou perfil alternativo implícito. Reportar e decidir adequação/seleção com impacto explícito, preservando o escopo do PRD.

Antes da execução, obter autorização específica para máquina/conta/storage e preparo administrativo, repos/issues/PRs/branches/workflows/relações de teste,
App/instalação/permissões e operadores participantes, modelos/provedores/custos e operações GitHub/Git/cleanup.
Identificar onde injetar falhas, interferência tolerada, recursos descartáveis e quem faz merge humano.
Não selecionar ou acessar recursos reais, criar credenciais, instalar serviços ou provocar falhas pela aprovação deste plano.

## Conclusão, reprovações e limites

**Fechamento desta decisão de planejamento:** matriz RF-01–14/RNF-01–05/CA-01–12 rastreável, tipos de evidência e resultados esperados,
sequência/gates e seleção/autorização futura definidos. Isso libera somente a consolidação documental da spec.

**Aceite futuro do MVP:** todos os RF/RNF/CA e as obrigações dos contratos precisam de evidência suficiente no nível fiel,
na composição/release/configuração declarada, mais avaliação humana da utilidade/qualidade em tickets reais.
Variações condicionais de integração, como API/Compose/build usados pelos pilotos, têm seu escopo registrado; não permitem dispensar um requisito do MVP.
Nenhuma falha obrigatória é dispensada por boa métrica; sucesso de simulação não aprova integração, e aprovação do plano não aprova o MVP.

Medir tempos de elegibilidade/início/PR/prontidão/merge separando execução/espera; intervenções/perguntas/correções/retomadas;
resultados/motivos; Slots/filas/impacto da prioridade; uso/custo disponível, incluindo revisores; recuperações, duplicações e cleanup falho.
Não fixar taxa de sucesso, custo-alvo, desempenho ou prazo de resolução arbitrários antes do piloto.

Prova reprovada/inconclusiva bloqueia o gate dependente e a declaração de conformidade, não obriga repetir testes independentes sem relação.
Corrigir implementação compatível e revalidar os requisitos afetados. Lacuna/incompatibilidade de desenho exige decisão própria e dependência real;
não alterar tecnologia, poderes, escopo ou garantia silenciosamente. Não concluir o mapa enquanto houver tal decisão pendente.

Limites residuais permanecem os aprovados: APIs podem ter lacunas de visibilidade; fontes podem ficar inacessíveis; custo/capacidade real e compatibilidade
musl/FUSE/TLS precisam de prova; hardware/storage defeituosos não são cobertos por FULL; processos confiáveis host e administração estão na base de confiança.
Filtragem conhecida não saneia arquivos arbitrários, segredos transformados ou cópias externas; contenção de código deliberadamente hostil não é prometida.
Configuração das barreiras GitHub pertence ao time operador, sem gate de certificação/monitoramento pela fábrica.
Backup/restauração integrado, outros perfis de sandbox/macOS, HA/SaaS, merge automático e execução de provas nesta cartografia seguem fora do escopo.
