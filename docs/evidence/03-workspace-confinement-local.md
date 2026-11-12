# 03 — confinamento de ancestrais no RealFS usado pelo adapter

Sem VM/guest script/rede/sinais ou alteração da imagem4b6. Testes somente em
fixtures novas, incluindo falsos home/control/git-cache/other-work; nenhum
arquivo pessoal ou credencial real lido. Mounts continuam apenas workspace e
artifacts próprios, definidos privadamente pelo adapter.

## Repro na fronteira efetivamente usada

SDK0.14 RealFSProvider aplica confinamento lexical+realpath a open e mutações,
mas lstat/readlink async/sync apenas confinavam lexicalmente a string final,
sem validar seus ancestrais. No serviço público FsRpcService real, lookup de
symlink retorna inode; uma requisição malformada usando esse inode como parent
conseguia lookup de arquivo de fixture fora da raiz. Audit privado registrou
vfs-ancestor-escape-detected, resposta err0 indevida. Isso é exposição de metadata
no protocolo, não prova de leitura de corpos arbitrários nem escape de hypervisor.

Loop RED executado no entrypoint real do adapter, com VM/manager externos dobrados,
mas RealFSProvider e FsRpcService REAIS. Primeiro compile exigiu anotações explícitas
para inferência TS7022 da fixture; depois RED real em~342ms com audit de escape,
antes da correção. Spawn de processo VMM proibido, VM.create real proibido e fetch
proibido; mock de módulo não substitui a implementação do produto.

## Correção pequena, sem engine/fork

createWorkspaceProvider constrói o RealFSProvider original e decora somente
lstat/readlink async+sync: primeiro valida o pai normalizado pela API pública
realpath do próprio provider, depois delega ao método original. Não altera FD,
open/mutações/capacidades ou readonly do provider, não edita SDK/node_modules,
não cria filesystem alternativo nem novo seam/flag de worker.

Factory é chamada no adapter após os gates de propriedade/runtime/asset/supervisão
e import dinâmico do SDK, para ambas as raízes próprias. Usa a fila serial nativa
de FsRpcService (fonte instalada explicita essa garantia) contra trocas de path
entre operações do guest. Isso não é proteção contra comprometimento da conta ou
dos processos host confiáveis, explicitamente fora desse limite no contrato19.
Não alegar que chamadas diretas arbitrárias ao provider ou hosts concorrentes
foram transformadas em uma primitiva kernel openat2.

## GREEN e alcance

O mesmo probe passou depois da correção. Verifica as duas chaves/raízes exatas,
lookup RPC malformado negado em quatro zonas externas por raiz, lstat/readlink
async/sync negados via ancestor symlink e travessia lexical; open/leitura/create/
rename/unlink para fora negados. Symlink interno válido continua funcionando,
com open/FDread/close reais. Fixtures externas preservam canário; nunca aparece
em stdout/stderr ou evidência pública. Os demais13casos do produtor continuam
passando (focused14pass). Apenas sintaxe não foi usada como substituto do repro.

Ainda não é teste de kernel/FUSE aliases rodando no guest, isolamento entre duas
VMs ou projeção de tools/roles de workers. A composição exata provider+serviçoRPC
foi exercitada sem hardware; alias de mount no guest deve voltar ao mesmo serviço
confinado, mas não declarar esse caminho como prova física já feita.

Revisão independente única53c769a3: sem P1/P2, OK no incremento; confirmou a
sequência RPC e a fila nativa, sem alegar prova de kernel/FUSE. Gates finais:
101casos100pass/1VMskip/0fail (~21.41s), strict compile/build/arquitetura/ESLint
72módulos321dependências e diff-check. LSP sem achados retornados, mas não
certificado clean por servidor push-only. Nenhuma mudança
retroativa às provas u3/v3 ou liberação de UNKNOWN/noRetry. Ticket03 continua aberto
até fechar critérios/provas restantes; sem integração/push/cleanup histórico.
