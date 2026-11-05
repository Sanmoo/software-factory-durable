# Isolamento Linux e Docker concorrente por Trabalho — pesquisa documental

**Data da consulta:** 2026-11-03 (UTC). **Estado:** pesquisa, não decisão de backend nem homologação.
**Autoridade:** [PRD da Software Factory](../prd.md), especialmente RF-03–04, RF-07, RF-10, RF-12–14, RNF-01–02 e CA-03/05–08.
**Origem:** [ticket de pesquisa](../issues/04-linux-docker-research.md), na [cartografia Wayfinder](../map.md).
**Plataforma da investigação:** Linux em uma única máquina é premissa aceita no mapa, não o significado de RNF-01; esse requisito do PRD trata de durabilidade e reconciliação. [MAP] [PRD]

## 1. Resposta curta e limites

Há alternativas intermediárias entre worktree sem contenção e VM. Docker rootless sob uma conta Unix dedicada reduz o privilégio do daemon; sandbox de processo pode limitar os caminhos e processos vistos pelo Builder; daemon por Trabalho separa os recursos da API Docker. **Essas três propriedades são distintas e não vêm automaticamente juntas.** Rootless usa user namespace, não uma VM; bubblewrap permite construir um filesystem visível restrito, mas sua política depende dos argumentos; bind mounts Docker são resolvidos pelo daemon, não pelo cliente. Logo, conter só o Builder não contém os poderes indiretos concedidos pelo socket. [D01] [D07] [S01]

**Conclusões documentais, sem escolher tecnologia:**

1. **Não tratar socket do Docker rootful pessoal como padrão aceitável.** Controle dessa API permite montar e alterar o filesystem do host com os poderes do daemon. Montar o socket como arquivo somente leitura não transforma a API em somente leitura: é uma conexão de controle, não um arquivo de configuração. Esta última conclusão decorre do modelo de API descrito pela Docker. [D06]
2. **Usuário/daemon rootless dedicado à instalação é uma redução real, mas não isolamento entre Trabalhos.** Clientes do mesmo endpoint continuam controlando o mesmo daemon. Prefixos, labels e projetos Compose reduzem colisões cooperativas, não são autorização de acesso por Trabalho. [D01] [D06] [D08] [D14]
3. **Daemon por Trabalho resolve uma classe maior de colisões do que somente namespaces de nomes**, mas exige dados/runtime/configuração próprios, planejamento de rede e recuperação. A documentação classifica múltiplos daemons no mesmo host como experimental; rootless não é uma dispensa documental desse aviso. Separar sockets sob o mesmo UID também não cria uma fronteira DAC entre Trabalhos. [D08] [D09] [D04]
4. **Usuário por Trabalho + sandbox do Builder + daemon rootless próprio é candidato intermediário, ainda condicional.** Protege arquivos privados de outras contas pelas permissões, mas o daemon no host pode acessar arquivos públicos e tudo permitido à sua conta. Para atender uma política estrita de caminhos, é preciso conter também a visão de filesystem do daemon, ou explicitar uma superfície de host permitida. A composição concreta daemon+sandbox permanece não provada. [D01] [D04] [D07] [S01] [L01]
5. **Container com Docker interno não equivale automaticamente a menos poderes.** O padrão oficial `dind-rootless` dentro de Docker rootful ainda requer `--privileged` no container externo, para desabilitar seccomp, AppArmor e máscaras de mounts. VM por Trabalho desloca o daemon e os mounts para um kernel/filesystem guest, mas adiciona imagem, rede, armazenamento e ciclo de vida próprios. MicroVM tem obrigações operacionais adicionais, não é requisito do PRD. [D02] [V01] [V02] [V03]
6. **Testcontainers/Ryuk em Docker rootless tem evidência local positiva estreita**, não certificação geral. O smoke registrado executou um método Java com Testcontainers 2.0.5, Ryuk 0.14.0 e Docker 29.7.2; não demonstrou concorrência, SIGKILL, reboot, quotas ou reconciliação da fábrica. [L01] [L02] [L03] [L04]

### Método e proibições observadas

Esta sessão leu documentação/código públicos por HTTPS e registros já versionados no repositório. Não instalou pacotes, não chamou Docker, não criou contas, não leu credenciais, não alterou host/configuração e não executou programas das provas locais. Os comandos de validação deste documento não são provas de isolamento.

As ferramentas web não estavam disponíveis na allowlist do pesquisador. Após tentativa de habilitação pelo supervisor, ele autorizou leitura pública via `urllib`/HTTPS. Páginas `java.testcontainers.org` e `git-scm.com/docs/git-worktree` retornaram **HTTP 403**; foram usados os documentos e o código dos próprios projetos no GitHub, não fontes secundárias. Não foi trocado o transporte Git. As fontes efetivamente usadas e suas revisões estão na seção 9.

**Convenção de evidência:** “documentado” significa fonte primária; “registro local” significa relato/recibo anterior, sem reexecução; “inferência” identifica consequência do modelo; “proposta” significa validação futura dependente de autorização. Nenhuma alternativa abaixo está aprovada pelo operador.

## 2. Unidade de isolamento e fronteira de confiança

O PRD define **Trabalho** como unidade lógica persistente, **Execução** como uma ativação de Builder e **Slot** como capacidade de execução ativa. Reparos reutilizam a identidade do Trabalho. Aplicar “um ambiente por job” sem dizer qual dessas unidades é ambíguo. [PRD]

| Nível | O que pode ser dedicado | O que isso não resolve sozinho |
| --- | --- | --- |
| Instalação | Conta Unix, daemon, diretório de dados e imagens da fábrica separados dos pessoais | Dois Trabalhos dessa instalação ainda compartilham daemon/conta; crash do controlador não define quem pode retomar a escrita. [D01] [D06] [PRD] |
| Trabalho | UID ou ambiente, daemon, worktree, branch, estado e limites agregados | Execuções do mesmo Trabalho ainda precisam de exclusão de escrita e reconciliação; serviços antigos podem continuar ativos. [D08] [D18] [PRD] |
| Execução | Processos/cgroup, HOME/tmp, sessão Testcontainers, logs e recursos transitórios | Apagar a Execução não pode apagar a worktree/branch persistentes do Trabalho; recursos do daemon podem estar fora da árvore do Builder. [D18] [T05] [PRD] |
| Slot | Capacidade para admissão | Reciclar o Slot não pode dar a um Trabalho novo socket, volume, cache mutável ou processo ainda pertencente ao anterior. É uma restrição derivada de RF-03/04 e RNF-02, não comportamento fornecido pelo Docker. [PRD] |

### Capacidades a separar

- **Filesystem direto:** mounts, HOME, tmp, `.git`, sockets e permissões do processo. **Filesystem indireto:** qualquer caminho que o daemon consiga montar a pedido desse processo. O mount namespace do cliente não é uma whitelist para o daemon. [D07] [S01]
- **Poder da API:** rootless limita a autoridade ao usuário e seus IDs mapeados; não filtra a API por Trabalho. Conta sem `sudo` e sem grupo `docker` não ajuda se o socket rootful for exposto por outro caminho. [D01] [D04] [D06]
- **Processos/IPC/rede:** namespaces podem separar essas visões; compartilhar rede do host continua expondo serviços locais conforme sua autenticação e permissões. Não montar D-Bus, agente SSH, sockets de outros runtimes ou gerenciador de usuário indiscriminadamente: bubblewrap cita D-Bus como caminho para executar comandos fora da sandbox. [S01] [S02]
- **Recursos:** cgroups limitam consumo; não autorizam operações Docker nem impedem leitura de arquivos permitidos. Limite apenas no processo Gradle não é limite agregado do Trabalho, especialmente com revisores e containers criados pelo daemon. [D02] [D12] [S04] [L02]
- **Durabilidade e ownership:** PID ou nome de container não substitui identidade persistente de Trabalho/Execução. A especificação futura precisa reconciliar processos/recursos antes de abrir um escritor substituto. Isso é obrigação de RF-04 e RNF-01; não é garantia automática de nenhuma alternativa. [PRD]

