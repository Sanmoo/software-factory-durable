# Definir o contrato e o perfil distribuível do adapter Gondolin

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão Pi `01a1a3f7-629e-72a8-8dc8-48f4d2b7e9fa`; branch de registros `software-factory-adapter-contract`, worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-adapter-contract`; integração em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`, sem publicação. Recursos da sessão removíveis após integração e validação.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 06, 07, 18

## Question

Qual é a menor interface de sandbox e o perfil concreto do adapter Gondolin que tornam implementáveis as escolhas de isolamento já aprovadas, sem espalhar configuração ou implementação do backend pelo controlador?

Definir operações, identidades persistentes e de inicialização, observações e resultados; configuração/unidades/capacidade; perfil distribuível, imagem/Docker, pré-requisitos e permissões; acesso dos revisores, proteção do host e credenciais; desligamento/novo boot, cessação e remoção própria. Distinguir desenho de provas futuras, sem criar outro motor, scheduler, framework de plugins ou backend.

A expectativa original de fixar todos os números de versão nesta decisão foi ajustada explicitamente em Q16: decidir a composição e o manifesto obrigatório, preenchendo versões exatas e integridade dos artefatos efetivamente construídos na futura release. Não inventar artefato homologado antes de construí-lo e validá-lo.

## References

- [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](07-isolation-choice.md).
- [Verificar Gondolin como ambiente de execução isolado da fábrica](18-gondolin-isolation-research.md), com relatório imutável e limites de evidência.
- [Escolher o runtime de agentes e seus pontos de integração](06-agent-runtime-choice.md).
- [Definir estados, filas, persistência e reconciliação dos efeitos](08-state-and-effects-contract.md).
- [Definir o contrato de permissões e verificação da GitHub App](11-github-app-contract.md).
- [Definir a captura versionada da especificação e das instruções](16-specification-snapshot-contract.md).
- [Definir o pacote de skills e o contrato verificável de revisão e validação](17-skills-and-review-contract.md).
- [PRD — Software Factory MVP](../prd.md): RF-03–07, RF-12–14; RNF-01–03/05; CA-03/05–08/11–12.

## Comments

- Reivindicação registrada antes do trabalho e integrada em `main` no commit `644c99f`. Esta sessão resolve somente esta decisão não-research.
- Q1–Q4 aprovadas com “sim às quatro”; Q6–Q8 com “estou de acordo”. A proposta Debian de Q5 não foi aprovada; o operador questionou o peso e propôs facilitar Alpine com skill. Q5 reformulada foi aprovada com “de acordo”.
- Q9–Q11 aprovadas com “sim às três”; Q12–Q14 com “de acordo”; Q16–Q17 com “De acordo”.
- Q15 original não aprovada: o operador questionou manutenção de ferramentas próprias e sugeriu token temporário. Depois esclareceu: “Não precisa de shell geral, pode ter uma ferramenta simples e genérica (já ofertada pelo próprio pi) de leitura de arquivos”. O fechamento com `read`, índice/diff/contexto preservado e sem token GitHub no revisor foi aprovado com “sim”. Isso substitui o conjunto mais amplo de operações de revisão discutido em Q3, não a exigência de cobertura integral.
- Aprovações parciais consolidadas no Answer, única fonte da resolução. Não há Q15 pendente, implantação autorizada ou revisão de outros tickets resolvida por inferência.
- Reutilizada a pesquisa concluída, sem relançar agentes. Conferidas fontes fixadas de Gondolin e Pi e consultadas fontes oficiais de compatibilidade Alpine. Inspeção read-only identificou Arch Linux x86_64/systemd no host, sem QEMU no PATH/pacotes consultados; isso não homologa o host e não autorizou instalação.
- Validação documental: `git diff --check`; 22 tickets com status/tipos/labels/Answers/dependências válidos, grafo sem ciclos; 18 resolvidos indexados uma vez; 102 links locais/âncoras nos seis arquivos alterados conferidos. Probe ativo de diagnósticos nos seis arquivos retornou somente sugestões informativas de ortografia inglesa sobre termos portugueses, sem erros/avisos; não tratadas como correções do texto em português. Markdownlint CLI não disponível, sem instalação para esta sessão. Provas de runtime não executadas.

## Answer

### Escolha e alcance do perfil

