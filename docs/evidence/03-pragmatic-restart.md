# Ticket03 — retomada com validação local normal

## Estado

Incremento parcial, não aceite do ticket03 ou do MVP.

Destino de integração preservado: branch `integration/software-factory-mvp`,
checkout `.worktrees/software-factory-mvp`, em `b591ec7`.
A retomada está em `implement/software-factory-mvp-03-pragmatic`, no checkout
`.worktrees/software-factory-mvp-03-pragmatic`.

Foram reaproveitados somente os incrementos de validação e preparo:

- `7abfc63` → `b57d98c`: integridade dos assets explicitamente fixados;
- `60cd813` → `d3fec60`: preparo idempotente de disco próprio.

Não foram importados os testes perigosos de lifecycle nem o controlador
experimental. A branch03 antiga, seus estágios e arquivos permanecem preservados.
O probe de VM reaproveitado está explicitamente desabilitado, inclusive quando
variáveis de ambiente de teste estiverem presentes.

## Inspeção da interrupção

A inspeção somente de leitura não encontrou processos correspondentes aos nomes
conhecidos H/O/lançador/TypeScript. Os quatro arquivos `compiler.*` esperados pelo
antigo harness e seu diretório de emissão estavam ausentes. Isso não é uma prova
de cessação de todos os serviços/VMs do host; nenhum recurso existente foi parado
ou removido.

O typecheck normal da branch03 antiga terminou com TS18047 em
`test/sandbox/test-controller-core-candidate.ts:132`. Esse erro da infraestrutura
experimental não foi reparado nem ocultado como sucesso.

## Validação local

Ferramentas locais usam timeout de 60 segundos, conforme a nova aprovação do
operador. Isso não autoriza encerrar VMs ou serviços persistentes.

As dependências desta retomada foram instaladas do cache com
`npm ci --offline --ignore-scripts --no-audit --no-fund`. A tentativa inicial de
reusar dependências por symlinks fez o gate arquitetural enxergar caminhos fora
do checkout; foi corrigida a instalação, sem enfraquecer a regra arquitetural.
Não houve download, script de instalação ou uso de credenciais pessoais.

Com Node 24.21.0, no checkout da retomada:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmitOnError
npm run check:architecture
```

Typecheck, compilação, dependency-cruiser e ESLint passaram.

Testes focados usam `TMPDIR` e `FACTORY_SANDBOX_TEST_ROOT` em
`/home/sanmoo/software-factory-test/product-local-clYJQT`:

- Sandbox.validate e Sandbox.prepare: 7/7; inclui qemu-img real em arquivos
  descartáveis próprios, sem boot de guest ou prova de isolamento de VM.
- Configuração/doctor, protocolo e garantia de typecheck estrito: 9/9.
- Reexecução conjunta final: 17 casos, 16 passaram, 1 prova de VM explicitamente
  ignorada, nenhuma falha; duração total dos testes de 6,87 segundos.

A sondagem LSP não apresentou erro de TypeScript. O analisador auxiliar apontou
cinco sugestões e um alerta de `JSON.parse` em `prepareEnvironment`; a exceção
já é convertida em resultado indeterminado pelo `try/catch` de `Sandbox.prepare`.
Isso foi registrado, sem anunciar uma análise auxiliar totalmente limpa nem
refatorar código apenas para silenciar o alerta.

Não foi executada a suíte antiga em quarentena, nem houve boot, sinalização de
VM, alteração de serviço, acesso GitHub ou chamada de modelo.

## Próximo recorte do produto

Implementar e validar o lifecycle pela interface pública da Sandbox: iniciar,
observar e parar um ambiente próprio, depois comprovar reinício preservando dados.
Essa prova e os critérios de isolamento/cessação ainda estão pendentes. Não
integrar o incremento parcial nem declarar o ticket resolvido por estes testes.

## Primeiro incremento: observação pela interface pública

`Sandbox.observe` foi acrescentado diretamente ao módulo do produto, sem runner
ou controlador adicional. Valida referências e metadados privados/versionados,
consulta somente a unit derivada do boot próprio e correlaciona invocação,
cgroup e início do processo. Não usa PID isolado como prova de cessação nem
converte métricas indisponíveis em zero. Metadados antigos/incompletos ou aliases
não são adotados.

TDD no seam público Q5: os quatro testes inicialmente falharam com operação
inexistente (TS2339 e TypeError); após implementação passaram em 0,14s.
Cobrem ambiente desconhecido, alias de diretório, host boot diferente e evidência
incompleta, preservando arquivos e resultado indeterminado. Typecheck,
compilação e arquitetura/lint passaram novamente.

A reexecução conjunta com o novo incremento teve 21 casos: 20 passaram, uma
prova de VM continuou ignorada e nenhuma falha, em 5,93 segundos.

A revisão independente apontou dois problemas concretos e ambos foram corrigidos:

- Metadados agora são abertos com `O_NONBLOCK` antes de verificar por fstat que
  são arquivos regulares. A regressão pública com FIFO sem escritor falhou antes
  por timeout do subprocesso local recém-criado (1,5s) e passou após a correção
  em 0,11s; nenhum processo de VM foi alvo desse timeout.
- Ausência de `cgroup.events` não basta: a observação exige cgroup v2, mount da
  hierarquia completa, fonte de controllers legível e namespaces de cgroup/mount
  iguais aos registrados. Grupo existente sem eventos legíveis é indeterminado;
  ausência do grupo só vale após revalidar a disponibilidade da hierarquia.
  Essa correção foi analisada como fonte; não é prova de cessação de VM real.

Após as correções: typecheck, compilação e arquitetura/lint passaram; 22 casos
focados, 21 passaram, 1 prova de VM ignorada e nenhuma falha, em 6,03s.

Os ramos que retornam ativo/parado têm implementação real de consulta ao
systemd e `/proc`/cgroup; ainda não foram qualificados com uma VM real neste
incremento. Os testes negativos não substituem essa prova. `start`, `stop`,
reinício persistente e demais critérios continuam pendentes.