O modelo de ameaça do PRD não exige conter código deliberadamente hostil, mas exige evitar acesso amplo acidental e não herdar credenciais pessoais. Recursos compartilhados ainda podem ser afetados por um teste errado, um comando de cleanup genérico ou dependência com script de instalação. A análise de alcance abaixo serve também a esses acidentes, sem prometer resistência a escape de kernel. [PRD] [D06] [S01]

## 3. Alternativas, começando pelas menores

Os custos são **avaliação qualitativa**, não benchmark: incluem código próprio, provisionamento, dependências, operação e recuperação. “Condicional” não significa conformidade demonstrada.

| Alternativa | Separação obtida | Lacuna principal / Testcontainers | Complexidade total relativa e estado |
| --- | --- | --- | --- |
| A0 — worktree ou container de Builder com socket rootful do host | Worktree própria; container pode restringir acesso direto | API pode montar o host e controlar recursos alheios. Testcontainers pode funcionar, mas compatibilidade não corrige a autoridade excessiva. [D06] [T03] | Baixo arranque; alto alcance de acidente. Não é base aceitável para alegar RNF-02 sem outra fronteira aprovada. |
| A1 — conta e daemon rootless dedicados à instalação; Builder em sandbox | Afasta daemon root do host e credenciais privadas do operador, se DAC/mounts corretos | Todos os Trabalhos com socket acessam recursos e caminhos permitidos à mesma conta. Exige nomes/portas cooperativos; `prune` pode afetar irmãos. Compatibilidade local Java existe só no perfil registrado. [D01] [D06] [D07] [L01] [L02] | Menor salto operacional; política de concorrência e limpeza própria continua necessária. Baseline de comparação, não isolamento por Trabalho. |
| A2 — daemon rootless por Trabalho, todos sob a mesma conta; Builder em sandbox | Inventário Docker, nomes, volumes, redes e cache de dados separados por daemon | Mesmo UID pode acessar sockets/dados de irmãos se visíveis; mount do daemon não é contido pela sandbox do cliente. Portas publicadas no host ainda colidem. [D04] [D08] [D09] | Médio: muitos serviços/estados, duplicação de cache; apenas isolamento de recursos da API, não fronteira completa de filesystem/identidade. |
| A3 — UID e daemon rootless por Trabalho + sandbox de processo | Acrescenta DAC entre contas e namespaces do Builder; daemon não opera como root do host | Daemon ainda vê caminhos públicos/permissões da conta. Conter o daemon em uma visão de mounts mínima, além do Builder, exige composição e prova específicas. [D01] [D07] [S01] | Médio/alto na instalação (contas, sub-IDs, units, ACLs e delegações); médio na operação. Candidato condicional se o custo e superfície residual forem aceitos. |
| A4 — container/ambiente de sistema por Trabalho com daemon interno | Rootfs própria para dependências e namespace de nomes do daemon; bind sources passam a ser do ambiente externo ao container de teste | Docker-in-Docker rootless oficial sobre rootful requer container externo privilegiado; não confundir root interno sem privilégio com contenção externa. Montagens, `/dev`, cgroups e rede determinam a fronteira efetiva. [D02] [D07] [T03] | Médio/alto: imagem por stack, daemon interno, armazenamento aninhado e diagnóstico de rede. Não há prova local dessa composição. |
| A5 — VM Linux por Trabalho, Docker no guest; microVM como variante | Kernel e filesystem guest; root do daemon pertence ao guest. Bind não alcança host sem compartilhamento explícito. [V01] [D07] | Exportação de worktree/artefatos, guest agent/transporte, disco, portas e cleanup da VM precisam de contrato. Socket da API do gerenciador de VMs é poder do host, não deve ser entregue ao Builder. Esta última restrição é inferência do papel do gerenciador. [V01] [V02] | Alto arranque; ciclo de vida de uma unidade descartável pode simplificar recuperação/limpeza frente a A3/A4. Não há medição que determine qual é mais simples no total. MicroVM não elimina gestão de guest, rede ou host. [V03] [V04] |

### Variações que não devem ser confundidas

**`--user` no container:** executa a aplicação como usuário não root; não muda o usuário do daemon. **`userns-remap`:** remapeia UIDs dos containers para IDs subordinados, mas o daemon permanece root. **Rootless:** daemon e containers executam em user namespace sem root no host, com exceção dos helpers de mapeamento necessários. `userns-remap` ajuda contra privilégios internos, não resolve a concessão da API rootful ao Builder. [D01] [D05] [D06]

**Sandbox de processo:** bubblewrap cria um mount namespace inicialmente vazio e recebe os mounts/isolamentos por argumentos. Pode separar PID, IPC, UTS e rede, usar binds RO e seccomp; não é gerenciador de pacotes, daemon Docker, VM ou política pronta. Instalar dependências de usuário em HOME próprio é diferente de instalar pacotes do SO: reutilizar `/usr` do host RO não permite `apt`/`pacman` alterá-lo; um rootfs gravável próprio/container/guest pode acomodar dependências do SO sem autorizar alteração do host. Esta última comparação é inferência da visibilidade e permissão dos mounts. [S01]

**Container sem `--privileged`:** não se deve inferir que qualquer container rootless suportará Docker aninhado, módulos, dispositivos e a suíte de cada repositório. O padrão oficial consultado exige privilégio externo. Explorar outras combinações de kernel/runtime seria outra prova autorizada, não lacuna a preencher com flags inseguras. [D02]

**VM convencional vs microVM:** QEMU oferece máquina virtual completa e aceleradores, incluindo KVM no Linux e TCG; libvirt tem instância `qemu:///session` sem privilégio e `qemu:///system` privilegiada. Acesso a KVM, rede e discos deve ser provisionado conforme o host; não se presume que o Builder precise da API libvirt. Firecracker depende de KVM e recomenda jailer ou restrições equivalentes, usuário/grupo próprios, paths confiáveis, cgroups, filtros e manutenção de kernels/microcode. Isso permite avaliar uma VM comum antes de construir um orquestrador específico de microVM. [V01] [V02] [V03] [V04]

## 4. Instalação, dependências e poderes residuais

