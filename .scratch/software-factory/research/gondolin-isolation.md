# Pesquisa: Gondolin como isolamento da Software Factory MVP

Consulta documental: 2026-11-03 (UTC). Upstream fixado em `6b381a9fd1c353e80cc9b4cf35474b6909703a16`.
Origem: [Verificar Gondolin como ambiente de execução isolado da fábrica](../issues/18-gondolin-isolation-research.md).
O pesquisador entregou o texto pelo artefato da execução; o supervisor materializou este arquivo na worktree de pesquisa, conferiu fontes por amostragem e assume validação Git/publicação.

## Resumo

**Gondolin é uma composição documentalmente plausível, não uma solução já demonstrada para o MVP.** Há VM Linux, Docker no guest em exemplo oficial, filesystem/rede mediados pelo host e checkpoints de disco. Não há evidência suficiente para afirmar menor custo/complexidade total que VM convencional ou conta/sandbox com Docker rootless, nem para aceitar três Builders Linux x86_64 com Testcontainers: os bloqueadores decisivos são armazenamento/CA de containers, Git por FUSE, durabilidade real dos artefatos e ownership/interrupção após crash.

Esta evidência **não escolhe backend de isolamento**, não reabre a escolha Pi coding-agent SDK e não aprova execução de provas. QEMU é o backend padrão/recomendado **pelo upstream**; krun continua experimental.

## Escopo, método e autoridade

- Pergunta canônica: `.scratch/software-factory/issues/18-gondolin-isolation-research.md`; lidos também `map.md` (Notes), Answers de `06-agent-runtime-choice.md` e `02-durability-strategy.md`, PRD `tecnologia/software-factory-0.0.1-prd.md`, skill research e instruções locais. O PRD é autoridade de produto; relatórios não são decisões HITL.
- Recorte upstream fixado: **`6b381a9fd1c353e80cc9b4cf35474b6909703a16`**, manifesto host **0.14.0**, Node >=22.19.0 e licença declarada Apache-2.0 [S1]. Isso não comprova homologação de pacote publicado, dependências ou imagem da fábrica.
- Quatro ângulos: plataforma/custo; Docker/rede; filesystem/persistência; ciclo de vida/revisão e encaixe no runtime aprovado. Inspeção read-only de fontes locais fornecidas e fontes públicas; nenhuma instalação, shell/Git, VM, container, agente ou medição.
- **Fato / evidência direta** descreve docs/código; **inferência** é conclusão desta pesquisa; **proposta** é desenho a deliberar/provar. Confiança alta no comportamento explicitamente descrito, não no aceite ponta a ponta.
- `source_check` executado para claims críticos retornou `unclear`: recuperou passagens, mas sem avaliação semântica automática disponível. As passagens e originais foram conferidos manualmente; a fonte fixada prevalece sobre docs públicas móveis. Uma leitura inicial de nome presumido `host/examples/docker.ts` falhou com ENOENT; o índice público fixado localizou os arquivos reais `docker.json` e `docker-init-extra.sh`. Sem troca de transporte para contornar falha ou execução de comandos.

## Findings

### 1. Linux x86_64 existe; o custo-base não é consumo demonstrado

**Fato, confiança alta:** o builder aceita `x86_64`; QEMU seleciona `qemu-system-x86_64` conforme assets. Em Linux de mesma arquitetura usa KVM quando `/dev/kvm` é acessível, caso contrário TCG; no caminho x86_64 seleciona `microvm` com KVM e `q35` sem ele [S2, S3]. A documentação recomenda QEMU e desaconselha TCG para uso regular; diz que a validação runtime é mais forte em ARM64 e que o smoke Linux x86_64 citado cobre build do runner krun — **não** uma homologação Docker/Testcontainers x86_64 [S1–S3].

**Fato, confiança alta:** defaults são **1G de memória guest e 2 vCPUs** [S3]. Não são RSS do host, mínimo garantido, reserva física integral nem dimensionamento de JVM/Postgres. Assets são descritos como aproximadamente 200MB+; isso não inclui imagens Docker, caches, snapshots, worktrees ou logs [S1].