Adotar um único perfil inicial **Gondolin QEMU/KVM, Linux x86_64, guest Alpine e Docker com driver `vfs`**, com **Arch Linux x86_64 como host de referência**. O suporte é à combinação validada, não a qualquer atualização rolling, distribuição Linux ou arquitetura. Sem ARM, krun, TCG ou fallback Docker como alternativa de sandbox no MVP.

Preservar as escolhas anteriores: ambiente/disco por Trabalho, workspace host via RealFSProvider, Builder e dois revisores na mesma VM em handoff controlado, workers Pi no host e Pi Durable/SQLite como única autoridade do domínio. Não adicionar snapshot obrigatório da worktree, commit candidato, VM auxiliar, serviço global de sandbox ou plataforma de delegação.

Alpine mantém proximidade do caminho upstream e reduz a base em relação à composição com rootfs Debian. Isso não prova menor RAM/CPU ou custo total; runtimes/builds/Docker podem dominar o consumo. Debian é alternativa a reconsiderar por necessidade concreta, não segundo perfil nem fallback automático. A base musl não garante compatibilidade de binários glibc ou de todas as dependências nativas.

### Manifesto, distribuição e pré-requisitos

Partir do recorte documental Gondolin **0.14.0**, commit `6b381a9fd1c353e80cc9b4cf35474b6909703a16`, sem presumir pacote/imagem homologados. O runtime Pi continua conforme sua decisão; não herdar Node ou recursos do perfil pessoal do operador.

Cada release fornece manifesto com:

- identidade do perfil e versões exatas de Node, Gondolin, QEMU e helpers;
- kernel, initramfs, base Alpine e pacotes da imagem;
- identidades/integridade dos artefatos, incluindo manifesto/checksums/buildId dos assets;
- kernel e systemd do host da validação e configuração efetiva usada nas provas.

Os números finais e hashes são preenchidos na construção/validação da release, como aprovado em Q16. Isso é execução posterior do desenho, não licença para mudar backend, base, papéis ou mecanismos silenciosamente. Nenhuma release é declarada suportada antes das provas.

Distribuir **assets prontos**, preparados no processo de release. A instalação comum e cada Trabalho não constroem imagem nem precisam de Docker/Podman no host apenas para produzi-la. Verificar integridade e fornecer paths explícitos; não usar descoberta no home pessoal, tags móveis ou downloads implícitos que substituam o perfil. Manter assets enquanto houver disco dependente; atualização não migra disco/base automaticamente.

