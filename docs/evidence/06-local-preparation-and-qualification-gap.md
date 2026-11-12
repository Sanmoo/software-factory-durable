# Ticket06 — preparação local parcial, não aceite Docker

## Estado e autoridade

Base: integração `4e085bff` (03 integrado), branch
`implement/software-factory-mvp-06`. Destino original continua
`integration/software-factory-mvp` no checkout irmão; nenhum merge/remote ou
alteração de assets foi feito por este implementer.

Autoridade: `.scratch/software-factory/spec.md` §§7.3–7.5, 13.3–13.4 e 14;
`module-public-interfaces.md` Q5/Q11; decisão19, Interface, Imagem e Rede;
matriz V-02. A política **já aprovada** permite HTTP(S) público mediado sem
allowlist manual por domínio, nega host/redes privadas externas/outro Trabalho
salvo exceções autorizadas, e permite tráfego de testes **dentro da VM** sem
publicar portas fora dela. TLS tem três camadas distintas. Não pedir reaprovação
dessa política nem confundir rede privada interna dos containers com egress
privado externo proibido.

**Nenhum AC06 foi fechado. Nenhum Docker/VM/pull/TLS físico foi executado.**
Todos os grants03/X3 estão consumidos. Fixtures não equivalem às suítes dos
pilotos; diagnóstico e syntax-check não provam a fronteira substituída.

## Trabalho local entregue

- `Sandbox.validate` agora expõe separadamente dois impedimentos concretos:
  projeção/transporte `executeTool` ainda ausente nesta base e rede guest
  desabilitada. `docker-runtime` continua `unverified`, não sucesso.
- Teste pelo seam público **já aprovado** `Sandbox.validate` verifica diagnóstico
  e ausência de criação de recursos, com diretório temporário real. Baseline
  seis casos verdes, RED novo caso por diagnóstico ausente, GREEN sete casos.
- `test/sandbox/fixtures/docker06.sh`: fixture guest real preparada, não rodada.
  Usa API Testcontainers normal, Network/GenericContainer, Ryuk obrigatório,
  imagens por digest, binds read-only sobre workspace FUSE, alias DNS, porta
  mapeada dentro do guest, servidor HTTPS e segundo container Node verificando
  HTTPS com CA explícita. Sem host networking/socket host, privileged,
  `--insecure`, Ryuk-off ou alteração de testes para obter verde.
- `https-server.mjs`: asset de aplicação da fixture, não serviço host.
- `git06.sh`: fixture guest real de Git init/commit, exclusão por index.lock,
  rename, modo executável e fsck; mantém repo/OIDs para inspeção após reboot.
  Não executada no host: somente parsing `sh -n` e `node --check`.

### Pré-requisitos ainda NÃO fornecidos à fixture

Staging dentro de um filho de `/workspace`, próprio deste Trabalho; Node compatível,
OpenSSL, pacote Testcontainers com versão/lock/integridades fixados e revisados
antes de qualquer instalação; imagem Node Alpine e Ryuk com digests explícitos.
A fixture deliberadamente não instala dependências, fabrica certificados, escolhe
tags ou inicia VM. Arquivos `tls/ca.pem`, `server.pem`, `server-key.pem` devem ser
criados no guest próprio com CA sintética e SANs `localhost`/`fixture-service`,
nunca com material pessoal. Não foi adicionado pacote Testcontainers à aplicação.
Sua API contra a futura versão fixada ainda precisa de validação; parsing não
resolve imports nem comprova compatibilidade musl.

A CA sintética só exercita truststore da aplicação/tráfego interno. Não prova
CA mediada do Gondolin, HTTPS público das ferramentas, trust do daemon ou pull.
O collector futuro deve preservar comandos/ambiente não secreto, versão/lock,
IDs/logs do Ryuk e recursos próprios, configuração/manifesto/host/boot,
expectativa/observado e amostras `Sandbox.observe` antes/depois. Falha de start
pode deixar efeito ambíguo sem objeto retornado; reconciliar identidades/labels
próprias, nunca `prune` ou remoção global. Stop de containers no finally não
prova por si que Ryuk foi executado/limpou tudo.

## Impedimentos de implementação, não nova aprovação de Q5

Na base03, `src/sandbox/index.ts` só oferece lifecycle/validate. O adapter dono
possui apenas `vm.exec` privados de readiness/finalização; não há projeção de
ferramentas vinculada a boot/invocação/papel ou transporte para ela. O nome
`ToolEnvironment` não é uma API exata obrigatória do desenho: sua ausência não
reabre a decisão já aprovada. O supervisor atribuiu implementação compartilhada
desse seam ao ticket05. 06 não escreveu código concorrente nem criou guestExec,
flag de papel livre, acesso direto ao SDK ou seam filesystem alternativo.
Integrar o seam aprovado de05 antes de executar as fixtures por `executeTool`.