**Inferência, confiança média:** três guests com defaults configuram nominalmente 3G de RAM guest e seis vCPUs virtuais; isso não permite estimar RAM necessária da máquina. Somam-se Node/controlador/workers, rede/VFS, QEMU, page cache, builds, Docker e revisores. Dois revisores paralelos por Builder não consomem Slots, mas podem aumentar processos/chamadas/custo. Não foram encontrados benchmarks pertinentes de RSS, boot sob carga, throughput, I/O ou três JVMs + bancos neste perfil. Portanto “microVM leve” não decide capacidade ou economia.

### 2. Docker no guest tem receita concreta, mas não prova Testcontainers

**Fato, confiança alta:** o exemplo oficial é **aarch64/Alpine**, inclui docker/containerd/runc/iptables; o init tenta montar cgroup v2, habilita forwarding, inicia dockerd no socket `/var/run/docker.sock`, data-root `/var/lib/docker`, com **`--storage-driver=vfs`** e bridge/NAT habilitados [S4]. Isso demonstra uma receita de composição, não teste concluído nesta máquina nem compatibilidade x86_64. Não confundir o storage driver Docker `vfs` com o VFS/FUSE do Gondolin.

**Fato, confiança alta:** Docker documenta que esse driver faz **deep copy**, sem copy-on-write por camada, com pior desempenho e mais disco que outros drivers [S5]. O qcow2 externo não converte essas cópias internas em overlayfs Docker. **Inferência:** pode pesar em pull/build/start e em três daemons; não há fator quantitativo verificável. O comentário do exemplo de que overlayfs frequentemente está indisponível em VMs pequenas não prova impossibilidade em toda imagem/kernel x86_64; trocar driver requer prova explícita, não pressuposição.

**Fato, confiança alta:** o init instala um wrapper apenas para **`docker run`**, que injeta `SSL_CERT_FILE` e monta o bundle CA read-only [S4]. O Gondolin intercepta TLS e injeta CA no guest; trust upstream também depende do host [S2, S6]. **Inferência decisiva:** Testcontainers usa API Docker, não precisa passar por esse wrapper; portanto a receita **não demonstra propagação de CA** para containers criados pela API, Compose ou Dockerfile/build. Nem toda aplicação respeita `SSL_CERT_FILE` (truststore Java é questão específica do piloto). Distinguir pull pelo daemon, HTTPS pelo processo guest e HTTPS de dentro do container.

**Fato, confiança alta:** Testcontainers Java requer runtime compatível com Docker API e documenta acesso a portas publicadas, mounts, socket para Ryuk/helpers e overrides de host/socket [S7]. Não foi localizada prova Gondolin/Testcontainers/Ryuk nas fontes focadas; ausência localizada não é afirmação de inexistência universal. Há divergência nas próprias docs Testcontainers: configuration diz Ryuk privilegiado obrigatório; supported environments diz que rootful Podman deixou de exigir a opção desde 1.19.0. Fixar versões e verificar o perfil real; não desabilitar Ryuk por conveniência ou tratar isso como cleanup equivalente.

**Inferência, confiança média:** executar JVM/testes **dentro do mesmo guest que dockerd** evita encaminhar toda a rede Docker ao host; redes e portas internas dos containers podem permanecer dentro desse guest. A comunicação externa pela eth0 continua mediada. HTTP/1.x/TLS são o caminho padrão; não há NAT externo genérico, HTTP/2/3 ou UDP genérico; mapped TCP é exceção explícita sem hooks HTTP/substituição de segredo [S6]. Testes usando Postgres entre guest/containers não equivalem a acesso a Postgres externo bloqueado pela política. Ingress HTTP não prova acesso host a qualquer porta JDBC/Ryuk. Expor o socket Docker ao host ampliaria a superfície; não é requisito demonstrado.

### 3. VFS/FUSE, Git e disco exigem escolher onde os dados vivem

