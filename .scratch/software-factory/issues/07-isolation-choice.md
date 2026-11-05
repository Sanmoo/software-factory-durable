# Escolher o isolamento e o ciclo de vida dos ambientes de trabalho

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão Pi `01a1a1d0-7fa4-72a8-8dc8-48e72b6d1c93`; branch de registros `software-factory-isolation`, worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-isolation`; integração em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 01, 02, 04, 06, 18

## Question

Qual composição de isolamento Linux atende ao PRD com a menor complexidade total, à luz da pesquisa e da autoridade atribuída a cada componente?

Definir fronteiras de filesystem, processos, credenciais, rede e Docker; unidade de isolamento (trabalho/execução/revisão); montagem de repositórios/worktrees; localização do estado persistente; propriedade e reconhecimento de processos/recursos após crash; encerramento/cancelamento; preservação e cleanup. Revisores não podem escrever na worktree revisada.

Explicitar requisitos de instalação, compatibilidade com integração Docker concorrente, incompatibilidades que o operador deverá corrigir no repo, limitações residuais e provas de aceite propostas. A aceitação do custo de ambientes dedicados não escolheu container, rootless ou VM. Não provisionar o host nem executar provas neste ticket.

## References

- [Escolher o runtime de agentes e seus pontos de integração](06-agent-runtime-choice.md): Builder e revisores em workers Node/SDK próprios;
  perfil independente do operador, revisão integral sem escrita no fluxo das skills e cessação confirmada antes de liberar Slot/substituir escritor.
  Concretizar isolamento e supervisão sem transformar abort do SDK em garantia de encerramento de processos/containers.
- [Escolher a estratégia mínima de durabilidade e recuperação](02-durability-strategy.md): proteger storage SQLite do controle e impor seu proprietário único; concretizar observação/interrupção de escritores sobreviventes antes de substituição. Não confundir owner do storage com builder único.
- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md): encaixe posterior da evidência de processos/recursos e barreiras selecionadas aqui.
- [PRD — Software Factory MVP](../prd.md): RF-03–04, RF-06–07, RF-12–14; RNF-01–02; CA-03, CA-06–08.

## Comments

- Criado na cartografia aprovada; reivindicação registrada antes do trabalho e integrada em `main` no commit `bd5922a`.
- As doze escolhas HITL foram confirmadas nesta sessão. As aprovações parciais foram consolidadas em Answer, a única fonte da resolução; não se infere aceite tecnológico das pesquisas.
- A proposta inicial de VM convencional foi substituída por Gondolin após indicação do operador e pesquisa documental. A revisão passou por propostas rejeitadas de VM auxiliar, snapshot e commit obrigatório; após esclarecer a ausência de subagentes prontos no core do Pi, o operador aprovou o handoff mínimo ao controlador.
- A exigência anterior de referência imutável em revisão foi explicitamente retirada. A decisão de runtime e o ticket de skills foram alinhados; o PRD continua exigindo cobertura integral e revisores sem escrita.
- Nenhuma implementação, instalação, imagem, serviço, VM, agente ou prova foi executada.

## Answer

### Escolha e alcance

Adotar **Gondolin com QEMU/KVM como adapter de sandbox inicial**, em Linux de uma única máquina, com **ambiente e disco próprios por Trabalho**. Não adotar krun ou fallback Docker no MVP. Exigir aceleração funcional: máquina física ou VM Linux com nested KVM disponível. Sem aceleração, bloquear com diagnóstico, sem fallback silencioso para TCG ou isolamento mais fraco.

O recorte documental é Gondolin 0.14.0 no upstream `6b381a9fd1c353e80cc9b4cf35474b6909703a16`; não é combinação publicada/homologada. Perfil distribuível, política de versões/arquitetura e pré-requisitos concretos foram detalhados em [Definir o contrato e o perfil distribuível do adapter Gondolin](19-gondolin-adapter-contract.md).

A justificativa é aproveitar a interface TypeScript, execução, VFS e mediação de rede existentes e manter Docker no guest, em vez de compor contenção de Builder e daemon rootless do host. VM convencional continua alternativa possível; não há medição que prove Gondolin mais leve ou simples no total. A escolha é de desenho e depende das provas de aceite.

### Interface e configuração do adapter

Configuração, defaults, validação e aplicação das opções de sandbox pertencem ao **adapter Gondolin e à interface de sandbox**:

- Defaults iniciais, convenção explícita de unidades e capacidade foram precisados com aprovação humana em [Definir o contrato e o perfil distribuível do adapter Gondolin](19-gondolin-adapter-contract.md#configuração-do-adapter). Não são limites globais nem defaults universais de futuros adapters.
- QEMU, units/grupos/cgroups systemd do ambiente, disco, mounts, rede, observação e confirmação de cessação são implementação do adapter.
- O controlador usa handles/resultados da interface e os Slots. Não conhece flags QEMU, não mantém campos paralelos de RAM/vCPUs/disco nem executa outro escalonador de recursos.
- Dimensionamento de disco, unidades/conversões explícitas e requisitos de capacidade pertencem ao perfil do adapter. Não converter silenciosamente uma unidade nem apresentar defaults como capacidade comprovada.
- Mostrar consumo dos discos/workspaces preservados e falhas de recurso. Falta de espaço impede novos preparos; não autoriza apagar artefatos.
- Limite do guest não equivale ao consumo total do host: workers/VMM e overhead entram na prova de capacidade.
- Uma interface pequena é suficiente; não criar framework genérico de plugins, outro motor ou serviço de recursos.

### Filesystem, processos e credenciais

| Papel ou recurso | Fronteira aprovada |
| --- | --- |
| Controlador | Pi Durable/SQLite e chave emissora GitHub fora dos mounts/ferramentas dos agentes; proprietário único do estado conforme a decisão de durabilidade. Serviço systemd do controlador é opcional conforme o [contrato operacional](21-installation-operations-contract.md#alcance-e-instalação-autocontida), não configuração de sandbox fora de sua interface. |
| Workers Pi | Processos Node/SDK próprios no host, com perfil explícito e independente do operador. Integram a base confiável da fábrica; não executam código arbitrário do repo no host. |
| Ferramentas do Builder | Leitura/edição/escrita/comandos do repo encaminhados ao guest. Não expor ferramenta de execução no host nem carregar extensões/plugins do repo. |
| Workspace e Git | Diretório persistente próprio do Trabalho no host, exposto estritamente por RealFSProvider; worktree, branch e metadados próprios, sem metadados comuns graváveis com outros Trabalhos. Não montar home do operador ou checkout amplo. |
| Disco do guest | Próprio do Trabalho; conserva ambiente instalado, Docker data e caches que residirem nele, sem ser autoridade de autorização/fila. |
| Docker | Daemon e recursos dentro da VM do Trabalho; não fornecer socket Docker do host ou de outro Trabalho. Poderes Docker dentro do guest não são administração do host. |
| Revisores | Workers/sessões/modelos/objetivos independentes; ferramentas somente leitura sobre o conteúdo revisado na mesma VM, sem shell irrestrito, mutação, acesso Docker ou credencial GitHub de escrita. Uma instrução ao modelo, sozinha, não impõe a restrição. |

A publicação permanece direta pelo Builder com token reduzido da GitHub App, conforme [Definir a fronteira mínima entre controlador e builder](01-control-authority.md). Emissão, renovação e retirada de acesso ficam no [contrato da GitHub App](11-github-app-contract.md). Não expor credenciais pessoais ou material emissor; o adapter e o perfil devem impedir acesso a esses dados por ferramentas/mounts. Proteção e retenção de outros segredos/logs continuam na área de observabilidade do mapa.

[Definir o contrato e o perfil distribuível do adapter Gondolin](19-gondolin-adapter-contract.md) concretiza os paths/mounts, instalação sem poderes de administração do host para os agentes, perfil/imagem e evidências do ambiente; [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md) concretiza a propriedade única de controle e a exclusão de escritores. Nenhuma garantia física é inferida só do estado SQLite.

### Preparação Git e cache simples

Manter **um cache Git bare local por repositório**, administrado exclusivamente pela fábrica e nunca montado no guest.

Para o mesmo repo, a fábrica sequencia **fetch → concluir clone local → próxima preparação**. Não há lock de arquivo, serviço de lock ou mecanismo distribuído para o cache. Repos diferentes podem ser preparados em paralelo; isso não cria mutex de execução por repo e Builders já preparados continuam concorrentes.

Criar cópia local independente por Trabalho com `--no-hardlinks`, sem `--shared`, `--reference` ou alternates, e configurar seu remoto para GitHub. A preparação não executa scripts/hooks/plugins do repo no host. Retomadas/reparos reutilizam o checkout existente, sem novo clone.

Cache pode ser descartado/reconstruído sem invalidar cópias já preparadas; não contém trabalho em andamento nem autoridade da referência-base. Após crash, reconciliar processos próprios de preparo antes de mutar novamente o cache. Falha de atualização não autoriza assumir base atualizada. Sem TTL/LRU ou serviço extra; não prometer cache de LFS/submódulos/dependências. Há custo de cópia local/disco, mesmo evitando downloads repetidos.

A [documentação de git clone](https://git-scm.com/docs/git-clone) sustenta cópia com `--no-hardlinks`, dependência perigosa de alternates e corrida de clone local com mutação da origem; a serialização escolhida trata essa corrida.

### Revisão: handoff mínimo ao controlador

1. Builder executa implement e sinaliza que está pronto para revisão, devolvendo o controle.
2. Controlador reutiliza seu mecanismo de workers para executar Standards e Spec em paralelo na **mesma VM e mesmo workspace do Trabalho**.
3. Builder não executa enquanto os revisores trabalham; o Slot continua ocupado.
4. Controlador recebe os dois resultados e alimenta a sessão existente do Builder para continuar e tratar achados.

Adaptar apenas o ponto de revisão de implement/code-review. Não exigir extensão genérica de subagentes, plataforma de delegação ou segundo motor. O Pi SDK oferece sessões configuráveis, mas isso não é ferramenta de subagentes pronta no core; essa ausência motivou a escolha do controlador.

Não exigir VM auxiliar, cópia/snapshot próprio, commit candidato, worktree limpa ou auditoria genérica de quiescência como pré-condição da revisão. **Não se promete congelamento do workspace contra escritores externos.** Permanecem revisão integral (incluindo alterações não commitadas/arquivos novos), Spec com especificação versionada, restrição de escrita, resultados reais, falha distinta de sucesso, tratamento dos achados e nova revisão após alterações relevantes. A declaração do Builder dispara revisão, não substitui suas conclusões nem comprova prontidão do PR.

Detalhes de conteúdo, evidências e invalidação pertencem ao [contrato de skills e revisão](17-skills-and-review-contract.md), sem reintroduzir gates retirados.

### Rede e compatibilidade dos repositórios

Usar mediação Gondolin para **HTTP(S) público**, sem lista manual de cada domínio público. Não conceder acesso geral ao host, rede privada ou outros Trabalhos. Testes comunicam-se com containers dentro da própria VM; não publicar portas para fora do ambiente por padrão.

Endpoints privados necessários são exceções autorizadas na configuração da instalação/repositório, não aprovação repetida por Ticket. Incompatibilidade de protocolo/DNS/TLS/CA produz diagnóstico/bloqueio, sem liberação automática de rede ou troca de sandbox.

Inventários Docker e portas internas pertencem a cada VM. Isso não certifica qualquer suíte: paths de bind, FUSE, nomes/volumes persistentes, serviços residuais, arquiteturas e recursos especiais precisam de compatibilidade demonstrada. Reportar adequação necessária no repo; não reescrever testes silenciosamente.

### Ciclo de vida, supervisão e recuperação

- **Ativo:** mesma VM durante implementação, revisões e tratamento dos achados.
- **Espera por resposta/CI/merge:** encerrar processamento, manter disco/workspace/contexto. Liberar Slot somente conforme a cessação confirmada prevista no runtime/protocolo.
- **Retomada/reparo:** novo boot/processo/handle sobre o mesmo disco e identidade lógica; não reconstruir a imagem ou reclonar.
- **Cancelamento:** impedir novos disparos/renovações, interromper por supervisão, confirmar cessação e reconciliar efeitos externos já enviados. Preservar disco/workspace/artefatos.
- **Bloqueio ou PR fechado sem merge:** preservar até limpeza explícita. Estado externo não comprova que uma execução ativa já terminou.
- **Merge confirmado:** permitir cleanup conservador somente dos recursos próprios. Falha visível/repetível não desfaz a entrega.

Usar **systemd** como supervisor dos ambientes no Linux, sem supervisor próprio: grupos identificáveis por Trabalho abrangendo workers e QEMU. O controlador pode executar em primeiro plano ou como serviço opcional, conforme o [contrato operacional](21-installation-operations-contract.md#alcance-e-instalação-autocontida); isso não dispensa a supervisão dos ambientes. Administração systemd não é oferecida aos agentes; detalhes dos ambientes ficam dentro do adapter.

Após crash do controlador, **encerrar e retomar**, não adotar execução viva: identificar sobreviventes próprios, interromper e confirmar que não podem escrever, reconciliar push/PR/pergunta e retomar pelo controle normal com disco/sessão/histórico preservados. É falha operacional sob os limites persistentes, não novo Trabalho, cancelamento ou repetição cega de ferramenta. Se identidade, propriedade ou cessação forem indeterminadas, bloquear; PID isolado/retorno best-effort não bastam. A recuperação também cobre processos de preparo do cache.

Os [contratos de estados](08-state-and-effects-contract.md) e [protocolo](15-controller-worker-protocol.md) definem IDs, transações, mensagens/gerações, barreira de boot e evidências; o adapter fornece observação/cessação sem criar autoridade concorrente.

### Persistência do disco não é suspensão

O [VM core fixado](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/src/vm/core.ts) oferece disco explícito com `sandbox.rootDiskPath`, formato e `rootDiskDeleteOnClose: false`, em vez do overlay temporário padrão. `close()` encerra a instância; não prometer stop/start sobre o mesmo objeto SDK, RAM salva ou continuidade de processos.

O [SDK storage](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/sdk-storage.md) documenta tmpfs por padrão em `/root`, `/tmp`, `/var/tmp`, `/var/cache` e `/var/log`. Configurar dados a preservar para residirem no disco; não prometer persistência de `/run`. Manter os mesmos assets/base enquanto houver disco dependente. Close não demonstra desligamento gracioso: parada/sincronização, integridade no próximo boot e morte confirmada do VMM precisam de prova.

Isso mantém a escolha de workspace host/VFS, ainda que o [guia de workloads](https://github.com/earendil-works/gondolin/blob/6b381a9fd1c353e80cc9b4cf35474b6909703a16/docs/workloads.md) favoreça guests descartáveis. O operador escolheu conservar adicionalmente o disco para não reinstalar/redownloadar o ambiente entre Execuções.

### Limites da evidência e provas pendentes

O [relatório de Gondolin](18-gondolin-isolation-research.md) e a [pesquisa Linux/Docker](04-linux-docker-research.md) são evidência documental, não aceite. Limites centrais:

- Exemplo Docker upstream é aarch64 e usa driver Docker `vfs`; não prova perfil x86_64 nem o driver final. Deep copy/custo de disco/I/O precisa consideração.
- Wrapper de CA do exemplo cobre `docker run`, não demonstra certificados em containers criados por Testcontainers/API.
- FUSE/RealFSProvider não é prova de Git/builds equivalentes a ext4 local.
- Defaults, startup e close/abort não provam capacidade, interrupção ou recuperação.
- A instalação não promete conter código deliberadamente hostil, escape de hypervisor, todo DoS ou exfiltração de segredos legitimamente concedidos.

Antes do aceite, com autorização separada e ambientes apropriados:

| Prova futura | Cobertura pertinente |
| --- | --- |
| Três Builders simultâneos, dois no mesmo repo, cópias/worktrees/branches próprias, sem escritores duplicados; recursos reais medidos | CA-03; RF-03–04; RNF-02 |
| Docker/Testcontainers/Ryuk e gates reais dos pilotos; CA, binds, DNS/portas, nomes/volumes, não interferência e limpeza própria | CA-08; RF-07; RNF-02 |
| Ferramentas host/guest e papéis: negativas de acesso a host/controlador/outros Trabalhos; revisores sem escrita e duas conclusões reais | CA-01/12; RF-04–07; RNF-02 |
| Desligar/religar com pacotes/cache/Docker data e workspace preservados; pergunta libera Slot e retoma sem clone | CA-05/11; RF-03/10/13; RNF-01 |
| Crash durante execução e após push/PR/pergunta; cache em preparo; ausência de substituto antes de cessação confirmada | CA-06; RF-04/08/10; RNF-01 |
| Cancelamento, limite de recurso, disco cheio, retenção de não entregue e falha/retry de cleanup sem apagar recurso alheio | CA-07; RF-12–14; RNF-01–03 |

Instalação reproduzível inclui Linux/systemd, QEMU/KVM funcional (inclusive nested quando aplicável), assets/perfil fixados e storage local apropriado, sem herança pessoal; os comandos/versões e provas concretas pertencem ao [contrato do adapter](19-gondolin-adapter-contract.md). Falha decisiva de API ou prova exige retorno ao operador, não relaxamento silencioso.

### Roadmap e encerramento desta decisão

Outras modalidades de sandbox, **incluindo Docker para hosts que já são VMs**, são evolução pós-MVP; não fallback nem autorização implícita de socket rootful, daemon compartilhado ou container privilegiado. macOS também é posterior; Gondolin documenta QEMU/HVF, mas a fábrica ainda precisará de adaptação/suporte por arquitetura e provas. Não prometer portabilidade de checkpoints entre arquiteturas.

Esta resolução fecha a **composição de isolamento e o ciclo de vida**. O contrato concreto do adapter, protocolo, estados, GitHub App, especificação e skills permanecem decisões próprias apontadas acima; instalação/CLI global, observabilidade/retenção e cobertura final continuam no mapa. Não foi produzida spec implementável completa nem autorizada construção/prova nesta sessão.