| Componente / condição documentada | Instalação e autorização necessárias | Poder residual / lacuna a validar |
| --- | --- | --- |
| Docker rootless | `newuidmap`/`newgidmap`, pelo menos 65.536 sub-UIDs e sub-GIDs; kernel com user namespaces utilizáveis. Helpers de mapeamento são a exceção SETUID/capabilities documentada. Daemon pode ser instalado sem root **se** pré-requisitos já existem. [D01] | Criar conta, atribuir sub-IDs sem sobreposição e instalar helpers/pacotes podem exigir administrador. Rootless não significa instalação do host sem preparo administrativo. [D01] [D05] |
| Kernel/storage/LSM | Docs listam `overlay2` em kernel ≥5.11; `fuse-overlayfs` em ≥4.18 com pacote; também `btrfs` nas condições descritas e `vfs`. Data-root em NFS não é suportado. Ubuntu ≥24.04 restringe user namespaces via AppArmor, com diferença entre pacote e script de instalação. [D03] | Lista é de storage drivers, não certificação de todo snapshotter/filesystem/LSM. Docs rootless listam AppArmor, checkpoint, overlay network e SCTP exposto entre limitações. Não desativar LSM/sysctl global automaticamente para fazer um ensaio passar. [D03] |
| Serviço persistente | Docker recomenda user unit systemd e linger para inicialização sem login; serviço system-wide mesmo com `User=` não é suportado pelo guia rootless. Runtime padrão `/run/user/$UID/docker.sock`; dados em `~/.local/share/docker`; config do daemon em `~/.config/docker`. [D02] | Linger e serviço sobrevivente têm ciclo de vida diferente do controlador. Não encerrar o daemon como consequência implícita de uma espera por resposta. Conta/daemon por Trabalho aumentam provisionamento e inventário. [D02] [PRD] |
| Daemons múltiplos | Separar socket, PID, exec-root, data-root, config e opções de rede/iptables; considerar containerd, namespaces e armazenamento conforme modo usado. Docker chama a configuração multi-daemon de experimental. [D08] [D09] | Não copiar literalmente o exemplo rootful para rootless. Docker ≥29 usa containerd image store por padrão em instalações novas; mudar só `data-root` não move o armazenamento do containerd externo. Descobrir o modo real antes de declarar isolamento dos dados. [D08] [D09] |
| Limites agregados | Flags cgroup do Docker rootless só são suportadas com cgroup v2 + systemd; normalmente `memory`/`pids` delegados, outros controllers podem requerer configuração administrativa; `cpuset` delegado exige systemd ≥244. [D02] | Sem condições, flags cgroup podem ser ignoradas. `ulimit`, heap e workers não equivalem ao orçamento agregado do Trabalho. Cgroup do Builder não inclui automaticamente containers geridos por serviço separado. [D02] [D12] [S04] |
| Bubblewrap / sandbox | Binário do sistema e user namespaces conforme distribuição; política explícita de mounts, PID/IPC/rede, sessão e filtros. [S01] [S02] | Kernel compartilhado; same UID e sockets acessíveis podem ampliar autoridade. `--die-with-parent` oferece acoplamento ao pai, mas não é protocolo de ownership nem gestão do daemon externo. [S01] [S02] |
| Sandbox via systemd | `ProtectSystem`, `ProtectHome`, `PrivateTmp`, `ReadWritePaths`, `NoNewPrivileges` e gestão de cgroup são controles disponíveis, com restrições de contexto/capacidades descritas nos manuais. [S03] [S04] | Não assumir que toda diretiva funciona em user unit sem privilégio: vários controles de mount dependem de user namespaces/contexto. Não transformar proposta em unit “suportada” sem teste; rootless system-wide com `User=` já tem restrição própria. [S03] [D02] |
| VM / microVM | Imagem/kernel guest, hypervisor, acesso a virtualização e rede, usuário do VMM, armazenamento e atualizações. Firecracker jailer faz operações privilegiadas e depois reduz privilégios. [V01] [V02] [V03] [V04] | Guest root não é host root, mas passthrough/mounts/gerenciador do host reabrem a fronteira. Memória, discos e logs do VMM também precisam de limites e coleta. [V01] [V03] |

**Sem poderes implícitos de instalação:** qualquer requisito futuro de sudo, criação de conta, delegação de controller, capability para porta baixa ou alteração de AppArmor deve aparecer no instalador e no consentimento operacional. A pesquisa não aprova executar essas alterações. Portas ≥1024 evitam parte do preparo: para portas baixas, o guia propõe capability em RootlessKit ou sysctl; ambos alteram a superfície do host e não devem ser fallback silencioso. [D02] [PRD]

## 5. Compatibilidade e armadilhas concretas

### 5.1 Testcontainers e Ryuk

Testcontainers Java exige runtime compatível com Docker API; a documentação diz testar ativamente Docker recente em Linux e Docker Desktop. Isso não é certificação de qualquer sandbox, nem de todas as alternativas de runtime. A orientação para **Podman rootless desabilitar Ryuk** é específica de Podman, não regra para Docker rootless; trocar Docker por API compatível seria outra decisão e exigiria avaliar a perda de cleanup. [T01]

Para o baseline **Testcontainers 2.0.5**, distinguir três parâmetros: [T02] [T04]

| Parâmetro | Consumidor / significado | Risco na composição |
| --- | --- | --- |
| `DOCKER_HOST` | Cliente Java/CLI alcança o endpoint do daemon, por exemplo um socket Unix dedicado | Caminho visível ao cliente não precisa ser o mesmo source visível ao daemon. Não aceitar fallback para socket pessoal se falhar. |
| `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` | Caminho de socket usado por containers auxiliares como Ryuk/Compose; Ryuk o monta internamente em `/var/run/docker.sock` | Source tem de existir e estar acessível do lado do daemon. Expor socket de outro Trabalho compromete a separação. |
| `TESTCONTAINERS_HOST_OVERRIDE` | Host onde a JVM alcança as portas publicadas | `127.0.0.1` só é correto se a topologia realmente compartilhar esse loopback. Em VM ou container aninhado pode ser outro endereço/forward. |

No código fixado de 2.0.5, `RyukContainer` usa imagem `testcontainers/ryuk:0.14.0`, porta interna 8080, nome com session ID, auto-remove, bind do socket e `withPrivileged(isRyukPrivileged())`. **`isRyukPrivileged()` usa default `true`**, confirmado por leitura do código pelo SHA e pela API de conteúdo GitHub. A documentação também diz que Ryuk necessita de container privilegiado. Não é correto reportar “Ryuk não precisa de privilégio” genericamente. Em daemon rootless, esse privilégio/capabilities continua subordinado ao user namespace; não é equivalente a `--privileged` concedido por daemon rootful no host. Não é por isso uma API de baixo poder: continua controlando todo seu daemon. [T04] [T09] [T02] [D03]

Ryuk recebe filtros/labels e remove recursos; seu README 0.14.0 documenta janela de reconexão de 10 s depois de fechar a última conexão, timeout inicial de 60 s, retries e timeout de shutdown. Testcontainers registra marcação de sessão e inicia Ryuk salvo `TESTCONTAINERS_RYUK_DISABLED=true`; desabilitá-lo deixa cleanup normal da JVM, que não roda em `kill -9`. São mecanismos de melhor esforço com dependências (daemon ativo, socket correto, conexão/filtros estabelecidos), não substitutos de reconciliação persistente após crash. Um crash do controlador não é necessariamente crash da JVM nem fechamento da conexão Ryuk. [T05] [T06] [T07] [T02]

**Não propor desativar checks/Ryuk para declarar compatibilidade.** O check inicial inclui mount de arquivo e porta alcançável. Uma prova deve manter esses checks e registrar configuração e digests; se a política não comportar Ryuk, apresentar a incompatibilidade e uma estratégia de cleanup explicitamente aprovada, sem maquiar a evidência. [T02] [PRD]

### 5.2 Bind mounts, volumes e ownership

O source do bind é resolvido no host do daemon. Se o Builder vê `/workspace` e o daemon vê somente `/srv/trabalhos/T`, o source `/workspace` não se torna válido por existir no Builder. O padrão Testcontainers de testes dentro de container recomenda mesmos caminhos para os sources do bind. Em VM, o arquivo deve estar no guest/ser transferido ou compartilhado intencionalmente; não existe bind remoto de um arquivo só do cliente por mágica. [D07] [T03]