`src/sandbox/adapter.ts` mantém `netEnabled:false`. O asset congelado declara
`bridge:none`, iptables/ip6tables/ip-forward/ip-masq/userland-proxy falsos em
`guest-profile/docker-daemon.json`. Isso ainda **não demonstra** a capacidade de
rede/port mapping normal que Testcontainers/Ryuk necessitam. A fixture não muda
esses valores, não usa host networking para mascarar a lacuna e não libera rede
externa. Inspecionar/implementar mediação pelo SDK instalado é trabalho de código
permitido; ativá-la fisicamente continua exigindo grant. Se a composição
congelada não suportar o caminho necessário sem mudança de imagem, apresentar
o erro/caminho mínimo ao operador antes de escolher alteração de perfil/assets.
Não há evidência suficiente agora para declarar incompatibilidade definitiva ou
pedir uma política de rede diferente da já aprovada.

## Matriz de execução futura (tudo pendente)

| Recorte | Preparado / prova faltante |
| --- | --- |
| Daemon/data-root/vfs sem host Docker | preflight da fixture; observar daemon/container real e manifesto do perfil, sem overlay2 |
| Testcontainers/Ryuk/binds/DNS/portas | fixture real preparada; observar dois containers e Ryuk, resolução e cleanup próprio |
| Volumes persistentes / reboot Docker | ainda implementar subcaso por API aprovada; preservar volume/dados e comparar antes/depois, sem reprepare/reclone |
| API/Compose/build | fixture cobre API Testcontainers; Compose/build **não cobertos**, não declarar equivalência; fechar escopo conforme suíte representativa/pilotos |
| TLS guest/daemon/aplicação | fixture só prepara aplicação; faltam ferramentas HTTPS público/CA mediada, pull autenticado por TLS do daemon, runtime/truststore e negativos |
| Git FUSE/persistência | fixture Git preparada; executar pelo guest e reler OIDs/modos/locks e caches/pacotes após novo boot |
| Isolamento | provar negativas host/rede privada externa/outro Trabalho sem tocar recursos alheios; fixture não é essa prova |
| Diagnósticos musl/cert/nome/porta | teste local só diagnostica capacidades ausentes; falhas reais devem preservar causa/adequação explícita, nunca relaxar gates |
| Recursos/manifesto | observar consumo disponível e lacunas, incluir overhead/vfs; fixture não mede capacidade nem prova piloto/hardware |

## Menor próximo passo e futuro grant fechado

1. Receber/integrar o seam aprovado de05; verificar identidade/fencing, projeção
   por papel e saída protegida sem substituir a fronteira por doubles.
2. Implementar/inspecionar mediação/TLS e caminho Docker interno sob a política
   existente; identificar qualquer necessidade **real** de mudar assets antes de
   pedir exceção. Fixar lock de dependências/imagens e escopo dos subcasos.
3. Só então solicitar um plano físico enumerado: um ambiente06 novo e próprio,
   dois boots sequenciais para comparação persistente, assets32 pin
   `4b6e90d356b2f93a2f7ec014f2778c1ce2fea8cfd8a19894fdb8112aa95038c1`
   (ou mudança explicitamente aprovada), manifests/digests, endpoints HTTP(S)
   mediados e tráfego interno, provisionamento guest restrito, RAM/CPU/disco
   e limite incremental dentro do inventory/piso4GiB/orçamento80GiB atuais,
   prazos/stop/cleanup próprios e regra de saída sem fallback. Não reutilizar
   grants03, apagar históricos para espaço ou iniciar tentativa por conta própria.

Não se solicita grant executável incompleto neste relatório. Nada autoriza
pull/rede/boot/install/reparo/sinal/hostmount/Dockerhost/sudo/credencial/GH/modelo.
Fixture interna preparada não aprova release, CA-08 dos pilotos ou MVP.

## Validação local desta alteração

Node24.21.0 explícito, NODE_OPTIONS/NODE_COMPILE_CACHE unset,
NODE_DISABLE_COMPILE_CACHE=1, TMPDIR=/home/sanmoo/software-factory-test.
`npm ci --offline --ignore-scripts --no-audit --no-fund`: 235 pacotes em3s;
nenhuma rede ou script de instalação. Tentativa inicial de build antes disso
falhou `tsc: command not found`; resolvido pelo restore offline próprio.

- Build/TypeScript: passou.
- Teste focado final: 7 testes, 7 pass, 0 fail, 0 skip, 731.170956ms.
- Arquitetura + ESLint: 77 modules, 346 dependencies, nenhuma violação/aviso.
- Grupo sandbox serial: 96 testes, 95 pass, 0 fail, 1 VM skip incondicional,
  18431.216623ms; não executou harness físico antigo.
- Architecture/entrypoints/protocol serial: 46 testes, 46 pass, 0 fail/skip,
  37912.763236ms. Total local: 142 casos, 141 pass, 1 VM skip, 0 fail.
- Fixtures: `sh -n` ambos scripts e `node --check` servidor/corpo JS embutido:
  exit0, sem executar corpo guest. Não são provas reais das fixtures.
- Probe LSP ativo: 3 arquivos, 0 diagnostics; 1 confirmado clean, 2 inconclusivos
  (timeout/push-only). Não alegar certificado LSP clean; tsc/gate passaram.