O preparo administrativo instala/concede os pré-requisitos de execução: QEMU/ferramentas de disco, acesso a KVM funcional, supervisão systemd dos ambientes e storage apropriado aos arquivos persistentes. Conta dedicada é recomendada, não obrigatória, conforme o [contrato operacional](21-installation-operations-contract.md#alcance-e-instalação-autocontida). Nested KVM é necessário quando aplicável; ausência de aceleração bloqueia, sem TCG. A operação habitual usa conta sem poderes administrativos; não oferecer sudo/administração host aos agentes. Comandos/packaging e experiência de instalação pertencem ao ticket operacional.

### Configuração do adapter

```yaml
schemaVersion: 1
profile: <identidade do perfil distribuído>
memoryMiB: 2048
vcpus: 2
diskGiB: 40
shutdownGraceSeconds: 30
minFreeSpaceGiB: 4
```

O adapter valida esquema, tipos, valores e compatibilidade com o perfil; o controlador não mantém cópias paralelas desses campos nem interpreta flags QEMU/cgroups/units. Valores de recursos devem ser válidos para a operação, sem coerção silenciosa. A configuração efetiva é registrada por ambiente/inicialização. Política de rede autorizada vem da instalação/repositório, aplicada pelo adapter.

- **Memória:** 2048 MiB = **2 GiB = 2.147.483.648 bytes**. Precisão aprovada expressamente para a formulação anterior de “2 GB”; não é RAM total medida do host.
- **Disco:** 40 GiB = 42.949.672.960 bytes de capacidade virtual inicial, não reserva física nem garantia de suficiência. Sem redimensionamento automático no MVP.
- **CPU:** 2 vCPUs; não significa exclusividade ou reserva de dois núcleos físicos.
- **Parada:** 30 segundos para tentativa graciosa, configuráveis; não é timeout de Execução.
- **Piso livre:** 4 GiB = 4.294.967.296 bytes, configuráveis, como margem operacional inicial sem benchmark.

Antes do preparo, considerar cópias estimáveis e exigir a margem restante; antes de novo boot, verificar novamente o piso. Se workspace/disco ocuparem filesystems diferentes, verificar ambos. Distinguir capacidade virtual, uso físico do disco, espaço do workspace e espaço livre. Não reservar antecipadamente toda a capacidade, criar scheduler de recursos, prometer ausência de disco cheio ou apagar artefatos para abrir espaço. Cruzar o piso não mata Execução ativa: reportar e impedir novas operações afetadas; falha real durante execução continua visível ao controlador.

Não oferecer argumentos QEMU livres, scripts de init arbitrários ou mounts livres. Driver, paths internos e composição dos assets são definidos pelo perfil. RAM/vCPUs/prazo de parada podem mudar na próxima inicialização, com registro; não modificar VM viva nem migrar disco/perfil implicitamente.

### Interface, referências e resultados

Os nomes abaixo descrevem operações da interface, não novas APIs alegadas do SDK:

| Operação | Entrada/resultado essencial | Limite |
| --- | --- | --- |
| Validar configuração | Configuração/perfil e pré-requisitos → diagnóstico | Não inicia VM; inspeção estática não prova boot/Docker |
| Preparar ambiente | Identidade do Trabalho e configuração autorizada → referência persistente | Prepara recursos próprios, não executa Builder; repetição não cria duplicata |
| Iniciar ambiente | Referência persistente/configuração compatível → referência desta inicialização quando operacional | Reutiliza disco/workspace; não adota execução sobrevivente após crash |
| Executar ferramenta | Inicialização, papel e operação autorizados → resultado/atividade/erro | Não entrega SDK irrestrito ao worker; não transforma timeout em ausência de efeito |
| Observar ambiente | Referência persistente/inicialização → condição, evidências e consumo disponível | Não deduz morte de PID nulo, ausência de recibo ou falha de consulta |
| Parar ambiente | Referência própria → resultado de parada/cessação | Preserva disco/workspace; distingue gracioso de forçado |
| Remover ambiente | Referência própria e autorização de cleanup → removido ou resultado parcial/erro | Exige cessação; não apaga histórico lógico, PR ou branch remota |

**Referência persistente do ambiente:** opaca para o controlador; identifica o ambiente do Trabalho, seu disco, workspace e perfil, sobrevivendo à troca de processo/objeto SDK. **Referência de inicialização:** identifica uma ativação concreta e seus recursos supervisionados; muda em novo boot. O controlador persiste referências e correlação, sem interpretar paths, PIDs ou nomes de units.

Observação distingue **ativo**, **parado com cessação confirmada**, **removido** e **indeterminado**. Informa evidências associadas à identidade observada; consumo indisponível não é zero. Falha conhecida de uma operação e condição atual do ambiente são dimensões distintas: um erro ao parar pode deixar o ambiente ativo ou indeterminado.

Resultados distinguem sucesso, falha conhecida e resultado indeterminado. Não repetir cegamente operação ambígua, reaproveitar recurso incompatível nem remover recurso de propriedade incerta. Cleanup parcial permanece identificável e repetível; não transformar erro em “já removido”. Retomada é **iniciar novamente o ambiente preservado**, não restaurar RAM/processos.

O [protocolo controlador–worker](15-controller-worker-protocol.md) concretiza mensagens, gerações, reservas, recibos, fencing, correlação e barreira de recuperação usando esta interface; não cria outro banco/motor nem duplica seus métodos/configuração.

### Processos, supervisão e cessação

Um **processo host do adapter por Trabalho ativo** é dono de uma única instância Gondolin, separado dos workers Pi. Mantém a VM durante o handoff e atende ferramentas autorizadas. A separação evita colocar VMMs de Trabalhos diferentes no conjunto de children de um mesmo proprietário Gondolin, relevante para o fallback de término documentado.

O adapter organiza seus processos, workers associados e QEMU em grupos identificáveis pelo systemd; controlador continua decidindo quem/quando executar. Não criar supervisor próprio ou serviço global adicional. A observação relaciona recursos supervisionados à inicialização própria, em vez de confiar somente em PID reutilizável.

Na parada normal, tentar encerrar containers/daemon Docker e sincronizar guest antes de fechar VM. Até o prazo configurado, tentar encerramento gracioso; depois recorrer ao término forçado dos processos próprios. Distinguir:

- **cessação confirmada:** recursos próprios capazes de continuar escrevendo foram encerrados, com evidência da supervisão;
- **parada graciosa concluída:** também foi possível finalizar atividades/sincronizar antes do término.

Retorno de `close()`/`abort()`, `getHostPid() == null`, processo proprietário morto ou token expirado não provam cessação. Identidade/término indeterminados bloqueiam substituição/liberação presumida de Slot. A concretização da correlação e das barreiras é do protocolo; não atribuir exclusão física ao owner único do SQLite.

Preservar disco após término forçado e verificar usabilidade no próximo boot; não declarar integridade apenas porque o VMM morreu. Na recuperação de crash, manter a estratégia já aprovada de encerrar sobreviventes próprios, confirmar cessação, reconciliar efeitos e retomar — sem adoção de execução viva. Push/PR/pergunta já enviados podem concluir durante parada e continuam sujeitos à reconciliação externa.

### Filesystem, conta da instalação e confiança

Preferir **uma conta dedicada, não administrativa**, sem conta Linux por Trabalho. A revisão do [contrato operacional](21-installation-operations-contract.md#alcance-e-instalação-autocontida) permite usar a conta pessoal: processos host têm as permissões dessa conta, sem adquirir root; não expor poderes administrativos aos agentes. Separar storage de controle/chave, assets/cache Git, workspace/disco por Trabalho e sessões/registros. O controlador, adapter e workers host integram a base confiável; a mesma conta e a separação de diretórios **não** protegem contra comprometimento desses processos ou acesso aos arquivos que essa conta possa ler.

O código do repositório executa no guest. Não expor ferramenta host, plugins/extensões do repo, home pessoal, SQLite, chave emissora, cache Git, sessões do host, socket Docker host ou recursos de outros Trabalhos. RealFSProvider expõe somente a área de workspace daquele Trabalho; paths/symlinks não podem escapar. Considerar também aliases do mount FUSE, não só a string `/workspace`.

Dentro da área própria exposta, distinguir checkout/metadados Git independentes e artefatos operacionais acessíveis ao Builder/revisores, **fora das alterações destinadas ao PR**. Isso acomoda `spec/<versão>/` e `instructions/<versão>/`, com seus `sources.json`, sem montar diretórios gerais do controlador. Saídas longas necessárias aos agentes seguem a [exposição seletiva do contrato de observabilidade](22-observability-retention-contract.md#saídas-volumosas-e-falhas-de-gravação) nessa área própria, com leitura confinada e sem montar os registros host. Recursos auxiliares das skills necessários à leitura seguem o perfil explícito da fábrica, não o perfil pessoal. A disposição física final sob a raiz da instalação será documentada no contrato operacional sem ampliar mounts.

O cache Git bare permanece exclusivo da fábrica e nunca montado, com preparação sequenciada por repo e cópias independentes conforme a decisão de isolamento. Acesso root/Docker dentro do guest não concede administração host; os limites residuais de ambiente não adversarial continuam explícitos.

### Imagem, dependências e persistência

A imagem Alpine traz as ferramentas básicas de implementação/revisão, Git/gh, certificados, Docker e utilitários necessários ao disco/boot; o manifesto fixa os pacotes efetivos. Runtimes/dependências específicos do repo podem ser instalados pelo Builder **no guest**, sem imagem por repo ou caches pessoais no host.

Incluir no pacote próprio uma **skill de preparação/diagnóstico Alpine**: identificar versões requeridas, orientar `apk`, distribuições musl e compilação quando apropriada, registrar instalações e distinguir falha de preparo de falha de código. Não trocar versões exigidas, stack, testes ou imagem silenciosamente. Fonte/incompatibilidade não resolvida é impedimento explícito; a skill não é novo gerenciador de ambientes nem converte ABI/garante compatibilidade universal.

Usar disco persistente próprio, com assets/base preservados e deleção automática no close desativada. O suporte documental de `sandbox.rootDiskPath`/formato/`rootDiskDeleteOnClose: false` não equivale a prova de recuperação. Não usar o overlay descartável padrão como armazenamento durável.

Configurar **`tmpfs: {}`**: `/root`, `/tmp`, `/var/tmp`, `/var/cache` e `/var/log` ficam no disco; `/run` continua efêmero. Preservar pacotes/caches/Docker data e diagnósticos entre Execuções, sem prometer processos vivos nem limpeza automática desses diretórios na retomada. Workspace e metadados Git persistem no provider host, fora do disco/checkpoint da VM; não existe transação atômica entre esses arquivos, SQLite e GitHub.

Docker usa daemon próprio no guest, data-root persistente e **driver `vfs`**. Esse driver faz deep copy, pode elevar disco/I/O e não é o VFS/FUSE Gondolin. Não supor que qcow2 externo elimine seu custo ou que 40 GiB bastem. Custo/compatibilidade inadequados voltam ao operador, sem troca automática para `overlay2`, desligamento de Ryuk ou enfraquecimento dos testes.

### Revisores: somente `read` e contexto da rodada

O conjunto de ferramentas de **acesso a contexto** dos revisores é apenas o **`read` nativo do Pi**, com `path`, `offset` e `limit`, reaproveitando paginação e suporte de arquivos/imagens. Não fornecer shell, escrita, Docker, wrappers Git, ferramentas próprias de busca/listagem ou consulta remota no perfil inicial. Resultados dos revisores continuam pelo mecanismo de workers já aprovado.

A API `createReadTool` admite operações substituíveis de `access`, `readFile` e detecção opcional de imagem. O adapter encaminha essas operações à leitura autorizada no guest e confina paths/symlinks; **trocar cwd não basta**. Não usar defaults host nem fallback host para leitura/detecção. Nenhuma operação exposta ao revisor escreve no workspace. A restrição é da ferramenta e de seu backend, não só do prompt.

No handoff, fornecer **índice de arquivos, diff e referências da rodada**, além dos caminhos da especificação/instruções preservadas. Esse material complementa a identificação de conteúdo já exigida pelo contrato de revisão; não substitui a inspeção do resultado real nem autoriza o Builder a fabricar pareceres. O Builder conserva as fontes com as ferramentas normais, sem coletor/ingestão documental no controlador.

Cobrir alterações commitadas, staged, não staged, arquivos novos, remoções e demais mudanças relevantes. O revisor recebe caminhos de entrada e pode ler outros arquivos/contexto local, não apenas hunks. Índice/diff não são snapshot obrigatório da worktree nem commit candidato. A correlação com identidade do conteúdo, invalidação após alterações e cobertura efetivamente publicada continuam no contrato de revisão.

Usar as cópias versionadas do pedido e fontes necessárias, não presumir que a issue atual seja a especificação vigente. **Não entregar token GitHub aos revisores neste fluxo** nem criar ferramenta de consulta remota. A possibilidade de token de leitura no contrato da App não obriga seu uso; token não restringiria filesystem nem mostraria alterações locais não publicadas.

`read` não lista diretórios, calcula diff ou consulta URLs sozinho. Arquivo ausente/ilegível, fonte faltante, truncamento não superado ou limitação que impeça inspecionar conteúdo necessário produz indicação de **revisão incompleta**, nunca aprovação presumida. Paginar quando possível; uma mensagem padrão sugerindo bash não autoriza acrescentar shell. Complementação de contexto segue o fluxo de revisão existente, sem ampliar poderes. Não prometer congelamento contra outros escritores.

### Rede, certificados e credenciais

Manter HTTP(S) público mediado, sem lista manual de cada domínio público e sem acesso geral ao host/redes privadas/outros Trabalhos. Exceções privadas são autorizadas na configuração de instalação/repo; não liberar protocolo/rede automaticamente quando algo falhar. Testes comunicam-se dentro da VM, sem exposição de portas para fora por padrão.

Separar três caminhos de confiança TLS:

1. guest e ferramentas comuns, configurados pelo perfil;
2. daemon Docker para pulls/acessos externos;
3. runtimes com truststore próprio e aplicações dentro de containers.

A skill orienta runtimes instalados como Java. Containers com HTTPS externo recebem a configuração apropriada pelo mecanismo suportado pelo projeto; não exigir CA apenas para tráfego interno. O wrapper upstream de `docker run` não prova Testcontainers, Compose, API Docker ou Dockerfile/build. Adaptação necessária nos testes é explícita; sem alteração silenciosa, `--insecure`, desativação TLS ou ampliação de rede como fallback. Pull funcionando não comprova HTTPS dentro do container.

Builder continua publicando diretamente com Git/gh e token reduzido fornecido pelo ambiente explícito de cada comando, separado de argv. Não encaminhar ambiente inteiro do host, persistir token em disco/configuração/prompt ou criar cofre/broker. Revisores não recebem esse ambiente nem token. Emissão/renovação/revogação e token perdido após crash permanecem no contrato da App; observabilidade detalha filtragem antes de logs/sessões. Código ao qual o token foi legitimamente entregue pode copiá-lo: não prometer segurança contra código deliberadamente hostil.

### Evidência documental e provas requeridas

Fontes fixadas de Gondolin: [custom-images](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/custom-images.md), [sdk-storage](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/sdk-storage.md), [VFS](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/vfs.md), [SDK VM](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/sdk-vm.md), [QEMU](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/qemu.md) e [init Docker](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/examples/docker-init-extra.sh). O [relatório imutável](https://github.com/Sanmoo/pkm/blob/3f928a4ff4eeae3268661d8921b722cdee714b7a/.scratch/software-factory/research/gondolin-isolation.md) continua sendo evidência documental, não aceite.

Pi: [read.ts no snapshot do runtime](https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/src/core/tools/read.ts), conferido diretamente, sustenta reaproveitamento/operations e limites da ferramenta. Fontes oficiais móveis de [Node/Alpine](https://github.com/nodejs/docker-node/blob/main/README.md#nodealpine) e [PyPA/musllinux](https://packaging.python.org/en/latest/specifications/platform-compatibility-tags/#musllinux) sustentam riscos de dependências, não incompatibilidade de um piloto particular nem medição da fábrica.

**Provas futuras, com autorização própria:**

| Prova | Resultado necessário / cobertura |
| --- | --- |
| Perfil fixado e preparo | Assets íntegros, KVM real sem fallback, nenhuma dependência do perfil pessoal e nenhuma administração host pelo agente; boot/Docker funcionais no x86_64 escolhido |
| Três Trabalhos, dois no mesmo repo | Ambientes, discos, Git e VMMs próprios; medir RAM/CPU/I/O/disco incluindo overhead/driver; falha de um proprietário Gondolin não encerra os demais — CA-03/08 |
| Docker/Testcontainers/Ryuk | Suites reais, binds FUSE/paths, socket guest, portas/DNS/names/volumes e limpeza própria; nenhum bypass de testes ou Ryuk — CA-08 |
| TLS por camada | Guest, daemon, runtimes próprios e containers API/Compose/build conforme pilotos; sem falsa equivalência de wrapper e API — RF-07, RNF-02 |
| Git e read integral | Git por FUSE com locks/renames/metadados; índice/diff incluindo novos/deletados/não commitados; revisão lê contexto além dos hunks; paths/symlinks/aliases não expõem host/segredos; tentativas de escrita negadas e truncamento sem falso sucesso — CA-01/12 |
| Parada e novo boot | Pacotes/caches/Docker data/workspace/contexto preservados, sem reclone; parada forçada distinta de graciosa, ambiente inutilizável bloqueia — CA-05/11 |
| Crash e cancelamento | Cortes de controlador/worker/proprietário, subprocessos sobreviventes e efeito externo sem recibo; cessação antes de substituto, sem dupla escrita — CA-06/07 |
| Capacidade e cleanup | Piso de espaço, disco cheio, falha/retomada de remoção própria, preservação de não entregue e histórico; sem limpeza global — CA-07, RF-14 |

Falha decisiva exige correção compatível ou retorno ao operador, não relaxamento do PRD. Estas provas não foram executadas: não foram instalados pacotes, criadas contas/units/imagens/VMs, executados modelos ou usados tokens reais.

### Encaminhamentos e encerramento

- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md): consumir referências/resultados desta interface, correlacionar supervisão/ownership, barreiras e handoff com caminhos de contexto, sem reintroduzir wrappers de ferramentas ou ingestão documental.
- [Definir a configuração, a CLI e o ciclo operacional da instalação](21-installation-operations-contract.md): incorporar conta/pré-requisitos/manifesto/perfil e configuração do adapter, com paths concretos, atualização e recuperação após crash, sem backup integrado nem migração automática de assets/discos.
- [Definir observabilidade, proteção de segredos e retenção dos artefatos](22-observability-retention-contract.md): consumo/indisponibilidade, motivo de parada, evidência de cessação, falha parcial de cleanup e retenção protegida de artefatos/contexto.
- [Definir o pacote de skills e o contrato verificável de revisão e validação](17-skills-and-review-contract.md): consumir a skill Alpine e o handoff com `read`, índice/diff/fontes preservadas; sem criar ferramenta especializada por consulta.

Os encaminhamentos já têm tickets próprios. Cobertura final de aceite/construção incremental e revisão cruzada continuam na névoa do mapa, dependentes dos contratos restantes. Nenhuma nova decisão autônoma foi criada por estes detalhes. Esta resolução fecha o desenho do adapter, **não** a spec integral, a homologação ou a implementação da fábrica.