A consequência crítica para A1–A3: ocultar `/home/operador` no bubblewrap do Builder não impede que ele peça ao daemon um bind desse caminho. Quem decide o sucesso é a visão/permissão do daemon. Conta dedicada + diretórios privados pode negar a operação, como registrou a prova local; arquivo público segue acessível. Uma proteção completa precisa tratar **acesso direto e acesso por API**, inclusive leitura, escrita e sockets. [D07] [D04] [L01]

Na modalidade rootless, UID 0 no container mapeia ao UID do usuário que executa o daemon; UID `n ≥ 1` mapeia a `subuid + (n − 1)`; GIDs seguem regra análoga. Em `userns-remap`, UID 0 mapeia ao primeiro sub-UID. Dados de um PostgreSQL não root podem ficar pertencendo a sub-IDs no host. O UID visto dentro de uma sandbox externa pode estar unmapped e aparecer como overflow UID: não deduzir ownership host a partir de um `stat` interno isolado. [D04] [D05] [L01]

**Proposta de contrato, não escolha:** provisionar diretórios exatos RW, inspecionar mapeamentos reais e documentar como publicar artefatos legíveis sem `chmod 777`, `chown -R` amplo ou root no host. Não reutilizar data-root entre daemons nem cache mutável entre contas como se fosse imutável. Com Docker 29/containerd, inventariar também o armazenamento correspondente, não somente volumes. [D04] [D08] [PRD]

Volumes/nets Compose têm escopo pelo projeto em uso normal; campos `name:` usam nomes literais não escopados e `external: true` aponta recursos já existentes fora do lifecycle normal do projeto. Portanto, `COMPOSE_PROJECT_NAME` distinto ajuda, mas não corrige fixtures com nomes explícitos, volumes externos ou `container_name` fixo. Daemon independente é uma fronteira de inventário mais forte que convenção de prefixos; ainda não protege paths bind compartilhados. [D14] [D15] [D16] [D19] [D08]

### 5.3 Rede, portas e concorrência

Testcontainers mapeia portas expostas para portas host aleatórias para evitar choques; obter `getHost()` + `getMappedPort()` depois do start é o padrão documentado, não fixar `localhost:5432`. Containers na mesma rede Docker podem usar aliases e portas internas; Testcontainers documenta múltiplas redes Docker, mas atualmente um container dessa API só pode participar de uma rede por vez. Suites com topologias especiais precisam de ensaio próprio. [T08]

**Porta interna fixa não é problema por si só** (cada namespace pode usar 5432). Porta **publicada fixa no host** colide entre daemons/Trabalhos que usam a mesma rede host, mesmo com UIDs e data-roots diferentes. Nomes de rede/volumes iguais podem coexistir em daemons separados, mas dois serviços publicando `127.0.0.1:5432` no mesmo host não ganham um loopback exclusivo só por isso. Isso é inferência do significado de host port e da separação por daemon. [D08] [D10] [T08]

Publicação sem IP explícito normalmente expõe portas para fora do host; o guia recomenda endereço loopback para restringir o acesso local e alerta sobre versões <28.0.0, em que vizinhos L2 podiam alcançar publicação em localhost. O endereço de escuta realmente aplicado em rootless/VM/container deve ser observado na prova. Política de egress e isolamento de serviços locais não são consequências de escolher portas aleatórias. [D10] [D03]

**Sensível à versão:** a documentação Docker consultada registra que, **antes de 29.5**, `--net=host` no rootless permanecia no namespace de RootlessKit; **desde 29.5** pode compartilhar a rede real do host. Não reutilizar a antiga afirmação de que host networking rootless é sempre isolado. O IP de `docker inspect` na rede RootlessKit normalmente não é diretamente alcançável do host; publicação/override são necessários. [D03]

RootlessKit oferece rede separada e opções como `--disable-host-loopback`, mas sua presença não deve ser assumida como política de egress universal nem como prova de que todos os caminhos até serviços do host estejam fechados. O perfil local compartilhou a rede do host no Builder e usou `TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1`: **não era offline nem tinha allowlist de saída**. Containers de teste e JVM devem conseguir se comunicar na topologia aprovada; downloads de dependências/imagens também precisam de caminho de rede ou insumos preparados. [S05] [L01] [L02] [PRD]

### 5.4 Credenciais, dependências e acesso de revisores

Docker CLI guarda configuração em `~/.docker` ou `DOCKER_CONFIG` e pode conter dados de autenticação; Testcontainers consulta `DOCKER_AUTH_CONFIG` e Docker config. HOME novo com config Docker vazio e ambiente explícito evita herança involuntária desses canais, mas não resolve mounts extra, SSH agent, D-Bus, certificados, proxy autenticado ou segredo explicitamente injetado. Não montar o home pessoal, mesmo RO: leitura já é exposição de credenciais. [D17] [T01] [S01] [PRD]

Se algum gate precisar de registro privado, definir no desenho futuro qual segredo é estritamente necessário, quem o recebe, por quanto tempo e como logs/artefatos o excluem. Não há isolamento que impeça um processo de usar/exfiltrar um segredo que ele legitimamente recebeu enquanto tem rede. Esta é uma inferência da concessão de capacidade, não razão para transferir todos os tokens ao Builder. A fronteira controlador–Builder permanece aberta na cartografia: este relatório **não decide** quem faz Git/GitHub ou concentra operações privilegiadas. [PRD] [MAP]

Revisores sem escrita na worktree não precisam automaticamente da API Docker. Uma worktree RO com socket do daemon ainda permitiria operações indiretas. O registro rootless relata revisor offline/RO sem acesso ao socket; é um resultado desse perfil específico, não garantia do runtime inteiro nem de ferramentas de filesystem do harness. [D06] [L01]

Git worktree aponta `.git` a metadados administrativos no repositório principal e compartilha estado que não é por worktree. Montar somente a pasta pode quebrar comandos Git; montar todo o `.git` principal RW pode ampliar acesso a refs/configs/hooks e outros Trabalhos. O smoke Java não montou `.git` externo e não provou Git em sandbox. O contrato Git/ownership/caminhos precisa de prova própria antes de declarar RF-04 atendido. [G01] [L02] [PRD]

## 6. Encerramento, crash e cleanup conservador

### Fatos fornecidos pelos componentes

- `KillMode=control-group` termina processos restantes do cgroup da unit; `mixed` manda primeiro sinal ao principal e o SIGKILL posterior aos restantes. `process` e `none` são desaconselhados pelo systemd. Isso controla o cgroup da unit, não todo recurso Docker apenas porque foi criado por um cliente dessa unit. [S06] [D02]
- Bubblewrap pode usar PID namespace com PID 1 para reaping e `--die-with-parent` para receber encerramento com a morte do pai; ambos são peças locais de lifecycle, não uma política persistente de retomada. [S01] [S02]
- O guia Docker diz que, por padrão, ao parar o daemon ele também encerra containers; `live-restore` pode mantê-los vivos quando o daemon fica indisponível. Não assumir esse estado apenas porque o controlador morreu: controlador e daemon são processos/serviços distintos. [D18]
- Ryuk observa conexões/filtros do cliente e remove os recursos correspondentes; não sabe por si a semântica de Ticket/Trabalho, o escritor da worktree ou se um controlador reiniciado já pode substituir outro. Named volumes persistentes, binds e recursos externos ao Testcontainers precisam de ownership separado. [T05] [T06] [T07] [D15] [PRD]

### Obrigações para a spec futura (derivadas do PRD, não implementação)