**Fato, confiança alta:** `sandboxfs` usa FUSE/RPC até providers host; `RealFSProvider` escreve no diretório host exposto, `MemoryProvider` é efêmero e `ReadonlyProvider` rejeita mutações. Há patches locais para hard links/stat/RealFS; operações opcionais podem produzir ENOSYS. Symlinks que escapam do diretório são bloqueados em operações que os seguem; `chmod` afeta permissões host, retirando set-id [S8]. Não é ext4 local com todas as mesmas semânticas/custo.

**Inferência, confiança média:** montar apenas a pasta de uma worktree host não garante Git funcional: `.git` pode apontar para metadados comuns fora da montagem, com caminhos host ausentes no guest. Expor todo o repositório comum pode permitir escrita em refs/metadados de outros Trabalhos. É preciso provar layout de worktree + gitdir/commondir, paths e permissões, lock/rename, hooks/config e ausência de acesso lateral. Persistência de alterações não commitadas existe no provider host, **não dentro do checkpoint**; não é transação atômica com SQLite ou GitHub.

**Alternativas de desenho, não seleção:** (a) workspace durável host via RealFS restrito: facilita inspeção e sobrevivência ao guest, adiciona fronteira Git/FUSE e efeitos diretos no host; (b) worktree/metadados em root disk ext4 durável por Trabalho: reduz dependência de FUSE para build/Git, exige mecanismo de preservação/extração/recuperação do disco e snapshots para revisão. Clones separados, se considerados, devem preservar explicitamente o contrato RF-04 de branch/worktree próprias, não substituí-lo silenciosamente. Não executar ferramentas guest sobre um checkout amplo do operador.

### 4. Checkpoint não é durabilidade automática nem snapshot de execução

**Fato, confiança alta:** checkpoint captura **somente root disk**, para a VM, consome a instância e retoma por boot novo, sem RAM/processos. Usa `sync` best-effort; exclui VFS e tmpfs; precisa dos mesmos assets por buildId. Resume pode **mutar o próprio checkpoint** para rebase do backing path [S9]. A documentação chamar resume de “cheap” não é benchmark pertinente.

**Fato, confiança alta:** `/root`, `/tmp`, `/var/tmp`, `/var/cache`, `/var/log` são tmpfs por padrão; `tmpfs: {}` os põe no root disk, precisando dimensionar espaço. O overlay `cow` padrão é **descartado no close**, não volume durável do Trabalho; há configuração explícita de root disk e deleção no close [S10]. `memory` não significa sempre RAM: krun, ou QEMU com resize, usa overlay temporário em disco [S2, S10].

**Inferência decisiva:** sessão Pi em `/root`, logs e caches nesses defaults se perdem no reboot/checkpoint. Escrever uncommitted files em VFS ou rootfs não resolve sozinho retenção após close/crash/cleanup. Checkpoint voluntário bem-sucedido não prova recuperação de crash antes dele nem consistência de Docker/Postgres ativos. A composição tem de registrar exatamente onde ficam Git/metadados, novos arquivos, sessões, logs, Docker data e snapshots, com política de fsync/backup/restore e retenção. SQLite Pi Durable continua autoridade de controle; não substituí-lo por checkpoints.

### 5. Abort, close e registro de sessões não resolvem ownership

**Fato, confiança alta:** docs do SDK dizem que abort de `vm.exec` rejeita a Promise local e **não garante terminar processo guest** [S11]. O exemplo Pi propaga abort/timeout a esse sinal [S12]. Logo sucesso do abort do SDK do agente não prova cessação de comandos, daemon ou containers.

**Fato, confiança alta:** QEMU é child process rastreado em conjunto em memória; um `process.once('exit')` tenta SIGKILL nos children. `terminateChild` tenta TERM, KILL após 3s e espera no máximo 10s; se necessário destrói pipes e faz `unref`, inclusive tentando matar outros children rastreados [S13]. **Retorno de close não é prova infalível de morte**. SIGKILL no host Node não executa listeners JS [S14]; o exit hook não cobre esse corte. PID/UUID, list/attach e registro de sessão existem [S11], mas não demonstram fencing durável, reaproveitamento de todos os canais/políticas ou adoção segura após morte do proprietário.

