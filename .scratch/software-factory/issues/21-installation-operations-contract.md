# Definir a configuração, a CLI e o ciclo operacional da instalação

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão Wayfinder na branch `plan/software-factory-operations`, worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-operations`; integração em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 08, 11, 15, 19, 22

## Question

Qual é a interface operacional mínima e implementável para instalar, configurar, comandar, atualizar e recuperar a fábrica local,
sem editar diretamente seu storage nem expor detalhes específicos da sandbox no controlador?

Definir composição/distribuição e versões suportadas, configuração de repositórios/base/label, operadores, modelos por papel,
concorrência, polling, limites/esperas/timeout e caminhos de estado/artefatos.
Escolher sintaxe/semântica de CLI e comentários autorizados para perguntas, respostas, pausa/despausa, inspeção,
cancelamento, retomada/nova tentativa, concessão de orçamento, novo Trabalho e limpeza explícita.
Distinguir pausa global de suspensão de autorização por Trabalho, reabertura de PR e autorização de escopo;
nenhum comando pode ignorar silenciosamente os demais impedimentos ou apagar histórico.

Concretizar transporte até o controlador proprietário, inicialização/parada, mensagens de erro e condições de indisponibilidade,
sem escrita operacional direta no banco ou segundo proprietário.
Reutilizar lock/supervisão/protocolo já escolhidos e manter configuração Gondolin encapsulada no adapter.
Reutilizar o [contrato da GitHub App](11-github-app-contract.md) para instalação/credenciais, sem reabrir autoridade ou auditar exaustivamente CI.
A App e suas barreiras são configuradas/mantidas pelo time operador; a fábrica faz verificação operacional,
sem certificação, provas negativas obrigatórias ou monitoramento de bypasses. Incorporar os campos/referência à chave protegida
já decididos, sem serviço/cofre de credenciais ou administração automática da App.

Definir procedimento de atualização com parada controlada, compatibilidade e migração mínima,
sem suporte integrado a backup/restauração ou promessa de rollback universal. Proteção contra perda do storage é responsabilidade externa do operador.
Release incompatível sem migração suportada deve ser recusada antes de alterar o estado; cópias externas não são certificadas pela fábrica,
não desfazem GitHub e não dispensam reconciliação. Não prometer migração universal de sessões/perfis.
Saída: contrato de configuração, comandos/interfaces e roteiro operacional com limites e provas futuras.
Não instalar serviços, alterar o host, criar credenciais ou executar migrações nesta decisão.

## References

- [Escolher a estratégia mínima de durabilidade e recuperação](02-durability-strategy.md).
- [Escolher o runtime de agentes e seus pontos de integração](06-agent-runtime-choice.md).
- [Definir estados, filas, persistência e reconciliação dos efeitos](08-state-and-effects-contract.md).
- [Definir o contrato de permissões e verificação da GitHub App](11-github-app-contract.md).
- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md).
- [Definir o contrato e o perfil distribuível do adapter Gondolin](19-gondolin-adapter-contract.md).
- [Definir observabilidade, proteção de segredos e retenção dos artefatos](22-observability-retention-contract.md).
- [PRD — Software Factory MVP](../prd.md): RF-01, RF-03, RF-10–14; RNF-03–05; CA-05–07 e CA-10–12.

## Comments

- Confirmações HITL: Q1–Q4 aprovadas; proposta de paths de sistema rejeitada e substituída por instalação autocontida;
  conta dedicada esclarecida e aprovada como opcional; Q6–Q13 aprovadas. Q14–Q17 não foram adotadas:
  operador questionou backups, conferimos RNF-01/RF-13/CA-06 e ele aprovou sua retirada do MVP.
  Q18–Q20 aprovadas após esclarecer cadastro explícito e label default; Q21–Q24 aprovadas.
  Fechamento do entendimento e consolidação autorizados com “sim”.
- Revisões expressas: conta dedicada/serviço do controlador deixam de ser obrigatórios; suporte integrado a backup/restauração
  deixa de ser encaminhamento obrigatório. A supervisão systemd do adapter e o recovery após crash permanecem.
- Uma única decisão não-research resolvida nesta sessão. Nenhuma instalação, migração, credencial ou prova de runtime executada.
  As decisões consolidadas vivem exclusivamente no Answer; tickets seguintes não estão resolvidos.
- Validação documental: `git diff --check`; metadados/status/tipos/labels e dependências dos 25 tickets, grafo sem ciclos,
  Answers/índice de resoluções, links locais dos seis arquivos alterados e ausência de spec antecipada.
  Fronteira resultante: revisão cruzada da arquitetura. Não houve testes de runtime nem alegação de homologação.

## Answer

### Alcance e instalação autocontida

Distribuir release explícita/versionada com controlador, CLI, workers, skills e manifesto de dependências, acompanhada dos assets prontos
do perfil Gondolin aprovado. Sem Pi/perfil global, downloads implícitos que substituam perfil, autoatualização ou construção de imagem
na instalação. Versões exatas/hashes são fixados e provados na construção da release, não inventados nesta decisão.
Suporte continua restrito à combinação validada do [contrato do adapter](19-gondolin-adapter-contract.md), sem homologação presumida.

O operador extrai o pacote na pasta escolhida e executa `./factory setup`, configura e inicia com `./factory run`.
Layout relativo à raiz canônica escolhida:

| Path | Responsabilidade |
| --- | --- |
| `factory` | Entrada da CLI/lançamento |
| `releases/<versão>/` | Código, dependências e skills imutáveis da release selecionada explicitamente |
| `assets/` | Assets versionados dos perfis; preservar enquanto houver ambientes dependentes |
| `config.yaml` | Configuração versionada, sem valores secretos |
| `credentials/` | Arquivos secretos referenciados e privados |
| `data/` | Storage persistente e registros da fábrica |
| `environments/` | Recursos persistentes administrados pelo adapter, sem interpretação interna pelo controlador |
| `run/` | Socket e arquivos transitórios |

As áreas `records/<work_id>/sessions/`, `logs/` e `evidence/` aprovadas no
[contrato de observabilidade](22-observability-retention-contract.md) ficam sob a área persistente `data/`.
Seus ciclos de vida e proteção não mudam. O lock permanece estável e associado ao storage canônico, nunca à release ou a um socket descartável.

Setup repetível cria subdiretórios/permissões próprios, gera exemplo inicial e verifica pré-requisitos.
Não sobrescreve configuração, credenciais ou dados, não inicia tickets, não instala pacotes, não usa sudo implicitamente e
não altera permissões recursivamente em conteúdo preexistente desconhecido. Repositórios começam vazios.
Filesystem local deve suportar persistência/lock; incompatibilidade e paths longos demais para socket Unix geram diagnóstico,
sem fallback escondido. Instalação autocontida não promete relocação livre por cópia: parar e validar referências de ambientes existentes.

Conta dedicada é recomendada, não obrigatória. Na conta pessoal, controlador/SDK/adapter host possuem as permissões dessa conta,
sem adquirir root; falhas desses componentes podem alcançar arquivos acessíveis a ela. O modelo não recebe shell host:
implementação/testes executam na VM e revisores mantêm as restrições aprovadas. Não carregar ferramentas/plugins pessoais arbitrários.

Serviço systemd do controlador é opcional; setup pode gerar definição com paths escolhidos, registrando-a somente por solicitação explícita.
Primeiro plano e serviço executam o mesmo controlador/lock. Supervisão systemd dos ambientes, KVM/QEMU e demais pré-requisitos do adapter
continuam necessários; preparo administrativo é separado e explícito.

### Configuração e defaults

YAML com versão de schema, validado integralmente antes da aplicação, sem recarga automática no MVP.
Credenciais são referenciadas, não incluídas como valores secretos. Configuração inválida impede inicialização operacional com
diagnóstico, sem aplicação parcial silenciosa. Operações cotidianas são comandos persistidos, não edições do YAML.

| Nível | Campos e regra |
| --- | --- |
| Instalação | Operadores GitHub, provider/modelo de Builder/Standards/Spec, concorrência, polling, retenção, referências de credenciais e configuração do adapter |
| Repositório | Identidade, branch-base, label, permissão explícita de alteração de workflows, limites de correção/recuperação e timeout opcional |
| GitHub App | App ID, installation ID associado aos repositórios e referência à chave protegida conforme [contrato da App](11-github-app-contract.md) |
| Adapter | Configuração/perfil e política de rede conforme sua interface aprovada, sem duplicar flags ou dimensionamento no controlador |

Repositório/base/operadores são informados explicitamente; não descobrir repos e autorizá-los silenciosamente.
Label omitida significa `ready-for-agent`, com override por repo e valor efetivo visível.
Issue aberta com label em repo configurado autoriza entrada sem segunda aprovação quando a fábrica está operando sem pausa,
respeitadas dependências/elegibilidade. A lista de operadores autoriza comentários, não muda a confiança da CLI local.

Defaults: concorrência 1; polling 60 segundos configurável, respeitando rate limit/espera GitHub e evitando consultas sobrepostas
descontroladas; três correções e três retomadas operacionais, esperas 5/15/45 segundos conforme contrato de estados;
timeout ausente por padrão; retenção elegível de detalhes 30 dias conforme contrato de observabilidade.
Modelos dos três papéis são explícitos, podendo coincidir; sem fornecedor default, fallback ou herança pessoal.
Workflows exige escolha explícita por repo; limites omitidos usam defaults.
Defaults de sandbox pertencem somente ao adapter. Sem herança multicamada ou overrides arbitrários por Trabalho.

Mudanças entram por reinício. Novas ativações registram configuração efetiva e respeitam compatibilidade de sessões.
Não reinterpretar histórico, zerar contadores ou desbloquear orçamento esgotado apenas aumentando limite no YAML:
concessão adicional permanece explícita. Reduzir concorrência impede novos disparos acima do limite, sem cancelar Trabalhos.
Alterar base/remover repo não migra/apaga Trabalhos: incompatibilidades bloqueiam novos passos afetados e são explicadas.
Alterar configuração não renova autorização nem escopo.

### Autoridade, início, pausa e parada

CLI e ingressos GitHub usam o controlador proprietário e o
[protocolo local aprovado](15-controller-worker-protocol.md): socket Unix privado, permissões da conta, lock exclusivo
do storage e barreira de recuperação. Sem HTTP, autenticação local adicional, escrita operacional direta no banco ou segundo proprietário.

`pause` persiste a pausa de novos disparos, sem matar builders ou interromper acompanhamento/respostas/reconciliação.
`unpause` não remove impedimentos ou suspensão de autorização dos Trabalhos.

Parada normal de `run`, inclusive Ctrl+C ou parada pelo serviço, fecha despacho e solicita cessação supervisionada,
preservando contexto/artefatos; não cancela Trabalhos. Só declarar parada limpa após cessação e persistência confirmadas.
A continuação segue [a classificação de parada administrativa no contrato de estados](08-state-and-effects-contract.md#limites-falhas-e-tempo),
aprovada na [revisão cruzada](23-architecture-cross-review.md); não cobrar retomada por falha apenas pela parada limpa.
Parada forçada/incerta exige reconciliação no boot. Reiniciar não remove pausa, renova autorização ou zera limites.
Reutilizar observação/parada e prazos do adapter; não adotar workers sobreviventes nem presumir que liberar lock comprova cessação.

### CLI e comentários

Usar `./factory` dentro da instalação; abaixo, `factory` abrevia a mesma entrada.
Inspeção tem saída humana e `--json`, sem linguagem genérica de consultas.

| Comando | Semântica |
| --- | --- |
| `setup` / `run` | Preparação local repetível / controlador em primeiro plano |
| `doctor` | Diagnóstico sem reparo automático |
| `status` / `list` | Estado global, pausa, Slots, impedimentos / Trabalhos e filas |
| `show <trabalho>` | Resultado, autorização, bloqueios, perguntas, PR, consumo e evidências |
| `history <trabalho>` / `logs <trabalho>` | Histórico paginado / logs com filtros por Execução/papel |
| `request <pedido>` | Consultar resultado/andamento de ingresso identificado |
| `pause` / `unpause` | Controle global dos novos disparos |
| `cancel <trabalho>` | Solicitar interrupção e encerramento, preservando artefatos |
| `answer <pergunta> <texto>` | Resposta autorizada e correlacionada |
| `resume <trabalho>` | Autorizar retomada/nova tentativa e renovação suspensa, revalidando demais requisitos |
| `repair <trabalho> --reason <texto>` | Solicitar correção no escopo vigente |
| `update-scope <trabalho> --reason <texto>` | Autorizar nova versão do pedido conforme captura aprovada |
| `grant <trabalho> --corrections <n>` ou `--recoveries <n>` | Conceder orçamento adicional da categoria, preservando histórico |
| `new <ticket>` | Novo ciclo explícito após entrega/cancelamento, ligado ao anterior |
| `reopen <trabalho>` | Autorizar reabertura do PR próprio fechado sem merge |
| `cleanup <trabalho>` | Limpeza seletiva de recursos/logs/sessões, com seleção e confirmação explícitas |
| `forget <trabalho>` | Excluir histórico elegível, preservando memória mínima de ciclo/resultado/merge para antirredisparo e dependências |

Nenhum comando significa ignorar todos os impedimentos ou lançar Builder diretamente.
`resume` não reabre PR ou ressuscita Trabalho cancelado/entregue.
`reopen` não concede escopo/orçamento nem dispensa retomada explícita quando necessária.
Novo ciclo após cancelamento exige cessação e reconciliação; PR ainda aberto do ciclo cancelado exige decisão do operador,
sem adoção/fechamento/substituição silenciosos.

Comentários usam prefixo estrito `/factory`; prosa comum não é comando.
Operações de Trabalho usam o contexto do ticket/PR correspondente, sem permitir apontar outro Trabalho.
`/factory answer <pergunta> <texto>` valida também essa correlação.
Reutilizar operações/validações locais e operadores autorizados; bots/terceiros não concedem autoridade.
Operações globais, instalação, diagnóstico administrativo e exclusões destrutivas ficam locais.

Autorizações excepcionais para reconciliação de conteúdo/base usam Pergunta/resposta vinculada ao bloqueio e referências concretas,
conforme [manutenção do PR](20-pr-maintenance-contract.md). Não criar comando especializado por caso ou autorização genérica.
Referências novas exigem reavaliação e nova autorização quando necessário; orçamento/escopo permanecem separados.

Durante atividade, repair/update-scope persistem para a próxima ativação segura, sem alterar o escopo vigente ou criar segundo Builder.
Resume informa atividade existente sem nova ativação; cancel mantém a semântica explícita de interrupção/encerramento.
Informar aceito para depois, já atendido ou recusado; consolidar feedback para não multiplicar Execuções.

### Identidade, recibos, indisponibilidade e diagnóstico

CLI gera/apresenta identidade antes do envio de comando mutável; automação pode fornecer `--request-id`.
Controlador persiste ingresso junto com transição. Mesmo ID/conteúdo retorna resultado conhecido; conteúdo diferente com mesmo ID é erro.
Reutilizar deduplicação de ingresso GitHub existente. Sem banco, diário paralelo ou fila offline da CLI.

ACK confirma pedido persistido, não efeito concluído/cessação. Perda de conexão pode significar resultado indeterminado;
consultar `request` ou reenviar a mesma identidade/conteúdo, sem repetição cega.
Ausência de registro significa pedido não localizado, não prova de inexistência de outro ingresso equivalente.

Consultas lógicas e mutações exigem controlador disponível. Offline, somente diagnóstico de configuração, versões,
paths/pré-requisitos e logs do processo/serviço; sem leitor operacional paralelo do banco.
Indisponibilidade não é lista vazia ou sucesso presumido.

Doctor verifica configuração, permissões próprias, versões e pré-requisitos, delegando validação da sandbox ao adapter.
Consultas autenticadas GitHub passam pelo controlador disponível e verificam acesso operacional, não certificam proteções de merge/CI.
Não instalar pacotes, remover locks, matar processos, alterar permissões desconhecidas ou modificar GitHub.
Erros informam motivo, alcance do impedimento e ação necessária, sem segredos.
Distinguir sucesso, entrada inválida, recusa, indisponibilidade e resultado indeterminado; códigos JSON estáveis para automação.

### Limpeza e exclusão

Aplicar integralmente as políticas de [retenção e exclusão](22-observability-retention-contract.md), sem backend novo.
Cleanup exige seleção explícita de recursos/logs/sessões, apresenta plano de perdas e exige confirmação;
automação pode confirmar por opção, nunca dispensar verificações.
Na execução revalidar propriedade, cessação, uso e pendências; plano antigo não é autorização para apagar recurso agora em uso.

Preservar evidência de reconciliação; cancelamento prévio quando necessário para destruir contexto de Trabalho aberto.
Forget exige encerramento e ausência de recursos/efeitos pendentes; PR fechado sem merge exige cancelamento para excluir histórico.
Manter a memória mínima prevista no [contrato de exclusão](22-observability-retention-contract.md#limpeza-explícita-exclusão-do-histórico-e-cópias-externas),
para impedir redisparo automático pela label e preservar a avaliação de dependências próprias.
Não fechar PR, desfazer GitHub, apagar base/recursos alheios nem limpar Docker globalmente.
Falhas parciais permanecem visíveis/repetíveis nos recursos próprios pendentes, sem desfazer entrega.

### Atualização e limite de recuperação

Procedimento mínimo documentado, sem gerenciador de pacotes ou autoatualização:

1. Pausar novos disparos e parar com cessação confirmada.
2. Extrair/verificar nova release em diretório próprio, preservando a anterior.
3. Validar compatibilidade de configuração, formatos persistidos, sessões e perfis/ambientes antes de modificar estado.
4. Executar somente migração explicitamente fornecida e solicitada pelo operador.
5. Iniciar pausada, reconciliar e inspecionar antes de despausar.

Incompatibilidade sem migração suportada é recusada antes de alterar estado.
Migração suportada deve detectar interrupção e definir conclusão/recuperação própria; não aceitar estado parcialmente alterado sem saída conhecida.
Não migrar discos implicitamente nem descartar assets dependentes.
Release anterior só pode operar estado compatível; preservar executável não garante rollback universal.

**Sem suporte integrado a backup/restauração no MVP:** nenhum comando, agendamento, expiração ou certificação de cópias.
RNF-01/RF-13/CA-06 exigem recuperação após crash a partir do estado persistido, não recuperação de perda do storage.
Proteção contra essa perda é externa, sob responsabilidade do operador.
Cópias externas não são certificadas; podem recuperar dados excluídos e não desfazem efeitos GitHub nem dispensam reconciliação.
Exclusão local não apaga cópias anteriores. Esta revisão substitui o encaminhamento anterior do contrato de observabilidade
para procedimento integrado de backup/restauração, sem reabrir políticas de retenção.

### Provas futuras e encaminhamentos

| Cenário | Critério observável |
| --- | --- |
| Extração/setup repetido | Paths próprios privados; nenhum dado/segredo sobrescrito, repo autorizado ou mudança administrativa implícita |
| Primeiro plano/serviço e segundo início | Mesma autoridade/lock; segundo proprietário recusado; ausência de shell host nos agentes |
| Configuração inválida/alterada | Diagnóstico preciso; sem aplicação parcial, redisparo, contadores zerados ou escopo alterado silenciosamente |
| Pausa/parada/crash | Pausa persistida, cessação comprovada ou incerteza visível; parada limpa sem cobrança indevida de retomada, crash sem duplicar escritores/efeitos — CA-06/07 |
| Resposta/comando repetido ou conexão perdida | Uma transição por ingresso; resultado indeterminado consultável; sem autorização por prosa/terceiro — CA-05/10 |
| Mudança de escopo durante Execução | Escopo vigente preservado, nova ativação segura e sem segundo Builder |
| Limite/concessão/timeout | Categorias e histórico preservados; nenhuma edição de configuração ignora esgotamento — CA-11 |
| CLI offline e doctor | Indisponibilidade explícita; diagnóstico não modifica storage operacional/host/GitHub |
| Limpeza parcial/plano desatualizado | Revalidar propriedade/uso, preservar pendências e memória de ciclo/resultado/merge para antirredisparo e dependências — CA-02/07/10 |
| Atualização incompatível/interrompida | Recusa prévia ou recuperação da migração suportada; sem promessa de rollback universal |
| Inspeção humana/JSON | Bloqueio, causa, histórico, lacunas e próximo passo verificáveis — CA-12 |

São critérios futuros, não evidência de conformidade. Nenhuma prova ou instalação foi executada.
A revisão cruzada, a cobertura completa de RF-01–14/RNF-01–05/CA-01–12 e a consolidação final seguem em tickets próprios;
não produzir spec implementável nem decompor implementação nesta resolução.