1. Persistir a relação Trabalho → ambiente/UID/daemon e Execução → processos/cgroup/recursos, com identificadores que permitam distinguir processo novo de PID reutilizado. Reconciliação deve poder provar ausência ou assumir/bloquear a instância existente antes de liberar um novo escritor. Unidade systemd, PID/start time, cgroup e IDs Docker são candidatos de evidência, não protocolo aprovado. [PRD]
2. Separar **morte do controlador**, **morte do Builder/JVM**, **indisponibilidade do daemon** e **reboot do host**. Cada um deixa sobreviventes e janelas de cleanup diferentes; esperar por resposta/CI deve liberar Slot sem apagar o Trabalho. [D02] [D18] [T07] [PRD]
3. Inventariar IDs e owner no momento da criação. Para daemon compartilhado, labels/prefixos devem ser auxiliares de correlação, não justificativa para apagar qualquer recurso desconhecido. Verificar existência, endpoint e pertença antes de remover; ambiguidade é Bloqueio/report, não `prune` global. Para daemon próprio, o inventário exclusivo facilita comprovar alcance, mas ainda é preciso proteger binds, discos e paths persistentes. [D06] [D08] [T05] [PRD]
4. Distinguir limpeza transitória por Execução, retenção para reparo por Trabalho e desinstalação da instalação. Parar unit não apaga imagens/volumes/dados. O guia de desinstalação rootless ressalta que remover o serviço não remove binários nem dados. Conta/daemon do piloto anterior são persistentes por autorização anterior, não recursos desta pesquisa. [D03] [L01] [PRD]
5. Preservar worktree/branch após encerramento manual sem merge e após Bloqueio/falha quando forem necessárias ao reparo; após merge confirmado, apagar apenas artefatos próprios verificáveis. Imagens/cache compartilhados não devem ser coletados com base só na última Execução. [PRD]

**Conclusão:** daemon dedicado reduz a complexidade de identificar o universo a coletar; não elimina transações interrompidas, confirmação de ownership, retenção de artefatos ou controle de escritor. Em VM, desligar a VM encerra o guest, mas apagar disco/definição/rede antes de exportar resultados perderia o Trabalho. Nenhuma dessas alternativas prova RNF-01 apenas por ter auto-remove. RF-12 trata de CLI e cancelamento: interromper Builder/processos associados, impedir novos disparos/publicações e preservar artefatos exige controles próprios; efeitos externos já enviados devem ter o resultado efetivo reconciliado. [D08] [V01] [PRD]

## 7. Evidência local reutilizável e matriz por requisito

### 7.1 Registro histórico, não inspeção atual do host

| Registro | Fato registrado e limites explícitos |
| --- | --- |
| [Runner rootless validado][L01], recibo [rootless-proof.json][L03] | Recibo `observedAt=2026-11-01T05:33:31.358Z`: Docker 29.7.2 rootless, UID host do socket 1002, dataRoot `/var/lib/mastra-runner/.local/share/docker`, core 1.81.0/bwrap. Controle positivo bind de fixture pública e negativas para canary privada do controlador. PostgreSQL 18 respondeu 42; cleanup do controlador deixou zero containers/volumes observados daquela execução. **Não** demonstra proteção de todo filesystem, isolamento entre Trabalhos, quotas ou crash. A pesquisa não verificou se o serviço ainda existe ou preserva a configuração. |
| Provisionamento descrito em [L01] | Conta Unix separada sem sudo/docker/wheel, home 0700, socket com ACL limitada, user unit root-owned e linger. RootlessKit 3.1.0-1, slirp4netns 1.3.4-1, fuse-overlayfs 1.17-2 e libslirp 4.9.3-1 foram registrados. É histórico de host específico, não instalador genérico nem autorização transferida. |
| [Smoke Java][L02], versões [java-versions.json][L04] | `observedAt=2026-11-01T20:07:25.639Z`, JDK 25.0.2+10-69, Gradle 9.5.1, Testcontainers 2.0.5, Ryuk 0.14.0, postgres:18; método JDBC existente do projeto Java passou (1 teste, zero erros/falhas/skips). HOME/config Docker separados e rede host explícita; flags HOST_OVERRIDE/SOCKET_OVERRIDE específicas da topologia. **Não** é execução de todas as suítes ou gates do projeto. |
| Limpeza do smoke, [L02] e [eventos][L05] | Relatório registra create/start/die/destroy de PostgreSQL/Ryuk correlacionados à sessão; volume anônimo ausente no final; zero deleções pelo controlador. Parada normal ocorreu: isso **não prova que Ryuk foi o agente da remoção**, nem sobrevivência/cleanup em SIGKILL. Não foi feita injeção de falha. |
| Limites do harness, [L01] [L02] | Provas não homologam ferramentas de filesystem, todas as skills/revisores, sessão completa da fábrica, Git dentro do sandbox, cache concorrente, autorização GitHub ou agente real. Heap/workers de Gradle não foram quotas cgroup. |

A prova inicial rootless dizia não ter executado Java; o smoke Java foi uma etapa posterior, não contradição nem autorização para ampliar os resultados da primeira prova. Os recibos documentam versões/digests locais, não a versão “mais recente” upstream nem estado atual da máquina. [L01] [L02] [L03] [L04]

### 7.2 Matriz de atendimento documental

“Parcial” significa conhecimento para especificar e/ou prova histórica restrita; não aceite de implementação. Os IDs P1–P10 apontam propostas na seção 8.

| Requisito | O que a pesquisa estabelece | Evidência / lacuna | Prova futura |
| --- | --- | --- | --- |
| RF-03 — filas e concorrência | Worktree por Trabalho não evita colisões Docker; daemon por Trabalho separa inventário. Portas host e orçamento agregado exigem desenho; quotas de recursos não substituem o limite de Builders ativos. | Parcial: [D08] [D10] [D12] [T08] [PRD]. Sem Trabalhos reais concorrentes demonstrados. | P2, P5, P6 |
| RF-04 — worktree/branch e escritor único | Sandbox precisa considerar metadados Git externos e processos sobreviventes; daemon/UID não são lock de escrita. | Parcial: [G01] [S06] [PRD]. Smoke sem Git externo; sem fencing demonstrado. | P4, P7 |
| RF-07 — instalar dependências e testes Docker | Docker rootless + Testcontainers/Ryuk funcionou para um teste Java no perfil local; dependências SO exigem rootfs/guest ou preparo compatível. | Parcial: [D01] [T02] [L02] [L04]. Instalação genérica por stack e gates completos não provados. | P1, P3, P9 |
| RF-12 — CLI e cancelamento | Interromper Builder/processos associados requer alcançar o cgroup e os recursos do daemon; cancelamento deve impedir novos disparos/publicações, preservar artefatos e reconciliar efeitos externos já enviados. | Parcial documental: [S06] [D02] [D18] [PRD]. Não há CLI/cancelamento da fábrica demonstrados; matar processo não prova o requisito completo. | P8, P10 (parcela local) |
| RF-14 — cleanup apenas próprio, retenção | Bind/external volumes/cache não podem ser tratados como transitórios indiscriminadamente; daemon próprio ajuda a delimitar universo. | Parcial: [D07] [D15] [L01] [L02]. Só limpeza normal local, não lifecycle completo. | P2, P8, P10 |
| RNF-01 — durabilidade e reconciliação | Serviços podem sobreviver ao controlador; estado persistido precisa ser reconciliado com processos, artefatos e efeitos externos antes de publicar ou lançar substitutos. Ryuk/JVM hooks não garantem essa recuperação. | Parcial documental: [D02] [D18] [T07] [S06] [PRD]. Sem crash injetado, protocolo persistente ou reconciliação GitHub demonstrados. | P7, P8 (parcela local) |
| RNF-02 — limitar host, credenciais e arquivos alheios | Socket é autoridade indireta; rootless reduz privilégio, sandbox/UID/daemon são camadas distintas. Sem prometer contenção hostil. | Parcial: [D06] [D07] [S01] [D17] [L01]. Falta política explícita de paths/rede/poderes e prova entre Trabalhos. | P3, P4, P5 |
| CA-03 — concorrência três, três Builders, dois no mesmo repo | Três Builders simultâneos, sem compartilhar worktree/branch nem duplicar escritores; nomes fixos e não interferência também precisam de observação. | Não demonstrado: [L01] [L02]. Um teste ou somente dois Builders não atende ao cenário do [PRD]. | P2, P4, P6 |
| CA-05 — pergunta libera Slot; resposta autorizada e correlacionada retoma | Preservar Trabalho sem escritor ativo indevido durante espera; resposta não autorizada não desbloqueia. | Não demonstrado; obrigação [PRD], peças de lifecycle [S02] [S06]. Runtime de pergunta/resposta/autorização fora desta pesquisa. | P7 (parcela de isolamento) |
| CA-06 — crash durante execução e após push, criação de PR ou publicação de pergunta | Identificação persistente, exclusão de escritor e reconciliação devem recuperar o resultado sem duplicar efeitos ou escritores. | Não demonstrado: [L01] [L02] [PRD]. P7/P8 cobrem propostas locais; os efeitos GitHub exigem prova integrada adicional, fora desta pesquisa. | P7, P8 (parcela local) |
| CA-07 — cancelamento, esgotamento de limites e falha de cleanup | Resultados devem permanecer explícitos e operáveis, preservando Trabalho não entregue. Limites de correção/retomada e timeout são regras de RF-13, não quotas cgroup de P6. | Não demonstrado: [PRD]. Limpeza normal em [L01] [L02] não prova cancelamento, esgotamento de tentativas ou falha de cleanup; estes exigem também validação do workflow/CLI. | P8, P10 (parcela local) |
| CA-08 — testes de integração simultâneos, sem colisão entre Trabalhos | Método Java com PostgreSQL/Testcontainers indica viabilidade do perfil anterior, mas falta integração simultânea nos repositórios-piloto. | Parcial apenas quanto ao teste isolado: [L02] [L04] [L05]. Concorrência não demonstrada; não é aceite da fábrica futura. | P1, P2, P3, P5, P9 |