**Inferência/proposta, confiança média:** atribuir identidade durável Trabalho/Execução/geração a worker, VMM, disco e mounts; supervisão externa Linux independente do processo proprietário (por exemplo unidade/cgroup, a escolher) que permita descobrir e confirmar cessação. Persistir intenção antes do spawn, reconciliar sobreviventes/efeitos antes de substituto e bloquear quando exclusividade for indeterminada. Não usar PID sozinho, arquivo de sessão ou lease vencido como prova de morte. Avaliar também impacto do fallback que mata outros children do mesmo processo em três VMs. Esses são trabalhos próprios da fábrica, não APIs prontas alegadas do Gondolin.

### 6. Agente host versus guest; revisores somente leitura não bastam

**Fato, confiança alta:** a extensão Pi roda **Pi no host** e substitui read/write/edit/bash por operações guest, com diretório host montado RW em `/workspace`; fecha VM em `session_shutdown`. Não demonstra worker independente do perfil pessoal, sessões duráveis, ferramentas de fábrica, dois revisores ou o Pi 1.5.0 fixado pelo Answer 06 [S12].

**Inferência comparativa:** manter Pi SDK em worker host preserva a interface aprovada e concentra modelos/credenciais/sessão fora do guest, mas exige lista completa de ferramentas/extensões autorizadas e garantir que nada execute código do repo no host. Somente quatro overrides do exemplo não bastam. Pi SDK **dentro do guest** também preserva a escolha de runtime, mas exige Node/perfil fixados na imagem, protocolo de controle/ask-user/cancelamento e persistência da sessão, além de validar provider/TLS/streaming sob a rede mediada. Nenhuma posição é automaticamente mais simples. A chave emissora GitHub e o estado de controle permanecem fora do alcance do Builder em ambos os casos, conforme decisões existentes.

**Fato:** ReadonlyProvider impede escrita por aquele caminho, não congela os dados que um Builder ainda altera [S8]. **Proposta:** capturar referência imutável contendo tracked/untracked/uncommitted, especificação e instruções, antes de iniciar Standards e Spec; expor a mesma captura RO a ambos, sem caminho alternativo RW, shell irrestrito ou token GitHub de escrita. Não chamar montagem RO de “snapshot imutável”. Checkpoints também precisam cópia/controle de mutação devido ao rebase. Registro e invalidação de reviews permanecem responsabilidade do controlador.

## Matriz RF/RNF/CA — cobertura pertinente, não declaração de conformidade

| Área / evidência | RF / RNF pertinentes | CA a demonstrar / lacuna |
| --- | --- | --- |
| Três ambientes com recursos próprios; custo desconhecido | RF-03–04; RNF-02 | CA-03: três Builders, dois no mesmo repo, sem writer duplicado; CA-08: Docker simultâneo real |
| Docker/API, CA, bridge, storage driver | RF-07; RNF-02 | CA-08: Testcontainers/Ryuk, portas, mounts, egress e nomes/volumes fixos sem colisão; CA-12 se validação inviável |
| Git/worktree/disco/sessão e efeitos externos | RF-04, RF-08, RF-10; RNF-01 | CA-06: crash durante comando e após push/PR/pergunta sem duplicar efeitos/escritores |
| Suspensão/retomada e cancelamento físico | RF-03, RF-10, RF-12–13; RNF-01, RNF-05 | CA-05: pergunta libera Slot só após cessação; CA-07: interrupção/limites; CA-11: timeout configurado, sem teto fixo e esperas sem tempo/Slot |
| Captura imutável e revisores separados | RF-04–06, RF-07–08; RNF-02, RNF-05 | CA-01: fluxo integral; CA-12: falha de review/validação não vira sucesso |
| Identificação, retenção e cleanup conservador | RF-12, RF-14; RNF-01, RNF-03 | CA-01/07: preservar não entregue, remover somente recursos próprios e reportar falha |
| Git remoto e limites de autorização | RF-08–09; RNF-02, RNF-05 | CA-09: lease/base protegida; microVM não aplica permissões GitHub por si |

