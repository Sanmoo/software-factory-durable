# 03: Preparar, iniciar e parar um ambiente persistente por Trabalho

**What to build:** Uma integração autorizada prepara um ambiente próprio, inicia o guest, modifica dados e o desliga/reinicia sem perder disco ou workspace. O controlador consegue conhecer a condição e confirmar cessação mesmo se o proprietário anterior morrer.

**Blocked by:** [01: Preparar a instalação local e o gate de desenvolvimento](01-local-setup-and-development-gate.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Interface pública de Sandbox permite validar sem boot, preparar idempotentemente, iniciar com boot novo, observar, parar e remover recursos próprios; refs são opacas para Controle e resultados distinguem sucesso, falha e indeterminação.
- [ ] Perfil fixado usa Arch x86_64, QEMU/KVM e Alpine com assets íntegros; configuração aprovada é validada sem coerção e sem flags livres, scripts/mounts arbitrários ou fallback de aceleração.
- [ ] Disco próprio persistente, rootDiskDeleteOnClose desabilitado e configuração de tmpfs aprovada preservam arquivos/pacotes/caches esperados entre boots, sem prometer preservar processos/RAM.
- [ ] RealFSProvider expõe apenas workspace/artefatos próprios; testes de paths, symlinks e aliases negam escape para home, controlador, registros, cache Git ou outro Trabalho.
- [ ] Systemd supervisiona adapter/workers/VMM/subprocessos por identidade; observação e parada host funcionam sem adapter anterior e não afetam outro ambiente.
- [ ] Parada tenta cessação graciosa e depois término forçado próprio; pedido/exit code isolado não comprova cessação, e disco forçadamente parado é verificado antes de reuso.
- [ ] Piso livre, espaço físico/virtual e configuração efetiva são observáveis; falta de espaço impede operações afetadas sem apagar recursos para abrir espaço nem matar ativo automaticamente.
- [ ] Provas reais incluem ciclo persistente, falha do proprietário e isolamento entre ambientes; não usam dublê como prova de KVM, filesystem ou cessação.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 5.4, 7.1, 7.2, 7.3, 7.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-02, V-12, V-14 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Implementation checkpoint — BLOCKED

Desenvolvimento local autorizado; nenhum aceite acima está concluído. Após inspeção read-only,
QEMU/qemu-img não foram encontrados no PATH e nenhum perfil/asset de release foi fornecido.
Boot de VM, instalação, alteração de serviços e falha de proprietário não foram autorizados.
O supervisor aprovou um recorte parcial coerente apenas em `Sandbox.validate`, sem stubs de lifecycle.

Implementado diagnóstico de integridade com diretório explícito e SHA256 esperado do manifesto,
fornecidos pela composição confiável (não YAML); arquivos locais reais nos testes, sem boot,
download de imagem, descoberta de cache pessoal ou SDK irrestrito. Configuração válida não
é confundida com ambiente qualificado. Nenhuma prova de KVM, RealFSProvider/FUSE, systemd,
cessação ou persistência foi substituída por dublê.

[Evidência e lista completa das lacunas por critério](../../../docs/evidence/03-sandbox-validation-checkpoint.md).
Faltam o restante do lifecycle e todas as provas reais de V-02/V-12/V-14 pertinentes;
6 testes locais de validação e a suíte local verde não resolvem este ticket.
Status permanece não resolvido; preservar o checkpoint na branch local até autorização/pré-requisitos.

## Continuation checkpoint — PARTIAL (2026-11-05)

Autorização posterior e QEMU instalado permitiram continuar sem refazer o commit
anterior; rebase local sobre `b591ec7` preservou Controle/protocolo/CLI02. Implementado
`Sandbox.prepare` real, idempotente por Trabalho/configuração/pin, com identidade
registrada antes de efeitos, diretórios privados e cópia qcow2 standalone via
qemu-img. Sem stubs nem implementação pública de start/observe/stop/remove.

Prova real externa do SDK Gondolin0.14.0 em unit temporária systemd USER: dois boots
KVM distintos do asset upstream fixado preservam /root,/tmp e workspace RealFS;
teste opt-in do SDK + preparo público passou2/2. Isso NÃO comprova lifecycle público
completo, isolamento de paths ou cessação após morte do proprietário. Build nativo
rootless dos assets Alpine+git/gh/docker concluiu, mas seu boot real falhou no prazo
de60s para readiness; não foi declarado imagem homologada/Docker funcional.

Gate arquitetural/typecheck e suíte completa serial passam; `npm test` paralelo
falha no teste inalterado de readiness do ticket02 (linha43). Supervisor autorizou
commit parcial explícito; correção de pré-requisito pertence ao ticket04. Nenhuma
integração/resolução ou checkbox de aceite concluído. Zero VMs próprias vivas ao
checkpoint; assets/discos/logs identificados preservados somente no root autorizado.

[Evidência atual, inventário, hashes, comandos/resultados e os oito critérios ainda
incompletos](../../../docs/evidence/03-sandbox-validation-checkpoint.md#2026-11-05-continuation--partial-not-ticket-acceptance).
Próximo incremento: incorporar correção revisada do gate, diagnosticar boot da imagem
customizada e implementar adapter systemd persistido com start/observe/stop reais.

## Retomada simplificada — parcial

O operador aprovou voltar a comandos normais de validação local, com timeout
limitado aos processos recém-criados pelos próprios comandos. Os recursos e
registros anteriores são preservados, sem retomar o harness experimental.

A [retomada pragmática](../../../docs/evidence/03-pragmatic-restart.md) parte da
integração01/02 e reaproveita apenas validação de assets e preparo idempotente.
Typecheck, compilação, arquitetura/lint e16 testes focados passaram; a prova de
VM está explicitamente desabilitada. Lifecycle público, persistência entre boots,
isolamento e cessação ainda precisam de implementação/validação. Ticket não
resolvido e nenhum critério acima marcado como concluído.

Incremento seguinte: `Sandbox.observe` acrescentado ao módulo do produto, com
metadados privados/versionados, correlação de identidade e leitura do supervisor.
Cinco casos locais de recusa passaram; a revisão independente levou a correções
de FIFO e disponibilidade da hierarquia cgroup. A suíte focada atual passa21 casos
com uma prova de VM ignorada. Retornos ativo/parado ainda não qualificados com
VM real; início/parada/reinício persistente continuam pendentes.