**Premissa de plataforma, separada dos requisitos acima:** o mapa aceita Linux em uma única máquina. Pré-requisitos, storage, kernel, LSM, user units, linger e cgroups foram documentados, mas não há instalador reproduzível homologado; P1/P9/P10 são propostas relacionadas a essa premissa. Isso não é RNF-01 nem um critério de aceite adicional do PRD. [MAP] [D01] [D02] [D03] [V02] [V03]

Esta matriz não aprova arquitetura de fila, runtime de agentes, armazenamento durável ou operações GitHub. As decisões e provas de ponta a ponta pertencem à continuação da cartografia. [MAP]

## 8. Provas mínimas propostas — nenhuma executada nesta pesquisa

Estas propostas exigem autorização própria, ambiente descartável e recursos canários sintéticos, **nunca segredos pessoais ou fixtures da produção**. Registrar versões/kernel/LSM, flags, controllers efetivos, UID maps, endpoint e identidade do daemon, digests, IDs/labels de recursos, logs, comandos/resultados e resíduos. Reutilizar scripts antigos só depois de revisar escopo e obter autorização; não há autorização implícita para reexecutá-los.

| ID | Experimento proposto | Critério observável / risco que elimina |
| --- | --- | --- |
| P1 — pré-voo e gate real | Provisionar somente a alternativa autorizada; verificar daemon rootless/guest e endpoint sem fallback; instalar dependências em HOME/rootfs próprio; executar um gate real com Testcontainers/Ryuk e startup checks ativos. | Teste realmente executado, versões/digests e recibos; portas/mounts válidos; nenhum pacote/config do host alterado pelo Builder. Falhas devem bloquear, não desativar checks. |
| P2 — três Trabalhos, colisões e não interferência | Concorrência configurada em três, com três Builders e worktrees/branches próprias, dois no mesmo repo; os três tentam mesmos nomes de container, volume, rede, alias e porta interna. Incluir projeto Compose com `name:`/external e tentativa controlada de host port fixa. | Três Builders efetivamente simultâneos, sem compartilhamento de worktree/branch nem escritores duplicados (CA-03); testes criam containers simultaneamente sem colisões (parcela de CA-08). Em daemon separado, nomes Docker podem coexistir; host port compartilhada deve falhar visivelmente ou ser isolada por rede/guest. Cleanup de A deixa B/C íntegros e não toca recurso canário externo. |
| P3 — matriz direta/indireta de paths e credenciais | Fixtures públicas, privadas por Trabalho, canário privado do controlador e sockets sintéticos. Tentar ler/escrever diretamente e por bind Docker; conferir ambiente/HOME/Docker config; revisor sem socket. | Apenas paths/poderes permitidos funcionam; teste positivo prova que a negação não veio de um Docker inteiro quebrado. Capturar diferença entre fonte do cliente e fonte do daemon e documentar exposição residual permitida. |
| P4 — Git e ownership | Executar Git na worktree isolada com metadados necessários; teste separado para revisão RO; produzir arquivos root e não root via Docker e reabrir numa Execução de reparo. | Commit/status funcionam no escopo do Trabalho; revisão não escreve; nenhuma ref/worktree alheia é alterada; artefatos legíveis conforme política sem permissões globais. |
| P5 — rede local/saída e mounts de socket | Observar listeners reais IPv4/IPv6, acesso a loopback/serviços canários do host e entre Trabalhos, rede dos testes e downloads. Variar explicitamente `--net=host` só se autorizado. | JVM alcança apenas endpoints esperados; não existe API Docker aberta sem autenticação nem acesso involuntário a outro daemon. Resultado sensível à versão ≥29.5 é registrado, não inferido de docs antigas. |
| P6 — orçamento agregado | Rodar workloads sintéticos limitados de CPU/RAM/PIDs/IO/disco, Builder + revisores + containers, três Trabalhos em paralelo como em P2; limitar duração/volume para não exaurir o host. | Controllers/limites efetivos observados; excesso de A não encerra B/C/controlador; limites não ficam restritos ao Gradle ou ignorados pelo daemon. Retenção de logs/imagens/disco também tem política. |
| P7 — crash do controlador e exclusão de escritor | Matar apenas controlador enquanto Builder, processos netos e daemon seguem vivos; reiniciar e tentar retomar. Também simular espera/resposta e reaproveitamento de Slot. | Um único escritor por worktree; reconciliação reconhece sobrevivente ou bloqueia; não inicia substituto só por controlador novo. Estado e resposta continuam associados ao Trabalho correto. |
| P8 — JVM/daemon/host e cleanup | Separadamente: SIGTERM normal, SIGKILL da JVM, morte do daemon e reboot autorizado do ambiente descartável. Observar Ryuk/filtros, volumes/nets e retomada conservadora. | Distinguir quem removeu cada recurso, janelas e resíduos; nenhuma expectativa de hook em SIGKILL; resources ausentes/ambíguos geram resultado explícito; reinício não abandona recurso controlável nem apaga o alheio. |
| P9 — instalação reproduzível por stack | Em Linux limpo compatível, reproduzir apenas o preparo aprovado e testar stack piloto; registrar ações administrativas e operação sem sudo posterior. | Lista fechada de pré-requisitos/versões, ausência de ajustes manuais ocultos, falha clara em kernel/LSM/storage não suportado. Não extrapolar de um Arch preparado para toda distribuição. |
| P10 — cancelamento, retenção e cleanup operável | Após merge simulado/confirmado no ensaio autorizado, e separadamente cancelamento/PR fechado sem merge, coletar só recursos atribuídos; injetar falha controlada de cleanup e testar nova tentativa explícita. Testar remoção do ambiente da instalação sem dados alheios. | Cancelamento interrompe processos associados sem apagar artefatos; transientes elegíveis somem; evidências necessárias ao reparo são preservadas. Falha de cleanup fica visível e pode ser tentada novamente sem desfazer entrega; limpeza não usa prune global, não remove conta/daemon preexistentes e reporta ownership incerto. Esgotamento de limites e bloqueio de novas publicações exigem também prova integrada do workflow/CLI (CA-07/RF-12–14). |