CA-02/04/10 e RNF-04 dependem sobretudo de GitHub/fila/polling, não são demonstrados por Gondolin; isolamento não os dispensa. RF-01–02/09/11/13 e demais partes de RNF-03/05 continuam sob o controlador/protocolo aprovados. Não atribuir conformidade de todo RF-01–14 ao sandbox.

## Comparação qualitativa delimitada

**Inferência de arquitetura, não benchmark:**

| Alternativa | Possível simplificação | Complexidade/risco residual |
| --- | --- | --- |
| Gondolin QEMU/KVM por Trabalho | SDK de exec/VFS/rede/segredos e fronteira de kernel pronta; Docker contido no guest sem daemon host compartilhado | Imagem customizada, FUSE/Git, TLS/CA, driver Docker vfs, supervisão e durabilidade ainda próprias; validação x86_64 do perfil pendente |
| VM convencional por Trabalho | Userspace/disco/rede Linux mais convencionais podem reduzir adaptações Docker/Testcontainers | Provisionamento/guest agent, política de rede/segredos, snapshots/ownership/cleanup precisam composição; não há medição para chamá-la pesada ou mais simples |
| Conta/sandbox + Docker rootless por Trabalho | Evita hipervisor/boot e reaproveita Linux host | Separar conta/processos/FS e daemon realmente por Trabalho; kernel compartilhado, portas/recursos host, supervisão e restrições rootless dependem dos pilotos; worktree isolada não basta |
| Gondolin krun | Backend opcional dentro da mesma API | Experimental, kernel próprio/paridade/rede com ressalvas; nenhuma evidência de ganho líquido neste MVP [S2] |

Gondolin **continua sendo VM**: “micro” não elimina kernel, imagem, disco, daemon ou supervisão. A escolha deve minimizar complexidade total validada, não número de serviços ou tamanho nominal de RAM.

## Contradições e limites documentais

1. **“Only Alpine”** em limitations versus OCI Debian: custom-images esclarece que `distro: alpine` governa pipeline/boot (kernel/initramfs Alpine); `oci.image` substitui **userspace rootfs**, documentando Debian/Ubuntu [S15]. Não é suporte irrestrito a qualquer distro/kernel nem proibição de userspace glibc. A frase “adicionar pacotes exige rebuild” também deve ser lida como caminho suportado de imagem reproduzível, não prova de impossibilidade absoluta de instalação numa camada writable; sdk-storage contém exemplo `apk add`.
2. Descrição de segurança de raiz COW/segredos é condicional: existem modos readonly/memory e montagem host RW. Segredo só fica fora do guest se fornecido pelos mecanismos apropriados; allowed host pode refletir headers ou receber dados. Host Node é confiável; não há defesa contra mesmo usuário local, escape de hipervisor ou DoS completo [S6]. Não presumir conformidade RNF-02 com defaults/allowlist ampla.
3. Ryuk: contradição de alcance/privilégio entre páginas oficiais [S7]; resolver por versão/perfil, sem assumir bloqueio ou sucesso universal.

## Missing evidence e provas futuras decisivas

**Não autorizadas/executadas nesta pesquisa.** Primeiro fixar hipóteses e protocolo no ticket de isolamento; depois, mediante autorização própria:

1. **Gate Docker x86_64:** imagem/perfil fixados, QEMU/KVM, JVM + Postgres/Testcontainers/Ryuk reais de pilotos, socket/mount/porta/wait strategy, DNS/registry/redirects e CA em daemon, guest e containers API. Não usar wrapper CLI como evidência substituta, nem desligar limpeza/segurança para “passar”.
2. **Gate capacidade:** três Builders, dois no mesmo repo, com revisores e testes simultâneos; medir RAM host/guest, CPU, pico/latência I/O, disco de imagens/cache/driver vfs e tempo frio/quente. Definir capacidade com esses dados, sem inventar orçamento mínimo.
3. **Gate persistência/Git/revisão:** worktree/gitdir restritos ou disco escolhido; commits, locks, renames, novos/uncommitted, snapshot RO integral, alteração posterior invalidando review; reboot/close/crash/restore preservando artefatos exigidos, sem expor refs/segredos de outros Trabalhos.
4. **Gate ownership/cessação:** SIGKILL de controlador e worker, crash entre intenção/spawn/recibo, comando desassociado e containers sobreviventes; provar descoberta/eliminação ou acompanhamento exclusivo antes de substituto; confirmar cancelamento e Slot liberado. Close/abort retornando não basta. Injetar falha numa VM sem terminar indevidamente as demais.
5. **Gate composição aprovada:** Pi SDK/perfil independente do operador no host ou guest, perguntas e retomadas sob Pi Durable; CA-06 após push/PR/pergunta reais; logs/uso/custo por papel e retenção protegida. Impossibilidade ou ambiguidade produz bloqueio/retorno ao operador, não adaptação silenciosa do PRD.

## Sources

Todos os links Gondolin abaixo são permanentes no SHA pesquisado. Fontes externas oficiais são páginas móveis; fixar versões do software antes de prova.

- **[S1]** [README](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/README.md), [host README](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/README.md), [manifesto](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/package.json) — versão, suporte e limites de validação declarados.
- **[S2]** [Backends](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/backends.md), [QEMU](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/qemu.md) — recomendação upstream e paridade.
- **[S3]** [server-options.ts](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/src/sandbox/server-options.ts), [controller.ts](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/src/sandbox/controller.ts) — defaults/resolução e KVM/TCG/machine type.
- **[S4]** [docker.json](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/examples/docker.json), [docker-init-extra.sh](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/examples/docker-init-extra.sh) — receita Docker, driver, CA e rede.
- **[S5]** [Docker: VFS storage driver](https://docs.docker.com/engine/storage/drivers/vfs-driver/) — deep copy e trade-off qualitativo oficial.
- **[S6]** [Security design](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/security.md), [Limitations](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/limitations.md) — modelo de confiança, rede, TLS e não garantias.
- **[S7]** [Testcontainers: runtime requirements](https://java.testcontainers.org/supported_docker_environment/), [configuration](https://java.testcontainers.org/features/configuration/) — socket/portas/helpers/Ryuk; não homologação Gondolin.
- **[S8]** [VFS providers](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/vfs.md) — FUSE/RPC, providers, symlinks/semânticas e RO.
- **[S9]** [Snapshots](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/snapshots.md) — parar/reboot, exclusões, buildId e mutação no resume.
- **[S10]** [SDK storage](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/sdk-storage.md), [root disk options](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/src/sandbox/server-options.ts) — tmpfs, overlay descartável e tamanho.
- **[S11]** [SDK VM](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/sdk-vm.md) — identidade/PID, attach e abort somente local.
- **[S12]** [Pi extension example](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/examples/pi-gondolin.ts) — agente host, ferramentas guest, mount RW e shutdown hook.
- **[S13]** [child-process.ts](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/src/sandbox/child-process.ts) — exit hook e término best-effort com timeout/fallback.
- **[S14]** [Node: signal events](https://nodejs.org/api/process.html#signal-events) — SIGKILL não executa listener.
- **[S15]** [Custom images](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/custom-images.md) — arquitetura, pipeline Alpine versus rootfs OCI e custo de build.

**Depriorizadas:** snippets de busca (inclusive busca que não localizou o exemplo Docker), docs móveis como autoridade da versão fixada e alegações genéricas de boot subsegundo/“lightweight”: não provam perfil x86_64, RSS, concorrência ou aceite. Não houve coleta exaustiva de alternativas microVM.

## Próximo passo

Levar estes cinco gates e as duas posições do agente à decisão de isolamento/ciclo de vida, sem encerrar a escolha com base documental. A primeira prova útil, se autorizada, é Docker/Testcontainers/Ryuk + CA no guest Linux x86_64; ela pode invalidar cedo a vantagem de simplicidade antes de construir adaptador/recovery completo.
