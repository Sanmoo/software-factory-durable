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