Para comparar simplicidade, medir por alternativa: ações administrativas, pacotes/serviços, código específico de lifecycle, tempo de preparo frio/quente, disco por Trabalho, esforço para recuperar P7/P8 e riscos residuais. Não há números observados aqui. Uma alternativa com mais serviços pode custar menos código de reconciliação; isso só pode ser confirmado no desenho/prova, não pelo número de processos.

### Lacunas/decisões a levar ao responsável do mapa

- Qual superfície explícita de filesystem, rede e sockets será permitida ao Builder **e ao daemon**? Conta dedicada protegendo apenas arquivos privados é suficiente para o operador ou é necessário rootfs mínimo para ambos?
- Compartilhamento cooperativo do daemon é aceitável para algum perfil ou o Trabalho precisa de inventário/UID próprios? Não chamar prefixos de isolamento forte.
- Ambiente persiste por Trabalho, é recriado por Execução ou vive em pool de Slots? Qual contrato evita herdar dados e respeita reparos?
- Quem provisiona/gerencia contas, sub-IDs, serviços e limites; quem recebe a API de Docker/VM; qual fronteira controlador–Builder? Esta pesquisa não resolve essa autoridade.
- Quais repositórios/stacks exigem portas fixas, dependências do SO, imagens privadas, Docker Compose ou recursos especiais de kernel incompatíveis com rootless?
- Qual conjunto de falhas e retenção deve a primeira prova cobrir, e qual orçamento de instalação/recursos é aceitável? Não há autorização para realizar P1–P10 nesta sessão.

## 9. Fontes, revisões e rastreabilidade

Todas as fontes externas abaixo foram consultadas em **2026-11-03 UTC** via HTTPS público. Links Docker `.md` são a representação Markdown oferecida pelo próprio site. Documentação viva não é um release pin; limites sensíveis à versão estão explicitados no texto. HTTP 200 verifica acessibilidade e conteúdo documental, não correção de runtime. Fontes locais são leitura histórica de arquivos versionados, não sondagem do host.

### Docker e Compose (fontes primárias vivas)

| ID | Fonte | Alcance usado |
| --- | --- | --- |
| D01 | [Rootless mode][D01] | Daemon+containers sem root host, helpers e sub-IDs, instalação condicionada a pré-requisitos. |
| D02 | [Rootless tips][D02] | User units/linger, diretórios, dind-rootless privilegiado externo, portas baixas e cgroups. |
| D03 | [Rootless troubleshooting][D03] | Kernel/storage/LSM, limites atuais/históricos de rede, desinstalação. |
| D04 | [Rootless UID/GID mapping][D04] | Diferença exata entre rootless e remap para ownership. |
| D05 | [User namespace remapping][D05] | Daemon continua root, IDs subordinados, permissões e limitações. |
| D06 | [Docker security — daemon attack surface][D06] | Poder de API/socket e bind do host. |
| D07 | [Bind mounts][D07] | Source no daemon, escrita default, RO/recursive/propagation. |
| D08 | [dockerd — run multiple daemons][D08] | Aviso experimental, opções de separação e colisões de iptables. |
| D09 | [Daemon configuration][D09] | Diretórios por daemon e mudança do armazenamento com containerd image store em instalações novas ≥29. |
| D10 | [Port publishing][D10] | Exposição, loopback e ressalva antes de 28.0.0. |
| D12 | [Resource constraints][D12] | Ausência de limites por default e mecanismos CPU/memória. |
| D14 | [Compose CLI — project name][D14] | Nome de projeto e precedência para instâncias cooperativas. |
| D15 | [Compose volumes][D15] | `name` não escopado e volumes externos. |
| D16 | [Compose networks][D16] | Redes externas e nomes não escopados. |
| D17 | [Docker CLI configuration][D17] | `DOCKER_CONFIG`, config e autenticação sensível. |
| D18 | [Live restore][D18] | Diferença entre morte do daemon e manutenção de containers. |
| D19 | [Compose services — container_name][D19] | Nome explícito e restrição de escala do serviço. |

### Testcontainers/Ryuk (primárias fixadas)

Baseline consultado **Testcontainers Java 2.0.5**, tag resolvida pela API GitHub para commit **`5c448202ac69d073f746433d3e79f6a2bf0ec585`**. Não é afirmação de latest. O código dessa revisão fixa Ryuk 0.14.0; para o README do Ryuk foi consultada a tag 0.14.0, resolvida para **`b3726afd6cc2c36628abcc08e9cabac43f587384`**. URLs abaixo são por commit.

| ID | Fonte | Alcance usado |
| --- | --- | --- |
| T01 | [Runtime requirements][T01] | Docker suportado, alternativas, descoberta e autenticação. |
| T02 | [Configuration][T02] | Overrides, checks, Ryuk e shutdown JVM. Exemplos antigos de tags nessa página não são usados como versão efetiva. |
| T03 | [Docker-in-Docker / sibling patterns][T03] | Montagem de socket, paths iguais, observação sobre DinD. |
| T04 | [RyukContainer.java][T04] | Imagem 0.14.0, bind, auto-remove, nome e flag privilegiada. |
| T05 | [ResourceReaper.java][T05] | Marcação/filtros de sessão e escolha do reaper. |
| T06 | [RyukResourceReaper.java][T06] | Inicialização, conexão e registro de filtros. |
| T07 | [Moby Ryuk README 0.14.0][T07] | Recursos removíveis, reconexão, timeouts e retries. |
| T08 | [Networking][T08] | Portas aleatórias, host/mapped port e redes. |
| T09 | [TestcontainersConfiguration.java][T09] | `isRyukPrivileged` default `true`, confirmado também via API de conteúdo. |

### Sandboxes, gerenciadores e VM

| ID | Fonte / revisão | Alcance usado |
| --- | --- | --- |
| S01 | [Bubblewrap README][S01], commit `1fb0aa26d3eb66254f7742e704add7f82f41a582` | Ferramenta de política explícita, namespaces, mounts e riscos de sockets. |
| S02 | [Bubblewrap manual XML][S02], mesma revisão | Flags de namespaces, sessão e morte com pai. |
| S03 | [systemd.exec][S03], documentação `latest` viva | Controles de filesystem/credenciais e limites por contexto. Não se assume a versão instalada. |
| S04 | [systemd.resource-control][S04], `latest` viva | Controllers, hierarquia e delegação; não é evidência de controllers ativos no host. |
| S05 | [RootlessKit README][S05], commit `b908dce9b18fd6a31fd7903ce480dd8b28cf0ef6` | User/mount/net namespaces e opções de rede; não certifica todas as rotas. |
| S06 | [systemd.kill][S06], `latest` viva | `KillMode`, SIGTERM/SIGKILL e cgroup. |
| V01 | [QEMU system introduction][V01], manual `master` vivo | Modelo de máquina, guest OS, aceleradores e backends. |
| V02 | [Libvirt QEMU driver][V02], documentação viva | Instâncias session/system e diferença de privilégio. |
| V03 | [Firecracker production host setup][V03], commit `498273b2a0519e9d84671f540291202eb8dca971` | KVM, manutenção, jailer, recursos e privilégios residuais. |
| V04 | [Firecracker jailer][V04], mesma revisão | Preparo privilegiado, chroot, UID/GID e cgroups. |
| G01 | [Git worktree documentation][G01], commit `ebdc087dc99d68bb340c282b2ba5f722def28d19` | Metadados compartilhados e `.git` de linked worktree. |

### Evidências e autoridade locais

| ID | Documento / recibo | Limite de uso |
| --- | --- | --- |
| PRD | [PRD][PRD] | Requisitos e vocabulário; não aprovação tecnológica. |
| MAP | [Mapa][MAP] | Escopo e decisões ainda abertas. |
| L01 | [Runner rootless validado][L01] | Registro histórico da prova Node/Docker, não executado nesta sessão. |
| L02 | [Smoke Java][L02] | Registro de um método Java; não suíte inteira ou falha injetada. |
| L03 | [Recibo rootless][L03] | Metadados, versões, probes e cleanup registrados. |
| L04 | [Recibo de versões Java][L04] | Versões e configuração observadas no ensaio anterior. |
| L05 | [Eventos do smoke][L05] | Referência histórica de eventos; correlação não atribui causalidade da remoção a Ryuk. |

## 10. Validação documental

Rastreabilidade revisada contra PRD §§5–6 e §8: RF-12 corresponde a CLI/cancelamento; RNF-01 a durabilidade/reconciliação; CA-03 exige três Builders, dois no mesmo repositório; CA-05 trata de pergunta/resposta; CA-06 de crash durante execução/após efeitos; CA-07 de cancelamento/limites/falha de cleanup; CA-08 de integração Docker simultânea. Linux em uma máquina está atribuído à premissa do mapa. As propostas P2/P6 refletem concorrência três; evidência histórica e propostas locais não são apresentadas como aceite integrado desses cenários.

Verificação documental: todos os rótulos de referência Markdown definidos; 10 ocorrências de links locais resolvidas para arquivos existentes; 37 destinos externos citados consultados por HTTPS com HTTP 200 e conteúdo. `git diff --check` e a checagem do diff staged são os gates finais de whitespace antes do commit. Essas verificações atestam integridade do relatório e acessibilidade das fontes na data da pesquisa; **nenhuma executa nem homologa isolamento Linux/Docker**. SHA de publicação e URL imutável pertencem ao recibo de entrega, para não inserir autorreferência circular no próprio commit.

[D01]: https://docs.docker.com/engine/security/rootless.md
[D02]: https://docs.docker.com/engine/security/rootless/tips.md
[D03]: https://docs.docker.com/engine/security/rootless/troubleshoot.md
[D04]: https://docs.docker.com/engine/security/rootless/uid-gid-mapping.md
[D05]: https://docs.docker.com/engine/security/userns-remap.md
[D06]: https://docs.docker.com/engine/security.md
[D07]: https://docs.docker.com/engine/storage/bind-mounts.md
[D08]: https://docs.docker.com/reference/cli/dockerd.md
[D09]: https://docs.docker.com/engine/daemon.md
[D10]: https://docs.docker.com/engine/network/port-publishing.md
[D12]: https://docs.docker.com/engine/containers/resource_constraints.md
[D14]: https://docs.docker.com/reference/cli/docker/compose.md
[D15]: https://docs.docker.com/reference/compose-file/volumes.md
[D16]: https://docs.docker.com/reference/compose-file/networks.md
[D17]: https://docs.docker.com/reference/cli/docker.md
[D18]: https://docs.docker.com/engine/daemon/live-restore.md
[D19]: https://docs.docker.com/reference/compose-file/services.md
[T01]: https://raw.githubusercontent.com/testcontainers/testcontainers-java/5c448202ac69d073f746433d3e79f6a2bf0ec585/docs/supported_docker_environment/index.md
[T02]: https://raw.githubusercontent.com/testcontainers/testcontainers-java/5c448202ac69d073f746433d3e79f6a2bf0ec585/docs/features/configuration.md
[T03]: https://raw.githubusercontent.com/testcontainers/testcontainers-java/5c448202ac69d073f746433d3e79f6a2bf0ec585/docs/supported_docker_environment/continuous_integration/dind_patterns.md
[T04]: https://raw.githubusercontent.com/testcontainers/testcontainers-java/5c448202ac69d073f746433d3e79f6a2bf0ec585/core/src/main/java/org/testcontainers/utility/RyukContainer.java
[T05]: https://raw.githubusercontent.com/testcontainers/testcontainers-java/5c448202ac69d073f746433d3e79f6a2bf0ec585/core/src/main/java/org/testcontainers/utility/ResourceReaper.java
[T06]: https://raw.githubusercontent.com/testcontainers/testcontainers-java/5c448202ac69d073f746433d3e79f6a2bf0ec585/core/src/main/java/org/testcontainers/utility/RyukResourceReaper.java
[T07]: https://raw.githubusercontent.com/testcontainers/moby-ryuk/b3726afd6cc2c36628abcc08e9cabac43f587384/README.md
[T08]: https://raw.githubusercontent.com/testcontainers/testcontainers-java/5c448202ac69d073f746433d3e79f6a2bf0ec585/docs/features/networking.md
[T09]: https://raw.githubusercontent.com/testcontainers/testcontainers-java/5c448202ac69d073f746433d3e79f6a2bf0ec585/core/src/main/java/org/testcontainers/utility/TestcontainersConfiguration.java
[S01]: https://raw.githubusercontent.com/containers/bubblewrap/1fb0aa26d3eb66254f7742e704add7f82f41a582/README.md
[S02]: https://raw.githubusercontent.com/containers/bubblewrap/1fb0aa26d3eb66254f7742e704add7f82f41a582/bwrap.xml
[S03]: https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html
[S04]: https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html
[S05]: https://raw.githubusercontent.com/rootless-containers/rootlesskit/b908dce9b18fd6a31fd7903ce480dd8b28cf0ef6/README.md
[S06]: https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html
[V01]: https://www.qemu.org/docs/master/system/introduction.html
[V02]: https://libvirt.org/drvqemu.html
[V03]: https://raw.githubusercontent.com/firecracker-microvm/firecracker/498273b2a0519e9d84671f540291202eb8dca971/docs/prod-host-setup.md
[V04]: https://raw.githubusercontent.com/firecracker-microvm/firecracker/498273b2a0519e9d84671f540291202eb8dca971/docs/jailer.md
[G01]: https://raw.githubusercontent.com/git/git/ebdc087dc99d68bb340c282b2ba5f722def28d19/Documentation/git-worktree.adoc
[PRD]: ../../../tecnologia/software-factory-0.0.1-prd.md
[MAP]: ../map.md
[L01]: ../../../learning/sessions/software-factories-with-mastra/research/runner-rootless-validado.md
[L02]: ../../../learning/sessions/software-factories-with-mastra/research/java-native-smoke.md
[L03]: ../../../learning/sessions/software-factories-with-mastra/labs/0005-real-repo/evidence/rootless-proof.json
[L04]: ../../../learning/sessions/software-factories-with-mastra/labs/0005-real-repo/evidence/java-versions.json
[L05]: ../../../learning/sessions/software-factories-with-mastra/labs/0005-real-repo/evidence/java-smoke-events.json
